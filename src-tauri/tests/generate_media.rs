//! Loading reference media for a generation, against a project on disk.
//!
//! The rules themselves are unit-tested beside the code; what needs a real
//! store is the part that touches the project: which asset is read, what
//! happens when one is missing, and what a caller is handed back.

use std::path::Path;
use std::sync::Arc;

use moka_canvas::config::{parse_test_config, GenerateConfig};
use moka_canvas::domain::Capability;
use moka_canvas::generate::media::{load_inputs, AudioWindow};
use moka_canvas::generate::{GenerateInput, GenerateRequest, InputRole};
use moka_canvas::project::store::{FsProjectStore, ProjectRegistry};
use moka_canvas::project::{CreateProject, ProjectStore, StagedAsset};
use tempfile::TempDir;

async fn open_project(tmp: &TempDir) -> (Arc<FsProjectStore>, std::path::PathBuf) {
    let config = Arc::new(parse_test_config(tmp.path()));
    let registry = ProjectRegistry::new(config);
    let root = tmp.path().join("demo-project");
    let (store, _opened) = registry
        .create_project(
            &root,
            CreateProject {
                name: "Demo".into(),
                first_canvas_name: None,
            },
        )
        .await
        .expect("the project scaffolds");
    (store, root)
}

/// Stores bytes the way an upload would and returns the asset's identifier.
async fn upload(
    store: &FsProjectStore,
    root: &Path,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> String {
    let staging = root.join("tmp").join(format!("staged-{name}"));
    std::fs::write(&staging, bytes).expect("the staging directory exists");
    store
        .add_asset(StagedAsset {
            name: name.into(),
            tmp_path: staging,
            declared_mime: Some(mime.into()),
            category_hint: None,
            provenance: None,
        })
        .await
        .expect("the asset is accepted")
        .entry
        .id
}

fn encoded(format: image::ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([40, 90, 160]),
    ))
    .write_to(&mut std::io::Cursor::new(&mut bytes), format)
    .expect("the format encodes");
    bytes
}

fn request_for(inputs: Vec<GenerateInput>) -> GenerateRequest {
    GenerateRequest {
        capability: Capability::Image,
        prompt: "a lantern over a lake".into(),
        inputs,
        ..GenerateRequest::default()
    }
}

fn reference(asset_id: &str, role: InputRole) -> GenerateInput {
    GenerateInput {
        role,
        asset_id: asset_id.into(),
        window: None,
    }
}

#[tokio::test]
async fn references_come_back_in_the_order_the_request_names_them() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    let poster = encoded(image::ImageFormat::Png, 2, 2);
    let mask = encoded(image::ImageFormat::Png, 3, 1);
    let poster_id = upload(&store, &root, "poster.png", "image/png", &poster).await;
    let mask_id = upload(&store, &root, "mask.png", "image/png", &mask).await;

    let request = request_for(vec![
        reference(&mask_id, InputRole::Mask),
        reference(&poster_id, InputRole::Reference),
    ]);
    let loaded = load_inputs(store.as_ref(), &request, &GenerateConfig::default(), None)
        .await
        .expect("both assets are in the project");

    // The request's own order, because an adapter relies on position where a
    // role does not tell two inputs apart.
    let ids: Vec<&str> = loaded.iter().map(|input| input.asset_id.as_str()).collect();
    assert_eq!(ids, [mask_id.as_str(), poster_id.as_str()]);
    assert_eq!(loaded[0].role, InputRole::Mask);
    assert_eq!(loaded[0].mime, "image/png");
    assert_eq!(loaded[0].bytes, mask);
    // The display name, which is what a multipart filename is built from; the
    // location on disk stays inside the store.
    assert_eq!(loaded[0].name, "mask.png");
    assert_eq!(loaded[1].bytes, poster);
}

#[tokio::test]
async fn a_format_a_provider_cannot_read_is_converted_on_the_way_out() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    let tiff = encoded(image::ImageFormat::Tiff, 4, 3);
    let asset_id = upload(&store, &root, "scan.tiff", "image/tiff", &tiff).await;

    let request = request_for(vec![reference(&asset_id, InputRole::Reference)]);
    let loaded = load_inputs(store.as_ref(), &request, &GenerateConfig::default(), None)
        .await
        .expect("the asset is in the project");
    assert_eq!(loaded[0].mime, "image/png");
    assert_ne!(loaded[0].bytes, tiff);
}

#[tokio::test]
async fn an_oversized_reference_is_refused_by_the_ceiling_for_its_family() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    let poster = encoded(image::ImageFormat::Png, 8, 8);
    let asset_id = upload(&store, &root, "poster.png", "image/png", &poster).await;

    let budgets = GenerateConfig {
        max_image_input_bytes: 4,
        ..GenerateConfig::default()
    };
    let request = request_for(vec![reference(&asset_id, InputRole::Reference)]);
    let error = load_inputs(store.as_ref(), &request, &budgets, None)
        .await
        .expect_err("four bytes of ceiling cannot hold a png");
    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(error.to_string().contains("poster.png"), "{error}");
}

#[tokio::test]
async fn a_reference_that_is_not_in_the_project_keeps_the_storage_code() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = open_project(&tmp).await;
    let request = request_for(vec![reference(
        "asset-that-was-never-added",
        InputRole::Mask,
    )]);
    let error = load_inputs(store.as_ref(), &request, &GenerateConfig::default(), None)
        .await
        .expect_err("nothing is registered under that identifier");
    assert_eq!(error.code(), "NOT_FOUND");
}

#[tokio::test]
async fn a_reference_with_no_project_open_is_not_a_provider_failure() {
    let tmp = TempDir::new().unwrap();
    let store = Arc::new(FsProjectStore::new(Arc::new(parse_test_config(tmp.path()))));
    let request = request_for(vec![reference("asset-1", InputRole::Reference)]);
    let error = load_inputs(store.as_ref(), &request, &GenerateConfig::default(), None)
        .await
        .expect_err("no project is open");
    // The code every other route gives for this, so a client reacts the same
    // way it does to a failed save.
    assert_eq!(error.code(), "PROJECT_NOT_OPEN");
}

/// A stand-in for the cutting room, so the window rules can be read without a
/// renderer on the machine: what it was asked for, and what it hands back.
struct StandIn {
    /// Where the file each window was cut from lives, which a test asserts on.
    sources: std::sync::Mutex<Vec<std::path::PathBuf>>,
    asked: std::sync::Mutex<Vec<moka_canvas::generate::InputWindow>>,
    answer: Vec<u8>,
}

impl StandIn {
    fn answering(bytes: &[u8]) -> Self {
        Self {
            sources: std::sync::Mutex::new(Vec::new()),
            asked: std::sync::Mutex::new(Vec::new()),
            answer: bytes.to_vec(),
        }
    }
}

#[async_trait::async_trait]
impl moka_canvas::generate::media::AudioWindow for StandIn {
    async fn cut(
        &self,
        source: &Path,
        window: moka_canvas::generate::InputWindow,
    ) -> Result<(Vec<u8>, String), moka_canvas::generate::ProviderError> {
        self.sources
            .lock()
            .expect("not poisoned")
            .push(source.to_path_buf());
        self.asked.lock().expect("not poisoned").push(window);
        Ok((self.answer.clone(), "audio/wav".to_string()))
    }
}

/// A window is what travels: the cut bytes rather than the file's, the name
/// the clip was cut from, and the time span the caller asked for — measured
/// from the beginning of the file, so a recognizer's answer lands on the clip.
#[tokio::test]
async fn a_window_travels_as_the_cut_rather_than_the_whole_file() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    // A file far over any ceiling for a reference: what is bounded is the cut.
    let long = vec![7u8; 4_000];
    let asset_id = upload(&store, &root, "take-1.wav", "audio/wav", &long).await;

    let cutter = StandIn::answering(b"a-minute-of-it");
    let request = GenerateRequest {
        capability: Capability::Asr,
        inputs: vec![GenerateInput {
            role: InputRole::ControlAudio,
            asset_id: asset_id.clone(),
            window: Some(moka_canvas::generate::InputWindow {
                start_ms: 1_500,
                duration_ms: 30_000,
            }),
        }],
        ..GenerateRequest::default()
    };
    // The file is thousands of bytes and the ceiling is twenty, because what
    // is bounded is the cut rather than the file it came out of.
    let budgets = GenerateConfig {
        max_media_input_bytes: 20,
        ..GenerateConfig::default()
    };
    let loaded = load_inputs(store.as_ref(), &request, &budgets, Some(&cutter))
        .await
        .expect("the cut is small enough where the file is not");
    assert_eq!(
        cutter.asked.lock().expect("not poisoned").as_slice(),
        &[moka_canvas::generate::InputWindow {
            start_ms: 1_500,
            duration_ms: 30_000,
        }],
        "the window the caller asked for is the window that was cut"
    );
    assert_eq!(loaded[0].bytes, b"a-minute-of-it");
    assert_eq!(loaded[0].mime, "audio/wav");
    // The name is the file the window was cut from, with the extension the
    // bytes actually are — not the extension the file happens to have.
    assert_eq!(loaded[0].filename(), "take-1.wav");
    // The file on disk the clip was cut from, which is what a renderer is
    // pointed at: the location of a file never crosses this boundary.
    let wanted = store
        .asset_file(&asset_id, None)
        .await
        .expect("the recording is in the project")
        .path;
    let sources = cutter.sources.lock().expect("not poisoned").clone();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0], wanted);
}

/// A window with nothing here to cut it is refused in words a reader can act
/// on, rather than by sending the whole file and hoping.
#[tokio::test]
async fn a_window_with_no_cutter_is_refused_rather_than_guessed_at() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    let asset_id = upload(&store, &root, "take-1.wav", "audio/wav", &[7u8; 64]).await;

    let request = GenerateRequest {
        capability: Capability::Asr,
        inputs: vec![GenerateInput {
            role: InputRole::ControlAudio,
            asset_id,
            window: Some(moka_canvas::generate::InputWindow {
                start_ms: 0,
                duration_ms: 1_000,
            }),
        }],
        ..GenerateRequest::default()
    };
    let error = load_inputs(store.as_ref(), &request, &GenerateConfig::default(), None)
        .await
        .expect_err("nothing can cut that window");
    assert!(error.to_string().contains("take-1.wav"), "{error}");
}

/// The ffmpeg this machine has, by the same search the server makes: the
/// environment first, then the search path. None is a machine that cannot cut,
/// which is what the case below skips on.
fn machine_ffmpeg() -> Option<Arc<moka_canvas::clip::locate::CapabilityProbe>> {
    use moka_canvas::clip::locate::{locate, probe};
    let program = locate(
        None,
        std::env::var_os("MOKA_FFMPEG")
            .map(std::path::PathBuf::from)
            .as_deref(),
        std::env::var_os("PATH").as_deref(),
    )?;
    probe(&program).available.then(|| {
        Arc::new(moka_canvas::clip::locate::CapabilityProbe::new(
            &moka_canvas::config::ClipConfig::default(),
        ))
    })
}

/// The shape of a RIFF file's own header: what it holds and how long it runs,
/// without decoding a sample of it.
fn wav_shape(bytes: &[u8]) -> (u16, u32, u32, u32) {
    assert!(
        bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE",
        "not a wav"
    );
    let mut at = 12;
    let (mut channels, mut rate, mut byte_rate) = (0, 0, 0);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().expect("four bytes"));
        if id == b"fmt " {
            channels = u16::from_le_bytes(bytes[at + 10..at + 12].try_into().expect("two"));
            rate = u32::from_le_bytes(bytes[at + 12..at + 16].try_into().expect("four"));
            byte_rate = u32::from_le_bytes(bytes[at + 16..at + 20].try_into().expect("four"));
        }
        if id == b"data" {
            return (channels, rate, byte_rate, size);
        }
        at += 8 + size as usize + (size as usize % 2);
    }
    panic!("no data chunk in {} bytes", bytes.len());
}

/// The window is cut out of a real recording, and comes back as the mono
/// 16 kHz the transcription endpoints want: a recognizer answers about the
/// audio it was sent, so both ends of that audio have to be an ask's own.
#[tokio::test]
async fn a_window_of_a_real_recording_comes_back_as_mono_sixteen_kilohertz() {
    let Some(probe) = machine_ffmpeg() else {
        eprintln!("skipped: this machine has no usable ffmpeg");
        return;
    };
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("tone.wav");
    // Three seconds of a tone, made by the machine's own renderer, so the file
    // is one a reader could play rather than bytes a test invented.
    let made = std::process::Command::new(probe.program().expect("a probed program"))
        .args([
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-y",
        ])
        .arg(&source)
        .output()
        .expect("the renderer runs");
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );

    let cutter = moka_canvas::clip::audio::Windows::new(probe);
    let (bytes, mime) = cutter
        .cut(
            &source,
            moka_canvas::generate::InputWindow {
                start_ms: 1_000,
                duration_ms: 1_000,
            },
        )
        .await
        .expect("the window is cut");
    assert_eq!(mime, "audio/wav");
    let (channels, rate, byte_rate, data) = wav_shape(&bytes);
    assert_eq!(channels, 1);
    assert_eq!(rate, 16_000);
    assert_eq!(byte_rate, 32_000);
    let duration_ms = f64::from(data) / f64::from(byte_rate) * 1_000.0;
    assert!(
        (duration_ms - 1_000.0).abs() < 50.0,
        "a second was asked for and {duration_ms} ms came back"
    );
    // The file in the project is untouched: what travels is the cut.
    assert!(
        std::fs::metadata(&source)
            .expect("the source is still there")
            .len()
            > bytes.len() as u64
    );
}
