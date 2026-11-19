//! The converter host against a provider standing on localhost.
//!
//! What a script is handed and what it may hand back is a contract, and the
//! only way to test a contract like that is to run a script: these tests place
//! converters of their own in the models directory the host reads, and drive
//! them the way the gateway does — over a real socket, because the address
//! that gets built, where the credential travels, and what comes back are the
//! things the contract is about.

use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use moka_canvas::config::GenerateConfig;
use moka_canvas::converter::deploy::ensure_deployed;
use moka_canvas::converter::LuaAdapter;
use moka_canvas::domain::Capability;
use moka_canvas::generate::adapters::{ModelCall, ProviderAdapter};
use moka_canvas::generate::media::MediaInput;
use moka_canvas::generate::models::ResolvedModel;
use moka_canvas::generate::{Cancel, DeltaSink, GenerateRequest, InputRole, ProviderError};
use moka_canvas::metadata::Protocol;
use serde_json::{json, Value};

const API_KEY: &str = "sk-test-1234567890abcd";

/// The models directory this test binary runs against.
///
/// The host reads one root per process, so the root is deployed once — the
/// built-in converters, beside which each test places its own — and leaked,
/// because a root that went away with its test would leave the rest of the
/// binary reading a directory that no longer exists.
async fn models_root() -> &'static Path {
    static ROOT: tokio::sync::OnceCell<&'static Path> = tokio::sync::OnceCell::const_new();
    ROOT.get_or_init(|| async {
        let dir = std::env::temp_dir().join(format!("moka-lua-host-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a models directory is writable");
        let dir: &'static Path = Box::leak(dir.into_boxed_path());
        ensure_deployed(dir)
            .await
            .expect("the built-in converters deploy");
        dir
    })
    .await
}

/// Places one converter of the test's own under a capability directory.
async fn place(capability: &str, id: &str, document: Value, script: &str, lua: &str) {
    let dir = models_root().await.join(capability).join(id);
    tokio::fs::create_dir_all(&dir)
        .await
        .expect("the converter directory is writable");
    tokio::fs::write(dir.join("model.json"), document.to_string())
        .await
        .expect("the document is written");
    tokio::fs::write(dir.join(script), lua)
        .await
        .expect("the script is written");
}

/// A converter that declares nothing beyond the script beside it, which is
/// what most of these tests need.
async fn place_plain(capability: &str, id: &str, lua: &str) {
    place(
        capability,
        id,
        json!({
            "displayName": id,
            "urlExample": "https://example.com",
            "script": format!("{id}.lua"),
            "version": 1,
        }),
        &format!("{id}.lua"),
        lua,
    )
    .await;
}

/// A model configuration resolved to one call speaking a converter of the
/// test's own, at an address on a throwaway provider.
fn scripted(id: &str, base_url: &str, capability: Capability) -> ModelCall {
    let resolved = ResolvedModel {
        config_id: format!("{id}-config"),
        model: format!("{id}-model"),
        display_name: "Scripted".into(),
        category: capability,
        protocol: Protocol::from_wire_name(id),
        url: format!("{base_url}/generation"),
        scene: None,
    };
    ModelCall::new(&resolved, API_KEY.to_string(), GenerateConfig::default())
        .expect("a client builds")
}

fn generation(capability: Capability, prompt: &str) -> GenerateRequest {
    GenerateRequest {
        capability,
        prompt: prompt.into(),
        ..GenerateRequest::default()
    }
}

fn watching() -> (DeltaSink, Arc<Mutex<String>>) {
    let seen = Arc::new(Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected
            .lock()
            .expect("not held across a call")
            .push_str(chunk);
    }));
    (sink, seen)
}

fn shown(seen: &Arc<Mutex<String>>) -> String {
    seen.lock().expect("not held across a call").clone()
}

/// A real encoded image, so an item can be asserted on by what it is rather
/// than by what a test claimed it was.
fn png(width: u32, height: u32) -> Vec<u8> {
    let picture = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([12, 34, 56, 255]),
    ));
    let mut encoded = Vec::new();
    picture
        .write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .expect("a png encodes");
    encoded
}

fn base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// A wave header and a little silence: bytes that say what they are, so a test
/// can tell what the host sniffed from what the script claimed.
fn wave() -> Vec<u8> {
    let mut bytes = Vec::from(*b"RIFF");
    bytes.extend_from_slice(&36u32.to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8000u32.to_le_bytes());
    bytes.extend_from_slice(&8000u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&8u32.to_le_bytes());
    bytes.extend_from_slice(&[128, 128, 128, 128, 128, 128, 128, 128]);
    bytes
}

/// Starts a throwaway provider and returns the base address a converter's
/// endpoint URL is built on.
async fn serve(routes: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, routes).await;
    });
    format!("http://{address}")
}

/// What arrived at a throwaway provider.
#[derive(Clone, Default)]
struct Seen {
    requests: Arc<Mutex<Vec<Arrival>>>,
}

#[derive(Clone, Default, Debug)]
struct Arrival {
    path: String,
    authorization: Option<String>,
    api_key: Option<String>,
    x_api_key: Option<String>,
    body: String,
}

impl Seen {
    fn note(&self, path: &str, headers: &HeaderMap, body: &Bytes) {
        let header = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        };
        self.requests
            .lock()
            .expect("not held across a call")
            .push(Arrival {
                path: path.into(),
                authorization: header("authorization"),
                api_key: header("x-goog-api-key"),
                x_api_key: header("x-api-key"),
                body: String::from_utf8_lossy(body).to_string(),
            });
    }

    fn requests(&self) -> Vec<Arrival> {
        self.requests
            .lock()
            .expect("not held across a call")
            .clone()
    }

    fn paths(&self) -> Vec<String> {
        self.requests()
            .iter()
            .map(|seen| seen.path.clone())
            .collect()
    }
}

/// A server-sent stream out of the pieces named here, which is how a provider
/// that streams answers.
fn stream(events: &[&str]) -> Response {
    let mut body = String::new();
    for event in events {
        body.push_str(&format!("data: {event}\n\n"));
    }
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        body,
    )
        .into_response()
}

// ------------------------------------------------------------- what arrives

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scripted_stream_shows_its_pieces_and_keeps_the_whole_answer() {
    place_plain(
        "text",
        "streaming",
        r#"
function build_stream_request(call, req, inputs)
  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode({stream = true, prompt = req.prompt}),
  }
end

function parse_event(event)
  local payload = json.decode(event)
  if payload.error then
    return {failed = payload.error}
  end
  return {text = payload.delta, complete = payload.whole}
end
"#,
    )
    .await;

    let seen = Seen::default();
    let recorder = seen.clone();
    let base_url = serve(Router::new().route(
        "/generation",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorder = recorder.clone();
            async move {
                recorder.note("generation", &headers, &body);
                stream(&[
                    r#"{"delta":"A "}"#,
                    r#"{"delta":"lantern."}"#,
                    // The event that closes the stream carries the whole
                    // answer, which replaces what was collected rather than
                    // adding to it.
                    r#"{"whole":"A lantern."}"#,
                    "[DONE]",
                ])
            }
        }),
    ))
    .await;

    let call = scripted("streaming", &base_url, Capability::Text);
    let (sink, shown_so_far) = watching();
    let result = LuaAdapter::get()
        .generate_stream(
            &call,
            &generation(Capability::Text, "Draw a lantern."),
            &[],
            &sink,
            &Cancel::new(),
        )
        .await
        .expect("the stream is read");

    assert_eq!(shown(&shown_so_far), "A lantern.");
    assert_eq!(result.text.as_deref(), Some("A lantern."));
    let sent: Value =
        serde_json::from_str(&seen.requests()[0].body).expect("the body sent was JSON");
    assert_eq!(sent["stream"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_refused_at_the_door_it_named_is_asked_at_the_next_one() {
    let seen = Seen::default();
    let first = seen.clone();
    let second = seen.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/generation/first",
                post(move |headers: HeaderMap, body: Bytes| {
                    let first = first.clone();
                    async move {
                        first.note("first", &headers, &body);
                        (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"message": "not at this door"})),
                        )
                            .into_response()
                    }
                }),
            )
            .route(
                "/stream/second",
                post(move |headers: HeaderMap, body: Bytes| {
                    let second = second.clone();
                    async move {
                        second.note("second", &headers, &body);
                        stream(&[r#"{"piece":"An "}"#, r#"{"piece":"answer."}"#])
                    }
                }),
            ),
    )
    .await;

    // The second address is derived by the script, which is the whole point of
    // asking for the failure: the script knows what its provider offers and the
    // host does not. A stream is the same conversation as a whole answer here —
    // a refusal arrives whole, and what follows it may be a stream.
    place_plain(
        "text",
        "streaming-anyway",
        &format!(
            r#"
local second = "{base_url}/stream/second"

function build_stream_request(call, req, inputs)
  return {{
    request = {{
      method = "POST",
      url = call.url .. "/first",
      read_failure = true,
      body = json.encode({{stream = true, prompt = req.prompt}}),
    }},
    handler = "read_first",
    state = {{second = second}},
  }}
end

function read_first(status, headers, body, state)
  if status == 400 then
    return {{next = {{request = {{method = "POST", url = state.second,
                                   body = json.encode({{stream = true, prompt = "again"}})}}}}}}
  end
  return {{}}
end

function parse_event(event)
  return {{text = json.decode(event).piece}}
end
"#
        ),
    )
    .await;

    let call = scripted("streaming-anyway", &base_url, Capability::Text);
    let (sink, collected) = watching();
    let result = LuaAdapter::get()
        .generate_stream(
            &call,
            &generation(Capability::Text, "Ask anyway."),
            &[],
            &sink,
            &Cancel::new(),
        )
        .await
        .expect("the second door streams the answer");

    assert_eq!(result.text.as_deref(), Some("An answer."));
    assert_eq!(shown(&collected), "An answer.");
    assert_eq!(seen.paths(), vec!["first", "second"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_script_that_reads_a_failure_and_says_nothing_leaves_it_to_the_host() {
    // A script asks to read failures because one kind of them is its business;
    // the rest have to go on meaning what their status means, which is what an
    // empty reply at the host's door asks for.
    place_plain(
        "text",
        "defers",
        r#"
function build_request(call, req, inputs)
  return {method = "POST", url = call.url, read_failure = true,
          body = json.encode({prompt = req.prompt})}
end

function parse_response(status, headers, body)
  return {}
end
"#,
    )
    .await;

    let base_url = serve(Router::new().route(
        "/generation",
        post(|| async {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "7")],
                Json(json!({"error": {"message": "slow down"}})),
            )
                .into_response()
        }),
    ))
    .await;

    let call = scripted("defers", &base_url, Capability::Text);
    let error = LuaAdapter::get()
        .generate(
            &call,
            &generation(Capability::Text, "Ask anyway."),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("the refusal is the host's to explain");

    assert_eq!(error.code(), "PROVIDER_RATE_LIMIT");
    assert!(error.retryable(), "{error}");
    assert!(error.to_string().contains("slow down"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_complaint_that_arrives_mid_stream_is_refused_with_the_providers_words() {
    place_plain(
        "text",
        "complaining",
        r#"
function build_stream_request(call, req, inputs)
  return {method = "POST", url = call.url, body = json.encode({stream = true})}
end

function parse_event(event)
  local payload = json.decode(event)
  if payload.error then
    return {failed = payload.error}
  end
  return {text = payload.delta}
end
"#,
    )
    .await;

    let base_url = serve(Router::new().route(
        "/generation",
        post(|| async {
            stream(&[
                r#"{"delta":"Once "}"#,
                r#"{"error":"the model stopped on a filter"}"#,
            ])
        }),
    ))
    .await;

    let call = scripted("complaining", &base_url, Capability::Text);
    let (sink, _) = watching();
    let error = LuaAdapter::get()
        .generate_stream(
            &call,
            &generation(Capability::Text, "Say something."),
            &[],
            &sink,
            &Cancel::new(),
        )
        .await
        .expect_err("a complaint ends the stream as a failure");

    assert!(
        error.to_string().contains("the model stopped on a filter"),
        "{error}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_table_of_headers_and_the_bytes_themselves_come_with_the_answer() {
    place_plain(
        "speech",
        "hearable",
        r#"
function build_request(call, req, inputs)
  return {method = "POST", url = call.url, body = json.encode({input = req.prompt})}
end

function parse_response(status, headers, body, state, raw)
  -- The header arrives under the name it was sent with, lowercased, and the
  -- answer arrives whole whatever it holds.
  assert(headers["content-type"] == "audio/wav",
         "content type: " .. tostring(headers["content-type"]))
  assert(#raw == 52, "raw length: " .. tostring(#raw))
  assert(status == 200, "status: " .. tostring(status))
  return {items = {{raw = true, mime = "audio/mpeg"}}, usage = {seconds = 0.5}}
end
"#,
    )
    .await;

    let bytes = wave();
    let answering = bytes.clone();
    let base_url =
        serve(Router::new().route(
            "/generation",
            post(move || {
                let answering = answering.clone();
                async move {
                    ([(axum::http::header::CONTENT_TYPE, "audio/wav")], answering).into_response()
                }
            }),
        ))
        .await;

    let call = scripted("hearable", &base_url, Capability::Speech);
    let result = LuaAdapter::get()
        .generate(
            &call,
            &generation(Capability::Speech, "Say this."),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer is read");

    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].bytes, bytes);
    // Sniffed rather than trusted: the script called it an mp3 and the bytes
    // say otherwise, and what a file is wins over what it was called.
    assert_eq!(result.items[0].mime, "audio/x-wav");
    assert_eq!(result.usage.and_then(|usage| usage.seconds), Some(0.5));
}

// --------------------------------------------------------------- what fails

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_status_the_provider_refused_is_explained_here() {
    place_plain(
        "text",
        "throttled",
        r#"
function build_request(call, req, inputs)
  return {method = "POST", url = call.url, body = json.encode({prompt = req.prompt})}
end

function parse_response(status, headers, body)
  return {text = "this is never reached"}
end
"#,
    )
    .await;

    let base_url = serve(Router::new().route(
        "/generation",
        post(|| async {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "7")],
                Json(json!({"error": {"message": "slow down"}})),
            )
                .into_response()
        }),
    ))
    .await;

    let call = scripted("throttled", &base_url, Capability::Text);
    let error = LuaAdapter::get()
        .generate(
            &call,
            &generation(Capability::Text, "Ask anyway."),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("a rate limit is refused");

    // The code comes from the status rather than from the script, which is
    // what lets a caller know that asking again is worth it.
    assert_eq!(error.code(), "PROVIDER_RATE_LIMIT");
    assert!(error.retryable(), "{error}");
    assert!(error.to_string().contains("slow down"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_script_that_reads_a_failure_is_handed_one() {
    let seen = Seen::default();
    let first = seen.clone();
    let second = seen.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/generation/first",
                post(move |headers: HeaderMap, body: Bytes| {
                    let first = first.clone();
                    async move {
                        first.note("first", &headers, &body);
                        (
                            StatusCode::NOT_FOUND,
                            Json(json!({"message": "no such door"})),
                        )
                            .into_response()
                    }
                }),
            )
            .route(
                "/generation/second",
                post(move |headers: HeaderMap, body: Bytes| {
                    let second = second.clone();
                    async move {
                        second.note("second", &headers, &body);
                        Json(json!({"answer": "drawn anyway"})).into_response()
                    }
                }),
            ),
    )
    .await;

    // The second address is derived by the script, which is the whole point of
    // asking for the failure: the script knows what its provider offers and the
    // host does not.
    place_plain(
        "image",
        "falling-back",
        &format!(
            r#"
local second = "{base_url}/generation/second"

function build_request(call, req, inputs)
  return {{
    request = {{
      method = "POST",
      url = call.url .. "/first",
      read_failure = true,
      body = json.encode({{prompt = req.prompt}}),
    }},
    handler = "read_first",
  }}
end

function read_first(status, headers, body)
  if status == 404 then
    return {{next = {{request = {{method = "POST", url = second,
                                   body = json.encode({{prompt = "again"}})}},
                      handler = "read_second"}}}}
  end
  return {{error = "unexpected status " .. tostring(status)}}
end

function read_second(status, headers, body)
  return {{text = json.decode(body).answer}}
end
"#
        ),
    )
    .await;

    let call = scripted("falling-back", &base_url, Capability::Image);
    let result = LuaAdapter::get()
        .generate(
            &call,
            &generation(Capability::Image, "Draw a lantern."),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the second address answers");

    assert_eq!(result.text.as_deref(), Some("drawn anyway"));
    assert_eq!(seen.paths(), vec!["first", "second"]);
}

// --------------------------------------------------------- where keys ride

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_converter_says_which_header_its_credential_rides_in() {
    place_plain(
        "text",
        "bearer-key",
        r#"
function build_request(call, req, inputs)
  return {method = "POST", url = call.url, body = json.encode({prompt = req.prompt})}
end

function parse_response(status, headers, body)
  return {text = "answered"}
end
"#,
    )
    .await;
    place(
        "text",
        "header-key",
        json!({
            "displayName": "header-key",
            "urlExample": "https://example.com",
            "script": "header-key.lua",
            "auth": {"header": "x-api-key", "scheme": ""},
            "version": 1,
        }),
        "header-key.lua",
        r#"
function build_request(call, req, inputs)
  return {method = "POST", url = call.url, body = json.encode({prompt = req.prompt})}
end

function parse_response(status, headers, body)
  return {text = "answered"}
end
"#,
    )
    .await;
    place(
        "text",
        "keyless",
        json!({
            "displayName": "keyless",
            "urlExample": "https://example.com",
            "script": "keyless.lua",
            "auth": {"header": "", "scheme": ""},
            "version": 1,
        }),
        "keyless.lua",
        r#"
function build_request(call, req, inputs)
  return {method = "POST", url = call.url, body = json.encode({prompt = req.prompt})}
end

function parse_response(status, headers, body)
  return {text = "answered"}
end
"#,
    )
    .await;

    let seen = Seen::default();
    let recorder = seen.clone();
    let base_url = serve(Router::new().route(
        "/generation",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorder = recorder.clone();
            async move {
                recorder.note("generation", &headers, &body);
                Json(json!({"answer": "answered"})).into_response()
            }
        }),
    ))
    .await;

    for id in ["bearer-key", "header-key", "keyless"] {
        let call = scripted(id, &base_url, Capability::Text);
        LuaAdapter::get()
            .generate(
                &call,
                &generation(Capability::Text, "Ask."),
                &[],
                &Cancel::new(),
            )
            .await
            .expect("the answer is read");
    }

    let arrived = seen.requests();
    assert_eq!(
        arrived[0].authorization.as_deref(),
        Some(&format!("Bearer {API_KEY}")[..]),
        "a converter that says nothing gets the usual arrangement"
    );
    assert_eq!(arrived[1].x_api_key.as_deref(), Some(API_KEY));
    assert!(
        arrived[1].authorization.is_none() && arrived[1].api_key.is_none(),
        "the declared header is where it rides, and nowhere else"
    );
    assert!(
        arrived[2].authorization.is_none() && arrived[2].x_api_key.is_none(),
        "a converter that declares no credential carries none"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_credential_does_not_follow_an_address_off_the_configured_origin() {
    let elsewhere = Seen::default();
    let other = elsewhere.clone();
    let other_url = serve(Router::new().route(
        "/elsewhere",
        get(move |headers: HeaderMap| {
            let other = other.clone();
            async move {
                other.note("elsewhere", &headers, &Bytes::new());
                "something public".into_response()
            }
        }),
    ))
    .await;

    let here = Seen::default();
    let recorder = here.clone();
    let base_url = serve(Router::new().route(
        "/generation",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorder = recorder.clone();
            async move {
                recorder.note("generation", &headers, &body);
                Json(json!({"answer": "asked"})).into_response()
            }
        }),
    ))
    .await;

    // The script names the second address, which is where a provider left
    // something to fetch: the host never chooses an address.
    place_plain(
        "text",
        "wandering",
        &format!(
            r#"
local elsewhere = "{other_url}/elsewhere"

function build_request(call, req, inputs)
  return {{
    request = {{method = "POST", url = call.url,
                body = json.encode({{prompt = req.prompt}})}},
    handler = "read_first",
  }}
end

function read_first(status, headers, body)
  return {{next = {{request = {{method = "GET", url = elsewhere}},
                    handler = "read_second"}}}}
end

function read_second(status, headers, body)
  return {{text = body}}
end
"#
        ),
    )
    .await;

    let call = scripted("wandering", &base_url, Capability::Text);
    let result = LuaAdapter::get()
        .generate(
            &call,
            &generation(Capability::Text, "Ask."),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer is read");

    assert_eq!(result.text.as_deref(), Some("something public"));
    let arrived = elsewhere.requests();
    assert_eq!(arrived.len(), 1);
    assert!(arrived[0].authorization.is_none(), "{arrived:?}");
    // The configured endpoint is the origin the key belongs to, so it keeps it.
    assert_eq!(
        here.requests()[0].authorization.as_deref(),
        Some(&format!("Bearer {API_KEY}")[..])
    );
}

// -------------------------------------------------------------- what returns

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn media_a_script_describes_is_stored_as_what_it_is() {
    let picture = png(4, 3);
    let inline = base64(&picture);

    place_plain(
        "image",
        "painter",
        &format!(
            r#"
function build_request(call, req, inputs)
  return {{method = "POST", url = call.url,
           body = json.encode({{prompt = req.prompt, references = #inputs}})}}
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  return {{
    text = payload.revised_prompt,
    items = {{
      {{data_url = "data:image/png;base64,{inline}"}},
      {{base64 = "{inline}"}},
      {{url = payload.left_at}},
    }},
    usage = {{images = 3}},
  }}
end
"#
        ),
    )
    .await;

    let serving = picture.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/generation",
                post(move |headers: HeaderMap| async move {
                    // The address of the third item is read from the host the
                    // request arrived on, which is how one provider can name a
                    // second endpoint of its own.
                    let host = headers
                        .get("host")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    Json(json!({
                        "revised_prompt": "a lantern on a windowsill",
                        "left_at": format!("http://{host}/picture"),
                    }))
                    .into_response()
                }),
            )
            .route(
                "/picture",
                get(move || {
                    let serving = serving.clone();
                    async move {
                        ([(axum::http::header::CONTENT_TYPE, "image/png")], serving).into_response()
                    }
                }),
            ),
    )
    .await;

    let request = generation(Capability::Image, "Draw a lantern.");
    let call = scripted("painter", &base_url, Capability::Image);
    let inputs = vec![MediaInput {
        role: InputRole::Reference,
        asset_id: "ref-1".into(),
        name: "reference.png".into(),
        bytes: picture.clone(),
        mime: "image/png".into(),
    }];
    let result = LuaAdapter::get()
        .generate(&call, &request, &inputs, &Cancel::new())
        .await
        .expect("the answer is read");

    assert_eq!(result.items.len(), 3);
    for item in &result.items {
        assert_eq!(item.mime, "image/png");
        assert_eq!(item.kind, Capability::Image);
        assert_eq!(item.width, Some(4));
        assert_eq!(item.height, Some(3));
        assert_eq!(item.bytes, picture);
    }
    assert_eq!(result.text.as_deref(), Some("a lantern on a windowsill"));
    assert_eq!(result.usage.and_then(|usage| usage.images), Some(3));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chain_that_keeps_waiting_ends_at_the_steps_own_deadline() {
    use std::time::{Duration, Instant};

    place_plain(
        "image",
        "slowPoll",
        r#"
function build_request(call, req, inputs)
  return {
    state = {url = call.url},
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = "{}",
  }
end

function parse_response(status, headers, body, state)
  return {
    state = state,
    wait_ms = 5000,
    next = {request = {method = "GET", url = state.url, headers = {}}, handler = "parse_response"},
  }
end
"#,
    )
    .await;

    let base_url = serve(Router::new().route(
        "/generation",
        post(|| async { Json(json!({"still": true})) }),
    ))
    .await;
    let resolved = ResolvedModel {
        config_id: "slow-config".into(),
        model: "slow-model".into(),
        display_name: "Slow".into(),
        category: Capability::Image,
        protocol: Protocol::from_wire_name("slowPoll"),
        url: format!("{base_url}/generation"),
        scene: None,
    };
    let budgets = GenerateConfig {
        image_timeout_seconds: 1,
        ..GenerateConfig::default()
    };
    let call = ModelCall::new(&resolved, API_KEY.to_string(), budgets).expect("a client builds");

    let started = Instant::now();
    let error = LuaAdapter::get()
        .generate(
            &call,
            &generation(Capability::Image, "a slow picture"),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("the chain never finishes");
    assert!(matches!(error, ProviderError::Timeout(_)), "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the step ended at its deadline rather than after the pause"
    );
}
