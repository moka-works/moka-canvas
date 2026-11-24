//! Who may reach a web deployment.
//!
//! A server started from `config/moka.yaml` answers everyone until that file
//! names an account. Named, every page and every API call has to carry the
//! session cookie a successful sign-in hands out; a browser arriving without
//! one is sent to the login page, and anything under `/api/` is refused.
//!
//! Sessions are kept in the metadata directory rather than only in memory, so
//! restarting the server does not sign every reader out. Each record holds a
//! digest of the credentials it was issued under, so changing the password
//! ends the sessions it belongs to.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{rejection::JsonRejection, DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::problem::{json_or_problem, Problem};
use super::ApiState;
use crate::config::{AuthConfig, RuntimeMode};

/// The cookie a signed-in browser carries.
pub const COOKIE_NAME: &str = "moka_session";

/// How long one sign-in lasts. Long enough not to ask a reader to sign in every
/// morning, short enough that a forgotten browser is not signed in forever.
pub const SESSION_SECONDS: u64 = 7 * 24 * 60 * 60;

/// Where the sessions outlive the process that issued them.
const SESSIONS_FILE: &str = "auth-sessions.json";

/// One failed attempt waits this long before it is answered. Not a rate limit;
/// a floor under how fast a password can be guessed through the door.
const FAILED_LOGIN_DELAY: Duration = Duration::from_millis(300);

/// A sign-in lasts a week, and a login body is two short strings.
const MAX_LOGIN_BODY_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    username: String,
    /// The credentials this session was issued under, so a changed password
    /// ends it rather than leaving it valid for the rest of the week.
    digest: String,
    expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSession {
    token: String,
    username: String,
    digest: String,
    expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionsDocument {
    version: u32,
    sessions: Vec<StoredSession>,
}

/// The account a web deployment asks for, and the sessions it has handed out.
pub struct Auth {
    username: String,
    digest: [u8; 32],
    digest_hex: String,
    /// Absent for an in-memory store, which is what a test builds.
    sessions_path: Option<PathBuf>,
    root: Option<PathBuf>,
    sessions: Mutex<HashMap<String, Session>>,
}

impl Auth {
    /// The gate a configuration asks for, or none.
    ///
    /// A desktop window is never gated here: the operating system decides who
    /// may open it, and a copied web configuration does not change that.
    /// `root` is the metadata directory, whose file lets a restart keep the
    /// sign-ins it issued; without one the sessions live in memory alone.
    pub fn open(config: &AuthConfig, mode: RuntimeMode, root: Option<&Path>) -> Option<Arc<Self>> {
        if mode != RuntimeMode::Web || !config.is_enabled() {
            return None;
        }
        let digest = credential_digest(&config.username, &config.password);
        let digest_hex = hex::encode(digest);
        let (sessions_path, store_root) = match root {
            Some(root) => (Some(root.join(SESSIONS_FILE)), Some(root.to_path_buf())),
            None => (None, None),
        };
        let sessions = match &sessions_path {
            Some(path) => load_sessions(path, &digest_hex),
            None => HashMap::new(),
        };
        Some(Arc::new(Self {
            username: config.username.clone(),
            digest,
            digest_hex,
            sessions_path,
            root: store_root,
            sessions: Mutex::new(sessions),
        }))
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    fn verify(&self, username: &str, password: &str) -> bool {
        constant_time_eq(&credential_digest(username, password), &self.digest)
    }

    fn check(&self, token: &str) -> bool {
        let now = now_unix();
        let mut sessions = self.sessions.lock().unwrap_or_else(poisoned);
        let valid = sessions.get(token).is_some_and(|session| {
            session.expires_at > now
                && constant_time_eq(session.digest.as_bytes(), self.digest_hex.as_bytes())
        });
        if !valid && sessions.contains_key(token) {
            sessions.remove(token);
            drop(sessions);
            self.persist();
        }
        valid
    }

    fn issue(&self) -> String {
        let token = format!(
            "{}{}",
            uuid::Uuid::now_v7().simple(),
            uuid::Uuid::now_v7().simple()
        );
        let now = now_unix();
        let session = Session {
            username: self.username.clone(),
            digest: self.digest_hex.clone(),
            expires_at: now + SESSION_SECONDS,
        };
        let mut sessions = self.sessions.lock().unwrap_or_else(poisoned);
        // A file left alone for months would otherwise grow one dead record
        // per sign-in.
        sessions.retain(|_, held| held.expires_at > now);
        sessions.insert(token.clone(), session);
        drop(sessions);
        self.persist();
        token
    }

    fn revoke(&self, token: &str) {
        let mut sessions = self.sessions.lock().unwrap_or_else(poisoned);
        if sessions.remove(token).is_some() {
            drop(sessions);
            self.persist();
        }
    }

    /// Writes the live sessions down, best-effort.
    ///
    /// A directory that will not take the file costs a restart's worth of
    /// sign-ins, not the sign-in that was just accepted.
    fn persist(&self) {
        let (Some(path), Some(root)) = (&self.sessions_path, &self.root) else {
            return;
        };
        let now = now_unix();
        let sessions = {
            let held = self.sessions.lock().unwrap_or_else(poisoned);
            let mut live: Vec<StoredSession> = held
                .iter()
                .filter(|(_, session)| session.expires_at > now)
                .map(|(token, session)| StoredSession {
                    token: token.clone(),
                    username: session.username.clone(),
                    digest: session.digest.clone(),
                    expires_at: session.expires_at,
                })
                .collect();
            live.sort_by(|a, b| a.token.cmp(&b.token));
            live
        };
        let document = SessionsDocument {
            version: 1,
            sessions,
        };
        let bytes = match serde_json::to_vec_pretty(&document) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(error = %error, "the sign-in sessions could not be written");
                return;
            }
        };
        if let Err(error) =
            crate::metadata::fs::atomic_write(root, path, &bytes, crate::metadata::fs::SECRET_MODE)
        {
            tracing::warn!(error = %error, "the sign-in sessions could not be written");
        }
    }
}

fn poisoned<T>(error: std::sync::PoisonError<T>) -> T {
    error.into_inner()
}

fn load_sessions(path: &Path, digest_hex: &str) -> HashMap<String, Session> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return HashMap::new(),
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "the sign-in sessions could not be read; everyone signs in again"
            );
            return HashMap::new();
        }
    };
    let document: SessionsDocument = match serde_json::from_slice(&raw) {
        Ok(document) => document,
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "the sign-in sessions are not readable; everyone signs in again"
            );
            return HashMap::new();
        }
    };
    if document.version != 1 {
        tracing::warn!(
            version = document.version,
            "the sign-in sessions were written by an unknown version; everyone signs in again"
        );
        return HashMap::new();
    }
    let now = now_unix();
    document
        .sessions
        .into_iter()
        .filter(|session| {
            !session.token.is_empty()
                && session.expires_at > now
                && constant_time_eq(session.digest.as_bytes(), digest_hex.as_bytes())
        })
        .map(|session| {
            let token = session.token;
            (
                token,
                Session {
                    username: session.username,
                    digest: session.digest,
                    expires_at: session.expires_at,
                },
            )
        })
        .collect()
}

fn credential_digest(username: &str, password: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(username.as_bytes());
    hasher.update([0u8]);
    hasher.update(password.as_bytes());
    hasher.finalize().into()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn token_from(headers: &HeaderMap) -> Option<String> {
    let prefix = format!("{COOKIE_NAME}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|part| {
            part.trim()
                .strip_prefix(prefix.as_str())
                .filter(|token| !token.is_empty())
                .map(str::to_string)
        })
}

fn session_cookie(token: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}"
    ))
    .expect("a generated token is a valid cookie value")
}

fn cleared_cookie() -> HeaderValue {
    HeaderValue::from_static("moka_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    /// Whether this server asks for an account at all.
    pub required: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

/// What a browser asks before it draws anything, to know whether the door is
/// locked and whether it is already holding the key.
pub async fn session(State(state): State<ApiState>, headers: HeaderMap) -> Json<SessionResponse> {
    let Some(auth) = state.auth.as_deref() else {
        return Json(SessionResponse {
            required: false,
            authenticated: true,
            username: None,
        });
    };
    let authenticated = token_from(&headers)
        .as_deref()
        .is_some_and(|token| auth.check(token));
    Json(SessionResponse {
        required: true,
        authenticated,
        username: authenticated.then(|| auth.username().to_string()),
    })
}

pub async fn login(
    State(state): State<ApiState>,
    json: Result<Json<LoginRequest>, JsonRejection>,
) -> Result<Response, Problem> {
    let Json(request) = json_or_problem(json)?;
    let Some(auth) = state.auth.as_deref() else {
        return Err(Problem::new(
            StatusCode::BAD_REQUEST,
            "AUTH_NOT_CONFIGURED",
            "This server has no account configured; every request is served without one",
        ));
    };
    if !auth.verify(&request.username, &request.password) {
        tokio::time::sleep(FAILED_LOGIN_DELAY).await;
        return Err(Problem::new(
            StatusCode::UNAUTHORIZED,
            "AUTH_FAILED",
            "The username or password is not correct",
        ));
    }
    let token = auth.issue();
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session_cookie(&token));
    Ok(response)
}

pub async fn logout(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    if let (Some(auth), Some(token)) = (state.auth.as_deref(), token_from(&headers)) {
        auth.revoke(&token);
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, cleared_cookie());
    response
}

pub fn router() -> Router<ApiState> {
    Router::new()
        .route("/api/auth/session", get(session))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route_layer(DefaultBodyLimit::max(MAX_LOGIN_BODY_BYTES))
}

/// The door in front of every page and every API route.
///
/// Probes stay open for whatever watches the process, and the sign-in routes
/// have to be reachable by a browser that holds no cookie yet. Everything else
/// asks for the session: a navigation is sent to the login page with its
/// destination kept, an API call is answered 403, and an ordinary asset is let
/// through — a script or an icon cannot read a project.
pub async fn require_auth(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let Some(auth) = state.auth.as_deref() else {
        return next.run(request).await;
    };
    let path = request.uri().path().to_string();
    if path == "/api/health" || path == "/api/ready" || path.starts_with("/api/auth/") {
        return next.run(request).await;
    }
    if token_from(request.headers())
        .as_deref()
        .is_some_and(|token| auth.check(token))
    {
        return next.run(request).await;
    }
    if path.starts_with("/api/") {
        return Problem::new(
            StatusCode::FORBIDDEN,
            "AUTH_REQUIRED",
            "Sign in to use this server",
        )
        .into_response();
    }
    if path != "/login" && is_page_navigation(&request) {
        let destination = request
            .uri()
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/");
        let encoded: String =
            url::form_urlencoded::byte_serialize(destination.as_bytes()).collect();
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::LOCATION, format!("/login?next={encoded}"))
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::SEE_OTHER.into_response());
    }
    next.run(request).await
}

/// A browser asking for a page, as opposed to a script asking for bytes.
///
/// `fetch` sends `*/*`, a stream sends `text/event-stream`, and a picture sends
/// nothing that names html — none of them is something a person can be sent
/// from one page to another.
fn is_page_navigation(request: &Request) -> bool {
    matches!(*request.method(), Method::GET | Method::HEAD)
        && request
            .headers()
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/html"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_is_only_valid_for_the_credentials_it_was_issued_under() {
        let auth = Auth::open(
            &AuthConfig {
                username: "moka".into(),
                password: "correct horse".into(),
            },
            RuntimeMode::Web,
            None,
        )
        .expect("an account is configured");

        assert!(auth.verify("moka", "correct horse"));
        assert!(!auth.verify("moka", "battery staple"));
        assert!(!auth.verify("other", "correct horse"));

        let token = auth.issue();
        assert!(auth.check(&token));
        auth.revoke(&token);
        assert!(!auth.check(&token));
    }

    #[test]
    fn a_desktop_never_has_a_gate_however_it_is_configured() {
        let config = AuthConfig {
            username: "moka".into(),
            password: "correct horse".into(),
        };
        assert!(Auth::open(&config, RuntimeMode::Native, None).is_none());
    }

    #[test]
    fn an_empty_account_is_no_gate() {
        assert!(Auth::open(&AuthConfig::default(), RuntimeMode::Web, None).is_none());
    }

    #[test]
    fn the_cookie_carries_the_token_and_never_a_password() {
        let cookie = session_cookie("0123456789abcdef");
        let text = cookie.to_str().unwrap();
        assert!(text.starts_with("moka_session=0123456789abcdef"));
        assert!(text.contains("HttpOnly"));
        assert!(text.contains("SameSite=Lax"));
        assert!(!text.contains("correct horse"));
    }

    #[test]
    fn a_cookie_header_is_read_past_the_ones_beside_it() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("theme=dark"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("a=b; moka_session=token123; c=d"),
        );
        assert_eq!(token_from(&headers).as_deref(), Some("token123"));
        assert_eq!(token_from(&HeaderMap::new()), None);
    }
}
