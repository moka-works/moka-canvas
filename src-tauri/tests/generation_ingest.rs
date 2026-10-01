use moka_canvas::config::parse_test_config;
use moka_canvas::domain::commands::make_node;
use moka_canvas::domain::{
    generation_capability_for, id_tag, new_id, now_iso, Capability, GenerationInputMode,
    GenerationMode, GenerationSpec, NodeKind, ResourceEntry, RunRecord, RunStatus, WorkflowNode,
};
use moka_canvas::generate::{
    ingest_generated, GenerateInput, GenerateResult, GeneratedItem, InputRole, ResolvedInputs,
};
use moka_canvas::project::store::{FsProjectStore, ProjectRegistry};
use moka_canvas::project::{CreateProject, ProjectStore};
use moka_canvas::workflow::PROVIDER_EXECUTOR_KEY;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

async fn create_store(
    tmp: &TempDir,
) -> (Arc<ProjectRegistry>, Arc<FsProjectStore>, PathBuf, String) {
    let config = Arc::new(parse_test_config(tmp.path()));
    let registry = Arc::new(ProjectRegistry::new(config));
    let root = tmp.path().join("demo-project");
    let (store, opened) = registry
        .create_project(
            &root,
            CreateProject {
                name: "Demo".into(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();
    let canvas_id = opened.moka.canvas[0].id.clone();
    (registry, store, root, canvas_id)
}

fn run(canvas_id: &str) -> RunRecord {
    asked_over(canvas_id, None)
}

/// The same record, asked for on behalf of a conversation rather than by a card
/// wanting something for itself.
fn run_asked_over(canvas_id: &str, session: &str) -> RunRecord {
    asked_over(canvas_id, Some(session.to_string()))
}

fn asked_over(canvas_id: &str, session: Option<String>) -> RunRecord {
    let now = now_iso();
    RunRecord {
        id: new_id(),
        project_id: new_id(),
        canvas_id: canvas_id.into(),
        requested_node_ids: Vec::new(),
        status: RunStatus::Running,
        executor_key: PROVIDER_EXECUTOR_KEY.into(),
        graph_hash: String::new(),
        parameters: json!({}),
        retry_of_run_id: None,
        assistant_session_id: session,
        steps: Vec::new(),
        error: None,
        error_code: None,
        error_details: None,
        cancel_requested: false,
        created_at: now.clone(),
        updated_at: now,
    }
}

/// A node asking for something, the way the editor builds one: the kind decides
/// the capability, so the two can never disagree.
fn asking(kind: NodeKind, title: &str, params: Option<serde_json::Value>) -> WorkflowNode {
    let capability = generation_capability_for(kind).expect("a generation node has a capability");
    let mut node = make_node(kind, title.into(), 0.0, 0.0);
    node.data.generation = Some(GenerationSpec {
        capability,
        mode: GenerationMode::Generate,
        model: "acme::paint-1".into(),
        prompt: "A poster for the harvest festival".into(),
        input_mode: GenerationInputMode::Upstream,
        params,
        reference_node_ids: None,
        updated_at: now_iso(),
    });
    node
}

fn image(bytes: Vec<u8>) -> GeneratedItem {
    GeneratedItem {
        bytes,
        mime: "image/png".into(),
        kind: Capability::Image,
        width: Some(64),
        height: Some(64),
        duration_ms: None,
    }
}

fn speech(bytes: Vec<u8>) -> GeneratedItem {
    sound(bytes, Capability::Speech)
}

/// An answer of either sound capability: the kind a provider's answer carries
/// is the ask's own, which is what tells a line from a score apart.
fn sound(bytes: Vec<u8>, kind: Capability) -> GeneratedItem {
    GeneratedItem {
        bytes,
        mime: "audio/wav".into(),
        kind,
        width: None,
        height: None,
        duration_ms: Some(1000),
    }
}

fn answer(items: Vec<GeneratedItem>) -> GenerateResult {
    GenerateResult {
        text: None,
        items,
        usage: None,
    }
}

/// Everything the project has registered, across all five categories.
async fn registered(store: &FsProjectStore) -> Vec<ResourceEntry> {
    let resources = store.current().await.unwrap().unwrap().moka.resources;
    let mut all = Vec::new();
    for category in [
        &resources.images,
        &resources.music,
        &resources.voice,
        &resources.texts,
        &resources.videos,
    ] {
        all.extend(category.iter().cloned());
    }
    all
}

fn files_in(root: &Path, category: &str) -> usize {
    std::fs::read_dir(root.join("assets").join(category))
        .map(|entries| entries.count())
        .unwrap_or(0)
}

fn make_test_png() -> Vec<u8> {
    let mut png = image::RgbaImage::new(64, 64);
    for pixel in png.pixels_mut() {
        *pixel = image::Rgba([200, 120, 60, 255]);
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(png)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

/// Minimal but well-formed 1s stereo 44.1kHz PCM WAVE.
fn make_test_wav() -> Vec<u8> {
    let byte_rate = 176_400u32;
    let data_size = byte_rate;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36u32 + data_size).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&44_100u32.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    bytes.resize(bytes.len() + data_size as usize, 0);
    bytes
}

#[tokio::test]
async fn an_image_answer_lands_in_the_project_bearing_its_provenance() {
    let tmp = TempDir::new().unwrap();
    let (registry, store, root, canvas_id) = create_store(&tmp).await;
    let run = run(&canvas_id);
    let node = asking(
        NodeKind::Image,
        "Poster",
        Some(json!({ "size": "1024x1024" })),
    );
    let inputs = ResolvedInputs {
        prompt: "A poster for the harvest festival".into(),
        inputs: vec![GenerateInput {
            role: InputRole::Reference,
            asset_id: "asset-sketch".into(),
            window: None,
        }],
        used_node_ids: vec!["node-sketch".into()],
        ..ResolvedInputs::default()
    };
    // A caption beside the picture is not a second asset: it belongs on the
    // node, where the reader sees it next to what it describes.
    let result = GenerateResult {
        text: Some("Here is the poster.".into()),
        items: vec![image(make_test_png())],
        usage: None,
    };

    let entries = ingest_generated(store.as_ref(), &run, &node, &inputs, &result)
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);

    let entry = &entries[0];
    assert_eq!(entry.name, format!("Poster-{}", id_tag(&run.id, 8)));
    assert!(entry.path.starts_with("assets/images/"), "{}", entry.path);
    assert_eq!(entry.mime.as_deref(), Some("image/png"));
    assert!(root.join(&entry.path).is_file());
    let probe = entry.probe.as_ref().expect("an image is probed");
    assert_eq!((probe.width, probe.height), (Some(64), Some(64)));

    let provenance = entry.provenance.as_ref().expect("provenance recorded");
    assert_eq!(provenance.run_id.as_deref(), Some(run.id.as_str()));
    assert_eq!(provenance.canvas_id.as_deref(), Some(canvas_id.as_str()));
    assert_eq!(
        provenance.operation_node_id.as_deref(),
        Some(node.id.as_str())
    );
    assert_eq!(
        provenance.input_asset_ids.as_deref(),
        Some([String::from("asset-sketch")].as_slice())
    );
    let snapshot = provenance.parameter_snapshot.as_ref().expect("a snapshot");
    assert_eq!(snapshot["model"], json!("acme::paint-1"));
    assert_eq!(snapshot["params"]["size"], json!("1024x1024"));

    // The document was persisted, and the provenance survives the round trip
    // through it rather than living only in memory.
    registry.open_project(&root).await.unwrap();
    let reopened = registered(store.as_ref()).await;
    assert_eq!(reopened.len(), 1);
    let stored = reopened[0]
        .provenance
        .as_ref()
        .expect("provenance encoded in the document");
    assert_eq!(stored.run_id, provenance.run_id);
    assert_eq!(stored.parameter_snapshot, provenance.parameter_snapshot);
    // A card that asked for itself is traced to the card and the run, and to
    // no conversation.
    assert_eq!(stored.assistant_session_id, None);
}

#[tokio::test]
async fn an_answer_a_conversation_asked_for_is_traced_back_to_it() {
    let tmp = TempDir::new().unwrap();
    let (registry, store, _root, canvas_id) = create_store(&tmp).await;
    let run = run_asked_over(&canvas_id, "session-lantern");
    let node = asking(NodeKind::Image, "Poster", None);

    let entries = ingest_generated(
        store.as_ref(),
        &run,
        &node,
        &ResolvedInputs::default(),
        &answer(vec![image(make_test_png())]),
    )
    .await
    .unwrap();
    let provenance = entries[0].provenance.as_ref().expect("an answer is traced");
    assert_eq!(
        provenance.assistant_session_id.as_deref(),
        Some("session-lantern")
    );
    assert_eq!(provenance.run_id.as_deref(), Some(run.id.as_str()));

    registry
        .open_project(&tmp.path().join("demo-project"))
        .await
        .unwrap();
    let stored = registered(store.as_ref()).await;
    assert_eq!(
        stored[0]
            .provenance
            .as_ref()
            .expect("provenance encoded in the document")
            .assistant_session_id
            .as_deref(),
        Some("session-lantern")
    );
}

#[tokio::test]
async fn several_answers_are_numbered_and_one_is_not() {
    let tmp = TempDir::new().unwrap();
    let (_registry, store, _root, canvas_id) = create_store(&tmp).await;
    let run = run(&canvas_id);
    let node = asking(NodeKind::Image, "Poster", None);
    let inputs = ResolvedInputs::default();
    let short = id_tag(&run.id, 8);

    let pair = ingest_generated(
        store.as_ref(),
        &run,
        &node,
        &inputs,
        &answer(vec![image(make_test_png()), image(make_test_png())]),
    )
    .await
    .unwrap();
    assert_eq!(
        pair.iter()
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>(),
        vec![format!("Poster-{short}-1"), format!("Poster-{short}-2")]
    );

    let single = ingest_generated(
        store.as_ref(),
        &run,
        &node,
        &inputs,
        &answer(vec![image(make_test_png())]),
    )
    .await
    .unwrap();
    assert_eq!(single[0].name, format!("Poster-{short}"));
    assert_eq!(registered(store.as_ref()).await.len(), 3);
}

#[tokio::test]
async fn an_answer_of_only_words_becomes_a_text_asset() {
    let tmp = TempDir::new().unwrap();
    let (_registry, store, root, canvas_id) = create_store(&tmp).await;
    let run = run(&canvas_id);
    let node = asking(NodeKind::Text, "Synopsis", None);
    let result = GenerateResult {
        text: Some("A harvest festival poster, warm and crowded.".into()),
        items: Vec::new(),
        usage: None,
    };

    let entries = ingest_generated(
        store.as_ref(),
        &run,
        &node,
        &ResolvedInputs::default(),
        &result,
    )
    .await
    .unwrap();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert!(entry.path.starts_with("assets/texts/"), "{}", entry.path);
    assert_eq!(entry.mime.as_deref(), Some("text/plain"));
    assert_eq!(
        std::fs::read_to_string(root.join(&entry.path)).unwrap(),
        result.text.clone().unwrap()
    );
    // Nothing travelled with this request, so there is nothing to list.
    let provenance = entry.provenance.as_ref().expect("provenance recorded");
    assert_eq!(provenance.input_asset_ids, None);
}

#[tokio::test]
async fn an_answer_with_nothing_in_it_writes_nothing() {
    let tmp = TempDir::new().unwrap();
    let (_registry, store, root, canvas_id) = create_store(&tmp).await;
    let run = run(&canvas_id);
    let node = asking(NodeKind::Image, "Poster", None);
    let inputs = ResolvedInputs::default();

    let blank = GenerateResult {
        text: Some("   ".into()),
        items: Vec::new(),
        usage: None,
    };
    assert!(
        ingest_generated(store.as_ref(), &run, &node, &inputs, &blank)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(ingest_generated(
        store.as_ref(),
        &run,
        &node,
        &inputs,
        &GenerateResult::default()
    )
    .await
    .unwrap()
    .is_empty());

    assert!(registered(store.as_ref()).await.is_empty());
    assert_eq!(files_in(&root, "images"), 0);
    assert_eq!(std::fs::read_dir(root.join("tmp")).unwrap().count(), 0);
}

#[tokio::test]
async fn speech_and_music_land_where_their_kind_implies() {
    let tmp = TempDir::new().unwrap();
    let (_registry, store, _root, canvas_id) = create_store(&tmp).await;
    let run = run(&canvas_id);
    let inputs = ResolvedInputs::default();

    // A sniffer cannot tell speech from music, so the capability the ask was
    // made in is what decides.
    let mut score = asking(NodeKind::Audio, "Score", None);
    score.data.generation.as_mut().unwrap().capability = Capability::Music;
    ingest_generated(
        store.as_ref(),
        &run,
        &score,
        &inputs,
        &answer(vec![sound(make_test_wav(), Capability::Music)]),
    )
    .await
    .unwrap();

    let narration = asking(NodeKind::Audio, "Narration", None);
    ingest_generated(
        store.as_ref(),
        &run,
        &narration,
        &inputs,
        &answer(vec![speech(make_test_wav())]),
    )
    .await
    .unwrap();

    let entries = registered(store.as_ref()).await;
    assert_eq!(entries.len(), 2);
    let by_name = |wanted: &str| {
        entries
            .iter()
            .find(|entry| entry.name.starts_with(wanted))
            .unwrap_or_else(|| panic!("no asset named {wanted}"))
            .path
            .clone()
    };
    assert!(
        by_name("Score").starts_with("assets/music/"),
        "{}",
        by_name("Score")
    );
    assert!(
        by_name("Narration").starts_with("assets/voice/"),
        "{}",
        by_name("Narration")
    );
}

#[tokio::test]
async fn a_part_that_cannot_be_written_takes_the_rest_with_it() {
    let tmp = TempDir::new().unwrap();
    let (_registry, store, root, canvas_id) = create_store(&tmp).await;
    let run = run(&canvas_id);
    let node = asking(NodeKind::Image, "Poster", None);
    let result = answer(vec![
        image(make_test_png()),
        image(Vec::new()), // the provider sent a part with nothing in it
    ]);

    let error = ingest_generated(
        store.as_ref(),
        &run,
        &node,
        &ResolvedInputs::default(),
        &result,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "ASSET_INVALID");

    // Half an answer would sit in the resources panel as clutter nobody asked
    // for, with no node to point at it: the part that landed is taken back out.
    assert!(registered(store.as_ref()).await.is_empty());
    assert_eq!(files_in(&root, "images"), 0);
    assert_eq!(std::fs::read_dir(root.join("tmp")).unwrap().count(), 0);
}

#[tokio::test]
async fn the_snapshot_is_the_spec_itself_minus_when_it_was_edited() {
    let tmp = TempDir::new().unwrap();
    let (_registry, store, _root, canvas_id) = create_store(&tmp).await;
    let run = run(&canvas_id);
    let node = asking(
        NodeKind::Image,
        "Poster",
        Some(json!({ "size": "1024x1024", "quality": "high" })),
    );
    let result = GenerateResult {
        text: Some("A poster.".into()),
        items: Vec::new(),
        usage: None,
    };

    let entries = ingest_generated(
        store.as_ref(),
        &run,
        &node,
        &ResolvedInputs::default(),
        &result,
    )
    .await
    .unwrap();
    let snapshot = entries[0]
        .provenance
        .as_ref()
        .unwrap()
        .parameter_snapshot
        .clone()
        .expect("a snapshot");

    // Asking for it again is a deserialize, not a field-by-field copy that can
    // drift from the type it copies from.
    let asked_again: GenerationSpec = serde_json::from_value(snapshot.clone()).unwrap();
    let spec = node.data.generation.clone().unwrap();
    assert_eq!(asked_again.model, spec.model);
    assert_eq!(asked_again.prompt, spec.prompt);
    assert_eq!(asked_again.params, spec.params);

    // The snapshot is the spec's own fields and nothing else, which is what
    // keeps a stored credential out of the document: the model is a reference,
    // and the key it resolves to is fetched at send time.
    let mut fields: Vec<&String> = snapshot.as_object().unwrap().keys().collect();
    fields.sort();
    assert_eq!(
        fields,
        vec![
            "capability",
            "inputMode",
            "mode",
            "model",
            "params",
            "prompt"
        ]
    );
}
