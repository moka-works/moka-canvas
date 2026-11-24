import { defaultTextStyle, type TextClipStyle } from "../../shared/domain";

/**
 * The four styles the Text page offers, as whole values.
 *
 * A preset fills the entire style — every field a text clip carries, font
 * included — so pressing one is a decision about the whole look rather than a
 * nudge to one axis. All four are combinations of fields the domain already
 * has, and Basic is the style a clip is born with, so the presets and the
 * factory can never drift apart.
 *
 * Pure data: nothing here touches a document.
 */

export type TextStylePresetId =
  | "basic"
  | "title"
  | "lowerThird"
  | "caption"
  | "chapter"
  | "quote"
  | "end"
  | "cover";

export interface TextStylePreset {
  id: TextStylePresetId;
  /** What the picker calls the preset. */
  label: string;
  /** The catalogue entry the interface names it by. */
  labelKey: string;
  style: TextClipStyle;
  /** How long a card of this style wants to be, where it is a card. */
  durationMs?: number;
}

/** The catalogue addresses of the presets' names. */
export const TEXT_STYLE_PRESET_LABELS: Record<TextStylePresetId, string> = {
  basic: "clip:textPresets.basic",
  title: "clip:textPresets.title",
  lowerThird: "clip:textPresets.lowerThird",
  caption: "clip:textPresets.caption",
  chapter: "clip:textPresets.chapter",
  quote: "clip:textPresets.quote",
  end: "clip:textPresets.end",
  cover: "clip:textPresets.cover",
};

export const TEXT_STYLE_PRESETS: readonly TextStylePreset[] = [
  {
    id: "basic",
    label: "Basic",
    labelKey: TEXT_STYLE_PRESET_LABELS.basic,
    style: defaultTextStyle(),
  },
  {
    // A title: large, bold, and set at the foot of the frame.
    id: "title",
    label: "Title",
    labelKey: TEXT_STYLE_PRESET_LABELS.title,
    style: { ...defaultTextStyle(), fontSize: 96, bold: true },
  },
  {
    // A lower third: set left at the foot of the picture, on a plate so it
    // reads over anything.
    id: "lowerThird",
    label: "Lower third",
    labelKey: TEXT_STYLE_PRESET_LABELS.lowerThird,
    style: {
      ...defaultTextStyle(),
      fontSize: 56,
      align: "left",
      position: "bottom",
      background: "#101010",
    },
  },
  {
    // A caption: white words at the foot of the picture, kept readable by a
    // black outline — the shape subtitles arrive in.
    id: "caption",
    label: "Caption",
    labelKey: TEXT_STYLE_PRESET_LABELS.caption,
    style: {
      ...defaultTextStyle(),
      fontSize: 48,
      position: "bottom",
      strokeWidth: 4,
      strokeColor: "#000000",
    },
  },
  {
    // The name of an episode, held in the middle of the frame.
    id: "chapter",
    label: "Chapter",
    labelKey: TEXT_STYLE_PRESET_LABELS.chapter,
    style: {
      ...defaultTextStyle(),
      fontSize: 80,
      bold: true,
      position: "center",
      strokeWidth: 4,
      strokeColor: "#000000",
    },
  },
  {
    // A line quoted over the picture, softened by an italic face.
    id: "quote",
    label: "Quote",
    labelKey: TEXT_STYLE_PRESET_LABELS.quote,
    style: {
      ...defaultTextStyle(),
      fontSize: 64,
      italic: true,
      position: "center",
      strokeWidth: 3,
      strokeColor: "#000000",
    },
  },
  {
    // The last words of a film, centred like a chapter's name.
    id: "end",
    label: "End",
    labelKey: TEXT_STYLE_PRESET_LABELS.end,
    style: {
      ...defaultTextStyle(),
      fontSize: 72,
      bold: true,
      position: "center",
      strokeWidth: 4,
      strokeColor: "#000000",
    },
  },
  {
    // A cover's title: the largest words in the film, held at the foot of the
    // picture and made readable over any background by a heavy outline.
    id: "cover",
    label: "Cover",
    labelKey: TEXT_STYLE_PRESET_LABELS.cover,
    style: {
      ...defaultTextStyle(),
      fontSize: 96,
      bold: true,
      position: "bottom",
      strokeWidth: 6,
      strokeColor: "#000000",
    },
    durationMs: 2_500,
  },
];

/** The preset with this id, or undefined for one the table never knew. */
export function presetById(id: string): TextStylePreset | undefined {
  return TEXT_STYLE_PRESETS.find((preset) => preset.id === id);
}

/** Whether two styles ask for the same look, field by field. */
export function sameStyle(a: TextClipStyle, b: TextClipStyle): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.align === b.align &&
    a.position === b.position &&
    a.background === b.background &&
    a.strokeWidth === b.strokeWidth &&
    a.strokeColor === b.strokeColor
  );
}
