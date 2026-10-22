//! The JSON ReAct fallback, for models whose protocol has no native tools.
//!
//! A model that can write one object per step can act; it does not need a
//! provider-shaped tool channel. The shape is deliberately small so a model
//! that has never seen it can copy an example and a parser can read it without
//! guessing:
//!
//! ```json
//! {"thought": "I need the timeline first.", "tools": [{"name": "timeline.get", "input": {"timelineId": "tl_1"}}]}
//! {"thought": "Done.", "answer": "Trimmed both clips to 20 seconds."}
//! ```
//!
//! Parsing is forgiving about what surrounds the object — a fenced block, a
//! sentence before it — and strict about the object itself: a step that names
//! neither a tool nor an answer is not a step.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One decision the fallback protocol read out of a model's answer.
#[derive(Debug, Clone, PartialEq)]
pub struct ReActStep {
    pub thought: Option<String>,
    /// One step may ask for several independent reads or edits; the loop
    /// executes them in the order they were written.
    pub tools: Vec<ReActCall>,
    pub answer: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReActCall {
    pub name: String,
    pub input: Value,
}

/// The instructions a model is given when it has no native tool channel.
pub const REACT_INSTRUCTIONS: &str = r#"You act by writing exactly one JSON object per step and nothing else.
To call tools: {"thought":"why","tools":[{"name":"<tool name>","input":{...}}]}
To finish: {"thought":"why","answer":"what you did, briefly"}
Use only tools from the list. Times are integer milliseconds. Read before writing.
Never claim a change succeeded unless a tool result says it did."#;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepWire {
    #[serde(default)]
    thought: Option<String>,
    /// The older single-call shape, still read so a model that learned the
    /// first form keeps working.
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    input: Option<Value>,
    #[serde(default)]
    tools: Vec<WireCall>,
    #[serde(default)]
    answer: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct WireCall {
    name: String,
    #[serde(default)]
    input: Option<Value>,
}

/// Reads the first protocol object in an answer.
///
/// A model can wrap the object in prose or a code fence; both are ordinary.
/// Anything that is not a step is `None`, which the loop reports back to the
/// model as a malformed observation rather than executing.
pub fn parse(text: &str) -> Option<ReActStep> {
    let candidate = extract_object(text)?;
    let step: StepWire = serde_json::from_str(&candidate).ok()?;
    let mut tools: Vec<ReActCall> = step
        .tools
        .into_iter()
        .filter_map(|call| {
            let name = call.name.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(ReActCall {
                name,
                input: call
                    .input
                    .unwrap_or_else(|| Value::Object(Default::default())),
            })
        })
        .collect();
    if tools.is_empty() {
        if let Some(name) = step
            .tool
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            tools.push(ReActCall {
                name: name.to_string(),
                input: step
                    .input
                    .unwrap_or_else(|| Value::Object(Default::default())),
            });
        }
    }
    let answer = step
        .answer
        .map(|answer| answer.trim().to_string())
        .filter(|answer| !answer.is_empty());
    if tools.is_empty() && answer.is_none() {
        return None;
    }
    Some(ReActStep {
        thought: step
            .thought
            .map(|thought| thought.trim().to_string())
            .filter(|thought| !thought.is_empty()),
        tools,
        answer,
    })
}

/// The first balanced `{...}` in the text, ignoring braces inside strings.
fn extract_object(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, byte) in bytes[start..].iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..start + offset + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// The tools as the fallback prompt lists them: one line each, name, risk,
/// and the arguments' required keys.
pub fn tool_lines(tools: &[(String, String, Value)]) -> String {
    tools
        .iter()
        .map(|(name, description, schema)| {
            let required = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|keys| {
                    keys.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            if required.is_empty() {
                format!("- {name}: {description}")
            } else {
                format!("- {name}: {description} (requires: {required})")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_step_is_read_with_its_input() {
        let step = parse(
            r#"I'll look first.
            {"thought":"need the timeline","tool":"timeline.get","input":{"timelineId":"tl_1"}}"#,
        )
        .expect("a step");
        assert_eq!(step.thought.as_deref(), Some("need the timeline"));
        assert_eq!(step.tools.first().expect("a call").name, "timeline.get");
        assert_eq!(step.tools[0].input["timelineId"], "tl_1");
        assert!(step.answer.is_none());
    }

    #[test]
    fn a_fenced_answer_is_read_as_the_end_of_the_turn() {
        let step = parse("```json\n{\"answer\":\"Trimmed both clips.\"}\n```").expect("a step");
        assert_eq!(step.answer.as_deref(), Some("Trimmed both clips."));
        assert!(step.tools.is_empty());
    }

    #[test]
    fn braces_inside_strings_do_not_end_the_object_early() {
        let step =
            parse(r#"{"tool":"asset.update","input":{"note":"a { and a }"}}"#).expect("a step");
        assert_eq!(step.tools[0].input["note"], "a { and a }");
    }

    #[test]
    fn a_step_that_does_nothing_is_not_a_step() {
        assert!(parse("{\"thought\":\"hmm\"}").is_none());
        assert!(parse("no object here").is_none());
        assert!(parse("{\"tool\":\"\"}").is_none());
    }

    #[test]
    fn several_calls_in_one_step_are_read_in_order() {
        let step = parse(
            r#"{"thought":"two reads","tools":[
                {"name":"canvas.list","input":{}},
                {"name":"asset.list","input":{"unused":true}}
            ]}"#,
        )
        .expect("a step");
        assert_eq!(step.tools.len(), 2);
        assert_eq!(step.tools[0].name, "canvas.list");
        assert_eq!(step.tools[1].input["unused"], true);
        assert!(step.answer.is_none());
    }

    #[test]
    fn the_prompt_lists_required_arguments() {
        let listed = tool_lines(&[(
            "clip.trim".to_string(),
            "Trim clips".to_string(),
            serde_json::json!({"type":"object","required":["timelineId","edits"]}),
        )]);
        assert!(listed.contains("clip.trim"));
        assert!(listed.contains("requires: timelineId, edits"));
    }
}
