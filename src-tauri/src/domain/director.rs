//! The director desk's scene: a place staged in metres before a frame is made.
//!
//! A scene travels in the document beside the timelines and the stories, and
//! nothing here knows how it is drawn. The same readings are used by the
//! decoder (which refuses a scene it cannot honour), the command layer (which
//! refuses an edit), and the run preflight (which refuses an output that is
//! not there).

use serde::{Deserialize, Serialize};

use super::{AssetId, IsoTimestamp, NodeId};

pub type DirectorVec3 = [f64; 3];
pub type DirectorQuat = [f64; 4];

pub const DIRECTOR_SCHEMA_VERSION: i32 = 1;

pub const MAX_DIRECTOR_SCENES_PER_PROJECT: usize = 256;
pub const MAX_DIRECTOR_OBJECTS_PER_SCENE: usize = 128;
pub const MAX_DIRECTOR_CAMERAS_PER_SCENE: usize = 16;
pub const MAX_DIRECTOR_LIGHTS_PER_SCENE: usize = 32;
pub const MAX_DIRECTOR_SHOTS_PER_SCENE: usize = 64;
pub const MAX_DIRECTOR_KEYFRAMES_PER_TRACK: usize = 2_000;
pub const MAX_DIRECTOR_BONE_TRACKS_PER_OBJECT: usize = 64;
pub const MAX_DIRECTOR_SCENE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_DIRECTOR_NAME_LENGTH: usize = 120;

pub const DIRECTOR_HUMANOID_ARCHETYPES: [&str; 6] =
    ["standard", "youth", "senior", "broad", "slim", "stylized"];
pub const DIRECTOR_ANIMAL_ARCHETYPES: [&str; 2] = ["dog", "horse"];
pub const DIRECTOR_HUMANOID_POSES: [&str; 21] = [
    "neutral",
    "stand",
    "t_pose",
    "walk",
    "run",
    "sit",
    "squat",
    "kneel_single",
    "kneel_double",
    "hands_hips",
    "lean",
    "bow",
    "think",
    "fight",
    "kick",
    "throw",
    "push",
    "wave",
    "reach",
    "arms_crossed",
    "phone",
];
pub const DIRECTOR_ANIMAL_POSES: [&str; 6] = [
    "animal_stand",
    "animal_sit",
    "animal_lie",
    "animal_walk",
    "animal_run",
    "animal_alert",
];
pub const DIRECTOR_HUMANOID_BONES: [&str; 50] = [
    "root",
    "hips",
    "spine",
    "chest",
    "neck",
    "head",
    "leftShoulder",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightShoulder",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
    "leftThumb1",
    "leftThumb2",
    "leftThumb3",
    "leftIndex1",
    "leftIndex2",
    "leftIndex3",
    "leftMiddle1",
    "leftMiddle2",
    "leftMiddle3",
    "leftRing1",
    "leftRing2",
    "leftRing3",
    "leftPinky1",
    "leftPinky2",
    "leftPinky3",
    "rightThumb1",
    "rightThumb2",
    "rightThumb3",
    "rightIndex1",
    "rightIndex2",
    "rightIndex3",
    "rightMiddle1",
    "rightMiddle2",
    "rightMiddle3",
    "rightRing1",
    "rightRing2",
    "rightRing3",
    "rightPinky1",
    "rightPinky2",
    "rightPinky3",
];
pub const DIRECTOR_QUADRUPED_BONES: [&str; 19] = [
    "root",
    "hips",
    "spine",
    "chest",
    "neck",
    "head",
    "tail",
    "frontLeftUpperLeg",
    "frontLeftLowerLeg",
    "frontLeftPaw",
    "frontRightUpperLeg",
    "frontRightLowerLeg",
    "frontRightPaw",
    "rearLeftUpperLeg",
    "rearLeftLowerLeg",
    "rearLeftPaw",
    "rearRightUpperLeg",
    "rearRightLowerLeg",
    "rearRightPaw",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectorObjectKind {
    Solid,
    Model,
    Performer,
    Plate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectorSolidShape {
    Box,
    Sphere,
    Cylinder,
    Plane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectorActorAccessory {
    None,
    Cane,
    Horns,
    Crown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectorPose {
    Neutral,
    Stand,
    TPose,
    Walk,
    Run,
    Sit,
    Squat,
    KneelSingle,
    KneelDouble,
    HandsHips,
    Lean,
    Bow,
    Think,
    Fight,
    Kick,
    Throw,
    Push,
    Wave,
    Reach,
    ArmsCrossed,
    Phone,
    AnimalStand,
    AnimalSit,
    AnimalLie,
    AnimalWalk,
    AnimalRun,
    AnimalAlert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectorEasing {
    Step,
    Linear,
    Smooth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectorCameraMove {
    Static,
    PushIn,
    PullOut,
    PanLeft,
    PanRight,
    TiltUp,
    TiltDown,
    OrbitLeft,
    OrbitRight,
    Handheld,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectorShotSize {
    ExtremeWide,
    Wide,
    Full,
    Medium,
    CloseUp,
    ExtremeCloseUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DirectorAspectRatio {
    #[serde(rename = "16:9")]
    Wide,
    #[serde(rename = "9:16")]
    Tall,
    #[serde(rename = "4:5")]
    FourFive,
    #[serde(rename = "2.39:1")]
    Scope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectorLightType {
    Directional,
    Point,
    Spot,
    Ambient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectorRigStatus {
    Unmapped,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorTransform {
    pub position: DirectorVec3,
    pub rotation: DirectorVec3,
    pub scale: DirectorVec3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorKeyframe {
    pub id: String,
    pub time: f64,
    pub transform: DirectorTransform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub easing: Option<DirectorEasing>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorBoneKeyframe {
    pub id: String,
    pub time: f64,
    pub rotation: DirectorQuat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub easing: Option<DirectorEasing>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorBoneTrack {
    pub bone: String,
    pub keyframes: Vec<DirectorBoneKeyframe>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorActorBuild {
    pub stature: f64,
    pub head_scale: f64,
    pub shoulder_span: f64,
    pub torso_share: f64,
    pub accessory: DirectorActorAccessory,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorAnimalBuild {
    pub shoulder_height: f64,
    pub body_length: f64,
    pub body_width: f64,
    pub head_scale: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorRig {
    pub status: DirectorRigStatus,
    #[serde(default)]
    pub bone_map: std::collections::BTreeMap<String, String>,
    pub animation_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorMotionClip {
    pub id: String,
    pub name: String,
    pub source_animation: String,
    pub start: f64,
    pub duration: f64,
    pub playback_rate: f64,
    #[serde(rename = "loop")]
    pub loop_: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorObject {
    pub id: String,
    pub name: String,
    pub kind: DirectorObjectKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<DirectorSolidShape>,
    pub transform: DirectorTransform,
    pub color: String,
    pub visible: bool,
    pub cast_shadow: bool,
    pub receive_shadow: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pose: Option<DirectorPose>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archetype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_build: Option<DirectorActorBuild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animal_build: Option<DirectorAnimalBuild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rig: Option<DirectorRig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion_clips: Option<Vec<DirectorMotionClip>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_motion_clip_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bone_overrides: Option<std::collections::BTreeMap<String, DirectorQuat>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bone_tracks: Option<Vec<DirectorBoneTrack>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<NodeId>,
    pub keyframes: Vec<DirectorKeyframe>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorCamera {
    pub id: String,
    pub name: String,
    pub transform: DirectorTransform,
    pub target: DirectorVec3,
    pub focal_length: f64,
    pub aperture: f64,
    pub focus_distance: f64,
    pub near: f64,
    pub far: f64,
    pub keyframes: Vec<DirectorKeyframe>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorLight {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub light_type: DirectorLightType,
    pub transform: DirectorTransform,
    pub color: String,
    pub intensity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub penumbra: Option<f64>,
    pub cast_shadow: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorShot {
    pub id: String,
    pub name: String,
    pub camera_id: String,
    pub duration: f64,
    pub fps: u8,
    pub aspect_ratio: DirectorAspectRatio,
    pub shot_size: DirectorShotSize,
    pub camera_move: DirectorCameraMove,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorEnvironment {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_as_lighting: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lighting_intensity: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorScene {
    pub id: String,
    pub schema_version: i32,
    pub title: String,
    pub background: String,
    pub environment_intensity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<DirectorEnvironment>,
    pub grid_visible: bool,
    pub objects: Vec<DirectorObject>,
    pub cameras: Vec<DirectorCamera>,
    pub lights: Vec<DirectorLight>,
    pub shots: Vec<DirectorShot>,
    pub active_shot_id: String,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorState {
    pub scene_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking_asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_shot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<IsoTimestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectorIssue {
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

fn issue(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> DirectorIssue {
    DirectorIssue {
        code,
        path: path.into(),
        message: message.into(),
    }
}

fn finite(value: f64) -> bool {
    value.is_finite()
}

fn vec3(value: &DirectorVec3) -> bool {
    value.iter().all(|entry| finite(*entry))
}

fn color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn humanoid(archetype: &str) -> bool {
    DIRECTOR_HUMANOID_ARCHETYPES.contains(&archetype)
}

fn animal(archetype: &str) -> bool {
    DIRECTOR_ANIMAL_ARCHETYPES.contains(&archetype)
}

fn humanoid_pose(pose: DirectorPose) -> bool {
    !matches!(
        pose,
        DirectorPose::AnimalStand
            | DirectorPose::AnimalSit
            | DirectorPose::AnimalLie
            | DirectorPose::AnimalWalk
            | DirectorPose::AnimalRun
            | DirectorPose::AnimalAlert
    )
}

fn bone_in(bone: &str, bones: &[&str]) -> bool {
    bones.contains(&bone)
}

fn transform_issues(transform: &DirectorTransform, path: &str, issues: &mut Vec<DirectorIssue>) {
    if !vec3(&transform.position) {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.position"),
            "position must be three finite numbers",
        ));
    }
    if !vec3(&transform.rotation) {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.rotation"),
            "rotation must be three finite numbers",
        ));
    }
    if !vec3(&transform.scale) || transform.scale.iter().any(|axis| axis.abs() < 1e-4) {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.scale"),
            "scale must be three numbers with no axis near zero",
        ));
    }
}

fn keyframe_issues(keyframes: &[DirectorKeyframe], path: &str, issues: &mut Vec<DirectorIssue>) {
    if keyframes.len() > MAX_DIRECTOR_KEYFRAMES_PER_TRACK {
        issues.push(issue(
            "DIRECTOR_LIMIT_EXCEEDED",
            path,
            format!("{path} holds more than {MAX_DIRECTOR_KEYFRAMES_PER_TRACK} keyframes"),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for (index, keyframe) in keyframes.iter().enumerate() {
        let at = format!("{path}[{index}]");
        if !seen.insert(keyframe.id.as_str()) {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                format!("{at}.id"),
                format!("duplicate keyframe id \"{}\"", keyframe.id),
            ));
        }
        if !finite(keyframe.time) || keyframe.time < 0.0 {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{at}.time"),
                "time must be a finite number of seconds",
            ));
        }
        transform_issues(&keyframe.transform, &format!("{at}.transform"), issues);
    }
}

fn actor_issues(object: &DirectorObject, path: &str, issues: &mut Vec<DirectorIssue>) {
    let form_humanoid = object.archetype.as_deref().map(humanoid).unwrap_or(false);
    let form_animal = object.archetype.as_deref().map(animal).unwrap_or(false);
    if !form_humanoid && !form_animal {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.archetype"),
            "a performer needs a humanoid or animal archetype",
        ));
        return;
    }
    if let Some(pose) = object.pose {
        if form_humanoid && !humanoid_pose(pose) {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                format!("{path}.pose"),
                "this pose is not one a humanoid offers",
            ));
        }
        if form_animal && humanoid_pose(pose) {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                format!("{path}.pose"),
                "this pose is not one a quadruped offers",
            ));
        }
    }
    if form_humanoid && object.animal_build.is_some() {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.animalBuild"),
            "a humanoid may not carry an animal build",
        ));
    }
    if form_animal && object.actor_build.is_some() {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.actorBuild"),
            "a quadruped may not carry an actor build",
        ));
    }
    if form_humanoid && object.actor_build.is_none() && object.asset_id.is_none() {
        issues.push(issue(
            "DIRECTOR_REFERENCE_INVALID",
            format!("{path}.actorBuild"),
            "a procedural humanoid needs an actor build",
        ));
    }
    if form_animal && object.animal_build.is_none() {
        issues.push(issue(
            "DIRECTOR_REFERENCE_INVALID",
            format!("{path}.animalBuild"),
            "a quadruped needs an animal build",
        ));
    }
    if let Some(build) = &object.actor_build {
        if !finite(build.stature)
            || !(0.5..=2.5).contains(&build.stature)
            || !finite(build.head_scale)
            || !(0.5..=2.0).contains(&build.head_scale)
            || !finite(build.shoulder_span)
            || !(0.1..=1.2).contains(&build.shoulder_span)
            || !finite(build.torso_share)
            || !(0.25..=0.40).contains(&build.torso_share)
        {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.actorBuild"),
                "the actor build is outside its ranges",
            ));
        }
    }
    if let Some(build) = &object.animal_build {
        if !finite(build.shoulder_height)
            || !(0.15..=2.5).contains(&build.shoulder_height)
            || !finite(build.body_length)
            || !(0.2..=4.0).contains(&build.body_length)
            || !finite(build.body_width)
            || !(0.05..=1.2).contains(&build.body_width)
            || !finite(build.head_scale)
            || !(0.5..=2.0).contains(&build.head_scale)
        {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.animalBuild"),
                "the animal build is outside its ranges",
            ));
        }
    }
    let bones: &[&str] = if form_animal {
        &DIRECTOR_QUADRUPED_BONES
    } else {
        &DIRECTOR_HUMANOID_BONES
    };
    if let Some(overrides) = &object.bone_overrides {
        for (bone, rotation) in overrides {
            if !bone_in(bone, bones) {
                issues.push(issue(
                    "DIRECTOR_REFERENCE_INVALID",
                    format!("{path}.boneOverrides.{bone}"),
                    "this bone does not belong to the actor's form",
                ));
            }
            if !rotation.iter().all(|entry| finite(*entry)) {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{path}.boneOverrides.{bone}"),
                    "a bone override is a four-number quaternion",
                ));
            }
        }
    }
    for (index, track) in object.bone_tracks.iter().flatten().enumerate() {
        let at = format!("{path}.boneTracks[{index}]");
        if !bone_in(&track.bone, bones) {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                format!("{at}.bone"),
                "this bone does not belong to the actor's form",
            ));
        }
        if track.keyframes.len() > MAX_DIRECTOR_KEYFRAMES_PER_TRACK {
            issues.push(issue(
                "DIRECTOR_LIMIT_EXCEEDED",
                format!("{at}.keyframes"),
                format!("a bone track holds at most {MAX_DIRECTOR_KEYFRAMES_PER_TRACK} keyframes"),
            ));
        }
        for (frame_index, keyframe) in track.keyframes.iter().enumerate() {
            let frame_at = format!("{at}.keyframes[{frame_index}]");
            if !finite(keyframe.time) || keyframe.time < 0.0 {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{frame_at}.time"),
                    "time must be a finite number of seconds",
                ));
            }
            if !keyframe.rotation.iter().all(|entry| finite(*entry)) {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{frame_at}.rotation"),
                    "a bone keyframe is a four-number quaternion",
                ));
            }
        }
    }
}

fn rig_issues(object: &DirectorObject, path: &str, issues: &mut Vec<DirectorIssue>) {
    if let Some(rig) = &object.rig {
        let mut mapped = 0;
        for (bone, name) in &rig.bone_map {
            if !bone_in(bone, &DIRECTOR_HUMANOID_BONES) {
                issues.push(issue(
                    "DIRECTOR_REFERENCE_INVALID",
                    format!("{path}.rig.boneMap.{bone}"),
                    "this is not a humanoid bone",
                ));
            }
            if !name.trim().is_empty() {
                mapped += 1;
            }
        }
        if rig.status == DirectorRigStatus::Ready && mapped < 8 {
            issues.push(issue(
                "DIRECTOR_RIG_UNMAPPED",
                format!("{path}.rig.boneMap"),
                format!("a ready rig maps at least eight bones; this maps {mapped}"),
            ));
        }
    }
    if let Some(clips) = &object.motion_clips {
        let names: std::collections::HashSet<&str> = object
            .rig
            .as_ref()
            .map(|rig| {
                rig.animation_names
                    .iter()
                    .map(String::as_str)
                    .collect::<std::collections::HashSet<_>>()
            })
            .unwrap_or_default();
        let mut ids = std::collections::HashSet::new();
        for (index, clip) in clips.iter().enumerate() {
            let at = format!("{path}.motionClips[{index}]");
            if !ids.insert(clip.id.as_str()) {
                issues.push(issue(
                    "DIRECTOR_REFERENCE_INVALID",
                    format!("{at}.id"),
                    "duplicate motion clip id",
                ));
            }
            if !names.contains(clip.source_animation.as_str()) {
                issues.push(issue(
                    "DIRECTOR_REFERENCE_INVALID",
                    format!("{at}.sourceAnimation"),
                    "this animation is not in the rig",
                ));
            }
            if !finite(clip.start) || clip.start < 0.0 {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{at}.start"),
                    "start must be finite and non-negative",
                ));
            }
            if !finite(clip.duration) || clip.duration <= 0.0 {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{at}.duration"),
                    "duration must be positive",
                ));
            }
            if !finite(clip.playback_rate) || clip.playback_rate <= 0.0 {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{at}.playbackRate"),
                    "playback rate must be positive",
                ));
            }
        }
        if let Some(active) = &object.active_motion_clip_id {
            if !clips.iter().any(|clip| &clip.id == active) {
                issues.push(issue(
                    "DIRECTOR_REFERENCE_INVALID",
                    format!("{path}.activeMotionClipId"),
                    "the active clip is not in the clip list",
                ));
            }
        }
    }
}

fn object_issues(object: &DirectorObject, index: usize, issues: &mut Vec<DirectorIssue>) {
    let path = format!("objects[{index}]");
    if object.id.is_empty() {
        issues.push(issue(
            "DIRECTOR_REFERENCE_INVALID",
            format!("{path}.id"),
            "an object needs an id",
        ));
    }
    if object.name.chars().count() > MAX_DIRECTOR_NAME_LENGTH {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.name"),
            "a name is at most 120 characters",
        ));
    }
    transform_issues(&object.transform, &format!("{path}.transform"), issues);
    if !color(&object.color) {
        issues.push(issue(
            "VALIDATION_FAILED",
            format!("{path}.color"),
            "a colour is #rrggbb in lower case",
        ));
    }
    keyframe_issues(&object.keyframes, &format!("{path}.keyframes"), issues);
    let actor_fields = object.pose.is_some()
        || object.archetype.is_some()
        || object.actor_build.is_some()
        || object.animal_build.is_some()
        || object.bone_overrides.is_some()
        || object.bone_tracks.is_some();
    match object.kind {
        DirectorObjectKind::Solid => {
            if object.shape.is_none() {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{path}.shape"),
                    "a solid needs a shape",
                ));
            }
            if actor_fields {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    path.clone(),
                    "a solid carries no actor fields",
                ));
            }
            if object.rig.is_some() || object.motion_clips.is_some() || object.asset_id.is_some() {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    path.clone(),
                    "a solid carries neither an asset nor a rig",
                ));
            }
        }
        DirectorObjectKind::Plate => {
            if object.asset_id.is_none() {
                issues.push(issue(
                    "DIRECTOR_REFERENCE_INVALID",
                    format!("{path}.assetId"),
                    "a plate needs an image asset",
                ));
            }
            if actor_fields {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    path.clone(),
                    "a plate carries no actor fields",
                ));
            }
            if object.rig.is_some() || object.motion_clips.is_some() {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    path.clone(),
                    "a plate carries no rig",
                ));
            }
        }
        DirectorObjectKind::Model => {
            if object.asset_id.is_none() {
                issues.push(issue(
                    "DIRECTOR_REFERENCE_INVALID",
                    format!("{path}.assetId"),
                    "a model needs a model asset",
                ));
            }
            if actor_fields {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    path.clone(),
                    "a model carries no actor fields; use a performer for a rig",
                ));
            }
            rig_issues(object, &path, issues);
        }
        DirectorObjectKind::Performer => {
            actor_issues(object, &path, issues);
            rig_issues(object, &path, issues);
        }
    }
}

/// Everything wrong with a scene, as paths a reader can act on.
pub fn scene_issues(scene: &DirectorScene) -> Vec<DirectorIssue> {
    let mut issues = Vec::new();
    if scene.schema_version != DIRECTOR_SCHEMA_VERSION {
        issues.push(issue(
            "DIRECTOR_SCHEMA_UNSUPPORTED",
            "schemaVersion",
            format!("scene version {} is not supported", scene.schema_version),
        ));
    }
    if scene.title.chars().count() > MAX_DIRECTOR_NAME_LENGTH {
        issues.push(issue(
            "VALIDATION_FAILED",
            "title",
            "a scene title is at most 120 characters",
        ));
    }
    if !color(&scene.background) {
        issues.push(issue(
            "VALIDATION_FAILED",
            "background",
            "the background is #rrggbb in lower case",
        ));
    }
    if !finite(scene.environment_intensity) || scene.environment_intensity < 0.0 {
        issues.push(issue(
            "VALIDATION_FAILED",
            "environmentIntensity",
            "the environment intensity must be finite and non-negative",
        ));
    }
    if let Some(environment) = &scene.environment {
        if environment.mode != "color" && environment.mode != "panorama" {
            issues.push(issue(
                "VALIDATION_FAILED",
                "environment.mode",
                "the environment is color or panorama",
            ));
        }
        if environment.mode == "panorama" && environment.asset_id.is_none() {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                "environment.assetId",
                "a panorama needs an image asset",
            ));
        }
    }
    if scene.objects.len() > MAX_DIRECTOR_OBJECTS_PER_SCENE {
        issues.push(issue(
            "DIRECTOR_LIMIT_EXCEEDED",
            "objects",
            format!("a scene holds at most {MAX_DIRECTOR_OBJECTS_PER_SCENE} objects"),
        ));
    }
    if scene.cameras.len() > MAX_DIRECTOR_CAMERAS_PER_SCENE {
        issues.push(issue(
            "DIRECTOR_LIMIT_EXCEEDED",
            "cameras",
            format!("a scene holds at most {MAX_DIRECTOR_CAMERAS_PER_SCENE} cameras"),
        ));
    }
    if scene.lights.len() > MAX_DIRECTOR_LIGHTS_PER_SCENE {
        issues.push(issue(
            "DIRECTOR_LIMIT_EXCEEDED",
            "lights",
            format!("a scene holds at most {MAX_DIRECTOR_LIGHTS_PER_SCENE} lights"),
        ));
    }
    if scene.shots.len() > MAX_DIRECTOR_SHOTS_PER_SCENE {
        issues.push(issue(
            "DIRECTOR_LIMIT_EXCEEDED",
            "shots",
            format!("a scene holds at most {MAX_DIRECTOR_SHOTS_PER_SCENE} shots"),
        ));
    }
    if scene.shots.is_empty() {
        issues.push(issue(
            "DIRECTOR_REFERENCE_INVALID",
            "shots",
            "a scene needs at least one shot",
        ));
    }
    if scene.cameras.is_empty() {
        issues.push(issue(
            "DIRECTOR_REFERENCE_INVALID",
            "cameras",
            "a scene needs at least one camera",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    let mut notice = |id: &str, path: String, issues: &mut Vec<DirectorIssue>| {
        if id.is_empty() {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                path,
                "an id is required",
            ));
        } else if !ids.insert(id.to_string()) {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                path,
                format!("id \"{id}\" is used more than once in the scene"),
            ));
        }
    };
    for (index, object) in scene.objects.iter().enumerate() {
        notice(&object.id, format!("objects[{index}].id"), &mut issues);
        object_issues(object, index, &mut issues);
    }
    let camera_ids: std::collections::HashSet<&str> = scene
        .cameras
        .iter()
        .map(|camera| camera.id.as_str())
        .collect();
    for (index, camera) in scene.cameras.iter().enumerate() {
        let path = format!("cameras[{index}]");
        notice(&camera.id, format!("{path}.id"), &mut issues);
        transform_issues(&camera.transform, &format!("{path}.transform"), &mut issues);
        if !vec3(&camera.target) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.target"),
                "a camera target is three finite numbers",
            ));
        }
        if !finite(camera.focal_length) || !(12.0..=300.0).contains(&camera.focal_length) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.focalLength"),
                "the focal length is between 12 and 300 mm",
            ));
        }
        if !finite(camera.aperture) || !(1.2..=22.0).contains(&camera.aperture) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.aperture"),
                "the aperture is between f/1.2 and f/22",
            ));
        }
        if !finite(camera.focus_distance) || !(0.1..=1000.0).contains(&camera.focus_distance) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.focusDistance"),
                "the focus distance is between 0.1 and 1000 m",
            ));
        }
        if !finite(camera.near) || camera.near <= 0.0 {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.near"),
                "the near plane is positive",
            ));
        }
        if !finite(camera.far) || camera.far <= camera.near {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.far"),
                "the far plane is behind the near plane",
            ));
        }
        keyframe_issues(&camera.keyframes, &format!("{path}.keyframes"), &mut issues);
    }
    for (index, light) in scene.lights.iter().enumerate() {
        let path = format!("lights[{index}]");
        notice(&light.id, format!("{path}.id"), &mut issues);
        transform_issues(&light.transform, &format!("{path}.transform"), &mut issues);
        if !color(&light.color) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.color"),
                "a colour is #rrggbb in lower case",
            ));
        }
        if !finite(light.intensity) || !(0.0..=100.0).contains(&light.intensity) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.intensity"),
                "the intensity is between 0 and 100",
            ));
        }
        if let Some(angle) = light.angle {
            if !finite(angle) || angle <= 0.0 || angle > std::f64::consts::FRAC_PI_2 {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{path}.angle"),
                    "a spot angle is between 0 and 90 degrees",
                ));
            }
        }
        if let Some(penumbra) = light.penumbra {
            if !finite(penumbra) || !(0.0..=1.0).contains(&penumbra) {
                issues.push(issue(
                    "VALIDATION_FAILED",
                    format!("{path}.penumbra"),
                    "a spot penumbra is between 0 and 1",
                ));
            }
        }
    }
    for (index, shot) in scene.shots.iter().enumerate() {
        let path = format!("shots[{index}]");
        notice(&shot.id, format!("{path}.id"), &mut issues);
        if shot.name.chars().count() > MAX_DIRECTOR_NAME_LENGTH {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.name"),
                "a name is at most 120 characters",
            ));
        }
        if !camera_ids.contains(shot.camera_id.as_str()) {
            issues.push(issue(
                "DIRECTOR_REFERENCE_INVALID",
                format!("{path}.cameraId"),
                "the shot's camera is not in the scene",
            ));
        }
        if !finite(shot.duration) || !(0.5..=60.0).contains(&shot.duration) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.duration"),
                "a shot runs between 0.5 and 60 seconds",
            ));
        }
        if ![24, 25, 30].contains(&shot.fps) {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.fps"),
                "a shot runs at 24, 25, or 30 frames a second",
            ));
        }
        if shot.prompt.chars().count() > crate::domain::validate::MAX_PROMPT_LENGTH {
            issues.push(issue(
                "VALIDATION_FAILED",
                format!("{path}.prompt"),
                "a prompt is too long",
            ));
        }
    }
    if !scene
        .shots
        .iter()
        .any(|shot| shot.id == scene.active_shot_id)
    {
        issues.push(issue(
            "DIRECTOR_REFERENCE_INVALID",
            "activeShotId",
            "the active shot is not in the scene",
        ));
    }
    issues
}

/// Every project file a scene reads.
pub fn scene_asset_ids(scene: &DirectorScene) -> Vec<AssetId> {
    let mut ids = Vec::new();
    if let Some(asset_id) = scene
        .environment
        .as_ref()
        .and_then(|environment| environment.asset_id.clone())
    {
        ids.push(asset_id);
    }
    for object in &scene.objects {
        if let Some(asset_id) = &object.asset_id {
            if !ids.contains(asset_id) {
                ids.push(asset_id.clone());
            }
        }
    }
    ids
}
