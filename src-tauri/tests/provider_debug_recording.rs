//! Recording a generation that really went out, against a provider standing on
//! localhost.
//!
//! The recorder's own tests cover what it writes and how it protects it. What
//! they cannot cover is the seam that matters most: that the transport every
//! protocol shares reads a request before it goes out, writes the answer down
//! when it comes back, and puts every part of one generation in one directory
//! a person can read afterwards. That is proven here against a real socket.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::http::header::CONTENT_TYPE;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use moka_canvas::config::GenerateConfig;
use moka_canvas::domain::Capability;
use moka_canvas::generate::adapters::{for_protocol, ModelCall};
use moka_canvas::generate::media::MediaInput;
use moka_canvas::generate::models::ResolvedModel;
use moka_canvas::generate::{Cancel, DeltaSink, GenerateRequest, InputRole};
use moka_canvas::metadata::Protocol;
use serde_json::{json, Value};

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// The picture a video request opens on. A recorder does not decode it.
const PICTURE: &[u8] = b"an opening frame";

/// Bytes a provider would answer a speech request with, recognisable as sound
/// so that the answer is kept rather than refused.
const SPEECH: &[u8] = b"ID3\x04\x00\x00\x00\x00\x00\x00";

/// Bytes a provider would answer a finished shot with.
const FILM: &[u8] = b"\x00\x00\x00\x18ftypmp42a shot made of bytes";

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

fn channel(base_url: &str, protocol: &str, capability: Capability, path: &str) -> ModelCall {
    let resolved = ResolvedModel {
        config_id: format!("{protocol}-config"),
        model: "model-1".into(),
        display_name: "A model".into(),
        category: capability,
        protocol: Protocol::new(protocol),
        url: format!("{base_url}{path}"),
        scene: None,
    };
    ModelCall::new(&resolved, API_KEY.to_string(), GenerateConfig::default())
        .expect("a client builds")
}

fn generation(
    capability: Capability,
    prompt: &str,
    params: Value,
    inputs: Vec<MediaInput>,
) -> GenerateRequest {
    GenerateRequest {
        capability,
        prompt: prompt.into(),
        params: params.as_object().cloned().unwrap_or_default(),
        inputs: inputs
            .into_iter()
            .map(|media| moka_canvas::generate::GenerateInput {
                role: media.role,
                asset_id: media.asset_id,
                window: None,
                frame: None,
            })
            .collect(),
        ..GenerateRequest::default()
    }
}

/// The reference media a request carries, loaded the way the gateway would.
fn picture() -> MediaInput {
    MediaInput {
        role: InputRole::FirstFrame,
        asset_id: "frame-1".into(),
        name: "opening".into(),
        bytes: PICTURE.to_vec(),
        mime: "image/png".into(),
    }
}

fn stream(events: &[&str]) -> Response {
    let mut body = String::new();
    for event in events {
        body.push_str(&format!("data: {event}\n\n"));
    }
    ([(CONTENT_TYPE, "text/event-stream")], body).into_response()
}

fn watching() -> (DeltaSink, Arc<std::sync::Mutex<String>>) {
    let seen = Arc::new(std::sync::Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected.lock().expect("not poisoned").push_str(chunk);
    }));
    (sink, seen)
}

async fn record_into(dir: &Path) -> PathBuf {
    moka_canvas::generate::debug::init_in(dir)
        .expect("recording starts")
        .expect("recording is on");
    dir.to_path_buf()
}

/// Deploys the built-in converter scripts, which is also what points the
/// process-wide converter root at them.
async fn deploy_scripts() {
    if moka_canvas::converter::converter_root().is_some() {
        return;
    }
    let converter = tempfile::tempdir().expect("a converter directory");
    let path: &'static std::path::Path = Box::leak(converter.keep().into_boxed_path());
    moka_canvas::converter::deploy::ensure_deployed(path)
        .await
        .expect("the built-in scripts deploy");
}

fn directories(root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect::<Vec<PathBuf>>()
        })
        .unwrap_or_default();
    dirs.sort();
    dirs
}

/// Waits for the writer to catch up: recordings are written by a task of their
/// own, so a test has to wait for the files rather than assume they landed.
async fn settled<F>(root: &Path, ready: F) -> Vec<PathBuf>
where
    F: Fn(&[PathBuf]) -> bool,
{
    for _ in 0..600 {
        let dirs = directories(root);
        if ready(&dirs) {
            return dirs;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the recordings never settled: {:?}", directories(root));
}

fn read(root: &Path, name: &str) -> Vec<u8> {
    std::fs::read(root.join(name)).unwrap_or_else(|_| panic!("{name} is there"))
}

fn read_json(root: &Path, name: &str) -> Value {
    serde_json::from_slice(&read(root, name)).expect("the file is JSON")
}

fn calls(root: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(root.join("calls.jsonl")).expect("the calls are there");
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("one JSON line"))
        .collect()
}

/// The one directory whose answer holds a file with this name.
fn holding<'a>(dirs: &'a [PathBuf], name: &str) -> &'a PathBuf {
    dirs.iter()
        .find(|dir| dir.join(name).exists())
        .unwrap_or_else(|| panic!("no directory holds {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generation_that_really_went_out_is_written_as_readable_files() {
    deploy_scripts().await;
    let temp = tempfile::tempdir().expect("a directory to record into");
    let root = record_into(temp.path()).await;

    let polled = Arc::new(AtomicUsize::new(0));
    let polls = Arc::clone(&polled);
    let base_url = serve(
        Router::new()
            .route(
                "/v1/responses",
                post(|_headers: HeaderMap, body: Bytes| async move {
                    let asked =
                        serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
                    if asked.get("stream").and_then(Value::as_bool) == Some(true) {
                        return stream(&[
                            r#"{"type":"response.reasoning_text.delta","delta":"deliberate"}"#,
                            r#"{"type":"response.output_text.delta","delta":"A "}"#,
                            r#"{"type":"response.output_text.delta","delta":"lantern."}"#,
                            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"look"}}"#,
                            r#"{"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"where\":\"night\"}"}"#,
                            r#"{"type":"response.completed","response":{"output_text":"A lantern."}}"#,
                            "[DONE]",
                        ]);
                    }
                    Json(json!({ "output_text": "A lantern." })).into_response()
                }),
            )
            .route(
                "/v1/audio/speech",
                post(|_headers: HeaderMap, _body: Bytes| async move {
                    (
                        [(CONTENT_TYPE, "audio/mpeg")],
                        SPEECH.to_vec(),
                    )
                        .into_response()
                }),
            )
            .route(
                "/videos",
                post(|| async { Json(json!({ "id": "job-1" })) }),
            )
            .route(
                "/videos/job-1",
                get(move || {
                    let polls = Arc::clone(&polls);
                    async move {
                        // The first look finds a job still running; the second
                        // finds the finished film. The first must leave no file.
                        let at = polls.fetch_add(1, Ordering::SeqCst);
                        if at == 0 {
                            Json(json!({ "status": "in_progress" }))
                        } else {
                            Json(json!({ "status": "succeeded" }))
                        }
                    }
                }),
            )
            .route(
                "/videos/job-1/content",
                get(|| async { ([(CONTENT_TYPE, "video/mp4")], FILM.to_vec()) }),
            ),
    )
    .await;

    let text = channel(
        &base_url,
        "openaiResponses",
        Capability::Text,
        "/v1/responses",
    );
    let speech = channel(
        &base_url,
        "openaiSpeech",
        Capability::Speech,
        "/v1/audio/speech",
    );
    let video = channel(&base_url, "openaiVideos", Capability::Video, "/videos");
    let adapter = for_protocol(Protocol::new("openaiResponses"));

    adapter
        .generate(
            &text,
            &generation(
                Capability::Text,
                "describe a lantern",
                json!({}),
                Vec::new(),
            ),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("an answer");

    let (sink, seen) = watching();
    adapter
        .generate_stream(
            &text,
            &generation(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
                Vec::new(),
            ),
            &[],
            &sink,
            &Cancel::new(),
        )
        .await
        .expect("a stream");
    assert_eq!(*seen.lock().expect("not poisoned"), "A lantern.");

    adapter
        .generate(
            &speech,
            &generation(
                Capability::Speech,
                "say it",
                json!({ "voice": "nova", "format": "mp3" }),
                Vec::new(),
            ),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("a sound");

    let task = adapter
        .create_task(
            &video,
            &generation(
                Capability::Video,
                "a lantern at dusk",
                json!({ "seconds": 5 }),
                vec![picture()],
            ),
            &[picture()],
            &Cancel::new(),
        )
        .await
        .expect("a job");
    let pending = adapter
        .poll_task(&video, &task, &Cancel::new())
        .await
        .expect("a look");
    assert!(matches!(
        pending,
        moka_canvas::generate::TaskState::Pending { .. }
    ));
    let finished = adapter
        .poll_task(&video, &task, &Cancel::new())
        .await
        .expect("a finished look");
    assert!(matches!(
        finished,
        moka_canvas::generate::TaskState::Succeeded(_)
    ));

    let dirs = settled(&root, |dirs| {
        dirs.len() >= 4
            && dirs
                .iter()
                .filter(|dir| dir.join("response-1.mp3").exists())
                .count()
                == 1
            && dirs
                .iter()
                .filter(|dir| dir.join("response-1.mp4").exists())
                .count()
                == 1
            && dirs
                .iter()
                .filter(|dir| dir.join("response.sse.txt").exists())
                .count()
                == 1
            && dirs
                .iter()
                .filter(|dir| {
                    dir.join("response.txt").exists()
                        && !dir.join("response.sse.txt").exists()
                        && !dir.join("response-1.mp3").exists()
                        && !dir.join("response-1.mp4").exists()
                })
                .count()
                == 1
    })
    .await;
    assert_eq!(dirs.len(), 4, "one directory per generation");

    // The whole answer: the prompt in full, and the answer beside it.
    let text_dir = dirs
        .iter()
        .find(|dir| {
            dir.join("response.txt").exists()
                && !dir.join("response.sse.txt").exists()
                && !dir.join("response-1.mp3").exists()
                && !dir.join("response-1.mp4").exists()
        })
        .expect("the whole answer was recorded");
    assert_eq!(
        read_json(text_dir, "request.json")["prompt"],
        "describe a lantern"
    );
    assert_eq!(read_json(text_dir, "response.json")["ok"], true);
    assert_eq!(read(text_dir, "response.txt"), b"A lantern.");
    let whole = calls(text_dir);
    assert_eq!(whole.len(), 1);
    assert_eq!(whole[0]["kind"], "generate");
    assert_eq!(whole[0]["status"], 200);
    assert_eq!(whole[0]["request"]["input"], "describe a lantern");
    assert!(
        !text_dir.join("response.sse.txt").exists(),
        "a whole answer is not a stream"
    );

    // The stream: the reading, the raw events it was made of, its thoughts and
    // its tool call, each in a file a person can open.
    let stream_dir = holding(&dirs, "response.sse.txt");
    assert_eq!(read(stream_dir, "response.txt"), b"A lantern.");
    let events = String::from_utf8(read(stream_dir, "response.sse.txt")).expect("events are text");
    assert!(events.contains("response.output_text.delta"), "{events}");
    assert!(events.contains("response.reasoning_text.delta"), "{events}");
    let thinking =
        String::from_utf8(read(stream_dir, "response-thinking.txt")).expect("a thought is text");
    assert!(thinking.contains("deliberate"), "{thinking}");
    let tools = read_json(stream_dir, "response-tools.json");
    assert_eq!(tools[0]["name"], "look");
    assert_eq!(
        read_json(stream_dir, "response.json")["finishReason"],
        "tool_calls"
    );
    let streamed = calls(stream_dir);
    assert_eq!(streamed.len(), 1);
    assert_eq!(streamed[0]["kind"], "stream");
    assert_eq!(streamed[0]["request"]["stream"], true);
    assert_eq!(streamed[0]["stream"]["toolCalls"][0]["name"], "look");

    // The sound: the bytes the provider answered with, as a file that plays.
    let speech_dir = holding(&dirs, "response-1.mp3");
    assert_eq!(read(speech_dir, "response-1.mp3"), SPEECH);
    assert_eq!(
        read_json(speech_dir, "response.json")["media"][0]["mime"],
        "audio/mpeg"
    );
    assert_eq!(read_json(speech_dir, "request.json")["prompt"], "say it");

    // The shot: the create, the poll that ended it, and the film it named, all
    // in the directory the create made. The pending poll left no line.
    let video_dir = holding(&dirs, "response-1.mp4");
    let request = read_json(video_dir, "request.json");
    assert_eq!(request["prompt"], "a lantern at dusk");
    assert_eq!(request["references"][0]["role"], "firstFrame");
    assert_eq!(request["references"][0]["file"], "request-frame-1.png");
    assert_eq!(read(video_dir, "request-frame-1.png"), PICTURE);
    assert_eq!(read(video_dir, "response-1.mp4"), FILM);
    assert_eq!(
        read_json(video_dir, "response.json")["media"][0]["file"],
        "response-1.mp4"
    );
    let shot = calls(video_dir);
    let kinds: Vec<&str> = shot
        .iter()
        .map(|call| call["kind"].as_str().expect("a kind"))
        .collect();
    assert_eq!(
        kinds,
        ["task-create", "task-poll", "media"],
        "the pending poll left no line"
    );
    // The picture the request carried is pointed at the file it was written to,
    // rather than repeated as a data URL nobody can read.
    assert_eq!(
        shot[0]["request"]["first_frame"]["file"],
        "request-frame-1.png"
    );
    assert_eq!(shot[1]["response"]["status"], "succeeded");
    assert_eq!(shot[2]["media"]["mime"], "video/mp4");
    assert_eq!(shot[2]["media"]["bytes"], FILM.len());

    // The index is the place a reader starts: one start and one finish for
    // each generation.
    let index = std::fs::read_to_string(root.join("index.jsonl")).expect("an index");
    let lines: Vec<Value> = index
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("one JSON line"))
        .collect();
    let finished = lines
        .iter()
        .filter(|line| line["event"] == "finish")
        .count();
    assert_eq!(finished, 4, "one finish per generation: {index}");

    // The credential is masked in every text file, and no raw binary body was
    // left beside the records.
    for dir in &dirs {
        for entry in std::fs::read_dir(dir).expect("the directory is readable") {
            let path = entry.expect("an entry").path();
            assert!(
                path.extension().map(|ext| ext != "bin").unwrap_or(true),
                "{} is a raw body nobody can read",
                path.display()
            );
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            assert!(
                !text.contains(API_KEY),
                "{} leaks the credential in full",
                path.display()
            );
        }
    }
}
