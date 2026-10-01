use std::{net::SocketAddr, path::Path, sync::Mutex, time::Instant};

use anyhow::{ensure, Context, Result};
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use tokio::{net::TcpListener, sync::oneshot};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

use crate::api::{problem::ProblemMessage, ApiState};
use crate::config::{AppConfig, RuntimeMode};
use crate::project::ProjectStore;

pub struct LocalServer {
    address: SocketAddr,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl LocalServer {
    pub async fn start(config: AppConfig, mode: RuntimeMode, metadata_root: &Path) -> Result<Self> {
        // The prompts are embedded in this binary, so one that does not compile
        // is a fault in the build rather than in anything a reader can fix later,
        // and it is refused here rather than at the first request that reaches
        // it. Both runtimes start through this function, which is why the check
        // lives here rather than beside either of them.
        crate::prompts::verify().context("the embedded prompt templates do not compile")?;
        // Started here rather than beside either runtime, because both of them
        // start through this function and a recording that only one of them could
        // make would be a difference nobody asked for.
        crate::generate::debug::init(&config.generate.debug)
            .context("provider call recording could not be started")?;
        let address: SocketAddr = config
            .server
            .bind
            .parse()
            .context("server.bind is not a valid socket address")?;
        ensure!(
            config.server.static_dir.is_dir(),
            "static directory does not exist: {}",
            config.server.static_dir.display()
        );

        let state = ApiState::new(config, mode, metadata_root)?;
        crate::converter::deploy::ensure_deployed(state.converter_root())
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(target: "moka::converter", "deploy error: {error}");
            });
        let listener = TcpListener::bind(address)
            .await
            .context("failed to bind the local HTTP server")?;
        let address = listener.local_addr()?;
        let (shutdown_sender, shutdown_receiver) = oneshot::channel();
        let app = router(state);

        tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_receiver.await;
                })
                .await
            {
                eprintln!("local HTTP server stopped unexpectedly: {error}");
            }
        });

        Ok(Self {
            address,
            shutdown: Mutex::new(Some(shutdown_sender)),
        })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub fn shutdown(&self) {
        if let Ok(mut sender) = self.shutdown.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        }
    }
}

impl Drop for LocalServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn router(state: ApiState) -> Router {
    let static_dir = state.config.server.static_dir.clone();
    let max_body = state.config.server.max_upload_bytes as usize;
    let index = static_dir.join("index.html");
    let static_service = ServeDir::new(static_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/ready", get(ready))
        .route("/api/runtime", get(runtime))
        .merge(crate::api::router())
        .fallback_service(static_service)
        .layer(middleware::from_fn(log_api_request))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(DefaultBodyLimit::max(max_body))
        .with_state(state)
}

/// Liveness plus metadata diagnostics. Paths are redacted and no credential
/// material is reported — only the storage tier that holds the master key.
async fn health(State(state): State<ApiState>) -> impl IntoResponse {
    let info = state.metadata.info().await;
    // A document reset from a corrupt state is recoverable but must stay
    // visible, so the settings page can tell the user what was lost.
    let ok = info.documents.iter().all(|document| !document.corrupt);
    let documents = serde_json::to_value(&info.documents).unwrap_or_default();
    // Said out loud because a recording is the one diagnostic that changes what
    // the application keeps, and a reader who does not know it is on cannot weigh
    // what is on the disk in the application data directory. The directory is a
    // path and not a credential; the credentials inside it are always masked.
    let recording = match crate::generate::debug::active() {
        Some(settings) => json!({
            "enabled": true,
            "dir": settings.dir.to_string_lossy(),
        }),
        None => json!({ "enabled": false }),
    };
    Json(json!({
        "status": "ok",
        "llmDebug": recording,
        "metadata": {
            "store": serde_json::to_value(info.store).unwrap_or_default(),
            "root": info.root.to_string_lossy(),
            "schemaVersion": info.schema_version,
            "secretStorage": serde_json::to_value(info.secret_storage).unwrap_or_default(),
            "ok": ok,
            "documents": documents,
        },
    }))
}

/// Readiness probe: the loaded configuration's static directory exists, the
/// metadata store answers and survives the full write protocol, and the
/// current project directory (when one is open) is still accessible. Never
/// inspects request payloads.
async fn ready(State(state): State<ApiState>) -> impl IntoResponse {
    let config_loaded = state.config.server.static_dir.is_dir();
    let metadata_writable = state.metadata.probe_write().await.is_ok();
    let project_directory = match state.store.current_store() {
        None => true,
        Some(store) => match store.current().await {
            Ok(None) => true,
            Ok(Some(open)) => open.root.is_dir(),
            Err(_) => false,
        },
    };
    let ready = config_loaded && metadata_writable && project_directory;
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "status": if ready { "ready" } else { "unavailable" },
            "checks": {
                "config": config_loaded,
                "metadata": metadata_writable,
                "projectDirectory": project_directory,
            },
        })),
    )
}

/// Emits one structured event per API request with a request id, duration,
/// status, and error code. Request bodies are never logged, and neither are
/// headers, so a provider credential has no path into the log that a
/// redaction pass would have to catch.
async fn log_api_request(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let request_id = uuid::Uuid::now_v7().simple().to_string()[..12].to_string();
    let started = Instant::now();
    let mut response = next.run(req).await;
    let status = response.status().as_u16();
    let error_code = response
        .headers()
        .get("x-error-code")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    // A code says a request failed, not why; the sentence that does travels
    // beside the body, since the body itself is never read here.
    let error_message = response
        .extensions()
        .get::<ProblemMessage>()
        .map(|message| message.0.clone())
        .unwrap_or_default();
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    macro_rules! log_event {
        ($level:path) => {
            tracing::event!(
                target: "moka::http",
                $level,
                request_id = %request_id,
                method = %method,
                path = %path,
                status,
                duration_ms = started.elapsed().as_millis() as u64,
                error_code = %error_code,
                error_message = %error_message,
                "api request"
            )
        };
    }
    match status {
        500..=599 => log_event!(tracing::Level::ERROR),
        400..=499 => log_event!(tracing::Level::WARN),
        _ => log_event!(tracing::Level::INFO),
    }
    response
}

async fn runtime(State(state): State<ApiState>) -> impl IntoResponse {
    Json(json!({
        "delivery": "localhost",
        "mode": state.mode.as_str(),
        "renderer": "react + leafer-ui"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(root: &Path) -> ApiState {
        let config = crate::config::parse_test_config(root);
        let dir = config
            .metadata
            .dir
            .clone()
            .expect("the test configuration always sets a metadata directory");
        let metadata = crate::metadata::open(&dir, &config.metadata, RuntimeMode::Web)
            .expect("the metadata store opens inside a temporary directory");
        ApiState::with_metadata(config, RuntimeMode::Web, metadata, root.join("converter"))
    }

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the response body is readable");
        serde_json::from_slice(&bytes).expect("the response body is JSON")
    }

    #[tokio::test]
    async fn health_reports_the_metadata_backend() {
        let root = tempfile::tempdir().unwrap();
        let response = health(State(test_state(root.path()))).await.into_response();
        assert_eq!(response.status(), 200);
        let body = body_json(response).await;
        assert_eq!(body["status"], "ok");
        assert_eq!(body["metadata"]["store"], "file");
        assert_eq!(body["metadata"]["schemaVersion"], 3);
        assert_eq!(body["metadata"]["ok"], true);
        let names: Vec<&str> = body["metadata"]["documents"]
            .as_array()
            .expect("documents are listed")
            .iter()
            .map(|document| document["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"meta.json"), "{names:?}");
        assert!(names.contains(&"secrets.json"), "{names:?}");
    }

    #[tokio::test]
    async fn reports_runtime_mode() {
        let root = tempfile::tempdir().unwrap();
        let response = runtime(State(test_state(root.path())))
            .await
            .into_response();
        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn reports_ready_with_no_project_open() {
        let root = tempfile::tempdir().unwrap();
        let response = ready(State(test_state(root.path()))).await.into_response();
        assert_eq!(response.status(), 200);
        let body = body_json(response).await;
        assert_eq!(body["checks"]["metadata"], true);
    }

    /// The write probe must fail loudly rather than let the app serve requests
    /// whose saves are silently dropped.
    #[cfg(unix)]
    #[tokio::test]
    async fn reports_not_ready_when_the_metadata_directory_is_read_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let config = crate::config::parse_test_config(root.path());
        let dir = config
            .metadata
            .dir
            .clone()
            .expect("the test configuration always sets a metadata directory");
        let metadata = crate::metadata::open(&dir, &config.metadata, RuntimeMode::Web)
            .expect("the metadata store opens inside a temporary directory");
        let state = ApiState::with_metadata(
            config,
            RuntimeMode::Web,
            metadata,
            root.path().join("converter"),
        );

        let scratch = dir.join("tmp");
        assert!(
            scratch.is_dir(),
            "opening the store creates the scratch area"
        );
        std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o500)).unwrap();

        // File modes do not bind a root process — it writes through them — so
        // on such a machine a 0o500 directory is not read-only and the probe
        // rightly answers ready. Whether the modes hold is probed with the
        // same write the store itself would make.
        let canary = scratch.join(".mode-canary");
        let modes_hold = std::fs::write(&canary, b"").is_err();
        let _ = std::fs::remove_file(&canary);

        let response = ready(State(state)).await.into_response();
        if modes_hold {
            assert_eq!(response.status(), 503);
            let body = body_json(response).await;
            assert_eq!(body["status"], "unavailable");
            assert_eq!(body["checks"]["metadata"], false);
        } else {
            // The directory takes writes, so the honest answer is ready —
            // and this is still a reading of the probe, not of the modes.
            assert_eq!(response.status(), 200);
        }

        std::fs::set_permissions(&scratch, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}
