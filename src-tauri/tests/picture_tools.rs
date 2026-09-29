//! The tools that work on a picture the project already holds, asked through the
//! same store the route reaches them by.
//!
//! What is under test here is not the arithmetic — that is covered where the
//! arithmetic lives — but what a tool does to a project: that it files beside
//! what it was given, that it says where the result came from, and that a tool
//! which cannot finish leaves nothing behind.

use moka_canvas::assets::new_tmp_path;
use moka_canvas::config::parse_test_config;
use moka_canvas::domain::{DocumentCommand, ResourceEntry, RunRecord};
use moka_canvas::imaging::{operate, Operator, OperatorRequest};
use moka_canvas::project::store::FsProjectStore;
use moka_canvas::project::{
    AssetChange, AssetFile, AssetShelfEdit, ByteRange, CreateProject, FiledAsset, OpenProject,
    PackageReport, PackageScope, ProjectError, ProjectStore, SaveResult, StagedAsset,
};
use moka_canvas::story::StoryJobRecord;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tempfile::TempDir;

async fn opened_project(tmp: &TempDir) -> (FsProjectStore, PathBuf) {
    let config = Arc::new(parse_test_config(tmp.path()));
    let store = FsProjectStore::new(config);
    let root = tmp.path().join("studio");
    store
        .create_project(
            &root,
            CreateProject {
                name: "Studio".into(),
                first_canvas_name: None,
            },
        )
        .await
        .unwrap();
    (store, root)
}

/// A picture with something in it, so a cut of it can be told from a cut of any
/// other.
fn sheet(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = image::RgbaImage::new(width, height);
    for (x, y, pixel) in pixels.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x % 251) as u8, (y % 199) as u8, ((x + y) % 151) as u8, 255]);
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(pixels)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

/// Minimal but well-formed 1s stereo 44.1kHz PCM WAVE: a subject with no
/// picture in it at all.
fn speech() -> Vec<u8> {
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

/// A photograph, in the container photographs arrive in.
fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let mut pixels = image::RgbImage::new(width, height);
    for (x, y, pixel) in pixels.enumerate_pixels_mut() {
        *pixel = image::Rgb([(x % 251) as u8, (y % 199) as u8, 128]);
    }
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut std::io::Cursor::new(&mut bytes), 92)
        .encode_image(&pixels)
        .unwrap();
    bytes
}

/// A file that promises pixels in its header and has none behind them.
///
/// Enough for a reader that only looks at the size, and not enough for one that
/// wants the picture — which is what makes it a test of which of the two a
/// refusal came from.
fn promised_only(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"BM");
    bytes.extend_from_slice(&54u32.to_le_bytes()); // how much file there is
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&54u32.to_le_bytes()); // where the pixels would start
    bytes.extend_from_slice(&40u32.to_le_bytes()); // how much header is left
    bytes.extend_from_slice(&(width as i32).to_le_bytes());
    bytes.extend_from_slice(&(height as i32).to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // one plane
    bytes.extend_from_slice(&24u16.to_le_bytes()); // bits in a pixel
    bytes.extend_from_slice(&0u32.to_le_bytes()); // uncompressed
    bytes.extend_from_slice(&0u32.to_le_bytes()); // how many pixels: unstated
    for _ in 0..4 {
        bytes.extend_from_slice(&0u32.to_le_bytes()); // fields nobody reads
    }
    bytes
}

async fn filed(
    store: &dyn ProjectStore,
    root: &Path,
    name: &str,
    bytes: Vec<u8>,
    mime: &str,
) -> ResourceEntry {
    let tmp_path = new_tmp_path(root).unwrap();
    std::fs::write(&tmp_path, &bytes).unwrap();
    store
        .add_asset(StagedAsset {
            name: name.into(),
            tmp_path,
            declared_mime: Some(mime.into()),
            category_hint: None,
            provenance: None,
        })
        .await
        .unwrap()
        .entry
}

/// Everything the project has registered, across all five categories.
async fn registered(store: &dyn ProjectStore) -> Vec<ResourceEntry> {
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

/// Files left waiting in the project's own scratch directory, which is where a
/// tool that gave up part-way through would leave them.
fn leftovers(root: &Path) -> usize {
    std::fs::read_dir(root.join("tmp"))
        .map(|entries| entries.count())
        .unwrap_or(0)
}

fn cut(subject: &str) -> OperatorRequest {
    OperatorRequest {
        tool: Operator::Crop,
        asset_id: subject.into(),
        params: json!({ "region": { "x": 8, "y": 4, "width": 20, "height": 10 } }),
    }
}

#[tokio::test]
async fn a_cut_is_filed_beside_its_subject_and_the_subject_is_untouched() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    let subject = filed(&store, &root, "harvest.png", sheet(64, 48), "image/png").await;
    let before = std::fs::read(root.join(&subject.path)).unwrap();

    let report = operate(&store, cut(&subject.id)).await.unwrap();

    assert_eq!(report.entries.len(), 1);
    let made = &report.entries[0];
    assert_eq!(made.name, "harvest-20x10.png");
    assert!(made.path.starts_with("assets/images/"), "{}", made.path);
    assert_ne!(made.path, subject.path, "filed beside, not in place of");
    assert!(root.join(&made.path).is_file());
    let probe = made.probe.as_ref().expect("a picture is measured");
    assert_eq!((probe.width, probe.height), (Some(20), Some(10)));
    assert!(report.revision > 0, "the document moved on");
    assert!(!report.updated_at.is_empty());
    assert!(
        report.prompt.is_none(),
        "a cut has nothing to say for itself"
    );
    assert_eq!(leftovers(&root), 0);

    // The subject is still there and still itself: nothing was written over it.
    let entries = registered(&store).await;
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| entry.id == subject.id));
    assert_eq!(std::fs::read(root.join(&subject.path)).unwrap(), before);

    // And the two of them are still both there once the document is read back
    // from disk rather than held in memory.
    store.open_project(&root).await.unwrap();
    assert_eq!(registered(&store).await.len(), 2);
}

#[tokio::test]
async fn the_record_says_what_was_done_to_what_and_by_nobody() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    let subject = filed(&store, &root, "harvest.png", sheet(64, 48), "image/png").await;

    let report = operate(&store, cut(&subject.id)).await.unwrap();
    let made = &report.entries[0];
    let record = made.provenance.as_ref().expect("where it came from");

    // Nothing was asked of anybody, so there is no run to point at and no node
    // that made it: the record names the tool and the picture instead, which is
    // all a reader needs to know how this came to be here.
    assert_eq!(record.run_id, None);
    assert_eq!(record.canvas_id, None);
    assert_eq!(record.operation_node_id, None);
    assert_eq!(
        record.input_asset_ids.as_deref(),
        Some([subject.id.clone()].as_slice())
    );

    let snapshot = record.parameter_snapshot.as_ref().expect("what was asked");
    assert_eq!(snapshot["tool"], json!("crop"));
    assert_eq!(snapshot["sourceAssetId"], json!(subject.id));
    assert_eq!(snapshot["region"]["width"], json!(20));
    let mut fields: Vec<&String> = snapshot.as_object().unwrap().keys().collect();
    fields.sort();
    assert_eq!(fields, vec!["region", "sourceAssetId", "tool"]);

    // The record is written into the document, so a project handed to somebody
    // else still says how each of its pictures was made.
    store.open_project(&root).await.unwrap();
    let reopened = registered(&store).await;
    let kept = reopened
        .iter()
        .find(|entry| entry.id == made.id)
        .expect("the result survived the round trip")
        .provenance
        .as_ref()
        .expect("and its record with it");
    assert_eq!(kept.parameter_snapshot, record.parameter_snapshot);
    assert_eq!(kept.input_asset_ids, record.input_asset_ids);
}

#[tokio::test]
async fn a_division_files_every_piece_in_reading_order() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    let subject = filed(&store, &root, "harvest.png", sheet(64, 48), "image/png").await;

    let report = operate(
        &store,
        OperatorRequest {
            tool: Operator::Split,
            asset_id: subject.id.clone(),
            params: json!({ "rows": 2, "cols": 2 }),
        },
    )
    .await
    .unwrap();

    let names: Vec<&str> = report
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "harvest-2-2-1-1.png",
            "harvest-2-2-1-2.png",
            "harvest-2-2-2-1.png",
            "harvest-2-2-2-2.png"
        ]
    );
    assert_eq!(
        files_in(&root, "images"),
        5,
        "the subject and its four pieces"
    );
    assert!(
        report.entries.iter().all(|entry| entry
            .provenance
            .as_ref()
            .is_some_and(|record| record.parameter_snapshot.is_some())),
        "each piece says it came from the same division"
    );
    assert_eq!(leftovers(&root), 0);
}

/// A store that lets the first piece through and refuses the rest, the way a
/// disk that runs out of room part-way through a division would.
struct RefusesAfter {
    inner: FsProjectStore,
    seen: AtomicUsize,
    let_through: usize,
}

#[async_trait::async_trait]
impl ProjectStore for RefusesAfter {
    async fn add_asset(&self, staged: StagedAsset) -> Result<AssetChange, ProjectError> {
        if self.seen.fetch_add(1, Ordering::SeqCst) >= self.let_through {
            let _ = std::fs::remove_file(&staged.tmp_path);
            return Err(ProjectError::domain(
                "INTERNAL",
                "the disk would not take it",
            ));
        }
        self.inner.add_asset(staged).await
    }

    async fn create_project(
        &self,
        root: &Path,
        input: CreateProject,
    ) -> Result<OpenProject, ProjectError> {
        self.inner.create_project(root, input).await
    }
    async fn open_project(&self, entry: &Path) -> Result<OpenProject, ProjectError> {
        self.inner.open_project(entry).await
    }
    async fn current(&self) -> Result<Option<OpenProject>, ProjectError> {
        self.inner.current().await
    }
    async fn project_root(&self) -> Result<std::path::PathBuf, ProjectError> {
        self.inner.project_root().await
    }
    async fn self_check_status(
        &self,
    ) -> Result<Option<(moka_canvas::domain::SelfCheckReport, bool)>, ProjectError> {
        self.inner.self_check_status().await
    }
    async fn apply_commands(
        &self,
        expected_revision: i32,
        commands: Vec<DocumentCommand>,
    ) -> Result<SaveResult, ProjectError> {
        self.inner.apply_commands(expected_revision, commands).await
    }
    async fn remove_asset(&self, id: &str) -> Result<SaveResult, ProjectError> {
        self.inner.remove_asset(id).await
    }
    async fn replace_asset_bytes(
        &self,
        id: &str,
        staged: StagedAsset,
    ) -> Result<AssetChange, ProjectError> {
        self.inner.replace_asset_bytes(id, staged).await
    }
    async fn update_asset_shelf(
        &self,
        id: &str,
        edit: AssetShelfEdit,
    ) -> Result<AssetChange, ProjectError> {
        self.inner.update_asset_shelf(id, edit).await
    }
    async fn file_node_as_asset(
        &self,
        canvas_id: &str,
        node_id: &str,
    ) -> Result<FiledAsset, ProjectError> {
        self.inner.file_node_as_asset(canvas_id, node_id).await
    }
    async fn asset_file(
        &self,
        id: &str,
        range: Option<ByteRange>,
    ) -> Result<AssetFile, ProjectError> {
        self.inner.asset_file(id, range).await
    }
    async fn export_package(
        &self,
        destination: &Path,
        allow_incomplete: bool,
        scope: PackageScope,
    ) -> Result<PackageReport, ProjectError> {
        self.inner
            .export_package(destination, allow_incomplete, scope)
            .await
    }
    async fn import_package(
        &self,
        archive: &Path,
        target_root: &Path,
    ) -> Result<OpenProject, ProjectError> {
        self.inner.import_package(archive, target_root).await
    }
    async fn list_runs(&self) -> Result<Vec<RunRecord>, ProjectError> {
        self.inner.list_runs().await
    }
    async fn create_run(&self, run: RunRecord) -> Result<RunRecord, ProjectError> {
        self.inner.create_run(run).await
    }
    async fn get_run(&self, id: &str) -> Result<RunRecord, ProjectError> {
        self.inner.get_run(id).await
    }
    async fn update_run(&self, run: RunRecord) -> Result<RunRecord, ProjectError> {
        self.inner.update_run(run).await
    }
    async fn record_job(&self, id: &str, record: serde_json::Value) -> Result<(), ProjectError> {
        self.inner.record_job(id, record).await
    }
    async fn drop_job(&self, id: &str) -> Result<(), ProjectError> {
        self.inner.drop_job(id).await
    }
    async fn job(&self, id: &str) -> Result<Option<serde_json::Value>, ProjectError> {
        self.inner.job(id).await
    }
    async fn list_story_jobs(&self) -> Result<Vec<StoryJobRecord>, ProjectError> {
        self.inner.list_story_jobs().await
    }
    async fn create_story_job(&self, job: StoryJobRecord) -> Result<StoryJobRecord, ProjectError> {
        self.inner.create_story_job(job).await
    }
    async fn get_story_job(&self, id: &str) -> Result<StoryJobRecord, ProjectError> {
        self.inner.get_story_job(id).await
    }
    async fn update_story_job(&self, job: StoryJobRecord) -> Result<StoryJobRecord, ProjectError> {
        self.inner.update_story_job(job).await
    }
}

#[tokio::test]
async fn a_division_that_cannot_be_filed_takes_back_the_piece_that_landed() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    let subject = filed(&store, &root, "harvest.png", sheet(64, 48), "image/png").await;
    let stubborn = RefusesAfter {
        inner: store,
        seen: AtomicUsize::new(0),
        let_through: 1,
    };

    let error = operate(
        &stubborn,
        OperatorRequest {
            tool: Operator::Split,
            asset_id: subject.id.clone(),
            params: json!({ "rows": 2, "cols": 2 }),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "INTERNAL");

    // A quarter of a picture sitting in the library on its own is worse than no
    // result at all: nothing points at it, and its name says it belongs to a
    // division that did not happen.
    let entries = registered(&stubborn).await;
    assert_eq!(entries.len(), 1, "the subject and nothing else");
    assert_eq!(entries[0].id, subject.id);
    assert_eq!(files_in(&root, "images"), 1);
    assert_eq!(
        leftovers(&root),
        0,
        "the pieces still waiting are dropped too"
    );
}

#[tokio::test]
async fn a_subject_with_no_picture_in_it_is_refused_before_anything_is_written() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    let spoken = filed(&store, &root, "narration.wav", speech(), "audio/wav").await;

    let error = operate(&store, cut(&spoken.id)).await.unwrap_err();
    assert_eq!(error.code(), "UNSUPPORTED_MEDIA_TYPE");
    assert!(
        error.to_string().contains("audio/"),
        "the refusal names the kind of thing it was given: {error}"
    );

    assert_eq!(registered(&store).await.len(), 1);
    assert_eq!(files_in(&root, "images"), 0);
    assert_eq!(leftovers(&root), 0);
}

#[tokio::test]
async fn a_subject_the_project_does_not_hold_is_said_to_be_missing() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;

    let error = operate(&store, cut("asset-nobody-has")).await.unwrap_err();
    assert_eq!(error.code(), "NOT_FOUND");
    assert_eq!(registered(&store).await.len(), 0);
    assert_eq!(leftovers(&root), 0);
}

#[tokio::test]
async fn a_picture_past_the_ceiling_is_refused_from_its_header_and_not_decoded() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    // There are no pixels behind this header at all, so a refusal that came from
    // trying to read them would be a different refusal.
    let promised = filed(
        &store,
        &root,
        "enormous.bmp",
        promised_only(8000, 6000),
        "image/bmp",
    )
    .await;
    // The library read the size off the header when it was filed, and there are
    // no pixels in this file at all to have read it from.
    let probe = promised.probe.as_ref().expect("a picture is measured");
    assert_eq!((probe.width, probe.height), (Some(8000), Some(6000)));

    let error = operate(&store, cut(&promised.id)).await.unwrap_err();
    assert_eq!(
        error.code(),
        "VALIDATION_FAILED",
        "refused for its size rather than for being unreadable: {error}"
    );
    assert!(error.to_string().contains("8000 by 6000"), "{error}");
    assert!(
        error.to_string().contains("make it smaller first"),
        "the refusal says what to do about it: {error}"
    );

    assert_eq!(registered(&store).await.len(), 1);
    assert_eq!(files_in(&root, "images"), 1);
    assert_eq!(leftovers(&root), 0);
}

#[tokio::test]
async fn a_turn_reports_the_words_it_was_made_from_and_keeps_its_size() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    let subject = filed(&store, &root, "harvest.png", sheet(64, 48), "image/png").await;

    let report = operate(
        &store,
        OperatorRequest {
            tool: Operator::Tilt,
            asset_id: subject.id.clone(),
            params: json!({ "yaw": 20.0 }),
        },
    )
    .await
    .unwrap();

    assert_eq!(report.entries.len(), 1);
    let made = &report.entries[0];
    assert_eq!(made.name, "harvest-turned-20cw.png");
    assert_eq!(
        made.mime.as_deref(),
        Some("image/png"),
        "the corners a turn leaves behind are see-through"
    );
    let probe = made.probe.as_ref().expect("a picture is measured");
    assert_eq!(
        (probe.width, probe.height),
        (Some(64), Some(48)),
        "a turn cannot be used to make a picture bigger than the one it came from"
    );
    let prompt = report.prompt.expect("a turn says what it is for");
    assert!(prompt.contains("turned 20° to the right"), "{prompt}");
    assert_eq!(files_in(&root, "images"), 2);
}

#[tokio::test]
async fn a_picture_that_arrived_lossy_is_filed_lossy_and_one_that_did_not_is_not() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = opened_project(&tmp).await;
    let photograph = filed(&store, &root, "field.jpg", jpeg(64, 48), "image/jpeg").await;

    let report = operate(&store, cut(&photograph.id)).await.unwrap();
    assert_eq!(report.entries[0].mime.as_deref(), Some("image/jpeg"));
    assert!(
        report.entries[0].path.ends_with(".jpg"),
        "{}",
        report.entries[0].path
    );

    let drawing = filed(&store, &root, "harvest.png", sheet(64, 48), "image/png").await;
    let report = operate(&store, cut(&drawing.id)).await.unwrap();
    assert_eq!(report.entries[0].mime.as_deref(), Some("image/png"));

    assert_eq!(files_in(&root, "images"), 4);
    assert_eq!(leftovers(&root), 0);
}
