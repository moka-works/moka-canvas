//! Words turned into an ASS script for the burn-in.
//!
//! Pure: a timeline goes in and the script comes out, so the mapping the
//! preview approximates can be read and asserted line by line. The table is
//! package 11's §5, written the way the subtitle renderer spells it.

use super::fonts::{CJK_FAMILY, LATIN_FAMILY};
use crate::domain::{TextAlign, TextClipStyle, TextPosition, TimelineClip, TimelineDocument};

/// The header and style a script starts with. `Encoding` is 1 because the
/// renderer's own default is, and nothing here has a reason to disagree.
const STYLE_FORMAT: &str = "Format: Name, Fontname, Fontsize, PrimaryColour, \
SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, \
ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, \
MarginL, MarginR, MarginV, Encoding";
const EVENT_FORMAT: &str =
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

/// The share of the frame's height a top or bottom block keeps clear.
const MARGIN_V_SHARE: f64 = 0.06;
/// The share of the frame's width a block keeps at its sides.
const MARGIN_H_SHARE: f64 = 0.05;
/// The plate's padding, in font sizes: the same reference the preview pads by.
const PLATE_PADDING_SHARE: f64 = 0.6;

/// The script for every text clip on a timeline.
///
/// A timeline without words answers with an empty string, which is what the
/// caller tests before writing a file at all.
pub fn build_ass(timeline: &TimelineDocument) -> String {
    let mut clips: Vec<&TimelineClip> = timeline
        .clips
        .iter()
        .filter(|clip| clip.kind == crate::domain::TrackKind::Text)
        .filter(|clip| clip.text.is_some())
        .collect();
    clips.sort_by(|a, b| a.start_ms.cmp(&b.start_ms).then_with(|| a.id.cmp(&b.id)));
    if clips.is_empty() {
        // Nothing to burn in is not an empty script: it is no script, and the
        // caller is the one that knows whether there is a file to write.
        return String::new();
    }

    // The words a style has to draw decide the face it is drawn in: one family
    // per style is all the format carries, and nothing here may lean on the
    // renderer's own fallback, so a style whose words reach past Latin is
    // written in the bundled CJK family outright.
    let mut styles: Vec<(&TextClipStyle, bool)> = Vec::new();
    for clip in &clips {
        let text = clip.text.as_ref().expect("filtered above");
        match styles
            .iter_mut()
            .find(|(held, _)| same_style(held, &text.style))
        {
            Some((_, beyond)) => *beyond = *beyond || beyond_latin(&text.content),
            None => styles.push((&text.style, beyond_latin(&text.content))),
        }
    }

    let width = timeline.settings.width;
    let height = timeline.settings.height;
    let mut out = String::new();
    out.push_str("[Script Info]\n");
    out.push_str(&format!("Title: {}\n", one_line(&timeline.name)));
    out.push_str("ScriptType: v4.00+\n");
    out.push_str("WrapStyle: 0\n");
    out.push_str(&format!("PlayResX: {width}\n"));
    out.push_str(&format!("PlayResY: {height}\n"));
    out.push('\n');
    out.push_str("[V4+ Styles]\n");
    out.push_str(STYLE_FORMAT);
    out.push('\n');
    for (index, (style, beyond)) in styles.iter().enumerate() {
        out.push_str(&style_line(index, style, *beyond, width, height));
        out.push('\n');
    }
    out.push('\n');
    out.push_str("[Events]\n");
    out.push_str(EVENT_FORMAT);
    out.push('\n');
    for clip in &clips {
        let style = &clip.text.as_ref().expect("filtered above").style;
        let at = styles
            .iter()
            .position(|(held, _)| same_style(held, style))
            .expect("every clip's style was collected");
        out.push_str(&dialogue_line(clip, at));
        out.push('\n');
    }
    out
}

/// Whether two styles ask for the same rendered look: every field the style
/// line carries, which is the whole style.
fn same_style(a: &TextClipStyle, b: &TextClipStyle) -> bool {
    a.font_family == b.font_family
        && a.font_size == b.font_size
        && a.color == b.color
        && a.bold == b.bold
        && a.italic == b.italic
        && a.align == b.align
        && a.position == b.position
        && a.background == b.background
        && a.stroke_width == b.stroke_width
        && a.stroke_color == b.stroke_color
}

/// One `Style:` line, named `S<index>`.
fn style_line(
    index: usize,
    style: &TextClipStyle,
    beyond_latin: bool,
    width: i32,
    height: i32,
) -> String {
    let plate = style.background.as_deref();
    // The plate wins over the outline: under `BorderStyle=3` the outline is
    // the plate's padding, so the two cannot both be spelled.
    let (border_style, outline, outline_colour) = match plate {
        Some(colour) => (
            3,
            (style.font_size as f64 * PLATE_PADDING_SHARE)
                .round()
                .max(0.0) as i32,
            bgr(colour),
        ),
        None => (1, style.stroke_width.max(0), bgr(&style.stroke_color)),
    };
    let margin_v = match style.position {
        TextPosition::Center => 0,
        _ => share(height as f64, MARGIN_V_SHARE),
    };
    let margin_h = share(width as f64, MARGIN_H_SHARE);
    format!(
        "Style: S{index},{font},{size},{primary},{primary},{outline_colour},&H00000000,\
{bold},{italic},0,0,100,100,0,0,{border_style},{outline},0,{alignment},{margin_h},{margin_h},\
{margin_v},1",
        font = burn_in_font(style, beyond_latin),
        size = style.font_size.max(0),
        primary = bgr(&style.color),
        bold = if style.bold { -1 } else { 0 },
        italic = if style.italic { -1 } else { 0 },
        alignment = alignment_number(style.align, style.position),
    )
}

/// One `Dialogue:` line. Margins are the style's, so the event carries none.
fn dialogue_line(clip: &TimelineClip, style_index: usize) -> String {
    let data = clip.text.as_ref().expect("only text clips reach here");
    let content = escape_text(&data.content);
    format!(
        "Dialogue: 0,{start},{end},S{style_index},,0000,0000,0000,,{content}",
        start = time_cc(clip.start_ms),
        end = time_cc(clip.start_ms + clip.duration_ms),
    )
}

/// A moment as `H:MM:SS.cc`, in centiseconds, truncated toward zero — the
/// format's own unit, and the one the renderer's clock is read in.
pub fn time_cc(ms: i64) -> String {
    let negative = ms < 0;
    let ms = ms.unsigned_abs();
    let centiseconds = (ms / 10) % 100;
    let seconds = (ms / 1_000) % 60;
    let minutes = (ms / 60_000) % 60;
    let hours = ms / 3_600_000;
    format!(
        "{}{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}",
        if negative { "-" } else { "" }
    )
}

/// A body of words as ASS text: backslashes and braces escaped so they are
/// words rather than markup, and the author's newlines kept as hard breaks.
pub fn escape_text(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    for ch in content.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '\n' => out.push_str("\\N"),
            // A carriage return is half of a Windows line ending the words
            // travelled with; the break itself is the newline.
            '\r' => {}
            other => out.push(other),
        }
    }
    out
}

/// The numeric keypad alignment, which is how the renderer anchors a block.
pub fn alignment_number(align: TextAlign, position: TextPosition) -> i32 {
    let column = match align {
        TextAlign::Left => 1,
        TextAlign::Center => 2,
        TextAlign::Right => 3,
    };
    let row = match position {
        TextPosition::Bottom => 0,
        TextPosition::Center => 3,
        TextPosition::Top => 6,
    };
    column + row
}

/// The family the burn-in is actually written in.
///
/// One family per style is all the format carries, and the renderer's per-glyph
/// fallback is not something this pipeline can lean on: words that reach past
/// Latin are written in the bundled CJK family outright, and Latin words keep
/// the family their stack leads with — the picker's Latin families are the ones
/// installed machines are read against, and the bundled Latin face answers for
/// everything else.
pub fn burn_in_font(style: &TextClipStyle, beyond_latin: bool) -> String {
    if beyond_latin {
        return CJK_FAMILY.to_string();
    }
    first_family(&style.font_family).unwrap_or_else(|| LATIN_FAMILY.to_string())
}

/// The family a stack leads with, quotes and spaces aside — the same reading
/// the font picker does on the TypeScript side.
///
/// The css keywords (`ui-sans-serif`, `system-ui`, `sans-serif`, …) are ways
/// of saying "whatever the system has" rather than families a renderer can be
/// asked for, so a stack made only of them names nothing.
pub fn first_family(stack: &str) -> Option<String> {
    stack
        .split(',')
        .map(|part| {
            part.trim()
                .trim_matches(|ch| ch == '\'' || ch == '"')
                .trim()
                .to_string()
        })
        .find(|family| !family.is_empty() && !is_css_keyword(family))
}

/// Whether a spelling means "whatever the system has" rather than a family.
fn is_css_keyword(family: &str) -> bool {
    const KEYWORDS: [&str; 12] = [
        "ui-sans-serif",
        "ui-serif",
        "ui-monospace",
        "ui-rounded",
        "system-ui",
        "-apple-system",
        "BlinkMacSystemFont",
        "sans-serif",
        "serif",
        "monospace",
        "cursive",
        "fantasy",
    ];
    KEYWORDS
        .iter()
        .any(|keyword| family.eq_ignore_ascii_case(keyword))
}

/// Whether a body of words reaches past the Latin scripts.
///
/// Latin letters with their accents, the punctuation around them, and the
/// currency marks are what the picker's families and the bundled Latin face
/// cover; anything else — Chinese first among them — is drawn from the bundled
/// CJK family, since one family per style is all there is and nothing falls
/// back per glyph.
pub fn beyond_latin(text: &str) -> bool {
    text.chars().any(|ch| {
        let code = ch as u32;
        !(code < 0x0370 || (0x2000..=0x206F).contains(&code) || (0x20A0..=0x20CF).contains(&code))
    })
}

/// `#rrggbb` as the `&H00BBGGRR` the format writes colours in.
pub fn bgr(colour: &str) -> String {
    let hex = colour.strip_prefix('#').unwrap_or(colour);
    if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return "&H00FFFFFF".to_string();
    }
    let r = &hex[0..2];
    let g = &hex[2..4];
    let b = &hex[4..6];
    format!(
        "&H00{}{}{}",
        b.to_uppercase(),
        g.to_uppercase(),
        r.to_uppercase()
    )
}

/// A share of a measure, rounded to the whole pixel the format counts in.
fn share(measure: f64, share: f64) -> i32 {
    (measure * share).round().max(0.0) as i32
}

/// A title flattened to the one line a header field may be.
fn one_line(name: &str) -> String {
    name.replace(['\n', '\r'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::fixtures;
    use crate::domain::{TextClipStyle, TrackKind};

    fn styles_in(ass: &str) -> Vec<&str> {
        ass.lines()
            .filter(|line| line.starts_with("Style: "))
            .collect()
    }

    fn dialogues(ass: &str) -> Vec<&str> {
        ass.lines()
            .filter(|line| line.starts_with("Dialogue: "))
            .collect()
    }

    #[test]
    fn a_moment_is_written_in_centiseconds_and_truncated_toward_zero() {
        assert_eq!(time_cc(0), "0:00:00.00");
        assert_eq!(time_cc(59_999), "0:00:59.99");
        assert_eq!(time_cc(61_234), "0:01:01.23");
        assert_eq!(time_cc(3_600_000), "1:00:00.00");
        assert_eq!(time_cc(10), "0:00:00.01");
    }

    #[test]
    fn words_escape_markup_and_keep_their_own_breaks() {
        assert_eq!(escape_text("a\\b{c}\nd"), "a\\\\b\\{c\\}\\Nd");
        // A Windows line ending is one break, not a break and a stray return.
        assert_eq!(escape_text("one\r\ntwo"), "one\\Ntwo");
    }

    #[test]
    fn alignment_is_the_numeric_keypad() {
        use TextAlign::{Center as Mid, Left, Right};
        use TextPosition::{Bottom, Center, Top};
        assert_eq!(alignment_number(Left, Bottom), 1);
        assert_eq!(alignment_number(Mid, Bottom), 2);
        assert_eq!(alignment_number(Right, Bottom), 3);
        assert_eq!(alignment_number(Left, Center), 4);
        assert_eq!(alignment_number(Mid, Center), 5);
        assert_eq!(alignment_number(Right, Center), 6);
        assert_eq!(alignment_number(Left, Top), 7);
        assert_eq!(alignment_number(Mid, Top), 8);
        assert_eq!(alignment_number(Right, Top), 9);
    }

    #[test]
    fn a_stack_names_its_first_family_and_the_keywords_name_nothing() {
        assert_eq!(
            first_family("Inter, ui-sans-serif, system-ui"),
            Some("Inter".to_string())
        );
        assert_eq!(
            first_family("\"Courier New\", Courier, monospace"),
            Some("Courier New".to_string())
        );
        assert_eq!(first_family("ui-sans-serif, system-ui, sans-serif"), None);
        assert_eq!(first_family(""), None);
    }

    #[test]
    fn words_past_latin_take_the_bundled_cjk_family() {
        // A plain Latin body stays with whatever the stack names…
        let style = fixtures::text_style();
        assert_eq!(burn_in_font(&style, false), "Inter");
        // …while anything past Latin is drawn from the face that has it.
        assert_eq!(burn_in_font(&style, true), CJK_FAMILY);
        // A stack that names nothing falls back to the bundled Latin face.
        let keyworded = TextClipStyle {
            font_family: "ui-sans-serif, system-ui, sans-serif".to_string(),
            ..fixtures::text_style()
        };
        assert_eq!(burn_in_font(&keyworded, false), LATIN_FAMILY);

        assert!(!beyond_latin("Hello, world — “quotes”, café"));
        assert!(!beyond_latin(""));
        assert!(beyond_latin("中"));
        assert!(beyond_latin("字幕，你好！"));
    }

    #[test]
    fn a_style_with_chinese_words_is_written_in_the_cjk_face() {
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![
                fixtures::text("c1", "t1", 0, 1000, "中文标题", fixtures::text_style()),
                // The same style again, in Latin: still one style line, and it
                // is the CJK face — the style has Chinese to draw somewhere.
                fixtures::text("c2", "t1", 1000, 1000, "Latin", fixtures::text_style()),
            ],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        assert_eq!(styles_in(&ass).len(), 1, "{ass}");
        assert!(styles_in(&ass)[0].contains(",Noto Sans SC,"), "{ass}");

        let latin = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![fixtures::text(
                "c1",
                "t1",
                0,
                1000,
                "Latin words",
                fixtures::text_style(),
            )],
            Vec::new(),
        );
        let ass = build_ass(&latin);
        assert!(styles_in(&ass)[0].contains(",Inter,"), "{ass}");
    }

    #[test]
    fn colours_are_written_backwards_with_a_plate_of_alpha() {
        assert_eq!(bgr("#ff0000"), "&H000000FF");
        assert_eq!(bgr("#123456"), "&H00563412");
        // A colour the document should never hold falls back to white rather
        // than to a script the renderer refuses.
        assert_eq!(bgr("nonsense"), "&H00FFFFFF");
    }

    #[test]
    fn margins_are_shares_of_the_frame_and_a_centred_block_keeps_none() {
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![fixtures::text(
                "c1",
                "t1",
                0,
                1000,
                "At the foot",
                fixtures::text_style(),
            )],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        // 5% of 1920 is 96; 6% of 1080 is 64.8, rounded to 65. The style ends
        // with the alignment and the three margins.
        assert!(ass.contains(",2,96,96,65,1"), "{ass}");
        assert!(ass.contains("PlayResX: 1920"));
        assert!(ass.contains("PlayResY: 1080"));

        let mut centred = fixtures::text_style();
        centred.position = TextPosition::Center;
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![fixtures::text(
                "c1",
                "t1",
                0,
                1000,
                "In the middle",
                centred,
            )],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        assert!(ass.contains(",5,96,96,0,1"), "{ass}");
    }

    #[test]
    fn a_plate_wins_over_an_outline() {
        let mut plated = fixtures::text_style();
        plated.font_size = 48;
        plated.background = Some("#101010".to_string());
        plated.stroke_width = 4;
        plated.stroke_color = "#ff0000".to_string();
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![fixtures::text("c1", "t1", 0, 1000, "A plate", plated)],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        // BorderStyle 3: the outline is the plate's padding, and its colour is
        // the plate's — the outline the style also carried is dropped.
        assert!(ass.contains(",3,") && ass.contains(",&H00101010,"), "{ass}");
        assert!(
            ass.contains(",29,"),
            "0.6 x 48 is 28.8, rounded to 29: {ass}"
        );
        assert!(!ass.contains("&H000000FF"), "the outline is dropped: {ass}");

        let mut stroked = fixtures::text_style();
        stroked.stroke_width = 4;
        stroked.stroke_color = "#ff0000".to_string();
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![fixtures::text("c1", "t1", 0, 1000, "An outline", stroked)],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        assert!(ass.contains(",1,4,0,"), "{ass}");
        assert!(ass.contains("&H000000FF"), "{ass}");
    }

    #[test]
    fn a_style_with_no_outline_is_written_with_none() {
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![fixtures::text(
                "c1",
                "t1",
                0,
                1000,
                "Plain",
                fixtures::text_style(),
            )],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        assert!(ass.contains(",1,0,0,"), "{ass}");
    }

    #[test]
    fn the_same_style_twice_is_one_style_and_each_block_names_it() {
        let style = TextClipStyle {
            bold: true,
            ..fixtures::text_style()
        };
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![
                fixtures::text("c1", "t1", 0, 1000, "One", style.clone()),
                fixtures::text("c2", "t1", 1000, 1000, "Two", style),
                fixtures::text("c3", "t1", 2000, 1000, "Three", fixtures::text_style()),
            ],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        assert_eq!(styles_in(&ass).len(), 2, "{ass}");
        assert!(styles_in(&ass)[0].starts_with("Style: S0,"));
        assert!(styles_in(&ass)[1].starts_with("Style: S1,"));
        // Bold is -1 in this format, never 1.
        assert!(styles_in(&ass)[0].contains(",&H00000000,-1,0,0,"), "{ass}");
        let lines = dialogues(&ass);
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains(",S0,") && lines[1].contains(",S0,"));
        assert!(lines[2].contains(",S1,"));
        // The moment a block ends on is its own end, in centiseconds.
        assert!(lines[0].starts_with("Dialogue: 0,0:00:00.00,0:00:01.00,"));
        assert!(lines[2].starts_with("Dialogue: 0,0:00:02.00,0:00:03.00,"));
    }

    #[test]
    fn a_timeline_without_words_writes_nothing() {
        let timeline = fixtures::timeline(
            "Cut",
            vec![fixtures::track("t1", TrackKind::Video)],
            vec![fixtures::clip("c1", "t1", TrackKind::Video, 0, 1000)],
            Vec::new(),
        );
        assert_eq!(build_ass(&timeline), "");
    }

    #[test]
    fn the_header_names_the_timeline_it_belongs_to() {
        let timeline = fixtures::timeline(
            "A cut\nwith a break",
            vec![fixtures::track("t1", TrackKind::Text)],
            vec![fixtures::text(
                "c1",
                "t1",
                0,
                1000,
                "Words",
                fixtures::text_style(),
            )],
            Vec::new(),
        );
        let ass = build_ass(&timeline);
        assert!(ass.contains("Title: A cut with a break"), "{ass}");
        assert!(ass.starts_with("[Script Info]\n"));
        assert!(ass.contains("[V4+ Styles]\n"));
        assert!(ass.contains("[Events]\n"));
    }
}
