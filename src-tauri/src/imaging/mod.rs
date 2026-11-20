//! Working on a picture the project already holds, without asking anybody.
//!
//! Cutting a region out, dividing a sheet, resampling and tilting are
//! arithmetic rather than generation: there is no model to choose, nothing to
//! pay for, and nothing that can answer differently tomorrow. Doing them here
//! means they still work in a project with no model configured, and that
//! asking twice gives the same picture twice.
//!
//! What these share with a generation is where the answer goes. It lands beside
//! its subject as a new asset, never in place of it, carrying a record of the
//! tool that made it, the parameters it was given, and the picture it was given
//! them for. A tool that overwrote what it worked on would leave nothing to try
//! again from, and a result that did not say where it came from could not be
//! checked against the thing it claims to come from.

use crate::assets::new_tmp_path;
use crate::domain::{now_iso, AssetId, AssetProvenance, ResourceEntry};
use crate::project::{ProjectError, ProjectStore, StagedAsset};
use crate::prompts::{render, Prompt, PromptError};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, Rgb, RgbImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

/// How many pixels one operator will read.
///
/// A picture is stored compressed and worked on uncompressed, so what a decode
/// costs is its area rather than its bytes: four bytes a pixel puts the ceiling
/// below at 160 MB, already far past any picture somebody means to crop.
/// Refusing before the decode is what keeps one from being the thing that runs
/// the process out of memory.
pub const MAX_OPERATED_PIXELS: u64 = 40_000_000;

/// How many pieces one division may make. A sheet cut finer than this is a
/// canvas full of nodes nobody can see individually, which is the point at which
/// the tool stops helping.
const MAX_DIVISIONS: u32 = 64;

/// How far a tilt may go, in degrees. Past this the far edge of the picture is
/// behind the viewer and there is nothing sensible left to sample.
const MAX_TILT_DEGREES: f64 = 60.0;

/// The quality a result is written at when its subject arrived lossy.
///
/// High rather than default, because these tools are used in sequence: a
/// picture cut and then resampled and then cut again would gather three rounds
/// of compression artefacts at the default, and the third would be visible.
const JPEG_QUALITY: u8 = 92;

/// The distance the viewer stands from the picture, in half-widths.
///
/// One number rather than a parameter: it decides how strongly the tilt
/// converges, and a control that only makes the picture look more or less
/// broken is not one a reader can use.
const VIEWER_DISTANCE: f64 = 3.0;

/// What a tool does to a picture.
///
/// Named for the work rather than for the control that asks for it, because the
/// same one can be asked for from a node, from a keyboard shortcut, and from a
/// test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operator {
    Crop,
    Split,
    Resize,
    Tilt,
}

impl Operator {
    /// What the record says made this picture, and what a reader is told.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Crop => "crop",
            Self::Split => "split",
            Self::Resize => "resize",
            Self::Tilt => "tilt",
        }
    }
}

/// One ask, naming a picture already in the project and what to do to it.
///
/// The subject is an asset id rather than bytes: the picture is on this disk
/// already, so sending it back through the loopback socket would cost a copy
/// and a size ceiling for nothing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorRequest {
    pub tool: Operator,
    pub asset_id: AssetId,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// A region in the subject's own pixels, from its top-left corner.
///
/// Pixels and not proportions on purpose: a node can be any size on the canvas
/// and still show one picture, so a rectangle measured against the node would
/// mean something different from the same rectangle measured against the
/// picture. Every tool works in the picture's coordinates and the dialog that
/// asks for them shows the picture's coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Region {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

/// What a resample is asked to fit into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum Target {
    /// A named size, which is a square the picture is fitted into. Named
    /// because "make it 2k" is what a reader says, and because the pixels
    /// behind the name are one decision rather than a number in six places.
    Named(NamedTarget),
    /// An exact box, for a picture that has to be a particular size.
    Boxed { width: u32, height: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NamedTarget {
    /// 2048 pixels on the long edge.
    K2,
    /// 4096 pixels on the long edge.
    K4,
}

impl NamedTarget {
    fn pixels(&self) -> u32 {
        match self {
            Self::K2 => 2048,
            Self::K4 => 4096,
        }
    }
}

/// What a resample does with the part of the picture the box does not hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Fitting {
    /// The whole picture, as large as the box allows. The result is the shape
    /// of the picture, not of the box.
    #[default]
    Contain,
    /// The whole box, from the middle of the picture. What overflows is cut.
    Cover,
    /// The whole box, whatever that does to the shape.
    Fill,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct CropAsk {
    /// An exact region. Wins over `ratio` when both arrive.
    region: Option<Region>,
    /// A proportion to cut the largest centred region of, as `"16:9"`.
    ratio: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SplitAsk {
    rows: u32,
    cols: u32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResizeAsk {
    target: Target,
    #[serde(default)]
    fit: Fitting,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct TiltAsk {
    /// Turn about the upright axis, degrees; positive swings the right edge away.
    yaw: f64,
    /// Tip about the level axis, degrees; positive tips the top edge away.
    pitch: f64,
}

/// One picture a tool made, before it is written anywhere.
#[derive(Debug)]
struct Piece {
    pixels: RgbaImage,
    /// The tail of the name, so several pieces from one sheet are told apart
    /// while sharing the subject's own name.
    suffix: String,
}

/// What an ask produced.
#[derive(Debug)]
struct Answer {
    pieces: Vec<Piece>,
    /// Words the picture wants beside it. A tilt is the one that has any: it
    /// makes a plate meant to be shown to a model along with a description of
    /// the shot, and the description is only true of the picture that was just
    /// made, so it is assembled here rather than left to the caller to guess.
    prompt: Option<String>,
    /// Whether the result may be written as JPEG. False when a piece carries
    /// transparency, which JPEG has nowhere to put it.
    lossy: bool,
}

/// What landed, and the document revision it landed at.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorReport {
    /// The new assets, in the order the tool made them: a division reads
    /// left-to-right then top-to-bottom, which is the order the nodes that show
    /// them are placed in.
    pub entries: Vec<ResourceEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub revision: i32,
    pub updated_at: String,
}

/// Does the work and files the results.
///
/// Either every piece is registered or none is, for the reason an ingest has
/// the same rule: half a division left in the library is nine pieces of clutter
/// with nothing to show for it.
pub async fn operate(
    store: &dyn ProjectStore,
    request: OperatorRequest,
) -> Result<OperatorReport, ProjectError> {
    let source = store.asset_file(&request.asset_id, None).await?;
    let mime = source.entry.mime.as_deref().unwrap_or_default();
    if !mime.starts_with("image/") {
        return Err(ProjectError::domain(
            "UNSUPPORTED_MEDIA_TYPE",
            format!("{mime} has no picture to work on"),
        ));
    }
    let picture = read_picture(&source.path, mime)?;
    let answer = apply(request.tool, &picture, mime, &request.params)?;
    if answer.pieces.is_empty() {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            "That produced nothing to keep",
        ));
    }

    let root = store
        .current()
        .await?
        .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        .root;
    let record = provenance(request.tool, &request.asset_id, &request.params);
    let stem = subject_stem(&source.entry.name);
    let encoding = if answer.lossy {
        Encoding::Lossy
    } else {
        Encoding::Lossless
    };

    let mut staged = Vec::with_capacity(answer.pieces.len());
    for piece in &answer.pieces {
        let tmp_path = new_tmp_path(&root)?;
        let bytes = encode(&piece.pixels, encoding)?;
        if let Err(error) = std::fs::write(&tmp_path, bytes) {
            let _ = std::fs::remove_file(&tmp_path);
            discard(&mut staged);
            return Err(error.into());
        }
        staged.push(StagedAsset {
            name: result_name(&stem, &piece.suffix, encoding),
            tmp_path,
            declared_mime: Some(encoding.mime().to_string()),
            category_hint: None,
            provenance: Some(record.clone()),
        });
    }

    let mut entries = Vec::with_capacity(staged.len());
    let mut revision = 0;
    let mut updated_at = String::new();
    while !staged.is_empty() {
        // The store takes the file it is handed, so the ones still waiting go
        // one at a time and stay reachable for cleanup until they do.
        match store.add_asset(staged.remove(0)).await {
            Ok(change) => {
                entries.push(change.entry);
                revision = change.revision;
                updated_at = change.updated_at;
            }
            Err(error) => {
                discard(&mut staged);
                for entry in entries.iter().rev() {
                    let _ = store.remove_asset(&entry.id).await;
                }
                return Err(error);
            }
        }
    }
    Ok(OperatorReport {
        entries,
        prompt: answer.prompt,
        revision,
        updated_at,
    })
}

/// Decodes the subject, refusing one that is bigger than the ceiling or that is
/// not a picture this build can read.
fn read_picture(path: &std::path::Path, mime: &str) -> Result<DynamicImage, ProjectError> {
    // Dimensions come out of the header, so the ceiling is checked before the
    // pixels are read rather than after.
    let reader = image::ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|error| {
            ProjectError::domain(
                "ASSET_INVALID",
                format!("The picture could not be read: {error}"),
            )
        })?;
    let (width, height) = reader.into_dimensions().map_err(|_| {
        ProjectError::domain(
            "ASSET_INVALID",
            format!("{mime} is stored in a format this build cannot read"),
        )
    })?;
    let area = u64::from(width) * u64::from(height);
    if area > MAX_OPERATED_PIXELS {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!(
                "The picture is {} by {}, which is more than the {} pixels these tools will work on; make it smaller first",
                width, height, MAX_OPERATED_PIXELS
            ),
        ));
    }
    image::open(path).map_err(|error| {
        ProjectError::domain(
            "ASSET_INVALID",
            format!("The picture could not be decoded: {error}"),
        )
    })
}

fn apply(
    tool: Operator,
    picture: &DynamicImage,
    mime: &str,
    params: &serde_json::Value,
) -> Result<Answer, ProjectError> {
    match tool {
        Operator::Crop => cut(picture, mime, parse::<CropAsk>(tool, params)?),
        Operator::Split => divide(picture, mime, parse::<SplitAsk>(tool, params)?),
        Operator::Resize => resample(picture, mime, parse::<ResizeAsk>(tool, params)?),
        Operator::Tilt => tilt(picture, parse::<TiltAsk>(tool, params)?),
    }
}

/// An ask that names a field this tool does not have is refused rather than
/// quietly worked with the field missing: the alternative is a tool that does
/// something else and calls it what was asked for.
fn parse<T: serde::de::DeserializeOwned>(
    tool: Operator,
    params: &serde_json::Value,
) -> Result<T, ProjectError> {
    if params.is_null() {
        return serde_json::from_value(serde_json::Value::Object(Default::default())).map_err(
            |error| {
                ProjectError::domain(
                    "VALIDATION_FAILED",
                    format!("{} needs its parameters: {error}", tool.label()),
                )
            },
        );
    }
    serde_json::from_value(params.clone()).map_err(|error| {
        ProjectError::domain(
            "VALIDATION_FAILED",
            format!(
                "{} was asked for something it cannot do: {error}",
                tool.label()
            ),
        )
    })
}

/// The largest region of one proportion that fits inside a box, centred.
///
/// A ratio on its own is half an ask — it says the shape of the cut and not
/// where it goes — and the middle is the one place a reader who said only that
/// is not surprised by.
fn centred(width: u32, height: u32, across: u32, down: u32) -> Region {
    // Compared cross-multiplied so that a picture too wide for the shape and
    // one too tall for it come out of the same two numbers.
    let (cut_width, cut_height) =
        if u64::from(width) * u64::from(down) >= u64::from(height) * u64::from(across) {
            (height * across / down, height)
        } else {
            (width, width * down / across)
        };
    Region {
        x: i64::from((width - cut_width) / 2),
        y: i64::from((height - cut_height) / 2),
        width: cut_width.max(1),
        height: cut_height.max(1),
    }
}

fn ratio_of(asked: &str) -> Result<(u32, u32), ProjectError> {
    let (across, down) = asked
        .split_once(':')
        .ok_or_else(|| bad_ratio(asked))
        .and_then(|(across, down)| {
            let across: u32 = across.trim().parse().map_err(|_| bad_ratio(asked))?;
            let down: u32 = down.trim().parse().map_err(|_| bad_ratio(asked))?;
            Ok((across, down))
        })?;
    if across == 0 || down == 0 {
        return Err(bad_ratio(asked));
    }
    Ok((across, down))
}

fn bad_ratio(asked: &str) -> ProjectError {
    ProjectError::domain(
        "VALIDATION_FAILED",
        format!("\"{asked}\" is not a proportion like 16:9"),
    )
}

/// Where a region actually lands once it is held inside the picture.
///
/// Held rather than refused when it overlaps: a cut that hangs a little off one
/// edge is a normal thing to ask for, and cutting the overhang away is what the
/// reader meant. One that misses the picture altogether is a different thing and
/// is refused, because holding it would produce a sliver of an edge and call it
/// the cut that was asked for.
fn held_inside(region: Region, width: u32, height: u32) -> Result<Region, ProjectError> {
    if region.width == 0 || region.height == 0 {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            "A region has a size on both sides",
        ));
    }
    let across = i64::from(width);
    let down = i64::from(height);
    let misses = region.x >= across
        || region.y >= down
        || region.x.saturating_add(i64::from(region.width)) <= 0
        || region.y.saturating_add(i64::from(region.height)) <= 0;
    if misses {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!("That region is outside the picture, which is {width} by {height}"),
        ));
    }
    let x = region.x.max(0);
    let y = region.y.max(0);
    Ok(Region {
        x,
        y,
        width: region.width.min(width - x as u32),
        height: region.height.min(height - y as u32),
    })
}

fn cut(picture: &DynamicImage, mime: &str, ask: CropAsk) -> Result<Answer, ProjectError> {
    let (width, height) = picture.dimensions();
    let wanted = match (ask.region, ask.ratio.as_deref()) {
        (Some(region), _) => held_inside(region, width, height)?,
        (None, Some(ratio)) => {
            let (across, down) = ratio_of(ratio)?;
            centred(width, height, across, down)
        }
        (None, None) => {
            return Err(ProjectError::domain(
                "VALIDATION_FAILED",
                "A cut needs either a region or a proportion",
            ))
        }
    };
    let pixels = picture
        .view(
            wanted.x as u32,
            wanted.y as u32,
            wanted.width,
            wanted.height,
        )
        .to_image();
    Ok(Answer {
        pieces: vec![Piece {
            pixels,
            suffix: format!("{}x{}", wanted.width, wanted.height),
        }],
        prompt: None,
        lossy: stays_lossy(mime),
    })
}

fn divide(picture: &DynamicImage, mime: &str, ask: SplitAsk) -> Result<Answer, ProjectError> {
    let (rows, cols) = (ask.rows, ask.cols);
    if rows == 0 || cols == 0 {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            "A sheet is divided into at least one row and one column",
        ));
    }
    if rows.saturating_mul(cols) > MAX_DIVISIONS {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!("{rows} by {cols} is more than the {MAX_DIVISIONS} pieces one division makes"),
        ));
    }
    let (width, height) = picture.dimensions();
    let mut pieces = Vec::with_capacity((rows * cols) as usize);
    for row in 0..rows {
        for col in 0..cols {
            // Taken from the whole rather than accumulated, so the pieces differ
            // by at most a pixel and the last one always ends on the edge.
            let left = width * col / cols;
            let right = width * (col + 1) / cols;
            let top = height * row / rows;
            let bottom = height * (row + 1) / rows;
            pieces.push(Piece {
                pixels: picture
                    .view(left, top, right - left, bottom - top)
                    .to_image(),
                suffix: format!("{}-{}-{}-{}", rows, cols, row + 1, col + 1),
            });
        }
    }
    Ok(Answer {
        pieces,
        prompt: None,
        lossy: stays_lossy(mime),
    })
}

fn resample(picture: &DynamicImage, mime: &str, ask: ResizeAsk) -> Result<Answer, ProjectError> {
    let (width, height) = picture.dimensions();
    if width == 0 || height == 0 {
        return Err(ProjectError::domain(
            "ASSET_INVALID",
            "The picture has no pixels to resample",
        ));
    }
    let (box_width, box_height) = match ask.target {
        Target::Named(named) => (named.pixels(), named.pixels()),
        Target::Boxed { width, height } => {
            if width == 0 || height == 0 {
                return Err(ProjectError::domain(
                    "VALIDATION_FAILED",
                    "A box to fit into has a size on both sides",
                ));
            }
            (width, height)
        }
    };
    let across = f64::from(box_width) / f64::from(width);
    let down = f64::from(box_height) / f64::from(height);
    let scale = match ask.fit {
        Fitting::Contain => across.min(down),
        Fitting::Cover => across.max(down),
        Fitting::Fill => 1.0,
    };
    let (drawn_width, drawn_height) = match ask.fit {
        Fitting::Fill => (box_width, box_height),
        _ => (scaled(width, scale), scaled(height, scale)),
    };
    guard_area(drawn_width, drawn_height)?;

    let filter = if scale >= 1.0 {
        // Growing a picture invents detail either way; the cheaper filter is
        // the one that does not also invent ringing around every edge.
        FilterType::Triangle
    } else {
        FilterType::Lanczos3
    };
    let mut pixels = image::imageops::resize(picture, drawn_width, drawn_height, filter);
    if ask.fit == Fitting::Cover {
        let left = drawn_width.saturating_sub(box_width) / 2;
        let top = drawn_height.saturating_sub(box_height) / 2;
        pixels = pixels
            .view(
                left,
                top,
                box_width.min(drawn_width - left),
                box_height.min(drawn_height - top),
            )
            .to_image();
    }
    let suffix = format!("{}x{}", pixels.width(), pixels.height());
    Ok(Answer {
        pieces: vec![Piece { pixels, suffix }],
        prompt: None,
        // Resampling throws detail away whatever the container does, so a
        // picture that arrived lossy stays lossy and one that did not is not
        // made so on the way through.
        lossy: stays_lossy(mime),
    })
}

/// A scaled length, never zero: a picture scaled down far enough to round away
/// still has to be one pixel of something, or the encoder is handed an empty
/// buffer and the reader is told their resample succeeded with nothing in it.
fn scaled(length: u32, scale: f64) -> u32 {
    ((f64::from(length) * scale).round() as u32).max(1)
}

fn guard_area(width: u32, height: u32) -> Result<(), ProjectError> {
    if u64::from(width) * u64::from(height) > MAX_OPERATED_PIXELS {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!(
                "That would be {width} by {height}, more than the {} pixels these tools will make",
                MAX_OPERATED_PIXELS
            ),
        ));
    }
    Ok(())
}

/// Turns and tips the picture, on a plate the same size as it arrived.
///
/// The plate keeps the subject's own dimensions so that a tilt cannot become a
/// way of asking for a picture larger than the ceiling: the turned shape is
/// fitted inside what was already allowed. What falls outside the turned shape
/// is left see-through, which is the point — a tilt is a plate to show a model
/// beside the original, and a filled-in corner would be read as part of the
/// subject.
fn tilt(picture: &DynamicImage, ask: TiltAsk) -> Result<Answer, ProjectError> {
    let (width, height) = picture.dimensions();
    if width < 2 || height < 2 {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            "A picture one pixel across has no angle to it",
        ));
    }
    let yaw = clamp_angle(ask.yaw, "turn")?;
    let pitch = clamp_angle(ask.pitch, "tip")?;
    if yaw == 0.0 && pitch == 0.0 {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            "Nothing was asked to turn, so there is nothing to make",
        ));
    }

    let turn = yaw.to_radians();
    let tip = pitch.to_radians();
    // Where each pixel of the subject lands once it is turned, as a matrix
    // rather than a loop: turning a plane is one homography, so the whole
    // picture is four numbers applied to every pixel.
    let forward = turn_matrix(width, height, turn, tip);
    let corners = [
        (0.0, 0.0),
        (f64::from(width), 0.0),
        (0.0, f64::from(height)),
        (f64::from(width), f64::from(height)),
    ]
    .map(|(x, y)| project(&forward, x, y));
    let (least_x, most_x) = extremes(corners.map(|point| point.0));
    let (least_y, most_y) = extremes(corners.map(|point| point.1));
    let span_x = (most_x - least_x).max(1e-6);
    let span_y = (most_y - least_y).max(1e-6);

    // Fitted inside the plate with a little room, so a corner is not shaved by
    // the rounding that decides where the plate's edge falls.
    const MARGIN: f64 = 0.98;
    let zoom = (f64::from(width) / span_x).min(f64::from(height) / span_y) * MARGIN;
    let middle_x = (least_x + most_x) / 2.0;
    let middle_y = (least_y + most_y) / 2.0;
    // Plate pixel to turned position: the inverse of the fit above.
    let back_to_plate = [
        [1.0 / zoom, 0.0, middle_x - f64::from(width) / (2.0 * zoom)],
        [0.0, 1.0 / zoom, middle_y - f64::from(height) / (2.0 * zoom)],
        [0.0, 0.0, 1.0],
    ];
    let backward = multiply(&invert(&forward), &back_to_plate);

    let source = picture.to_rgba8();
    let mut plate = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]));
    for y in 0..height {
        for x in 0..width {
            let (sx, sy) = project(&backward, f64::from(x) + 0.5, f64::from(y) + 0.5);
            if let Some(pixel) = sample(&source, sx - 0.5, sy - 0.5) {
                plate.put_pixel(x, y, pixel);
            }
        }
    }
    // Only the angles somebody asked for, joined the way they are said: a name
    // carrying a zero says nothing and reads as though it meant something.
    let suffix = [
        (yaw != 0.0).then(|| signed(yaw, "turned")),
        (pitch != 0.0).then(|| signed(pitch, "tipped")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("-");
    Ok(Answer {
        pieces: vec![Piece {
            pixels: plate,
            suffix,
        }],
        prompt: Some(describe_tilt(yaw, pitch)?),
        // See-through corners have nowhere to go in a JPEG.
        lossy: false,
    })
}

fn clamp_angle(degrees: f64, name: &str) -> Result<f64, ProjectError> {
    if !degrees.is_finite() {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!("The {name} is not a number"),
        ));
    }
    if degrees.abs() > MAX_TILT_DEGREES {
        return Err(ProjectError::domain(
            "VALIDATION_FAILED",
            format!("A {name} of {degrees} degrees is past the {MAX_TILT_DEGREES} this goes to"),
        ));
    }
    Ok(degrees)
}

/// Subject pixel to turned position.
///
/// Built as the two moves it actually is — a proportion of the way across and
/// down the subject, then a turn, a tip and a perspective divide — so that the
/// numbers in it are the ones the angles mean rather than a matrix somebody
/// worked out separately and could get out of step with them.
fn turn_matrix(width: u32, height: u32, turn: f64, tip: f64) -> Matrix {
    let (sin_turn, cos_turn) = turn.sin_cos();
    let (sin_tip, cos_tip) = tip.sin_cos();
    // Subject pixels to -1..1 on both axes.
    let normalise = [
        [2.0 / f64::from(width), 0.0, -1.0],
        [0.0, 2.0 / f64::from(height), -1.0],
        [0.0, 0.0, 1.0],
    ];
    let distance = VIEWER_DISTANCE;
    // The turn and the tip with the divide folded into the bottom row, which is
    // what makes straight lines stay straight and parallel ones converge.
    let projective = [
        [distance * cos_turn, 0.0, 0.0],
        [distance * sin_turn * sin_tip, distance * cos_tip, 0.0],
        [-sin_turn * cos_tip, sin_tip, distance],
    ];
    multiply(&projective, &normalise)
}

/// Three by three, row by row: the shape a homography is written in, and one a
/// reader can check line by line against the arithmetic beside it.
type Matrix = [[f64; 3]; 3];

fn multiply(left: &Matrix, right: &Matrix) -> Matrix {
    let mut out = [[0.0; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            out[row][col] = (0..3)
                .map(|middle| left[row][middle] * right[middle][col])
                .sum();
        }
    }
    out
}

fn invert(matrix: &Matrix) -> Matrix {
    let [[a, b, c], [d, e, f], [g, h, i]] = *matrix;
    let determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    // A turn of zero degrees is refused before this, and no angle inside the
    // limit puts the subject edge-on, so the divide is by something that is not
    // nothing. Guarding it anyway is cheaper than reasoning about it twice.
    if determinant.abs() < 1e-12 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let scale = 1.0 / determinant;
    [
        [
            (e * i - f * h) * scale,
            (c * h - b * i) * scale,
            (b * f - c * e) * scale,
        ],
        [
            (f * g - d * i) * scale,
            (a * i - c * g) * scale,
            (c * d - a * f) * scale,
        ],
        [
            (d * h - e * g) * scale,
            (b * g - a * h) * scale,
            (a * e - b * d) * scale,
        ],
    ]
}

fn project(matrix: &Matrix, x: f64, y: f64) -> (f64, f64) {
    let across = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2];
    let down = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2];
    let weight = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2];
    if weight.abs() < 1e-12 {
        return (across, down);
    }
    (across / weight, down / weight)
}

fn extremes(values: [f64; 4]) -> (f64, f64) {
    let mut least = f64::INFINITY;
    let mut most = f64::NEG_INFINITY;
    for value in values {
        least = least.min(value);
        most = most.max(value);
    }
    (least, most)
}

/// One pixel of the subject at a place between pixels, mixed from the four
/// around it. Nothing outside the subject, which is what leaves the plate
/// see-through past the turned edge.
fn sample(source: &RgbaImage, x: f64, y: f64) -> Option<Rgba<u8>> {
    let last_x = f64::from(source.width()) - 1.0;
    let last_y = f64::from(source.height()) - 1.0;
    if x < 0.0 || y < 0.0 || x > last_x || y > last_y {
        return None;
    }
    let left = x.floor() as u32;
    let top = y.floor() as u32;
    let right = (left + 1).min(source.width() - 1);
    let bottom = (top + 1).min(source.height() - 1);
    let across = x - f64::from(left);
    let down = y - f64::from(top);
    let corners = [
        source.get_pixel(left, top).0,
        source.get_pixel(right, top).0,
        source.get_pixel(left, bottom).0,
        source.get_pixel(right, bottom).0,
    ];
    let weights = [
        (1.0 - across) * (1.0 - down),
        across * (1.0 - down),
        (1.0 - across) * down,
        across * down,
    ];
    let mut mixed = [0.0f64; 4];
    for (weight, corner) in weights.into_iter().zip(corners) {
        for (slot, value) in mixed.iter_mut().zip(corner) {
            *slot += f64::from(value) * weight;
        }
    }
    Some(Rgba(mixed.map(|value| value.round() as u8)))
}

/// What the plate says about itself, in the words a model is asked with.
///
/// The words themselves live under `prompts/imaging/`; what is here is the choice
/// of which angles were asked for and which way round each one goes. An angle of
/// zero is left out rather than said as nothing, because a name carrying a zero
/// reads as though it meant something.
fn describe_tilt(yaw: f64, pitch: f64) -> Result<String, ProjectError> {
    let mut angles = Vec::new();
    if yaw != 0.0 {
        let side = if yaw > 0.0 { "right" } else { "left" };
        angles.push(phrase(
            Prompt::TiltTurn,
            &serde_json::json!({
                "degrees": rounded(yaw.abs()),
                "side": side,
            }),
        )?);
    }
    if pitch != 0.0 {
        let way = if pitch > 0.0 { "back" } else { "forward" };
        angles.push(phrase(
            Prompt::TiltTip,
            &serde_json::json!({
                "degrees": rounded(pitch.abs()),
                "way": way,
            }),
        )?);
    }
    phrase(Prompt::Tilt, &serde_json::json!({ "angles": angles }))
}

/// One template's words, reported as the fault in the build that it is.
///
/// The templates are compiled when the server starts, so a failure here is not
/// something a reader did to their picture and is not reported as though it
/// were.
fn phrase(prompt: Prompt, context: &serde_json::Value) -> Result<String, ProjectError> {
    render(prompt, context)
        .map_err(|error: PromptError| ProjectError::domain("INTERNAL", error.to_string()))
}

fn rounded(degrees: f64) -> i64 {
    degrees.round() as i64
}

fn signed(degrees: f64, word: &str) -> String {
    let side = if degrees >= 0.0 { "cw" } else { "ccw" };
    format!("{word}-{}{side}", rounded(degrees.abs()))
}

/// A picture that arrived lossy stays lossy.
///
/// Not because lossy is better — it is not — but because a tool that quietly
/// moved a photograph into a container four times its size would fill a
/// project up, and the reader who wants lossless can ask for it by starting
/// from a picture that is.
fn stays_lossy(mime: &str) -> bool {
    mime == "image/jpeg"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Lossless,
    Lossy,
}

impl Encoding {
    fn mime(&self) -> &'static str {
        match self {
            Self::Lossless => "image/png",
            Self::Lossy => "image/jpeg",
        }
    }

    /// The ending a result's name carries for this container.
    fn extension(&self) -> &'static str {
        match self {
            Self::Lossless => "png",
            Self::Lossy => "jpg",
        }
    }
}

/// How much of a stored picture is read back to decide what it is called:
/// enough to keep two cuts of one sheet apart, short enough to stay readable
/// beside the subject's own name.
fn subject_stem(name: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    stem.chars().take(40).collect()
}

/// What a result is called: the subject's own name, what the piece is, and the
/// ending its container needs.
///
/// The registry reads an ending off a name to decide how to store the file, so a
/// name without one leaves this the only picture in the project that does not
/// say what it is — and anything offered for saving under that name is saved
/// without an ending either.
fn result_name(stem: &str, suffix: &str, encoding: Encoding) -> String {
    format!("{stem}-{suffix}.{}", encoding.extension())
}

fn encode(pixels: &RgbaImage, encoding: Encoding) -> Result<Vec<u8>, ProjectError> {
    let mut sink = std::io::Cursor::new(Vec::new());
    match encoding {
        Encoding::Lossless => pixels
            .write_to(&mut sink, image::ImageFormat::Png)
            .map_err(|error| {
                ProjectError::domain(
                    "INTERNAL",
                    format!("The result could not be written: {error}"),
                )
            })?,
        Encoding::Lossy => {
            // JPEG has no channel for see-through, and a picture with one is
            // never sent down this path.
            let flat = RgbImage::from_fn(pixels.width(), pixels.height(), |x, y| {
                let colour = pixels.get_pixel(x, y);
                Rgb([colour[0], colour[1], colour[2]])
            });
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut sink, JPEG_QUALITY)
                .encode_image(&flat)
                .map_err(|error| {
                    ProjectError::domain(
                        "INTERNAL",
                        format!("The result could not be written: {error}"),
                    )
                })?;
        }
    }
    Ok(sink.into_inner())
}

/// The record of what made this picture.
///
/// No run id and no node id: nothing ran and no node produced it. What it does
/// carry is the tool, the parameters as they were given, and the subject — which
/// is enough for a reader to see where the picture came from and enough for an
/// editor to offer the same cut again.
fn provenance(tool: Operator, subject: &AssetId, params: &serde_json::Value) -> AssetProvenance {
    let mut snapshot = serde_json::Map::new();
    snapshot.insert(
        "tool".to_string(),
        serde_json::Value::String(tool.label().to_string()),
    );
    snapshot.insert(
        "sourceAssetId".to_string(),
        serde_json::Value::String(subject.to_string()),
    );
    if let Some(fields) = params.as_object() {
        for (key, value) in fields {
            snapshot.entry(key.to_string()).or_insert(value.clone());
        }
    }
    AssetProvenance {
        run_id: None,
        canvas_id: None,
        operation_node_id: None,
        assistant_session_id: None,
        story_job_id: None,
        story_id: None,
        input_asset_ids: Some(vec![subject.clone()]),
        parameter_snapshot: Some(serde_json::Value::Object(snapshot)),
        generation: None,
        created_at: now_iso(),
    }
}

/// Leaves nothing behind for a tool that did not finish.
fn discard(staged: &mut Vec<StagedAsset>) {
    for asset in staged.drain(..) {
        let _ = std::fs::remove_file(asset.tmp_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    /// A picture whose every pixel says where it is, so a test can tell a
    /// region that was cut from one that was guessed at.
    fn sheet(width: u32, height: u32) -> DynamicImage {
        let mut pixels: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(width, height);
        for y in 0..height {
            for x in 0..width {
                pixels.put_pixel(
                    x,
                    y,
                    Rgba([(x % 251) as u8, (y % 199) as u8, ((x + y) % 151) as u8, 255]),
                );
            }
        }
        DynamicImage::ImageRgba8(pixels)
    }

    /// A picture that changes slowly, so a resample can be asked where it
    /// landed. The sheet above is no good for that: its detail is finer than the
    /// resample's own grid, so it aliases, and an aliasing answer looks the same
    /// whatever part of the picture was taken.
    fn ramp(width: u32, height: u32) -> DynamicImage {
        let mut pixels: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(width, height);
        for y in 0..height {
            for x in 0..width {
                pixels.put_pixel(
                    x,
                    y,
                    Rgba([
                        (x * 255 / (width - 1).max(1)) as u8,
                        (y * 255 / (height - 1).max(1)) as u8,
                        128,
                        255,
                    ]),
                );
            }
        }
        DynamicImage::ImageRgba8(pixels)
    }

    fn one(answer: &Answer) -> &RgbaImage {
        &answer.pieces.first().expect("one piece").pixels
    }

    /// The colour at a place in a result. A result is a buffer, which hands out
    /// a reference to what it holds; a decoded picture hands out the colour
    /// itself. Comparing one against the other needs this.
    fn colour(pixels: &RgbaImage, x: u32, y: u32) -> Rgba<u8> {
        *pixels.get_pixel(x, y)
    }

    #[test]
    fn a_region_is_cut_where_it_was_asked_for() {
        let answer = cut(
            &sheet(60, 40),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "region": { "x": 10, "y": 4, "width": 30, "height": 20 }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(answer.pieces.len(), 1);
        let cut = one(&answer);
        assert_eq!((cut.width(), cut.height()), (30, 20));
        assert_eq!(colour(cut, 0, 0), sheet(60, 40).get_pixel(10, 4));
        assert_eq!(colour(cut, 29, 19), sheet(60, 40).get_pixel(39, 23));
    }

    #[test]
    fn a_cut_hanging_off_the_edge_loses_the_overhang() {
        let answer = cut(
            &sheet(20, 20),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "region": { "x": -5, "y": 15, "width": 40, "height": 40 }
            }))
            .unwrap(),
        )
        .unwrap();
        let cut = one(&answer);
        assert_eq!((cut.width(), cut.height()), (20, 5));
        assert_eq!(colour(cut, 0, 0), sheet(20, 20).get_pixel(0, 15));
    }

    #[test]
    fn a_cut_that_misses_the_picture_altogether_is_refused() {
        let error = cut(
            &sheet(20, 20),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "region": { "x": 200, "y": 0, "width": 5, "height": 5 }
            }))
            .unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
        assert!(error.to_string().contains("20 by 20"));
    }

    #[test]
    fn a_proportion_on_its_own_cuts_the_largest_centred_region_of_that_shape() {
        let answer = cut(
            &sheet(100, 40),
            "image/png",
            serde_json::from_value(serde_json::json!({ "ratio": "1:1" })).unwrap(),
        )
        .unwrap();
        let cut = one(&answer);
        assert_eq!((cut.width(), cut.height()), (40, 40));
        // Centred: the same distance from both sides.
        assert_eq!(colour(cut, 0, 0), sheet(100, 40).get_pixel(30, 0));
    }

    #[test]
    fn a_proportion_the_picture_is_too_narrow_for_takes_the_whole_width() {
        let answer = cut(
            &sheet(40, 100),
            "image/png",
            serde_json::from_value(serde_json::json!({ "ratio": "9:16" })).unwrap(),
        )
        .unwrap();
        let cut = one(&answer);
        assert_eq!((cut.width(), cut.height()), (40, 71));
        // Centred in the one direction the cut is smaller than the picture.
        assert_eq!(colour(cut, 0, 0), sheet(40, 100).get_pixel(0, 14));
    }

    #[test]
    fn a_proportion_that_is_not_one_is_said_so() {
        for ratio in ["16x9", "16", "", "0:9", "16:0", ":9"] {
            let error = cut(
                &sheet(20, 20),
                "image/png",
                serde_json::from_value(serde_json::json!({ "ratio": ratio })).unwrap(),
            )
            .unwrap_err();
            assert_eq!(error.code(), "VALIDATION_FAILED", "for {ratio}");
        }
    }

    #[test]
    fn a_cut_with_neither_a_region_nor_a_proportion_is_refused() {
        let error = cut(
            &sheet(20, 20),
            "image/png",
            serde_json::from_value(serde_json::json!({})).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("region or a proportion"));
    }

    #[test]
    fn a_sheet_is_divided_in_reading_order_and_the_pieces_cover_it() {
        let answer = divide(
            &sheet(10, 10),
            "image/png",
            serde_json::from_value(serde_json::json!({ "rows": 3, "cols": 3 })).unwrap(),
        )
        .unwrap();
        assert_eq!(answer.pieces.len(), 9);
        // Ten does not divide by three; the last piece takes the odd pixel.
        let widths: Vec<u32> = answer
            .pieces
            .iter()
            .take(3)
            .map(|p| p.pixels.width())
            .collect();
        assert_eq!(widths, [3, 3, 4]);
        assert_eq!(
            colour(&answer.pieces[0].pixels, 0, 0),
            sheet(10, 10).get_pixel(0, 0)
        );
        // The last piece is the wide one, so its own far corner is the picture's.
        assert_eq!(
            colour(&answer.pieces[8].pixels, 3, 3),
            sheet(10, 10).get_pixel(9, 9)
        );
        let counted: u32 = answer
            .pieces
            .iter()
            .map(|p| p.pixels.width() * p.pixels.height())
            .sum();
        assert_eq!(counted, 100, "no pixel is dropped or counted twice");
    }

    #[test]
    fn a_division_into_one_by_one_is_the_whole_picture() {
        let answer = divide(
            &sheet(7, 5),
            "image/png",
            serde_json::from_value(serde_json::json!({ "rows": 1, "cols": 1 })).unwrap(),
        )
        .unwrap();
        assert_eq!(answer.pieces.len(), 1);
        assert_eq!((one(&answer).width(), one(&answer).height()), (7, 5));
    }

    #[test]
    fn a_division_past_the_limit_is_refused_rather_than_made() {
        let error = divide(
            &sheet(10, 10),
            "image/png",
            serde_json::from_value(serde_json::json!({ "rows": 9, "cols": 9 })).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("64"));
    }

    #[test]
    fn a_division_into_nothing_is_refused() {
        for (rows, cols) in [(0, 3), (3, 0), (0, 0)] {
            let error = divide(
                &sheet(4, 4),
                "image/png",
                serde_json::from_value(serde_json::json!({ "rows": rows, "cols": cols })).unwrap(),
            )
            .unwrap_err();
            assert!(
                error.to_string().contains("at least one row"),
                "for {rows} by {cols}"
            );
        }
    }

    #[test]
    fn a_named_size_fits_the_long_edge_inside_it() {
        let answer = resample(
            &sheet(400, 200),
            "image/png",
            serde_json::from_value(serde_json::json!({ "target": "k2" })).unwrap(),
        )
        .unwrap();
        assert_eq!((one(&answer).width(), one(&answer).height()), (2048, 1024));
    }

    #[test]
    fn a_box_fitted_into_keeps_the_shape_of_the_picture() {
        let answer = resample(
            &sheet(400, 200),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "target": { "width": 100, "height": 100 }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!((one(&answer).width(), one(&answer).height()), (100, 50));
    }

    #[test]
    fn a_box_covered_takes_the_middle_of_the_picture() {
        let answer = resample(
            &ramp(400, 200),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "target": { "width": 100, "height": 100 },
                "fit": "cover"
            }))
            .unwrap(),
        )
        .unwrap();
        let covered = one(&answer);
        assert_eq!((covered.width(), covered.height()), (100, 100));
        // The middle of the picture, not one end of it: the two ends of a ramp
        // are as far apart as it gets, so landing near one is a clear failure.
        let middle = ramp(400, 200).get_pixel(200, 100).0;
        let landed = colour(covered, 50, 50).0;
        assert!(
            middle
                .iter()
                .zip(landed.iter())
                .all(|(want, got)| want.abs_diff(*got) <= 2),
            "a cover resample should land on the middle: {middle:?} vs {landed:?}"
        );
    }

    #[test]
    fn a_box_filled_is_the_box_whatever_that_does_to_the_shape() {
        let answer = resample(
            &sheet(400, 200),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "target": { "width": 30, "height": 90 },
                "fit": "fill"
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!((one(&answer).width(), one(&answer).height()), (30, 90));
    }

    #[test]
    fn growing_a_picture_is_allowed_but_not_past_the_ceiling() {
        let refused = resample(
            &sheet(20, 20),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "target": { "width": 8000, "height": 8000 },
                "fit": "fill"
            }))
            .unwrap(),
        )
        .unwrap_err();
        assert!(refused.to_string().contains("these tools will make"));
        let small = resample(
            &sheet(20, 20),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "target": { "width": 200, "height": 200 },
                "fit": "fill"
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!((one(&small).width(), one(&small).height()), (200, 200));
    }

    #[test]
    fn a_box_of_nothing_to_fit_into_is_refused() {
        let error = resample(
            &sheet(20, 20),
            "image/png",
            serde_json::from_value(serde_json::json!({
                "target": { "width": 0, "height": 40 }
            }))
            .unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
    }

    #[test]
    fn a_turn_leaves_the_middle_of_the_picture_and_nothing_outside_it() {
        let subject = sheet(80, 60);
        let answer = tilt(
            &subject,
            serde_json::from_value(serde_json::json!({ "yaw": 20.0 })).unwrap(),
        )
        .unwrap();
        let plate = one(&answer);
        assert_eq!(
            (plate.width(), plate.height()),
            (80, 60),
            "the plate keeps its size"
        );
        assert!(answer
            .prompt
            .as_deref()
            .unwrap()
            .contains("turned 20° to the right"));
        // Something landed, and something did not: a plate with no see-through
        // corner has not been turned at all.
        assert!(plate.get_pixel(40, 30)[3] > 0);
        let corners_transparent = [(0, 0), (79, 0), (0, 59), (79, 59)]
            .iter()
            .filter(|(x, y)| plate.get_pixel(*x, *y)[3] == 0)
            .count();
        assert!(
            corners_transparent >= 2,
            "the corners a turn leaves behind stay empty"
        );
    }

    #[test]
    fn a_tip_is_described_the_way_a_turn_is() {
        let answer = tilt(
            &sheet(80, 60),
            serde_json::from_value(serde_json::json!({ "pitch": -12.0 })).unwrap(),
        )
        .unwrap();
        assert!(answer
            .prompt
            .as_deref()
            .unwrap()
            .contains("tipped 12° forward"));
        assert!(
            !answer.lossy,
            "see-through corners have nowhere to go in a JPEG"
        );
    }

    #[test]
    fn a_tilt_is_named_for_the_angles_it_was_asked_for_and_no_others() {
        let asked = |params: serde_json::Value| {
            let answer = tilt(&sheet(80, 60), serde_json::from_value(params).unwrap()).unwrap();
            answer.pieces[0].suffix.clone()
        };
        assert_eq!(asked(serde_json::json!({ "yaw": 20.0 })), "turned-20cw");
        assert_eq!(asked(serde_json::json!({ "pitch": -12.0 })), "tipped-12ccw");
        assert_eq!(
            asked(serde_json::json!({ "yaw": 20.0, "pitch": 8.0 })),
            "turned-20cw-tipped-8cw"
        );
    }

    #[test]
    fn a_tilt_nobody_asked_for_makes_nothing() {
        let error = tilt(
            &sheet(80, 60),
            serde_json::from_value(serde_json::json!({})).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("Nothing was asked to turn"));
    }

    #[test]
    fn a_tilt_past_the_limit_is_refused() {
        let error = tilt(
            &sheet(80, 60),
            serde_json::from_value(serde_json::json!({ "yaw": 90.0 })).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("60"));
    }

    #[test]
    fn the_same_ask_gives_the_same_picture_every_time() {
        // Arithmetic that is not the same twice is not arithmetic, and a test
        // that could only say "roughly" would not catch a resample that drifted.
        let ask = serde_json::from_value(serde_json::json!({ "yaw": 17.0, "pitch": 9.0 })).unwrap();
        let subject = sheet(64, 48);
        let first = tilt(&subject, ask).unwrap();
        let second = tilt(&subject, ask).unwrap();
        assert_eq!(one(&first).as_raw(), one(&second).as_raw());
    }

    #[test]
    fn a_picture_that_arrived_lossy_stays_lossy_and_one_that_did_not_does_not_become_so() {
        assert!(stays_lossy("image/jpeg"));
        assert!(!stays_lossy("image/png"));
        assert!(!stays_lossy("image/webp"));
        let lossy = cut(
            &sheet(10, 10),
            "image/jpeg",
            serde_json::from_value(serde_json::json!({ "ratio": "1:1" })).unwrap(),
        )
        .unwrap();
        assert!(lossy.lossy);
        let lossless = resample(
            &sheet(10, 10),
            "image/webp",
            serde_json::from_value(serde_json::json!({ "target": "k2" })).unwrap(),
        )
        .unwrap();
        assert!(!lossless.lossy);
    }

    #[test]
    fn both_containers_round_trip_what_was_written() {
        let pixels = sheet(12, 9).to_rgba8();
        for encoding in [Encoding::Lossless, Encoding::Lossy] {
            let bytes = encode(&pixels, encoding).unwrap();
            let back = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert_eq!(
                (back.width(), back.height()),
                (12, 9),
                "{} came back a different size",
                encoding.mime()
            );
            assert_eq!(encoding.mime(), infer::get(&bytes).unwrap().mime_type());
        }
    }

    #[test]
    fn a_name_is_taken_from_the_subject_without_its_extension() {
        assert_eq!(subject_stem("holiday-plate.png"), "holiday-plate");
        assert_eq!(subject_stem("no-extension"), "no-extension");
        assert_eq!(subject_stem("archive.tar.gz"), "archive.tar");
        assert_eq!(subject_stem(&"x".repeat(60)), "x".repeat(40));
    }

    #[test]
    fn a_result_is_named_with_the_ending_its_container_needs() {
        for encoding in [Encoding::Lossless, Encoding::Lossy] {
            let name = result_name("holiday-plate", "48x48", encoding);
            assert_eq!(
                crate::assets::extension_for(&name, encoding.mime()),
                encoding.extension(),
                "{name} would be stored under an ending that is not its own"
            );
        }
        assert_eq!(
            result_name("holiday-plate", "2-2-1-1", Encoding::Lossless),
            "holiday-plate-2-2-1-1.png"
        );
    }

    #[test]
    fn the_record_names_the_tool_the_parameters_and_the_subject() {
        let record = provenance(
            Operator::Crop,
            &AssetId::from("subject-1"),
            &serde_json::json!({ "region": { "x": 1, "y": 2, "width": 3, "height": 4 } }),
        );
        let snapshot = record.parameter_snapshot.unwrap();
        assert_eq!(snapshot["tool"], "crop");
        assert_eq!(snapshot["sourceAssetId"], "subject-1");
        assert_eq!(snapshot["region"]["width"], 3);
        assert_eq!(
            record.input_asset_ids.unwrap(),
            vec![AssetId::from("subject-1")]
        );
        assert!(record.run_id.is_none(), "nothing ran");
        assert!(record.operation_node_id.is_none(), "no node made this");
    }

    #[test]
    fn a_parameter_that_shares_a_name_with_the_record_does_not_overwrite_it() {
        let record = provenance(
            Operator::Tilt,
            &AssetId::from("subject-1"),
            &serde_json::json!({ "tool": "not-a-tool", "yaw": 5.0 }),
        );
        let snapshot = record.parameter_snapshot.unwrap();
        assert_eq!(snapshot["tool"], "tilt");
        assert_eq!(snapshot["yaw"], 5.0);
    }

    #[test]
    fn an_ask_arrives_in_camel_case_and_names_its_tool() {
        let request: OperatorRequest = serde_json::from_value(serde_json::json!({
            "tool": "resize",
            "assetId": "a1",
            "params": { "target": "k4", "fit": "cover" },
        }))
        .unwrap();
        assert_eq!(request.tool, Operator::Resize);
        assert_eq!(request.asset_id, AssetId::from("a1"));

        let ask: ResizeAsk = serde_json::from_value(request.params).unwrap();
        assert_eq!(ask.target, Target::Named(NamedTarget::K4));
        assert_eq!(ask.fit, Fitting::Cover);
    }

    #[test]
    fn a_tool_nobody_has_is_not_guessed_at() {
        for tool in ["sharpen", "Crop", "poster"] {
            let error = serde_json::from_value::<OperatorRequest>(serde_json::json!({
                "tool": tool,
                "assetId": "a1",
            }))
            .unwrap_err();
            assert!(
                error.to_string().contains(tool),
                "the refusal should name what was refused, got {error}"
            );
        }
    }

    #[test]
    fn a_field_this_tool_does_not_have_is_refused_rather_than_ignored() {
        let error = parse::<CropAsk>(
            Operator::Crop,
            &serde_json::json!({ "ratio": "1:1", "feather": 4 }),
        )
        .unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
        assert!(error.to_string().contains("crop"));
    }
}
