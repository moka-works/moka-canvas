//! The words this application asks a model with, kept out of the code that
//! sends them.
//!
//! A prompt written into a `.rs` file is a sentence nobody thinks to look for
//! when the answer coming back is wrong, and one kept under `prompts/` is a file
//! a reader can open, change, and read again without first finding the call site
//! that happens to send it. Every template is read out of the binary rather than
//! off the disk, so the words a build asks with are the words that build was
//! tested with, and there is no third thing to keep in step with them.
//!
//! The web client keeps its own set beside the code that sends it. The two are
//! built by different tools into different binaries, and a template that had to
//! be served to a browser before it could be read would make a prompt depend on
//! a request that has nothing to do with it.

use std::sync::OnceLock;

use minijinja::{AutoEscape, Environment};
use serde::Serialize;
use thiserror::Error;

/// One prompt template, embedded in the binary at build time.
///
/// Named here rather than reached for by a string at the call site, so that a
/// template which goes missing is a compile error instead of a failure at the
/// moment somebody asks for it, and so that [`verify`] has a list to walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    /// What a plate turned to a new angle asks for, with the angles named in it.
    /// Carries `angles`: the phrases below, in the order they were asked for.
    Tilt,
    /// One turn of the subject, as the phrase [`Prompt::Tilt`] lists it. Carries
    /// `degrees` and `side`.
    TiltTurn,
    /// One tip of the subject, as the phrase [`Prompt::Tilt`] lists it. Carries
    /// `degrees` and `way`.
    TiltTip,
    /// The standing instruction every written story answer is given.
    StorySystem,
    /// The shape of a telling — aspect, genre, style, running time — every
    /// story ask begins with.
    StoryFacts,
    /// A premise written as chapters.
    StoryOutline,
    /// The characters, places and things a telling is made of.
    StoryElements,
    /// One chapter written again in its place in the telling.
    StoryChapter,
    /// A chapter's acts planned before their shots.
    StoryActPlan,
    /// A chapter boarded as acts and shots.
    StoryStoryboard,
    /// A manuscript cut into chapters at the places its own text divides.
    StorySplit,
    /// The same cut asked again where a quotation could not be found.
    StorySplitRepair,
    /// The instruction a cut is answered under.
    StorySplitSystem,
    /// A board checked for staging that runs on across shots.
    StoryContinuity,
    /// A board revised from a newer outline.
    StoryRevision,
    /// A bridge filmed between two neighbouring clips.
    StoryTransitionVideo,
    /// The readings of one element's appearances reconciled.
    StoryMergeElements,
    /// One still frame of a board, drawn from its words and cast.
    StoryKeyframe,
    /// One act filmed, from the frames or words its shots carry.
    StoryActVideo,
    /// One shot filmed from its own frame.
    StoryKeyframeVideo,
    /// The music and sound under one act.
    StoryActMusic,
    /// A character, place or thing drawn on its own.
    StoryElementMain,
    /// Four views of one character on one sheet.
    StoryElementTurnaround,
}

impl Prompt {
    /// Every template there is, so a startup check walks all of them rather than
    /// the ones somebody remembered to list.
    pub const ALL: [Prompt; 23] = [
        Prompt::Tilt,
        Prompt::TiltTurn,
        Prompt::TiltTip,
        Prompt::StorySystem,
        Prompt::StoryFacts,
        Prompt::StoryOutline,
        Prompt::StoryElements,
        Prompt::StoryChapter,
        Prompt::StoryActPlan,
        Prompt::StoryStoryboard,
        Prompt::StorySplit,
        Prompt::StorySplitRepair,
        Prompt::StorySplitSystem,
        Prompt::StoryContinuity,
        Prompt::StoryRevision,
        Prompt::StoryTransitionVideo,
        Prompt::StoryMergeElements,
        Prompt::StoryKeyframe,
        Prompt::StoryActVideo,
        Prompt::StoryKeyframeVideo,
        Prompt::StoryActMusic,
        Prompt::StoryElementMain,
        Prompt::StoryElementTurnaround,
    ];

    /// The name this template is registered under, which is also its path under
    /// `prompts/` without the suffix.
    pub fn name(self) -> &'static str {
        match self {
            Self::Tilt => "imaging/tilt",
            Self::TiltTurn => "imaging/tilt-turn",
            Self::TiltTip => "imaging/tilt-tip",
            Self::StorySystem => "story/system",
            Self::StoryFacts => "story/facts",
            Self::StoryOutline => "story/outline",
            Self::StoryElements => "story/elements",
            Self::StoryChapter => "story/chapter",
            Self::StoryActPlan => "story/act-plan",
            Self::StoryStoryboard => "story/storyboard",
            Self::StorySplit => "story/split",
            Self::StorySplitRepair => "story/split-repair",
            Self::StorySplitSystem => "story/split-system",
            Self::StoryContinuity => "story/continuity",
            Self::StoryRevision => "story/revise",
            Self::StoryTransitionVideo => "story/transition-video",
            Self::StoryMergeElements => "story/merge-elements",
            Self::StoryKeyframe => "story/keyframe",
            Self::StoryActVideo => "story/act-video",
            Self::StoryKeyframeVideo => "story/keyframe-video",
            Self::StoryActMusic => "story/act-music",
            Self::StoryElementMain => "story/element-main",
            Self::StoryElementTurnaround => "story/element-turnaround",
        }
    }

    /// The template's own text, out of the binary.
    ///
    /// One trailing newline is taken off it: a file that ends with a line break
    /// is what an editor writes and what a reader expects to see, and a newline
    /// at the end of a prompt is neither.
    fn source(self) -> &'static str {
        let text = match self {
            Self::Tilt => include_str!("../../../prompts/imaging/tilt.tmpl"),
            Self::TiltTurn => include_str!("../../../prompts/imaging/tilt-turn.tmpl"),
            Self::TiltTip => include_str!("../../../prompts/imaging/tilt-tip.tmpl"),
            // The story prompts are the web client's own files: one copy of
            // each, so an ask made from the CLI and one made in the room are
            // the same words by construction.
            Self::StorySystem => {
                include_str!("../../../../src/shared/prompts/story/system.tmpl")
            }
            Self::StoryFacts => include_str!("../../../../src/shared/prompts/story/facts.tmpl"),
            Self::StoryOutline => include_str!("../../../../src/shared/prompts/story/outline.tmpl"),
            Self::StoryElements => {
                include_str!("../../../../src/shared/prompts/story/elements.tmpl")
            }
            Self::StoryChapter => {
                include_str!("../../../../src/shared/prompts/story/chapter.tmpl")
            }
            Self::StoryActPlan => {
                include_str!("../../../../src/shared/prompts/story/act-plan.tmpl")
            }
            Self::StoryStoryboard => {
                include_str!("../../../../src/shared/prompts/story/storyboard.tmpl")
            }
            Self::StorySplit => {
                include_str!("../../../../src/shared/prompts/story/split.tmpl")
            }
            Self::StorySplitRepair => {
                include_str!("../../../../src/shared/prompts/story/split-repair.tmpl")
            }
            Self::StorySplitSystem => {
                include_str!("../../../../src/shared/prompts/story/split-system.tmpl")
            }
            Self::StoryContinuity => {
                include_str!("../../../../src/shared/prompts/story/continuity.tmpl")
            }
            Self::StoryRevision => {
                include_str!("../../../../src/shared/prompts/story/revise.tmpl")
            }
            Self::StoryTransitionVideo => {
                include_str!("../../../../src/shared/prompts/story/transition-video.tmpl")
            }
            Self::StoryMergeElements => {
                include_str!("../../../../src/shared/prompts/story/merge-elements.tmpl")
            }
            Self::StoryKeyframe => {
                include_str!("../../../../src/shared/prompts/story/keyframe.tmpl")
            }
            Self::StoryActVideo => {
                include_str!("../../../../src/shared/prompts/story/act-video.tmpl")
            }
            Self::StoryKeyframeVideo => {
                include_str!("../../../../src/shared/prompts/story/keyframe-video.tmpl")
            }
            Self::StoryActMusic => {
                include_str!("../../../../src/shared/prompts/story/act-music.tmpl")
            }
            Self::StoryElementMain => {
                include_str!("../../../../src/shared/prompts/story/element-main.tmpl")
            }
            Self::StoryElementTurnaround => {
                include_str!("../../../../src/shared/prompts/story/element-turnaround.tmpl")
            }
        };
        text.strip_suffix('\n').unwrap_or(text)
    }
}

/// Why a template could not say what it was asked to.
#[derive(Debug, Error)]
pub enum PromptError {
    /// The template is not a template. Nothing a reader did can cause this: the
    /// text was embedded at build time, and it is what [`verify`] looks for
    /// before anything asks for it.
    #[error("the {0} prompt template does not compile: {1}")]
    Invalid(&'static str, String),
    /// The template is sound, and the context handed to it is not something the
    /// template can be read with.
    #[error("the {0} prompt template could not be rendered: {1}")]
    Render(&'static str, String),
}

/// The compiled templates, built once for the process.
static ENVIRONMENT: OnceLock<Environment<'static>> = OnceLock::new();

fn environment() -> Result<&'static Environment<'static>, PromptError> {
    if let Some(built) = ENVIRONMENT.get() {
        return Ok(built);
    }
    let mut built = Environment::new();
    // A prompt is plain words rather than a page, so nothing in one is escaped:
    // an ampersand asked for is an ampersand sent, and a template that turned it
    // into a character reference would be asking for something else.
    built.set_auto_escape_callback(|_| AutoEscape::None);
    for prompt in Prompt::ALL {
        built
            .add_template(prompt.name(), prompt.source())
            .map_err(|error| PromptError::Invalid(prompt.name(), error.to_string()))?;
    }
    // Two callers can compile at the same moment, and both compile the same
    // templates out of the same binary, so the one that loses the race drops its
    // copy and reads the winner's.
    let _ = ENVIRONMENT.set(built);
    // Filled either by this call or by the one that beat it to the cell, so
    // there is no third answer to handle.
    Ok(ENVIRONMENT
        .get()
        .expect("the cell was filled by this call or before it"))
}

/// One template's words, with `context` filling the holes in them.
///
/// The context carries what the caller has to say and nothing else. A key the
/// template does not name is ignored, and one the template names and the context
/// does not carry is written as nothing: a hole in a prompt is a thing a reader
/// can see in the answer, and a request that never went out is not.
pub fn render(prompt: Prompt, context: &impl Serialize) -> Result<String, PromptError> {
    let template = environment()?
        .get_template(prompt.name())
        .map_err(|error| PromptError::Invalid(prompt.name(), error.to_string()))?;
    template
        .render(context)
        .map_err(|error| PromptError::Render(prompt.name(), error.to_string()))
}

/// Compiles every embedded template, which is all a startup check can do without
/// knowing what each one will be asked for.
///
/// Called before anything can ask, so a template that does not parse is a
/// refusal to start rather than a failure at the first request that reaches it.
pub fn verify() -> Result<(), PromptError> {
    environment()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_template_compiles() {
        assert!(
            verify().is_ok(),
            "a template that does not parse is a build fault"
        );
    }

    #[test]
    fn one_angle_is_said_on_its_own() {
        let turned = render(Prompt::TiltTurn, &json!({ "degrees": 20, "side": "right" })).unwrap();
        assert_eq!(turned, "turned 20° to the right");

        let asked = render(Prompt::Tilt, &json!({ "angles": [turned] })).unwrap();
        assert_eq!(
            asked,
            "The same subject as the reference, turned 20° to the right, seen \
from a different angle. Keep what it is and how it is lit; change only where \
the viewer stands."
        );
    }

    #[test]
    fn two_angles_are_joined_with_the_word_that_joins_them() {
        let turned = render(Prompt::TiltTurn, &json!({ "degrees": 20, "side": "left" })).unwrap();
        let tipped = render(Prompt::TiltTip, &json!({ "degrees": 12, "way": "forward" })).unwrap();
        assert_eq!(tipped, "tipped 12° forward");

        let asked = render(Prompt::Tilt, &json!({ "angles": [turned, tipped] })).unwrap();
        assert!(
            asked.contains("turned 20° to the left and tipped 12° forward"),
            "both angles are said, in the order they were asked for"
        );
    }

    #[test]
    fn no_angles_leaves_the_sentence_to_say_nothing_about_them() {
        let none: Vec<String> = Vec::new();
        let asked = render(Prompt::Tilt, &json!({ "angles": none })).unwrap();
        assert!(asked.starts_with("The same subject as the reference, , seen"));
    }

    #[test]
    fn a_key_the_context_does_not_carry_is_written_as_nothing() {
        let turned = render(Prompt::TiltTurn, &json!({ "degrees": 8 })).unwrap();
        assert_eq!(
            turned, "turned 8° to the ",
            "a hole in a prompt is a thing a reader can see, not a refusal"
        );
    }

    #[test]
    fn a_template_carries_no_newline_of_its_own() {
        for prompt in Prompt::ALL {
            assert!(
                !prompt.source().ends_with('\n'),
                "{} ends with a newline the prompt did not ask for",
                prompt.name()
            );
        }
    }
}
