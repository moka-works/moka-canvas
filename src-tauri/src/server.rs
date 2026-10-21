use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

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
    /// The note a local CLI reads to find this server without being told.
    runtime_note: PathBuf,
}

/// Where the server listens: `server.bind` with the `--host` and `--port` named
/// on the command line folded in. Each names one part of an address, so each
/// beats the file for that part alone. Folded through `SocketAddr` rather than
/// by joining strings, because joining an IPv6 address would produce something
/// that is not one (`::1:8080`).
pub fn listen_address(bind: &str, host: Option<IpAddr>, port: Option<u16>) -> Result<SocketAddr> {
    let written: SocketAddr = bind
        .parse()
        .with_context(|| format!("server.bind is not a valid socket address: {bind}"))?;
    Ok(SocketAddr::new(
        host.unwrap_or(written.ip()),
        port.unwrap_or(written.port()),
    ))
}

/// The address a reader should open, which is not always the address bound: a
/// server on every interface answers on loopback too, and no browser opens
/// `0.0.0.0`.
fn navigable(address: SocketAddr) -> String {
    if address.ip().is_unspecified() {
        format!("http://127.0.0.1:{}", address.port())
    } else {
        format!("http://{address}")
    }
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
        let address = listen_address(&config.server.bind, None, None)?;
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
        // The built-in extension definitions are read from the same machine
        // tree a reader adds one to. A failure here leaves whatever is already
        // deployed, and the directory endpoint reports what it can read.
        crate::extension::deploy::ensure_deployed(state.nodes_root())
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(target: "moka::extension", "deploy error: {error}");
            });
        let listener = TcpListener::bind(address)
            .await
            .context("failed to bind the local HTTP server")?;
        let address = listener.local_addr()?;
        // Read from the listener rather than from what was asked for: a `:0`
        // port is only known once it is bound, and a warning that named the
        // wrong address would send a reader to the wrong one.
        if !address.ip().is_loopback() {
            tracing::warn!(
                target: "moka::server",
                "listening on {address}, which is not loopback: anything that can reach this port can read and write every project this process can open, and nothing in front of these routes asks who is calling (see docs/security.md)"
            );
        }
        // A CLI on this machine finds the server without a flag: the note
        // names the port that was actually bound, which a `:0` port only knows
        // after binding. Written before serving, best-effort: a read-only
        // metadata directory costs discovery, not startup.
        let runtime_note = metadata_root.join("runtime.json");
        let noted = serde_json::json!({
            "pid": std::process::id(),
            "port": address.port(),
            "mode": match mode {
                RuntimeMode::Native => "native",
                RuntimeMode::Web => "web",
            },
            "url": navigable(address),
            "updatedAt": crate::domain::now_iso(),
        });
        if let Err(error) = std::fs::write(
            &runtime_note,
            serde_json::to_vec_pretty(&noted).unwrap_or_default(),
        ) {
            tracing::warn!("runtime note could not be written: {error}");
        }
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
            runtime_note,
        })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// What goes in the line a reader is told to open. The desktop window is
    /// built from `url()`, which therefore stays the address really bound.
    ///
    /// A wildcard bind answers on loopback too, and no browser opens the
    /// wildcard, so the URL offered is loopback. The bound address is named
    /// beside it: "available at 127.0.0.1" alone reads as if a `--host` asking
    /// for the network had been ignored.
    pub fn display_url(&self) -> String {
        let url = navigable(self.address);
        if self.address.ip().is_unspecified() {
            format!("{url} (listening on {})", self.address)
        } else {
            url
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut sender) = self.shutdown.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
                // Only the note this process wrote is removed: a second
                // server on the same metadata directory would have replaced
                // it, and that one's note is still true.
                if let Ok(raw) = std::fs::read_to_string(&self.runtime_note) {
                    if let Ok(note) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if note["pid"].as_u64() == Some(std::process::id() as u64) {
                            let _ = std::fs::remove_file(&self.runtime_note);
                        }
                    }
                }
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
    // Whether this server answers anywhere but this machine. The configured
    // bind decides it: startup has already refused one that does not parse,
    // and a port of 0 is resolved without changing the host.
    let loopback = state
        .config
        .server
        .bind
        .parse::<SocketAddr>()
        .is_ok_and(|address| address.ip().is_loopback());
    Json(json!({
        "delivery": if loopback { "localhost" } else { "network" },
        "mode": state.mode.as_str(),
        "renderer": "react + leafer-ui"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(root: &Path) -> ApiState {
        state_bound_to(root, "127.0.0.1:0")
    }

    fn state_bound_to(root: &Path, bind: &str) -> ApiState {
        let mut config = crate::config::parse_test_config(root);
        config.server.bind = bind.to_owned();
        let dir = config
            .metadata
            .dir
            .clone()
            .expect("the test configuration always sets a metadata directory");
        let metadata = crate::metadata::open(&dir, &config.metadata, RuntimeMode::Web)
            .expect("the metadata store opens inside a temporary directory");
        ApiState::with_metadata(
            config,
            RuntimeMode::Web,
            metadata,
            root.join("converter"),
            root.join("nodes"),
        )
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
        let body = body_json(response).await;
        assert_eq!(body["delivery"], "localhost");
        assert_eq!(body["mode"], "web");
        assert_eq!(body["renderer"], "react + leafer-ui");
    }

    #[tokio::test]
    async fn reports_a_network_delivery_when_bound_off_loopback() {
        let root = tempfile::tempdir().unwrap();
        let response = runtime(State(state_bound_to(root.path(), "0.0.0.0:0")))
            .await
            .into_response();
        let body = body_json(response).await;
        assert_eq!(body["delivery"], "network");
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
            root.path().join("nodes"),
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

    #[test]
    fn the_configured_address_is_used_when_the_command_line_names_nothing() {
        assert_eq!(
            listen_address("127.0.0.1:3000", None, None).unwrap(),
            "127.0.0.1:3000".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn a_host_named_on_the_command_line_keeps_the_configured_port() {
        assert_eq!(
            listen_address("127.0.0.1:3000", Some("0.0.0.0".parse().unwrap()), None).unwrap(),
            "0.0.0.0:3000".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn a_port_named_on_the_command_line_keeps_the_configured_host() {
        assert_eq!(
            listen_address("0.0.0.0:3000", None, Some(9000)).unwrap(),
            "0.0.0.0:9000".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn a_host_and_a_port_named_on_the_command_line_fold_into_one_address() {
        assert_eq!(
            listen_address(
                "127.0.0.1:3000",
                Some("192.168.1.5".parse().unwrap()),
                Some(9000)
            )
            .unwrap(),
            "192.168.1.5:9000".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn an_ipv6_address_is_folded_into_one_that_can_be_written_down() {
        assert_eq!(
            listen_address("127.0.0.1:3000", Some("::1".parse().unwrap()), Some(8080)).unwrap(),
            "[::1]:8080".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            listen_address("[::1]:3000", None, Some(8080)).unwrap(),
            "[::1]:8080".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn a_bind_that_is_not_an_address_is_reported_with_what_was_written() {
        let error = listen_address("nonsense", None, Some(8080)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "server.bind is not a valid socket address: nonsense"
        );
    }

    #[test]
    fn a_server_on_every_interface_is_still_opened_on_loopback() {
        assert_eq!(
            navigable("0.0.0.0:8080".parse().unwrap()),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            navigable("[::]:8080".parse().unwrap()),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn a_named_address_is_opened_as_it_stands() {
        assert_eq!(
            navigable("127.0.0.1:8080".parse().unwrap()),
            "http://127.0.0.1:8080"
        );
        assert_eq!(
            navigable("192.168.1.5:9000".parse().unwrap()),
            "http://192.168.1.5:9000"
        );
        assert_eq!(
            navigable("[::1]:8080".parse().unwrap()),
            "http://[::1]:8080"
        );
    }

    fn display_url(address: &str) -> String {
        LocalServer {
            runtime_note: PathBuf::new(),
            address: address.parse().unwrap(),
            shutdown: Mutex::new(None),
        }
        .display_url()
    }

    #[test]
    fn a_wildcard_bind_names_the_address_it_listens_on_beside_the_one_to_open() {
        assert_eq!(
            display_url("0.0.0.0:8080"),
            "http://127.0.0.1:8080 (listening on 0.0.0.0:8080)"
        );
        assert_eq!(
            display_url("[::]:8080"),
            "http://127.0.0.1:8080 (listening on [::]:8080)"
        );
    }

    #[test]
    fn a_named_bind_is_one_address_in_the_delivery_line() {
        assert_eq!(display_url("127.0.0.1:8080"), "http://127.0.0.1:8080");
        assert_eq!(display_url("192.168.1.5:9000"), "http://192.168.1.5:9000");
    }
}
