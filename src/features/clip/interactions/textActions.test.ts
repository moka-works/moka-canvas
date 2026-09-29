import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultTextStyle,
  type MokaFile,
  type TimelineClip,
  type TimelineDocument,
} from "../../../shared/domain";
import {
  buildCutMokaFile,
  buildTimelineMokaFile,
  cutFixtureIds,
  timelineIds,
} from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore, isBoundary } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { setTrackFlag } from "./clipActions";
import { TEXT_STYLE_PRESETS } from "../textStyles";
import { frameAligned } from "../timeline/timecode";
import {
  MAX_SUBTITLE_FILE_BYTES,
  addTextClipAtPlayhead,
  clampFontSize,
  clampStrokeWidth,
  clampTextContent,
  cueSummary,
  editCue,
  importSrt,
  landTranscribedCues,
  legalStyle,
  sameText,
  srtImportPlan,
  styleApplyPatches,
} from "./textActions";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useClipStore.setState({
    activeTimelineId: null,
    selection: { clipIds: [], transitionId: null },
    playheadMs: 0,
    adjustDraft: null,
    textDraft: null,
    cueEditor: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Opens a document onto one cut, with a playhead. */
function open(moka: MokaFile, timelineId: string, playheadMs = 0): void {
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka,
    selfCheck: { ok: true, issues: [] },
  });
  useClipStore.setState({
    activeTimelineId: timelineId,
    selection: { clipIds: [], transitionId: null },
    playheadMs,
    adjustDraft: null,
    textDraft: null,
    cueEditor: null,
  });
}

function cut(): TimelineDocument {
  const moka = useProjectStore.getState().moka;
  const id = useClipStore.getState().activeTimelineId;
  const timeline = (moka?.timelines ?? []).find((each) => each.id === id);
  if (!timeline) throw new Error("no cut is open");
  return timeline;
}

function entryCount(): number {
  return useHistoryStore
    .getState()
    .undoStack.filter((item) => !isBoundary(item)).length;
}

/** A text clip as the fixtures and the tests write one. */
function textClip(
  id: string,
  trackId: string,
  startMs: number,
  durationMs: number,
  content = id,
): TimelineClip {
  const clip = {
    id,
    trackId,
    kind: "text" as const,
    label: content,
    startMs,
    durationMs,
    inPointMs: 0,
    outPointMs: durationMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    text: { content, style: defaultTextStyle() },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return clip;
}

/** The fixture cut with its text track holding the given clips. */
function withTextClips(clips: TimelineClip[]): TimelineDocument {
  const timeline = buildTimelineMokaFile().timelines![0];
  return { ...timeline, clips: [...timeline.clips, ...clips] };
}

const ids = timelineIds();
const style = defaultTextStyle();
const cue = (startMs: number, endMs: number, text = "cue") => ({
  startMs,
  endMs,
  text,
});

describe("clamps the form works inside", () => {
  it("keeps font sizes whole and inside 12–240", () => {
    expect(clampFontSize(48.4)).toBe(48);
    expect(clampFontSize(11.6)).toBe(12);
    expect(clampFontSize(0)).toBe(12);
    expect(clampFontSize(300)).toBe(240);
    expect(clampFontSize(Number.NaN)).toBe(12);
    expect(Number.isInteger(clampFontSize(240.5))).toBe(true);
  });

  it("keeps stroke widths whole and inside 0–16", () => {
    expect(clampStrokeWidth(4.6)).toBe(5);
    expect(clampStrokeWidth(-3)).toBe(0);
    expect(clampStrokeWidth(99)).toBe(16);
    expect(clampStrokeWidth(Number.NaN)).toBe(0);
  });

  it("stops the words where the counter stops", () => {
    expect(clampTextContent("short")).toBe("short");
    expect(clampTextContent("a".repeat(2_500)).length).toBe(2_000);
  });

  it("folds a cue's lines into one and cuts it at forty characters", () => {
    expect(cueSummary("one line")).toBe("one line");
    expect(cueSummary("first\nsecond")).toBe("first second");
    expect(cueSummary("a".repeat(50))).toBe(`${"a".repeat(40)}…`);
    expect(cueSummary("a".repeat(40))).toBe("a".repeat(40));
  });

  it("makes a style legal without touching what is already legal", () => {
    expect(
      legalStyle({ ...style, fontSize: 12.7, strokeWidth: 40 }).fontSize,
    ).toBe(13);
    expect(legalStyle({ ...style, strokeWidth: 40 }).strokeWidth).toBe(16);
    expect(legalStyle(style)).toEqual(style);
  });
});

describe("the four style presets", () => {
  it("holds all four, each a complete and legal style", () => {
    expect(TEXT_STYLE_PRESETS.map((preset) => preset.label)).toEqual([
      "Basic",
      "Title",
      "Lower third",
      "Caption",
    ]);
    for (const preset of TEXT_STYLE_PRESETS) {
      const fields = preset.style;
      expect(Number.isInteger(fields.fontSize)).toBe(true);
      expect(fields.fontSize).toBeGreaterThanOrEqual(12);
      expect(fields.fontSize).toBeLessThanOrEqual(240);
      expect(fields.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(Number.isInteger(fields.strokeWidth)).toBe(true);
      expect(fields.strokeWidth).toBeGreaterThanOrEqual(0);
      expect(fields.strokeColor).toMatch(/^#[0-9a-f]{6}$/);
      expect(["left", "center", "right"]).toContain(fields.align);
      expect(["top", "center", "bottom"]).toContain(fields.position);
      expect(
        fields.background === null || /^#[0-9a-f]{6}$/.test(fields.background),
      ).toBe(true);
      expect(fields.fontFamily.length).toBeGreaterThan(0);
    }
  });

  it("leaves Basic exactly what a clip is born with", () => {
    expect(TEXT_STYLE_PRESETS[0].style).toEqual(defaultTextStyle());
  });
});

describe("styleApplyPatches", () => {
  it("keeps each clip's own words and replaces the style", () => {
    const bold = { ...style, bold: true };
    const patches = styleApplyPatches(
      [
        textClip("a", ids.textTrack, 0, 2_000, "one"),
        textClip("b", ids.textTrack, 2_000, 2_000, "two"),
      ],
      bold,
    );
    expect(patches).toEqual([
      { clipId: "a", patch: { text: { content: "one", style: bold } } },
      { clipId: "b", patch: { text: { content: "two", style: bold } } },
    ]);
  });

  it("spends nothing on a clip already wearing the style, or on no text clip", () => {
    const clip = textClip("a", ids.textTrack, 0, 2_000, "one");
    expect(styleApplyPatches([clip], defaultTextStyle())).toEqual([]);
    const video: TimelineClip = { ...clip, id: "v", kind: "video" };
    expect(styleApplyPatches([video], { ...style, bold: true })).toEqual([]);
  });
});

describe("srtImportPlan", () => {
  it("puts both ends of a cue on the frame clock", () => {
    const timeline = withTextClips([]);
    const plan = srtImportPlan(timeline, [cue(1_010, 5_010, "hi")], style);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.clips[0].startMs).toBe(frameAligned(1_010, 30));
    expect(plan.clips[0].startMs).toBe(1_000);
    expect(plan.clips[0].durationMs).toBe(4_000);
    expect(plan.clips[0].text).toEqual({ content: "hi", style });
    expect(plan.commands.map((command) => command.type)).toEqual(["addClips"]);
  });

  it("skips cues too short to be seen, counting them", () => {
    const timeline = withTextClips([]);
    const plan = srtImportPlan(
      timeline,
      [cue(1_000, 1_050), cue(2_000, 4_000)],
      style,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.skipped).toBe(1);
    expect(plan.clips.map((clip) => clip.startMs)).toEqual([2_000]);
  });

  it("refuses a batch where every cue was too short", () => {
    const plan = srtImportPlan(withTextClips([]), [cue(1_000, 1_050)], style);
    expect(plan).toEqual({
      ok: false,
      message: "No cues were long enough to import.",
    });
  });

  it("refuses overlapping cues, naming the moment they meet", () => {
    const plan = srtImportPlan(
      withTextClips([]),
      [cue(1_000, 5_000, "one"), cue(4_400, 8_000, "two")],
      style,
    );
    expect(plan).toEqual({
      ok: false,
      message: "The subtitles overlap each other at 00:00:04:12.",
    });
  });

  it("lets cues butt end to start", () => {
    const plan = srtImportPlan(
      withTextClips([]),
      [cue(0, 2_000), cue(2_000, 4_000)],
      style,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.clips).toHaveLength(2);
  });

  it("refuses a cue that runs into a clip already on the row", () => {
    const timeline = withTextClips([
      textClip("existing", ids.textTrack, 5_000, 2_000, "already here"),
    ]);
    const plan = srtImportPlan(timeline, [cue(4_400, 6_000)], style);
    expect(plan).toEqual({
      ok: false,
      message: "The subtitles overlap a clip already on Text 1.",
    });
  });

  it("lands on the first text track in document order", () => {
    const base = withTextClips([]);
    const timeline: TimelineDocument = {
      ...base,
      tracks: [
        ...base.tracks,
        {
          id: "track-text-2",
          kind: "text",
          name: "Text 2",
          muted: false,
          hidden: false,
          locked: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const plan = srtImportPlan(timeline, [cue(0, 1_000)], style);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // §3: the first text track in document order takes the batch, even when
    // it is locked — the command layer is the place that refuses.
    expect(plan.clips[0].trackId).toBe(ids.textTrack);
    expect(plan.commands.map((command) => command.type)).toEqual(["addClips"]);
  });

  it("grows a text track as the first command when the cut has none", () => {
    const base = withTextClips([]);
    const timeline: TimelineDocument = {
      ...base,
      tracks: base.tracks.filter((track) => track.kind !== "text"),
    };
    const plan = srtImportPlan(timeline, [cue(0, 1_000)], style);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [first, second] = plan.commands;
    expect(first.type).toBe("addTrack");
    if (first.type !== "addTrack") return;
    expect(first.track.kind).toBe("text");
    expect(first.track.name).toBe("Text 1");
    expect(second.type).toBe("addClips");
    if (second.type !== "addClips") return;
    expect(second.clips[0].trackId).toBe(first.track.id);
  });

  it("cuts a wide batch into addClips steps of at most fifty", () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      cue(index * 1_000, index * 1_000 + 1_000, `cue ${index}`),
    );
    const plan = srtImportPlan(withTextClips([]), many, style);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.clips).toHaveLength(120);
    const adds = plan.commands.filter((command) => command.type === "addClips");
    expect(adds).toHaveLength(3);
    for (const command of adds) {
      if (command.type !== "addClips") continue;
      expect(command.clips.length).toBeLessThanOrEqual(50);
    }
  });

  it("refuses a batch that would take the timeline past its ceiling", () => {
    const timeline = withTextClips([
      textClip("existing", ids.textTrack, 0, 1_000),
    ]);
    const cues = Array.from({ length: 400 }, (_, index) =>
      cue(1_000 + index * 1_000, 2_000 + index * 1_000),
    );
    const plan = srtImportPlan(timeline, cues, style);
    // The fixture already holds one video clip and the text clip added here.
    expect(plan).toEqual({
      ok: false,
      message: "The timeline holds at most 400 clips — delete 2 first.",
    });
  });

  it("grows a row of its own for a transcript, clear of what is written", () => {
    const timeline = withTextClips([
      textClip("existing", ids.textTrack, 0, 4_000, "already here"),
    ]);
    // The moment is one the first text row is already speaking at, which is
    // exactly what a transcript must not be refused for.
    const plan = srtImportPlan(
      timeline,
      [cue(1_000, 2_000, "new")],
      style,
      "newTrack",
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [first, second] = plan.commands;
    expect(first.type).toBe("addTrack");
    if (first.type !== "addTrack") return;
    expect(first.track.kind).toBe("text");
    expect(first.track.name).toBe("Text 2");
    expect(second.type).toBe("addClips");
    if (second.type !== "addClips") return;
    expect(second.clips[0].trackId).toBe(first.track.id);
    expect(second.clips[0].trackId).not.toBe(ids.textTrack);
    expect(plan.clips[0].startMs).toBe(1_000);
    expect(plan.clips[0].text?.content).toBe("new");
  });

  it("still refuses a transcript whose own cues run into each other", () => {
    const plan = srtImportPlan(
      withTextClips([]),
      [cue(1_000, 5_000, "one"), cue(4_400, 8_000, "two")],
      style,
      "newTrack",
    );
    expect(plan).toEqual({
      ok: false,
      message: "The subtitles overlap each other at 00:00:04:12.",
    });
  });
});

describe("landTranscribedCues", () => {
  it("writes a transcript on a row of its own in one step of history", () => {
    open(buildTimelineMokaFile(), ids.timeline);
    const landed = landTranscribedCues([cue(1_000, 3_000, "hello")], style);
    expect(landed).not.toBeNull();
    if (!landed || !landed.ok) return;
    const after = cut();
    const landedClip = after.clips.find(
      (each) => each.id === landed.clips[0].id,
    );
    const track = after.tracks.find((each) => each.id === landedClip?.trackId);
    expect(track?.kind).toBe("text");
    expect(track?.id).not.toBe(ids.textTrack);
    expect(landedClip?.text?.content).toBe("hello");
    expect(landedClip?.startMs).toBe(1_000);
    expect(landedClip?.durationMs).toBe(2_000);
    expect(entryCount()).toBe(1);
  });

  it("says why nothing landed when every cue was too short", () => {
    open(buildTimelineMokaFile(), ids.timeline);
    expect(landTranscribedCues([cue(1_000, 1_050)], style)).toEqual({
      ok: false,
      message: "No cues were long enough to import.",
    });
    expect(cut().clips).toHaveLength(1);
    expect(entryCount()).toBe(0);
  });
});

describe("addTextClipAtPlayhead", () => {
  it("lands a styled clip at the playhead and chooses it", () => {
    const moka = buildTimelineMokaFile();
    open(moka, ids.timeline, 1_010);
    const clip = addTextClipAtPlayhead("A lantern over the lake", {
      ...style,
      fontSize: 300,
      strokeWidth: 40,
    });
    expect(clip).not.toBeNull();
    if (!clip) return;
    const after = cut();
    expect(after.clips).toHaveLength(2);
    const landed = after.clips.find((each) => each.id === clip.id);
    expect(landed?.trackId).toBe(ids.textTrack);
    expect(landed?.startMs).toBe(1_000);
    expect(landed?.durationMs).toBe(2_000);
    expect(landed?.text?.content).toBe("A lantern over the lake");
    // The form's clamps are the last word before the document is written.
    expect(landed?.text?.style.fontSize).toBe(240);
    expect(landed?.text?.style.strokeWidth).toBe(16);
    expect(useClipStore.getState().selection.clipIds).toEqual([clip.id]);
    expect(entryCount()).toBe(1);
  });

  it("refuses empty words without touching the cut", () => {
    open(buildTimelineMokaFile(), ids.timeline, 1_000);
    expect(addTextClipAtPlayhead("   ".trim(), style)).toBeNull();
    expect(cut().clips).toHaveLength(1);
    expect(entryCount()).toBe(0);
  });

  it("grows a text row in the same step when every row is locked", () => {
    const moka = buildTimelineMokaFile();
    const timeline = moka.timelines![0];
    moka.timelines = [
      {
        ...timeline,
        tracks: timeline.tracks.map((track) =>
          track.kind === "text" ? { ...track, locked: true } : track,
        ),
      },
    ];
    open(moka, ids.timeline, 0);
    const clip = addTextClipAtPlayhead("hello", style);
    expect(clip).not.toBeNull();
    const after = cut();
    const textTracks = after.tracks.filter((track) => track.kind === "text");
    expect(textTracks).toHaveLength(2);
    expect(textTracks[1].name).toBe("Text 2");
    expect(clip?.trackId).toBe(textTracks[1].id);
    expect(entryCount()).toBe(1);
  });
});

describe("editCue", () => {
  /** A cue already on the cut, written the way a reader would write one. */
  function landCue(): TimelineClip {
    const clip = addTextClipAtPlayhead("A line", style);
    if (!clip) throw new Error("the cue did not land");
    return clip;
  }

  it("opens the editor over a cue and takes the playhead to its head", () => {
    open(buildTimelineMokaFile(), ids.timeline, 1_010);
    const clip = landCue();
    // The playhead travels away first, so coming back is a change.
    useClipStore.getState().setPlayhead(3_000);
    editCue(clip);

    const state = useClipStore.getState();
    expect(state.cueEditor).toEqual({
      kind: "clip",
      clipId: clip.id,
      seed: "A line",
    });
    expect(state.selection.clipIds).toEqual([clip.id]);
    expect(state.playheadMs).toBe(clip.startMs);
  });

  it("leaves the playhead where it stands when it is already on the cue", () => {
    open(buildTimelineMokaFile(), ids.timeline, 1_010);
    const clip = landCue();
    useClipStore.getState().setPlayhead(1_500);
    editCue(clip);
    expect(useClipStore.getState().playheadMs).toBe(1_500);
    expect(useClipStore.getState().cueEditor?.clipId).toBe(clip.id);
  });

  it("refuses a cue on a locked row, the way every edit there is refused", () => {
    open(buildTimelineMokaFile(), ids.timeline, 1_010);
    const clip = landCue();
    setTrackFlag(cut(), clip.trackId, "locked", true);
    editCue(clip);
    expect(useClipStore.getState().cueEditor).toBeNull();
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "That track is locked.",
    );
  });
});

describe("importSrt", () => {
  /** A cut with no text row at all, so the batch has to grow one. */
  function textlessMoka(): MokaFile {
    const moka = buildTimelineMokaFile();
    const timeline = moka.timelines![0];
    moka.timelines = [
      {
        ...timeline,
        tracks: timeline.tracks.filter((track) => track.kind !== "text"),
      },
    ];
    return moka;
  }

  const file = (...lines: string[]): string => lines.join("\n");

  it("lands a whole file in one step, saying what it kept and what it skipped", () => {
    open(textlessMoka(), ids.timeline, 0);
    importSrt(
      file(
        "1",
        "00:00:01,000 --> 00:00:02,000",
        "one",
        "",
        "2",
        "00:00:02,050 --> 00:00:02,100",
        "too short to keep",
        "",
        "3",
        "00:00:03,000 --> 00:00:04,000",
        "two",
        "",
      ),
      style,
    );
    const after = cut();
    // The row the batch needed came in the same step as the clips.
    expect(after.tracks.filter((track) => track.kind === "text")).toHaveLength(
      1,
    );
    const landed = after.clips.filter((clip) => clip.kind === "text");
    expect(landed.map((clip) => [clip.startMs, clip.durationMs])).toEqual([
      [1_000, 1_000],
      [3_000, 1_000],
    ]);
    expect(entryCount()).toBe(1);
    expect(
      useAppStore.getState().toasts.map((notice) => notice.message),
    ).toContain("Imported 2 cues (1 skipped as too short).");
  });

  it("says nothing was imported when the file is empty or every cue is short", () => {
    open(textlessMoka(), ids.timeline, 0);
    importSrt("just prose, no time line", style);
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "No subtitles found in the file.",
    );
    importSrt(file("1", "00:00:01,000 --> 00:00:01,050", "short", ""), style);
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
      "No cues were long enough to import.",
    );
    expect(cut().clips.filter((clip) => clip.kind === "text")).toHaveLength(0);
    expect(entryCount()).toBe(0);
  });
});

describe("sameText", () => {
  it("sees no change in the same words and look, and a change anywhere else", () => {
    const text = { content: "hello", style };
    expect(sameText(text, { content: "hello", style: { ...style } })).toBe(
      true,
    );
    expect(sameText(text, { content: "hello!", style })).toBe(false);
    expect(
      sameText(text, { content: "hello", style: { ...style, bold: true } }),
    ).toBe(false);
  });
});

describe("the subtitle file guard", () => {
  it("keeps the file ceiling the page refuses past", () => {
    expect(MAX_SUBTITLE_FILE_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("the cut fixture's own text clip", () => {
  it("is a shape the plan can read", () => {
    const moka = buildCutMokaFile();
    const ids2 = cutFixtureIds();
    const timeline = moka.timelines![0];
    const clip = timeline.clips.find((each) => each.id === ids2.clipD);
    expect(clip?.text?.style.strokeWidth).toBe(4);
    const plan = srtImportPlan(timeline, [cue(0, 500)], style);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toBe(
      "The subtitles overlap a clip already on Text 1.",
    );
  });
});
