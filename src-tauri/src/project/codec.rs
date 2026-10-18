use crate::domain::story::STORY_SCHEMA_VERSION;
use crate::domain::validate::resource_path_valid;
use crate::domain::{
    reconcile_ports, MokaFile, CANVAS_SCHEMA_VERSION, CANVAS_SCHEMA_VERSION_MIN, MOKA_FILE_VERSION,
};
use thiserror::Error;

pub const MOKA_MAGIC: [u8; 4] = [0x4d, 0x4f, 0x4b, 0x41];

#[derive(Debug, Error)]
pub enum CodecError {
    #[error("canvas.moka does not start with the MOKA magic bytes")]
    MagicInvalid,
    #[error("canvas.moka contains invalid BSON: {0}")]
    BsonInvalid(String),
    #[error("canvas.moka version \"{0}\" is not supported (expected \"v1\")")]
    VersionUnsupported(String),
    #[error("canvas.moka schema version {0} is not supported")]
    SchemaUnsupported(i32),
    #[error("canvas.moka is missing required field \"{0}\"")]
    FieldMissing(&'static str),
    #[error("canvas.moka resource path escapes the project root: {0}")]
    PathEscape(String),
    #[error("canvas.moka would be {actual} bytes, exceeding the {limit} byte limit")]
    TooLarge { actual: usize, limit: u64 },
}

impl CodecError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MagicInvalid => "MOKA_MAGIC_INVALID",
            Self::BsonInvalid(_) => "MOKA_BSON_INVALID",
            Self::VersionUnsupported(_) => "MOKA_VERSION_UNSUPPORTED",
            Self::SchemaUnsupported(_) => "MOKA_VERSION_UNSUPPORTED",
            Self::FieldMissing(_) => "MOKA_FIELD_MISSING",
            Self::PathEscape(_) => "PATH_ESCAPE",
            Self::TooLarge { .. } => "MOKA_TOO_LARGE",
        }
    }
}

pub fn encode_moka_file(moka: &MokaFile, max_bytes: Option<u64>) -> Result<Vec<u8>, CodecError> {
    let bson =
        bson::serialize_to_vec(moka).map_err(|error| CodecError::BsonInvalid(error.to_string()))?;
    let mut bytes = Vec::with_capacity(4 + bson.len());
    bytes.extend_from_slice(&MOKA_MAGIC);
    bytes.extend_from_slice(&bson);
    if let Some(limit) = max_bytes {
        if bytes.len() as u64 > limit {
            return Err(CodecError::TooLarge {
                actual: bytes.len(),
                limit,
            });
        }
    }
    Ok(bytes)
}

pub fn decode_moka_file(bytes: &[u8]) -> Result<MokaFile, CodecError> {
    if bytes.len() < 5 {
        return Err(CodecError::BsonInvalid(
            "canvas.moka is too small to be valid".into(),
        ));
    }
    if bytes[..4] != MOKA_MAGIC {
        return Err(CodecError::MagicInvalid);
    }
    let mut document: bson::Document = bson::deserialize_from_slice(&bytes[4..])
        .map_err(|error| CodecError::BsonInvalid(error.to_string()))?;
    settle_steps(&mut document);
    let mut moka: MokaFile = bson::deserialize_from_document(document)
        .map_err(|error| CodecError::BsonInvalid(error.to_string()))?;

    if moka.version.is_empty() {
        return Err(CodecError::FieldMissing("version"));
    }
    if moka.version != MOKA_FILE_VERSION {
        return Err(CodecError::VersionUnsupported(moka.version));
    }
    if moka.metadata.id.is_empty() {
        return Err(CodecError::FieldMissing("metadata.id"));
    }
    for entry in moka.resources.all() {
        if !resource_path_valid(&entry.path) {
            return Err(CodecError::PathEscape(entry.path.clone()));
        }
    }
    for canvas in moka.canvas.iter_mut() {
        // The current schema and the one before it are read. A v3 canvas holds
        // no extension node, so upgrading it is one number: what it holds was
        // already decodable under this build's rules. Anything older would
        // need rules this build no longer carries, and anything newer says the
        // app was rolled back over a document this build cannot know.
        if !(CANVAS_SCHEMA_VERSION_MIN..=CANVAS_SCHEMA_VERSION).contains(&canvas.schema_version) {
            return Err(CodecError::SchemaUnsupported(canvas.schema_version));
        }
        canvas.schema_version = CANVAS_SCHEMA_VERSION;
        for node in canvas.nodes.iter_mut() {
            let stored = std::mem::take(&mut node.ports);
            node.ports = reconcile_ports(node.kind, &stored);
        }
    }
    // A story written by a newer build is refused rather than read as though
    // its words meant what this build's words mean, the way a timeline is.
    for story in moka.stories.iter().flatten() {
        if story.schema_version > STORY_SCHEMA_VERSION {
            return Err(CodecError::SchemaUnsupported(story.schema_version));
        }
    }
    Ok(moka)
}

/// The steps an older document had settled, written into the field that holds
/// them now.
///
/// A story written before the room confirmed whole steps said the same thing
/// one place at a time: a chapter agreed to, a description agreed to, a clip
/// agreed to. Reading those back is what keeps a telling someone had finished
/// standing where they left it rather than at the first step of five — and it
/// is read here rather than in the client because what the server holds in
/// memory is what the client is shown. The same reading stands in
/// `src/shared/domain/codec.ts`, which is where it is written when a file is
/// read outside the server.
fn settle_steps(moka: &mut bson::Document) {
    let Some(bson::Bson::Array(stories)) = moka.get_mut("stories") else {
        return;
    };
    for story in stories.iter_mut() {
        let bson::Bson::Document(story) = story else {
            continue;
        };
        // A document that says which steps were settled is read as it stands.
        if story.contains_key("confirmedSteps") {
            continue;
        }
        let chapters = rows(story.get("chapters"));
        let elements = rows(story.get("elements"));
        let acts: Vec<&bson::Bson> = chapters
            .iter()
            .flat_map(|chapter| rows(record(Some(chapter)).and_then(|held| held.get("acts"))))
            .collect();
        let mut steps: Vec<&str> = Vec::new();
        if record(story.get("brief")).is_some_and(|brief| {
            matches!(brief.get("idea"), Some(bson::Bson::String(words)) if !words.trim().is_empty())
                || brief.contains_key("sourceAssetId")
        }) {
            steps.push("idea");
        }
        if !chapters.is_empty()
            && chapters
                .iter()
                .all(|chapter| said(record(Some(chapter)), "synopsisConfirmed"))
        {
            steps.push("outline");
        }
        if !elements.is_empty()
            && elements.iter().all(|element| {
                let held = record(Some(element));
                said(held, "descriptionConfirmed")
                    && said(record(held.and_then(|each| each.get("main"))), "confirmed")
                    && match held.and_then(|each| each.get("turnaround")) {
                        None | Some(bson::Bson::Null) => true,
                        other => said(record(other), "confirmed"),
                    }
            })
        {
            steps.push("elements");
        }
        if !acts.is_empty()
            && acts.iter().all(|act| {
                let held = record(Some(act));
                said(held, "videoConfirmed")
                    && !rows(
                        record(held.and_then(|each| each.get("video")))
                            .and_then(|video| video.get("takes")),
                    )
                    .is_empty()
            })
        {
            steps.push("storyboard");
        }
        story.insert(
            "confirmedSteps",
            bson::Bson::Array(
                steps
                    .into_iter()
                    .map(|step| bson::Bson::String(step.into()))
                    .collect(),
            ),
        );
    }
}

/// A record, where the value is one.
fn record(value: Option<&bson::Bson>) -> Option<&bson::Document> {
    match value {
        Some(bson::Bson::Document(held)) => Some(held),
        _ => None,
    }
}

/// The entries of an array, where the value is one; nothing otherwise.
fn rows(value: Option<&bson::Bson>) -> Vec<&bson::Bson> {
    match value {
        Some(bson::Bson::Array(held)) => held.iter().collect(),
        _ => Vec::new(),
    }
}

/// Whether a record says true of a field: the old documents' way of agreeing.
fn said(held: Option<&bson::Document>, key: &str) -> bool {
    held.is_some_and(|held| matches!(held.get(key), Some(bson::Bson::Boolean(true))))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &[u8] = include_bytes!("../../../fixtures/minimal.canvas.moka");

    #[test]
    fn keeps_a_re_save_byte_canonical() {
        let once = encode_moka_file(&decode_moka_file(GOLDEN).unwrap(), None).unwrap();
        let twice = encode_moka_file(&decode_moka_file(&once).unwrap(), None).unwrap();
        assert_eq!(once, twice);
    }

    /// Ports are derived data: the table wins for every port it knows, and a
    /// port it does not know stays behind the table's own.
    #[test]
    fn reads_ports_from_the_table_and_keeps_one_it_does_not_know() {
        let mut moka = decode_moka_file(GOLDEN).unwrap();
        let node = &mut moka.canvas[0].nodes[0];
        let kind = node.kind;
        node.ports = vec![crate::domain::PortDefinition {
            id: "handAdded".into(),
            direction: crate::domain::PortDirection::Input,
            data_types: vec![crate::domain::DataType::Text],
            required: false,
            cardinality: crate::domain::Cardinality::One,
            label: "Hand added".into(),
        }];
        let bytes = encode_moka_file(&moka, None).unwrap();

        let read = decode_moka_file(&bytes).unwrap();
        let ports = &read.canvas[0].nodes[0].ports;
        let mut expected: Vec<String> = crate::domain::derive_ports(kind)
            .into_iter()
            .map(|port| port.id)
            .collect();
        expected.push("handAdded".into());
        assert_eq!(
            ports.iter().map(|port| port.id.clone()).collect::<Vec<_>>(),
            expected
        );
    }

    #[test]
    fn refuses_a_canvas_schema_that_is_not_the_current_one_or_the_one_before() {
        for version in [CANVAS_SCHEMA_VERSION_MIN - 1, CANVAS_SCHEMA_VERSION + 1] {
            let mut moka = decode_moka_file(GOLDEN).unwrap();
            moka.canvas[0].schema_version = version;
            let bytes = encode_moka_file(&moka, None).unwrap();
            assert_eq!(
                decode_moka_file(&bytes).unwrap_err().code(),
                "MOKA_VERSION_UNSUPPORTED"
            );
        }
    }

    #[test]
    fn a_canvas_of_the_previous_schema_is_read_and_written_as_the_current_one() {
        let mut moka = decode_moka_file(GOLDEN).unwrap();
        moka.canvas[0].schema_version = CANVAS_SCHEMA_VERSION_MIN;
        let bytes = encode_moka_file(&moka, None).unwrap();
        let read = decode_moka_file(&bytes).unwrap();
        assert_eq!(read.canvas[0].schema_version, CANVAS_SCHEMA_VERSION);
    }
}
