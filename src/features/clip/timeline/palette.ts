/**
 * What the 2D context paints with.
 *
 * Copies of the dark palette in tokens.css, since a canvas cannot read CSS
 * custom properties — and rather than reading them through the DOM, the
 * drawing code carries what it needs. Named for the part each colour plays
 * rather than for the token it mirrors: a row that wants a shade of its own
 * would otherwise be a lie about the theme.
 */

export interface TimelinePalette {
  /** The bed the whole screen lies on. */
  canvas: string;
  rowA: string;
  rowB: string;
  rowLine: string;
  /** The faint full-height lines the major ticks drop through the rows. */
  grid: string;
  ruler: string;
  rulerLine: string;
  tick: string;
  tickMinor: string;
  label: string;
  /** Words on a clip. */
  ink: string;
  muted: string;
  selection: string;
  selectionGlow: string;
  clip: Record<"video" | "audio" | "text", string>;
  clipStroke: string;
  /** The standard fade ramp drawn over a clip's corner. */
  fade: string;
  /** A sound's shape inside a block, drawn as vertical spans. */
  waveform: string;
  badgeFill: string;
  badgeStroke: string;
  badgeGlyph: string;
  speedFill: string;
  playhead: string;
  lock: string;
  /** The guide a snapped edge lands on, and the mark the edge wears. */
  snap: string;
  /** A ghost over a place the release would refuse. */
  refuse: string;
  /** The wash inside a marquee's rectangle. */
  marqueeFill: string;
}

export const TIMELINE_PALETTE: TimelinePalette = {
  canvas: "#0d0d10",
  rowA: "#16171b",
  rowB: "#1a1b20",
  rowLine: "#2a2c33",
  grid: "rgba(255, 255, 255, 0.06)",
  ruler: "#121316",
  rulerLine: "#2a2c33",
  tick: "#9a9aa4",
  tickMinor: "#5d5f68",
  label: "#9a9aa4",
  ink: "#f4f4f6",
  muted: "#9a9aa4",
  selection: "#f5f5f7",
  selectionGlow: "rgba(245, 245, 247, 0.45)",
  clip: { video: "#33507c", audio: "#2c6656", text: "#6a4f8e" },
  clipStroke: "rgba(0, 0, 0, 0.4)",
  fade: "rgba(255, 255, 255, 0.2)",
  waveform: "rgba(255, 255, 255, 0.55)",
  badgeFill: "#202126",
  badgeStroke: "#2a2c33",
  badgeGlyph: "#f4f4f6",
  speedFill: "rgba(0, 0, 0, 0.45)",
  playhead: "#f5f5f7",
  lock: "#9a9aa4",
  snap: "#f2ce7a",
  refuse: "#ff8a80",
  marqueeFill: "rgba(245, 245, 247, 0.07)",
};
