use moka_canvas::config::{parse_test_config, AppConfig};
use moka_canvas::domain::commands::{apply_commands, make_node};
use moka_canvas::domain::validate::{MAX_ASSET_TAGS, MAX_ASSISTANT_MESSAGES_PER_SESSION};
use moka_canvas::domain::{
    new_id, AssistantMessage, AssistantReference, AssistantRole, AssistantSession,
    AssistantToolCall, CanvasDocument, Capability, DocumentCommand, GenerationInputMode,
    GenerationMode, GenerationSpec, NodeKind, PointValue, TimelineDocument, TimelineSettings,
    TimelineTrack, TrackKind,
};
use moka_canvas::project::codec::decode_moka_file;
use moka_canvas::project::store::FsProjectStore;
use moka_canvas::project::{AssetShelfEdit, CreateProject, ProjectStore, StagedAsset};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

fn test_config(root: &Path) -> AppConfig {
    parse_test_config(root)
}

fn scaffold_ok(root: &Path) {
    assert!(root.join("canvas.moka").is_file());
    for category in ["images", "music", "voice", "texts", "videos"] {
        assert!(root.join("assets").join(category).is_dir(), "{category}");
    }
    assert!(root.join("output").is_dir());
    assert!(root.join("history/runs").is_dir());
    assert!(root.join("tmp").is_dir());
}

async fn create_store(tmp: &TempDir) -> (Arc<FsProjectStore>, PathBuf) {
    let config = Arc::new(test_config(tmp.path()));
    let store = Arc::new(FsProjectStore::new(config));
    let project_root = tmp.path().join("demo-project");
    store
        .create_project(
            &project_root,
            CreateProject {
                name: "Demo".into(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();
    (store, project_root)
}

#[tokio::test]
async fn create_scaffolds_the_project_tree_and_reopen_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    scaffold_ok(&root);

    // Opening the directory again keeps the same project identity.
    let first = store.current().await.unwrap().unwrap();
    let reopened = store
        .create_project(
            &root,
            CreateProject {
                name: "Ignored".into(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(reopened.moka.metadata.id, first.moka.metadata.id);
    assert_eq!(reopened.moka.metadata.name, "Demo");
}

/// A project made from an interface drawn in Chinese carries Chinese words; a
/// caller with no language of its own keeps the scaffold's own English name.
#[tokio::test]
async fn the_first_canvas_takes_the_name_the_interface_gave_it() {
    let tmp = TempDir::new().unwrap();
    let config = Arc::new(test_config(tmp.path()));
    let store = Arc::new(FsProjectStore::new(config));

    let spoken_root = tmp.path().join("spoken");
    let spoken = store
        .create_project(
            &spoken_root,
            CreateProject {
                name: "Spoken".into(),
                first_canvas_name: Some("画布 1".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(spoken.moka.canvas[0].name, "画布 1");

    // The name reaches the file and not only the answer.
    let reopened = store.open_project(&spoken_root).await.unwrap();
    assert_eq!(reopened.moka.canvas[0].name, "画布 1");

    let quiet = store
        .create_project(
            &tmp.path().join("quiet"),
            CreateProject {
                name: "Quiet".into(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(quiet.moka.canvas[0].name, "Canvas 1");
}

#[tokio::test]
async fn canvas_moka_round_trips_through_disk() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let node = make_node(NodeKind::Text, "Note".into(), 10.0, 20.0);

    let saved = store
        .apply_commands(
            0,
            vec![DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node.clone(),
            }],
        )
        .await
        .unwrap();
    assert_eq!(saved.revision, 1);

    // Re-open from disk and verify the node survived.
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(reopened.moka.canvas[0].nodes.len(), 1);
    assert_eq!(reopened.moka.canvas[0].nodes[0].id, node.id);
    assert_eq!(reopened.moka.metadata.revision, 1);
}

/// A write that fails publishes nothing.
///
/// The document is replaced only after the durable write succeeded, so a
/// rejected save leaves the revision a caller is compared against and the
/// content anyone can read exactly as the file has them — and the retry lands
/// once, not twice. Before this, the failed save left the in-memory document a
/// revision ahead of the file, and every later save was refused as a revision
/// conflict until the process was restarted.
#[tokio::test]
async fn a_failed_write_leaves_the_document_as_the_file_has_it() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let revision = current.moka.metadata.revision;
    let canvas_id = current.moka.canvas[0].id.clone();
    let node = make_node(NodeKind::Text, "Note".into(), 10.0, 20.0);
    let commands = || {
        vec![DocumentCommand::AddNode {
            canvas_id: canvas_id.clone(),
            node: node.clone(),
        }]
    };

    // The store writes through `<root>/tmp`, so a plain file where that
    // directory belongs refuses the write with ENOTDIR — the same refusal a
    // full disk or a permission change would produce, and one that does not
    // depend on the user the tests run as.
    let tmp_dir = root.join("tmp");
    std::fs::remove_dir_all(&tmp_dir).unwrap();
    std::fs::write(&tmp_dir, b"not a directory").unwrap();

    let error = store
        .apply_commands(revision, commands())
        .await
        .unwrap_err();
    assert_eq!(error.code(), "INTERNAL");

    let after = store.current().await.unwrap().unwrap();
    assert_eq!(after.moka.metadata.revision, revision);
    assert!(after.moka.canvas[0].nodes.is_empty());
    let on_disk = decode_moka_file(&std::fs::read(root.join("canvas.moka")).unwrap()).unwrap();
    assert_eq!(on_disk.metadata.revision, revision);
    assert!(on_disk.canvas[0].nodes.is_empty());

    // With the directory back, the retry from the same revision lands — and
    // the command it carries is applied exactly once.
    std::fs::remove_file(&tmp_dir).unwrap();
    std::fs::create_dir(&tmp_dir).unwrap();
    let saved = store.apply_commands(revision, commands()).await.unwrap();
    assert_eq!(saved.revision, revision + 1);
    let after = store.current().await.unwrap().unwrap();
    assert_eq!(after.moka.canvas[0].nodes.len(), 1);
    assert_eq!(after.moka.canvas[0].nodes[0].id, node.id);
}

/// A timeline born empty but for its three rows, as the cutting room makes one.
fn empty_timeline(id: &str, name: &str) -> TimelineDocument {
    let now = moka_canvas::domain::now_iso();
    let row = |kind: TrackKind, name: &str| TimelineTrack {
        id: new_id(),
        kind,
        name: name.into(),
        muted: false,
        hidden: false,
        locked: false,
        created_at: now.clone(),
    };
    TimelineDocument {
        id: id.into(),
        name: name.into(),
        schema_version: 1,
        settings: TimelineSettings {
            fps: 30,
            width: 1920,
            height: 1080,
            background: "#000000".into(),
        },
        tracks: vec![
            row(TrackKind::Video, "Video 1"),
            row(TrackKind::Audio, "Audio 1"),
            row(TrackKind::Text, "Text 1"),
        ],
        clips: Vec::new(),
        transitions: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    }
}

#[tokio::test]
async fn a_timeline_lands_through_the_pipeline_and_reads_back() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    assert!(current.moka.timelines.is_none());

    let timeline = empty_timeline("timeline-1", "Timeline 1");
    let saved = store
        .apply_commands(
            0,
            vec![DocumentCommand::AddTimeline {
                timeline: timeline.clone(),
                index: None,
            }],
        )
        .await
        .unwrap();
    assert_eq!(saved.revision, 1);

    // Re-open from disk and verify the timeline survived whole.
    let reopened = store.open_project(&root).await.unwrap();
    let held = reopened.moka.timelines.as_ref().unwrap();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].id, timeline.id);
    assert_eq!(held[0].tracks.len(), 3);
    assert_eq!(held[0].settings.fps, 30);
}

#[tokio::test]
async fn the_project_s_own_words_reach_the_disk_and_an_emptied_name_is_refused() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let before = store.current().await.unwrap().unwrap().moka.metadata;

    let saved = store
        .apply_commands(
            before.revision,
            vec![DocumentCommand::UpdateProjectMetadata {
                name: "  Autumn campaign  ".into(),
                description: "  A launch teaser  ".into(),
            }],
        )
        .await
        .unwrap();

    // Trimmed on the way in, and read back off the disk as written.
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(reopened.moka.metadata.name, "Autumn campaign");
    assert_eq!(
        reopened.moka.metadata.description.as_deref(),
        Some("A launch teaser")
    );

    // An emptied description is no description at all, and an emptied name is
    // refused before anything is written.
    let cleared = store
        .apply_commands(
            saved.revision,
            vec![DocumentCommand::UpdateProjectMetadata {
                name: "Autumn campaign".into(),
                description: "   ".into(),
            }],
        )
        .await
        .unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert!(reopened.moka.metadata.description.is_none());

    let refused = store
        .apply_commands(
            cleared.revision,
            vec![DocumentCommand::UpdateProjectMetadata {
                name: "   ".into(),
                description: String::new(),
            }],
        )
        .await;
    assert_eq!(refused.unwrap_err().code(), "VALIDATION_FAILED");
}

#[tokio::test]
async fn stale_revision_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let node = make_node(NodeKind::Text, "Note".into(), 0.0, 0.0);
    let result = store
        .apply_commands(41, vec![DocumentCommand::AddNode { canvas_id, node }])
        .await;
    assert_eq!(result.unwrap_err().code(), "REVISION_CONFLICT");
}

#[tokio::test]
async fn external_edit_is_detected_as_conflict() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();

    // Simulate another process rewriting canvas.moka.
    std::thread::sleep(std::time::Duration::from_millis(50));
    let moka_path = root.join("canvas.moka");
    let bytes = std::fs::read(&moka_path).unwrap();
    std::fs::write(&moka_path, &bytes).unwrap();

    let node = make_node(NodeKind::Text, "Note".into(), 0.0, 0.0);
    let result = store
        .apply_commands(0, vec![DocumentCommand::AddNode { canvas_id, node }])
        .await;
    assert_eq!(result.unwrap_err().code(), "REVISION_CONFLICT");
}

#[tokio::test]
async fn apply_commands_validates_edges() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let text = make_node(NodeKind::Text, "A".into(), 0.0, 0.0);
    let image = make_node(NodeKind::Image, "B".into(), 300.0, 0.0);

    store
        .apply_commands(
            0,
            vec![
                DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: text.clone(),
                },
                DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: image.clone(),
                },
            ],
        )
        .await
        .unwrap();

    // text.out → image.out is not a valid edge (output to output).
    let result = store
        .apply_commands(
            1,
            vec![DocumentCommand::AddEdge {
                canvas_id: canvas_id.clone(),
                edge: moka_canvas::domain::WorkflowEdge {
                    id: new_id(),
                    source: moka_canvas::domain::EdgeEndpoint {
                        node_id: text.id.clone(),
                        port_id: "out".into(),
                    },
                    target: moka_canvas::domain::EdgeEndpoint {
                        node_id: image.id.clone(),
                        port_id: "out".into(),
                    },
                    created_at: moka_canvas::domain::now_iso(),
                },
            }],
        )
        .await;
    assert_eq!(result.unwrap_err().code(), "PORT_TYPE_MISMATCH");
}

#[tokio::test]
async fn move_nodes_round_trip_with_inverse() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let node = make_node(NodeKind::Text, "Draggable".into(), 5.0, 6.0);
    store
        .apply_commands(
            0,
            vec![DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node.clone(),
            }],
        )
        .await
        .unwrap();

    let mut positions = BTreeMap::new();
    positions.insert(node.id.clone(), PointValue { x: 100.0, y: 200.0 });
    store
        .apply_commands(
            1,
            vec![DocumentCommand::MoveNodes {
                canvas_id: canvas_id.clone(),
                positions,
            }],
        )
        .await
        .unwrap();

    let after = store.current().await.unwrap().unwrap();
    let moved = &after.moka.canvas[0].nodes[0];
    assert_eq!((moved.bounds.x, moved.bounds.y), (100.0, 200.0));
}

#[tokio::test]
async fn asset_upload_registers_and_streams_back() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;

    // A real 64x64 PNG so the probe records dimensions.
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-test.bin");
    std::fs::write(&staging, &png).unwrap();

    let entry = store
        .add_asset(StagedAsset {
            name: "pixel.png".into(),
            tmp_path: staging,
            declared_mime: Some("image/png".into()),
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;
    assert_eq!(entry.mime.as_deref(), Some("image/png"));
    assert!(entry.path.starts_with("assets/images/"));
    assert!(root.join(&entry.path).is_file());
    assert_eq!(entry.probe.as_ref().unwrap().width, Some(64));

    let file = store.asset_file(&entry.id, None).await.unwrap();
    assert!(file.path.is_file());

    // Registry persisted: reopen and verify the entry survives.
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(reopened.moka.resources.images.len(), 1);
    assert!(reopened.self_check.ok);
}

/// Minimal but well-formed 1s stereo 44.1kHz PCM WAVE.
fn make_test_wav() -> Vec<u8> {
    let byte_rate = 176_400u32;
    let data_size = byte_rate; // exactly one second
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
async fn wav_upload_records_audio_probe_metadata() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;

    let staging = root.join("tmp").join("upload-tone.bin");
    std::fs::write(&staging, make_test_wav()).unwrap();

    let entry = store
        .add_asset(StagedAsset {
            name: "tone.wav".into(),
            tmp_path: staging,
            declared_mime: Some("audio/wav".into()),
            category_hint: Some("voice".into()),
            provenance: None,
        })
        .await
        .unwrap()
        .entry;
    assert!(entry.path.starts_with("assets/voice/"));
    let probe = entry.probe.expect("probe recorded");
    assert_eq!(probe.sample_rate, Some(44100));
    assert_eq!(probe.channels, Some(2));
    assert_eq!(probe.duration_ms, Some(1000));
}

#[tokio::test]
async fn invalid_upload_leaves_no_orphans() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let staging = root.join("tmp").join("upload-empty.bin");
    std::fs::write(&staging, b"").unwrap();
    let result = store
        .add_asset(StagedAsset {
            name: "empty.png".into(),
            tmp_path: staging,
            declared_mime: Some("image/png".into()),
            category_hint: None,
            provenance: None,
        })
        .await;
    assert_eq!(result.unwrap_err().code(), "ASSET_INVALID");
    assert!(store
        .current()
        .await
        .unwrap()
        .unwrap()
        .moka
        .resources
        .images
        .is_empty());
    let orphans = std::fs::read_dir(root.join("assets/images"))
        .unwrap()
        .count();
    assert_eq!(orphans, 0);
}

#[tokio::test]
async fn removing_a_referenced_asset_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-ref.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "ref.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;

    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let mut node = make_node(NodeKind::Image, "Uses asset".into(), 0.0, 0.0);
    node.data.asset_id = Some(entry.id.clone());
    store
        .apply_commands(1, vec![DocumentCommand::AddNode { canvas_id, node }])
        .await
        .unwrap();

    let result = store.remove_asset(&entry.id).await;
    assert_eq!(result.unwrap_err().code(), "ASSET_IN_USE");
}

#[tokio::test]
async fn self_check_reports_missing_and_changed_files() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-missing.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "gone.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;

    // Delete the file externally; reopening must surface the exact path.
    std::fs::remove_file(root.join(&entry.path)).unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert!(!reopened.self_check.ok);
    assert_eq!(reopened.self_check.issues.len(), 1);
    assert_eq!(reopened.self_check.issues[0].expected_path, entry.path);
    assert_eq!(
        reopened.self_check.issues[0].reason,
        moka_canvas::domain::SelfCheckReason::Missing
    );

    // Restore with a different length: a size the open reads, so the answer is
    // there before the room draws.
    let mut longer = make_test_png();
    longer.extend_from_slice(b"\n");
    std::fs::write(root.join(&entry.path), &longer).unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    // Nothing is left to read once the length disagrees: the issue is final.
    assert!(reopened.self_check_verified);
    assert_eq!(
        reopened.self_check.issues[0].reason,
        moka_canvas::domain::SelfCheckReason::Changed
    );

    // The rest of the file is put back, so what the read behind the open has to
    // speak about is a change of content alone: the sizes agree and only the
    // bytes say otherwise.
    let mut edited_in_place = make_test_png();
    let middle = edited_in_place.len() / 2;
    edited_in_place[middle] ^= 0xff;
    std::fs::write(root.join(&entry.path), &edited_in_place).unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert!(
        reopened.self_check.ok,
        "a file that kept its length is not something the sizes can speak about"
    );
    let (report, verified) = wait_for_verification(&store).await;
    assert!(verified);
    assert_eq!(report.issues.len(), 1);
    assert_eq!(
        report.issues[0].reason,
        moka_canvas::domain::SelfCheckReason::Changed
    );
    assert_eq!(report.issues[0].expected_path, entry.path);
}

/// Waits for the read behind an open to finish, so a test can speak about what
/// it found. Bounded on purpose: a check that never lands is a failed test, not
/// a hung suite.
async fn wait_for_verification(
    store: &Arc<FsProjectStore>,
) -> (moka_canvas::domain::SelfCheckReport, bool) {
    for _ in 0..200 {
        let (report, verified) = store.self_check_status().await.unwrap().unwrap();
        if verified {
            return (report, verified);
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the file check never finished");
}

/// A reader who puts a missing file back stops being told it is missing.
///
/// The dialog that raises the issue is also where a reader puts the file back,
/// so the report has to be able to come down: asking what is wrong again asks
/// about the files as they are now, not as they were at the open.
#[tokio::test]
async fn a_file_put_back_stops_being_an_issue() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-returned.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "returned.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;

    std::fs::remove_file(root.join(&entry.path)).unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(reopened.self_check.issues.len(), 1);

    std::fs::write(root.join(&entry.path), &png).unwrap();
    let (report, verified) = store.self_check_status().await.unwrap().unwrap();
    assert!(report.ok, "the file is back where the entry says it is");
    assert!(report.issues.is_empty());
    assert!(verified);
}

/// A finding about bytes stands until the entry speaks of other bytes.
///
/// A file edited in place at the same length is exactly what the read behind
/// the open is for, and exactly what a stat can never see: asking again must
/// not let that blindness take the finding back. Once the file is replaced
/// through the store the entry describes other bytes, and what was found is
/// about a file that is gone.
#[tokio::test]
async fn a_finding_about_bytes_stands_until_the_entry_moves_on() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-swapped.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "swapped.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;

    let mut edited = png.clone();
    let middle = edited.len() / 2;
    edited[middle] ^= 0xff;
    std::fs::write(root.join(&entry.path), &edited).unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert!(
        reopened.self_check.ok,
        "the length is the one the entry recorded, so the open has nothing to say"
    );
    let (report, _) = wait_for_verification(&store).await;
    assert_eq!(report.issues.len(), 1);

    // Asked again, the finding is still there although the stat it must look
    // past says the file is fine.
    let (again, _) = store.self_check_status().await.unwrap().unwrap();
    assert_eq!(again.issues.len(), 1);
    assert_eq!(
        again.issues[0].reason,
        moka_canvas::domain::SelfCheckReason::Changed
    );

    // Replaced through the store, the entry no longer describes the file the
    // read complained about.
    let mut other = image::RgbaImage::new(64, 64);
    for pixel in other.pixels_mut() {
        *pixel = image::Rgba([30, 60, 120, 255]);
    }
    let mut replacement = Vec::new();
    image::DynamicImage::ImageRgba8(other)
        .write_to(
            &mut std::io::Cursor::new(&mut replacement),
            image::ImageFormat::Png,
        )
        .unwrap();
    let staging2 = root.join("tmp").join("upload-swapped2.bin");
    std::fs::write(&staging2, &replacement).unwrap();
    let replaced = store
        .replace_asset_bytes(
            &entry.id,
            StagedAsset {
                name: "swapped.png".into(),
                tmp_path: staging2,
                declared_mime: None,
                category_hint: None,
                provenance: None,
            },
        )
        .await
        .unwrap()
        .entry;
    assert_ne!(replaced.sha256, entry.sha256, "the entry moved on");

    let (report, verified) = store.self_check_status().await.unwrap().unwrap();
    assert!(
        report.ok,
        "the bytes the entry speaks of are the bytes that are there"
    );
    assert!(report.issues.is_empty());
    assert!(verified);
}

#[tokio::test]
async fn replace_asset_bytes_clears_missing_state() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-replace.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "later.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;
    std::fs::remove_file(root.join(&entry.path)).unwrap();

    let staging2 = root.join("tmp").join("upload-replace2.bin");
    std::fs::write(&staging2, make_test_png()).unwrap();
    let updated = store
        .replace_asset_bytes(
            &entry.id,
            StagedAsset {
                name: "later.png".into(),
                tmp_path: staging2,
                declared_mime: None,
                category_hint: None,
                provenance: None,
            },
        )
        .await
        .unwrap()
        .entry;
    assert_eq!(updated.id, entry.id);
    let reopened = store.open_project(&root).await.unwrap();
    assert!(reopened.self_check.ok);
}

#[tokio::test]
async fn what_a_reader_says_about_an_asset_reaches_the_disk() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-shelf.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "lantern.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;
    assert_eq!(entry.origin.as_deref(), Some("brought"));
    assert!(entry.tags.is_none());
    assert!(entry.note.is_none());
    assert!(entry.favorite.is_none());
    assert!(entry.keyword.is_none());

    let said = store
        .update_asset_shelf(
            &entry.id,
            AssetShelfEdit {
                tags: Some(vec![" lake ".into(), "dusk".into(), "Lake".into()]),
                note: Some("  Kept for the opening shot.  ".into()),
                favorite: Some(true),
                keyword: None,
            },
        )
        .await
        .unwrap()
        .entry;
    assert_eq!(
        said.tags,
        Some(vec!["lake".to_string(), "dusk".to_string()])
    );
    assert_eq!(said.note.as_deref(), Some("Kept for the opening shot."));
    assert_eq!(said.favorite, Some(true));
    assert!(said.keyword.is_none());
    assert_eq!(said.sha256, entry.sha256);
    assert_eq!(std::fs::read(root.join(&said.path)).unwrap(), png);

    let unchecked = store
        .update_asset_shelf(
            &entry.id,
            AssetShelfEdit {
                favorite: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .entry;
    assert_eq!(unchecked.favorite, Some(false));
    assert_eq!(unchecked.tags, said.tags);
    assert_eq!(unchecked.note, said.note);

    let taken_back = store
        .update_asset_shelf(
            &entry.id,
            AssetShelfEdit {
                note: Some("   ".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .entry;
    assert!(taken_back.note.is_none());
    assert_eq!(taken_back.tags, unchecked.tags);

    let reopened = store.open_project(&root).await.unwrap();
    let on_disk = reopened
        .moka
        .resources
        .find(&entry.id)
        .expect("the asset is still registered");
    assert_eq!(
        on_disk.tags,
        Some(vec!["lake".to_string(), "dusk".to_string()])
    );
    assert!(on_disk.note.is_none());
    assert_eq!(on_disk.favorite, Some(false));
    assert_eq!(on_disk.origin.as_deref(), Some("brought"));
    assert!(reopened.self_check.ok);
}

#[tokio::test]
async fn the_shelf_refuses_more_than_it_can_hold() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let staging = root.join("tmp").join("upload-crowded.bin");
    std::fs::write(&staging, make_test_png()).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "crowded.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;

    let crowded: Vec<String> = (0..=MAX_ASSET_TAGS)
        .map(|index| format!("word-{index}"))
        .collect();
    let result = store
        .update_asset_shelf(
            &entry.id,
            AssetShelfEdit {
                tags: Some(crowded),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(result.unwrap_err().code(), "VALIDATION_FAILED");

    let long_tag = "l".repeat(40);
    let result = store
        .update_asset_shelf(
            &entry.id,
            AssetShelfEdit {
                tags: Some(vec![long_tag]),
                ..Default::default()
            },
        )
        .await;
    assert_eq!(result.unwrap_err().code(), "VALIDATION_FAILED");

    let result = store
        .update_asset_shelf("no-such-asset", AssetShelfEdit::default())
        .await;
    assert_eq!(result.unwrap_err().code(), "NOT_FOUND");

    let current = store.current().await.unwrap().expect("a project is open");
    let unchanged = current
        .moka
        .resources
        .find(&entry.id)
        .expect("the asset is still registered");
    assert!(unchanged.tags.is_none());
}

#[tokio::test]
async fn filing_a_text_node_writes_its_words_once() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();

    let mut node = make_node(NodeKind::Text, "Opening line".into(), 40.0, 60.0);
    node.data.content = Some("A lantern floats over a quiet lake at dusk.".into());
    store
        .apply_commands(
            current.moka.metadata.revision,
            vec![DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node.clone(),
            }],
        )
        .await
        .unwrap();

    let filed = store
        .file_node_as_asset(&canvas_id, &node.id)
        .await
        .unwrap();
    assert!(filed.created);
    let entry = filed.change.entry;
    assert_eq!(entry.origin.as_deref(), Some("filed"));
    assert_eq!(entry.mime.as_deref(), Some("text/markdown"));
    assert_eq!(entry.favorite, Some(true));
    assert_eq!(entry.name, "Opening line.md");
    assert!(entry.path.starts_with("assets/texts/"), "{}", entry.path);
    assert_eq!(
        entry.keyword.as_deref(),
        Some("A lantern floats over a quiet lake at dusk.")
    );
    assert_eq!(
        entry
            .provenance
            .as_ref()
            .and_then(|origin| origin.operation_node_id.as_deref()),
        Some(node.id.as_str())
    );
    assert_eq!(
        std::fs::read_to_string(root.join(&entry.path)).unwrap(),
        "A lantern floats over a quiet lake at dusk."
    );

    // The same words from the same node are one file, not a second copy.
    let again = store
        .file_node_as_asset(&canvas_id, &node.id)
        .await
        .unwrap();
    assert!(!again.created);
    assert_eq!(again.change.entry.id, entry.id);

    let reopened = store
        .create_project(
            &root,
            CreateProject {
                name: "Ignored".into(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(reopened.moka.resources.texts.len(), 1);
    assert_eq!(
        reopened.moka.resources.texts[0].id, entry.id,
        "a reopen reads the filed words back"
    );
}

#[tokio::test]
async fn filing_a_picture_keeps_the_picture_it_already_has() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let staging = root.join("tmp").join("upload-lantern.bin");
    std::fs::write(&staging, make_test_png()).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "lantern.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry;
    let before = std::fs::read(root.join(&entry.path)).unwrap();

    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let mut node = make_node(NodeKind::Image, "Lantern".into(), 0.0, 0.0);
    node.data.asset_id = Some(entry.id.clone());
    node.data.generation = Some(GenerationSpec {
        capability: Capability::Image,
        mode: GenerationMode::Generate,
        prompt: "A lantern lit at night".into(),
        input_mode: GenerationInputMode::Manual,
        ..Default::default()
    });
    store
        .apply_commands(
            current.moka.metadata.revision,
            vec![DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node.clone(),
            }],
        )
        .await
        .unwrap();

    let filed = store
        .file_node_as_asset(&canvas_id, &node.id)
        .await
        .unwrap();
    assert!(!filed.created, "the file was already in the project");
    assert_eq!(filed.change.entry.id, entry.id);
    assert_eq!(filed.change.entry.favorite, Some(true));
    assert_eq!(
        filed.change.entry.keyword.as_deref(),
        Some("A lantern lit at night"),
        "the shelf can be searched by the ask that made it"
    );
    assert_eq!(filed.change.entry.sha256, entry.sha256);
    assert_eq!(
        std::fs::read(root.join(&filed.change.entry.path)).unwrap(),
        before,
        "keeping a picture costs nothing of the picture's"
    );
}

#[tokio::test]
async fn a_node_with_nothing_in_it_cannot_be_filed() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();

    let empty = make_node(NodeKind::Text, "Blank".into(), 0.0, 0.0);
    let grouped = make_node(NodeKind::Group, "A group".into(), 0.0, 0.0);
    store
        .apply_commands(
            current.moka.metadata.revision,
            vec![
                DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: empty.clone(),
                },
                DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: grouped.clone(),
                },
            ],
        )
        .await
        .unwrap();

    let result = store.file_node_as_asset(&canvas_id, &empty.id).await;
    assert_eq!(result.unwrap_err().code(), "VALIDATION_FAILED");
    let result = store.file_node_as_asset(&canvas_id, &grouped.id).await;
    assert_eq!(result.unwrap_err().code(), "VALIDATION_FAILED");
    let result = store.file_node_as_asset(&canvas_id, "no-such-node").await;
    assert_eq!(result.unwrap_err().code(), "NOT_FOUND");
    let result = store.file_node_as_asset("no-such-canvas", &empty.id).await;
    assert_eq!(result.unwrap_err().code(), "NOT_FOUND");

    // A picture whose file is no longer registered has nothing to keep.
    let mut lost = make_node(NodeKind::Image, "Lost".into(), 0.0, 0.0);
    lost.data.asset_id = Some("asset-that-went-away".into());
    store
        .apply_commands(
            store
                .current()
                .await
                .unwrap()
                .unwrap()
                .moka
                .metadata
                .revision,
            vec![DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: lost.clone(),
            }],
        )
        .await
        .unwrap();
    let result = store.file_node_as_asset(&canvas_id, &lost.id).await;
    assert_eq!(result.unwrap_err().code(), "NOT_FOUND");
}

#[tokio::test]
async fn path_escape_is_rejected_when_streaming() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let result = store.asset_file("../../etc/passwd", None).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn commands_module_applies_group_dissolve() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();

    let node_a = make_node(NodeKind::Text, "A".into(), 0.0, 0.0);
    let node_b = make_node(NodeKind::Text, "B".into(), 300.0, 0.0);
    let group = make_node(NodeKind::Group, "G".into(), 0.0, 0.0);

    let (next, _) = apply_commands(
        &current.moka,
        &[
            DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node_a.clone(),
            },
            DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node_b.clone(),
            },
            DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: group.clone(),
            },
            DocumentCommand::SetGroupMembership {
                canvas_id: canvas_id.clone(),
                group_id: group.id.clone(),
                child_node_ids: vec![node_a.id.clone(), node_b.id.clone()],
            },
        ],
    )
    .unwrap();
    assert_eq!(next.canvas[0].groups.len(), 1);

    let (dissolved, _) = apply_commands(
        &next,
        &[DocumentCommand::SetGroupMembership {
            canvas_id: canvas_id.clone(),
            group_id: group.id.clone(),
            child_node_ids: vec![node_a.id.clone()],
        }],
    )
    .unwrap();
    assert_eq!(dissolved.canvas[0].groups.len(), 0);
    assert!(!dissolved.canvas[0].nodes.iter().any(|n| n.id == group.id));
    assert!(dissolved.canvas[0].nodes.iter().any(|n| n.id == node_a.id));
}

/// A moment after the one before it, so recency can be told apart.
fn at(second: u32) -> String {
    format!("2026-01-01T00:{:02}:{:02}Z", second / 60, second % 60)
}

fn line(role: AssistantRole, text: &str, second: u32) -> AssistantMessage {
    AssistantMessage {
        id: new_id(),
        role,
        text: text.to_string(),
        created_at: at(second),
        references: None,
        tool_calls: None,
        failure: None,
    }
}

/// A conversation nobody has said anything in yet, opened at the first moment so
/// that whatever is said in it is later.
fn conversation(title: &str) -> AssistantSession {
    AssistantSession {
        id: new_id(),
        title: title.to_string(),
        messages: Vec::new(),
        created_at: at(0),
        updated_at: at(0),
    }
}

fn said(canvas: &CanvasDocument) -> Vec<String> {
    canvas
        .sessions
        .iter()
        .flatten()
        .flat_map(|session| session.messages.iter().map(|line| line.text.clone()))
        .collect()
}

fn held(canvas: &CanvasDocument) -> Vec<String> {
    canvas
        .sessions
        .iter()
        .flatten()
        .flat_map(|session| session.messages.iter().map(|line| line.id.clone()))
        .collect()
}

#[tokio::test]
async fn a_conversation_survives_the_disk_and_undoes_to_nothing() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let opened = store.current().await.unwrap().unwrap();
    let canvas_id = opened.moka.canvas[0].id.clone();
    assert_eq!(
        opened.moka.canvas[0].sessions, None,
        "a canvas nobody has asked anything of carries no conversations"
    );

    let session = conversation("What is over the lake");
    let card = make_node(NodeKind::Image, "Lake".into(), 0.0, 0.0);
    // Every part of a line that can be left off is filled in, so the round trip
    // through the disk is a round trip through all of them.
    let answered = AssistantMessage {
        references: Some(vec![AssistantReference {
            node_id: card.id.clone(),
            title: card.title.clone(),
            kind: NodeKind::Image,
            asset_id: Some("asset-made".to_string()),
        }]),
        tool_calls: Some(vec![AssistantToolCall {
            run_id: new_id(),
            node_id: Some(card.id.clone()),
            summary: "Painted it".to_string(),
        }]),
        ..line(AssistantRole::Assistant, "A lake, at dusk.", 2)
    };
    let turn = vec![
        DocumentCommand::AddNode {
            canvas_id: canvas_id.clone(),
            node: card,
        },
        DocumentCommand::AddSession {
            canvas_id: canvas_id.clone(),
            session: session.clone(),
            index: None,
        },
        DocumentCommand::AppendMessages {
            canvas_id: canvas_id.clone(),
            session_id: session.id.clone(),
            messages: vec![
                line(AssistantRole::User, "What is over the lake?", 1),
                answered,
            ],
            at: None,
        },
    ];

    let (spoken, inverse) = apply_commands(&opened.moka, &turn).unwrap();
    assert_eq!(
        said(&spoken.canvas[0]),
        vec!["What is over the lake?", "A lake, at dusk."]
    );
    assert_eq!(
        spoken.canvas[0].sessions.as_ref().unwrap()[0].updated_at,
        at(2),
        "the newest conversation is found by when something was last said in it"
    );

    store.apply_commands(0, turn).await.unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(
        reopened.moka.canvas[0], spoken.canvas[0],
        "what was said is what comes back off the disk"
    );

    let (taken_back, _) = apply_commands(&spoken, &inverse).unwrap();
    assert_eq!(
        taken_back.canvas[0], opened.moka.canvas[0],
        "and taking it back leaves the canvas as it was, conversations and all"
    );
}

#[tokio::test]
async fn the_oldest_lines_go_at_the_ceiling_and_come_back_on_undo() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let opened = store.current().await.unwrap().unwrap();
    let canvas_id = opened.moka.canvas[0].id.clone();

    let mut filled = conversation("A long one");
    for index in 0..MAX_ASSISTANT_MESSAGES_PER_SESSION {
        let second = u32::try_from(index + 1).unwrap();
        filled.messages.push(line(
            AssistantRole::User,
            &format!("Line {}", index + 1),
            second,
        ));
    }
    let (full, _) = apply_commands(
        &opened.moka,
        &[DocumentCommand::AddSession {
            canvas_id: canvas_id.clone(),
            session: filled,
            index: None,
        }],
    )
    .unwrap();

    let one_more = line(
        AssistantRole::User,
        "One more",
        u32::try_from(MAX_ASSISTANT_MESSAGES_PER_SESSION + 1).unwrap(),
    );
    let (trimmed, inverse) = apply_commands(
        &full,
        &[DocumentCommand::AppendMessages {
            canvas_id,
            session_id: full.canvas[0].sessions.as_ref().unwrap()[0].id.clone(),
            messages: vec![one_more],
            at: None,
        }],
    )
    .unwrap();

    let messages = &trimmed.canvas[0].sessions.as_ref().unwrap()[0].messages;
    assert_eq!(
        messages.len(),
        MAX_ASSISTANT_MESSAGES_PER_SESSION,
        "a conversation is kept to a length that can be read through"
    );
    assert_eq!(
        messages[0].text, "Line 2",
        "and the oldest line is the one that goes"
    );
    assert_eq!(messages.last().unwrap().text, "One more");

    let (given_back, _) = apply_commands(&trimmed, &inverse).unwrap();
    assert_eq!(
        held(&given_back.canvas[0]),
        held(&full.canvas[0]),
        "each line comes back to the place it held"
    );
}

#[tokio::test]
async fn a_conversation_nobody_had_is_not_there_to_say_something_in() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let opened = store.current().await.unwrap().unwrap();
    let canvas_id = opened.moka.canvas[0].id.clone();
    let session = conversation("Asked and answered");
    let (spoken, _) = apply_commands(
        &opened.moka,
        &[DocumentCommand::AddSession {
            canvas_id: canvas_id.clone(),
            session: session.clone(),
            index: None,
        }],
    )
    .unwrap();

    let refused = |command: DocumentCommand| -> &'static str {
        apply_commands(&spoken, &[command]).unwrap_err().code
    };
    assert_eq!(
        refused(DocumentCommand::AppendMessages {
            canvas_id: canvas_id.clone(),
            session_id: new_id(),
            messages: vec![line(AssistantRole::User, "Anything?", 1)],
            at: None,
        }),
        "SESSION_NOT_FOUND"
    );
    assert_eq!(
        refused(DocumentCommand::RemoveMessages {
            canvas_id: canvas_id.clone(),
            session_id: session.id.clone(),
            message_ids: vec![new_id()],
        }),
        "MESSAGE_NOT_FOUND"
    );
    assert_eq!(
        refused(DocumentCommand::AppendMessages {
            canvas_id: canvas_id.clone(),
            session_id: session.id.clone(),
            messages: Vec::new(),
            at: None,
        }),
        "VALIDATION_FAILED"
    );
    assert_eq!(
        refused(DocumentCommand::AddSession {
            canvas_id,
            session,
            index: None,
        }),
        "CONFLICT"
    );
}

/// Generates a deterministic 64x64 PNG without external fixtures.
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
