//! The account a web deployment asks for: the login routes, the cookie the
//! page and every API call have to carry, and the probes that stay open.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, AuthConfig, RuntimeMode};
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

fn gated_config(root: &Path) -> AppConfig {
    let mut config = parse_test_config(root);
    config.server.auth = AuthConfig {
        username: "moka".into(),
        password: "correct horse".into(),
    };
    config
}

fn open_state(config: &AppConfig) -> ApiState {
    let root = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    ApiState::new(config.clone(), RuntimeMode::Web, &root).expect("the metadata store opens")
}

fn app(state: ApiState) -> axum::Router {
    moka_canvas::server::router(state)
}

/// The static tree the page route falls back to, so that an allowed navigation
/// has something to serve and an asset is distinguishable from a page.
fn write_site(root: &Path) {
    let static_dir = root.join("static");
    std::fs::create_dir_all(static_dir.join("assets")).unwrap();
    std::fs::write(static_dir.join("index.html"), "<!doctype html><p>moka</p>").unwrap();
    std::fs::write(static_dir.join("assets/app.js"), "console.log('moka')").unwrap();
}

fn plain(method: &str, uri: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

fn navigation(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header(header::ACCEPT, "text/html,application/xhtml+xml")
        .body(Body::empty())
        .unwrap()
}

fn with_cookie(mut request: Request<Body>, cookie: &str) -> Request<Body> {
    request
        .headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    request
}

fn login_request(username: &str, password: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&json!({ "username": username, "password": password })).unwrap(),
        ))
        .unwrap()
}

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).expect("response body must be JSON")
}

fn cookie_of(response: &axum::http::Response<Body>) -> String {
    response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .expect("the sign-in sets a cookie")
        .to_string()
}

async fn sign_in(app: &axum::Router) -> String {
    let response = app
        .clone()
        .oneshot(login_request("moka", "correct horse"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    cookie_of(&response)
}

#[tokio::test]
async fn a_server_without_an_account_asks_nobody() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let config = parse_test_config(temp.path());
    let app = app(open_state(&config));

    let response = app
        .clone()
        .oneshot(plain("GET", "/api/v1/config"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app.clone().oneshot(navigation("/")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(plain("GET", "/api/auth/session"))
        .await
        .unwrap();
    let body = body_json(response).await;
    assert_eq!(body["required"], false);
    assert_eq!(body["authenticated"], true);
}

#[tokio::test]
async fn api_calls_without_a_session_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let app = app(open_state(&gated_config(temp.path())));

    for uri in ["/api/v1/config", "/api/v1/recent-projects", "/api/runtime"] {
        let response = app.clone().oneshot(plain("GET", uri)).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
        let body = body_json(response).await;
        assert_eq!(body["code"], "AUTH_REQUIRED", "{uri}");
    }
}

#[tokio::test]
async fn probes_stay_open_and_no_longer_name_a_path() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let app = app(open_state(&gated_config(temp.path())));

    let response = app
        .clone()
        .oneshot(plain("GET", "/api/health"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["status"], "ok");
    assert!(
        body["metadata"].get("root").is_none(),
        "a public probe must not hand out a filesystem path: {body}"
    );
    assert!(body["llmDebug"].get("dir").is_none());

    let response = app.oneshot(plain("GET", "/api/ready")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_page_without_the_cookie_is_sent_to_the_login_page() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let app = app(open_state(&gated_config(temp.path())));

    let response = app
        .clone()
        .oneshot(navigation("/?project=p1"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        response.headers().get(header::LOCATION).unwrap(),
        "/login?next=%2F%3Fproject%3Dp1"
    );

    // The login page itself, and the payload it needs, are reachable.
    let response = app
        .clone()
        .oneshot(navigation("/login?next=%2F"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .clone()
        .oneshot(plain("GET", "/assets/app.js"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_wrong_password_is_one_refusal_and_a_right_one_opens_the_door() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let app = app(open_state(&gated_config(temp.path())));

    let response = app
        .clone()
        .oneshot(login_request("moka", "battery staple"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(response).await;
    assert_eq!(body["code"], "AUTH_FAILED");

    let cookie = sign_in(&app).await;
    assert!(cookie.starts_with("moka_session="));

    let response = app
        .clone()
        .oneshot(plain("GET", "/api/auth/session"))
        .await
        .unwrap();
    let body = body_json(response).await;
    assert_eq!(body["required"], true);
    assert_eq!(body["authenticated"], false);

    let response = app
        .clone()
        .oneshot(with_cookie(plain("GET", "/api/v1/config"), &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(with_cookie(navigation("/"), &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .oneshot(with_cookie(plain("GET", "/api/auth/session"), &cookie))
        .await
        .unwrap();
    let body = body_json(response).await;
    assert_eq!(body["authenticated"], true);
    assert_eq!(body["username"], "moka");
}

#[tokio::test]
async fn signing_out_ends_the_session_it_was_signed_in_with() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let app = app(open_state(&gated_config(temp.path())));
    let cookie = sign_in(&app).await;

    let response = app
        .clone()
        .oneshot(with_cookie(plain("POST", "/api/auth/logout"), &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cleared = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cleared.contains("Max-Age=0"));

    let response = app
        .oneshot(with_cookie(plain("GET", "/api/v1/config"), &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_restart_keeps_the_sessions_it_issued() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let config = gated_config(temp.path());

    let cookie = {
        let app = app(open_state(&config));
        sign_in(&app).await
    };

    // The first state is gone, and so is the directory lock it held; a fresh
    // state over the same metadata directory is what a restart looks like.
    let app = app(open_state(&config));
    let response = app
        .oneshot(with_cookie(plain("GET", "/api/v1/config"), &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn a_changed_password_ends_the_sessions_the_old_one_issued() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let mut config = gated_config(temp.path());
    let cookie = {
        let app = app(open_state(&config));
        sign_in(&app).await
    };

    config.server.auth.password = "battery staple".into();
    let app = app(open_state(&config));
    let response = app
        .oneshot(with_cookie(plain("GET", "/api/v1/config"), &cookie))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn signing_in_is_refused_when_the_server_has_no_account() {
    let temp = tempfile::tempdir().unwrap();
    write_site(temp.path());
    let app = app(open_state(&parse_test_config(temp.path())));

    let response = app
        .oneshot(login_request("moka", "correct horse"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = body_json(response).await;
    assert_eq!(body["code"], "AUTH_NOT_CONFIGURED");
}
