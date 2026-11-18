// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { MokaFile } from "../../../shared/domain";
import {
  buildLongStory,
  buildStoryMokaFile,
} from "../../../shared/domain/fixtures";
import { createKeyframe } from "../../../shared/domain/factories";
import { undo } from "../../editor/commands/execute";
import { planKeyframeArt } from "../jobs/plan";
import { useStoryJobStore } from "../stores/storyJobStore";
import {
  ids,
  T0,
  starts,
  answers,
  landed,
  comesBack,
  boarded,
  withEveryFrame,
  withUndrawnFrames,
  withASecondAct,
  withTwoDrawnActs,
  withTwoFilmedActs,
  openAtBoard,
  story,
  acts,
  storyLine,
  lineVoice,
  card,
  boardAnswer,
  withReadLine,
  openLine,
  resetStoryboard,
  cleanupStoryboard,
} from "./storyboardStepKit";

beforeEach(resetStoryboard);
afterEach(cleanupStoryboard);

/** The telling with its first shot closed without a picture. */
function withAPicturelessShot(): MokaFile {
  const moka = withUndrawnFrames();
  const act = moka.stories![0]!.chapters[0]!.acts[0]!;
  act.keyframes[0]!.artNotNeeded = true;
  return moka;
}

describe("editing an episode's board", () => {
  it("asks before writing an episode's board again, and lists what it costs", async () => {
    openAtBoard(boarded());
    // An episode that already has a board is asked for by its second name, and
    // the ask stands behind a question rather than writing over it at once.
    expect(screen.getByTestId("story-board-regenerate").textContent).toBe(
      "Write the board again",
    );
    fireEvent.click(screen.getByTestId("story-board-regenerate"));
    const dialog = screen.getByTestId("regenerate-board");
    expect(dialog.textContent).toContain("1 act");
    expect(dialog.textContent).toContain("episode 1");

    fireEvent.click(screen.getByTestId("regenerate-board-cancel"));
    expect(starts).toHaveLength(0);

    fireEvent.click(screen.getByTestId("story-board-regenerate"));
    fireEvent.click(screen.getByTestId("regenerate-board-confirm"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items[0]?.id).toBe(
      `storyboard:${story().chapters[0]!.id}`,
    );
  });

  it("marks the cells whose framing the answer never really gave", async () => {
    openAtBoard(boarded(), 1);
    answers[`storyboard:${story().chapters[1]!.id}`] = boardAnswer("遥遥远景");

    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() =>
      expect(screen.getByTestId("story-act-0")).toBeDefined(),
    );
    const mark = within(card(0)).getByTestId("story-guessed-size-0");
    expect(mark.getAttribute("title")).toContain("遥遥远景");
    expect(acts()[0]?.keyframes[0]?.shotSize).toBe("medium");
  });

  it("writes the lines of a shot as one step, off screen ones included", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(screen.getByTestId("story-dialogue")).toBeDefined();

    fireEvent.click(screen.getByTestId("story-line-add"));
    fireEvent.change(screen.getByTestId("story-line-text-1"), {
      target: { value: "末班车，不停了。" },
    });
    fireEvent.change(screen.getByTestId("story-line-text-0"), {
      target: { value: "车已经停运了。" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));

    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.dialogue).toHaveLength(2),
    );
    const lines = acts()[0]?.keyframes[0]?.dialogue ?? [];
    // Every line arrives with a name of its own, and no two share one: what a
    // take read aloud is filed under is the line's own name.
    expect(lines[0]?.id).toBeTruthy();
    expect(lines[1]?.id).toBeTruthy();
    expect(lines[0]?.id).not.toBe(lines[1]?.id);
    expect(lines[0]?.speaker).toBe("林");
    expect(lines[0]?.text).toBe("车已经停运了。");
    // A line nobody in the cast says keeps no name of its own: it is read in
    // the telling's own voice.
    expect(lines[1]?.speaker).toBe("");
    expect(lines[1]?.text).toBe("末班车，不停了。");
    expect(lines[1]?.characterId).toBeUndefined();
  });

  it("gives a line the character it is read by, and lets it be off screen again", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));

    // The line the board wrote for 林 opens with him picked, and no name field
    // stands beside the cast: the pick is the whole of who says it.
    const pick = screen.getByTestId("story-line-role-0") as HTMLSelectElement;
    expect(pick.value).toBe(ids.hero);
    expect(screen.queryByTestId("story-line-speaker-0")).toBeNull();

    // Picking another character of the act carries his name with him.
    fireEvent.change(pick, { target: { value: ids.partner } });
    expect(
      (screen.getByTestId("story-line-role-0") as HTMLSelectElement).value,
    ).toBe(ids.partner);
    fireEvent.click(screen.getByTestId("story-line-done"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.dialogue[0]?.characterId).toBe(
        ids.partner,
      ),
    );
    expect(acts()[0]?.keyframes[0]?.dialogue[0]?.speaker).toBe("周");

    // Off screen is nobody in the cast: the line keeps no name and falls to
    // the telling's own voice.
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    fireEvent.change(screen.getByTestId("story-line-role-0"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.dialogue[0]?.characterId).toBeUndefined(),
    );
    expect(acts()[0]?.keyframes[0]?.dialogue[0]?.speaker).toBe("");
  });

  it("names every control by the shot and the column it belongs to", () => {
    openAtBoard(boarded());
    expect(screen.getByLabelText("shot 1 · Movement")).toBeDefined();
    expect(screen.getByLabelText("shot 2 · Framing")).toBeDefined();
    expect(screen.getByLabelText("shot 1 · Length")).toBeDefined();
    expect(screen.getByTestId("story-kf-add").tagName).toBe("BUTTON");
  });

  it("adds and takes away shots by writing the act's table whole", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-add"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(3));

    fireEvent.click(screen.getByTestId("story-kf-remove-1"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(2));
    expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameFirst);
  });

  it("inserts a shot above the row it was asked for, and the rest keep their places", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-kf-insert-1"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(3));

    const frames = acts()[0]!.keyframes;
    expect(frames[0]?.id).toBe(ids.frameFirst);
    expect(frames[2]?.id).toBe(ids.frameSecond);
    expect(frames[1]?.content).toBe("");
    expect(frames[1]?.art.takes).toHaveLength(0);
    // The rows are the shots in their order: the third row is the one that
    // stood second, drawn for as long as its own picture is there.
    expect(
      (screen.getByTestId("story-kf-size-2") as HTMLSelectElement).value,
    ).toBe("close");
    expect(
      screen.getByTestId("story-kf-slot-2").querySelector("img"),
    ).toBeNull();

    act(() => {
      undo();
    });
    expect(acts()[0]?.keyframes).toHaveLength(2);
  });

  it("copies a shot below itself, words, lines and pictures included", async () => {
    const moka = withEveryFrame();
    const source = moka.stories![0]!.chapters[0]!.acts[0]!.keyframes[0]!;
    source.filmRole = "firstFrame";
    source.voices = [
      {
        lineId: ids.lineFirst,
        text: "车已经停运了。",
        voice: "平静",
        slot: { takes: [{ assetIds: ["asset-line-voice"], createdAt: T0 }] },
      },
    ];
    openAtBoard(moka);

    fireEvent.click(screen.getByTestId("story-kf-copy-0"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(3));

    const frames = acts()[0]!.keyframes;
    const copy = frames[1]!;
    // The copy stands right below the shot it was made from; the shot that
    // stood second keeps its place after it.
    expect(frames[0]?.id).toBe(ids.frameFirst);
    expect(frames[2]?.id).toBe(ids.frameSecond);
    expect(copy.id).not.toBe(source.id);
    expect(copy.content).toBe(source.content);
    expect(copy.shotSize).toBe(source.shotSize);
    expect(copy.cameraMove).toBe(source.cameraMove);
    expect(copy.angle).toBe(source.angle);
    expect(copy.durationMs).toBe(source.durationMs);
    expect(copy.filmRole).toBe("firstFrame");
    expect(copy.references).toEqual(source.references);
    // The frame drawn for the shot shows in the copy as well.
    expect(copy.art.takes[0]?.assetIds[0]).toBe(ids.frameArt);
    expect(
      screen
        .getByTestId("story-kf-slot-1")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toContain(ids.frameArt);
    // Its lines say what the shot said, under names of their own: what was
    // read aloud belongs to the shot's lines, not to the copy's.
    expect(copy.dialogue.map((line) => line.text)).toEqual(
      source.dialogue.map((line) => line.text),
    );
    expect(copy.dialogue[0]?.id).not.toBe(ids.lineFirst);
    expect(copy.voices).toBeUndefined();

    act(() => {
      undo();
    });
    expect(acts()[0]?.keyframes).toHaveLength(2);
  });

  it("moves a shot up and down the act, and the ends say so", async () => {
    openAtBoard(boarded());
    const first = acts()[0]!.keyframes[0]!;
    expect(
      (screen.getByTestId("story-kf-up-0") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("story-kf-down-1") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("story-kf-down-0"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameSecond),
    );
    // The picture drawn for the shot travels with it: what moved is the place
    // in the list rather than the shot, so nothing is asked for again.
    expect(acts()[0]?.keyframes[1]?.id).toBe(ids.frameFirst);
    expect(acts()[0]?.keyframes[1]?.art.takes[0]?.assetIds[0]).toBe(
      first.art.takes[0]?.assetIds[0],
    );
    // And the rows read the document: the first row is the shot that moved up.
    expect(
      (screen.getByTestId("story-kf-size-0") as HTMLSelectElement).value,
    ).toBe("close");

    act(() => {
      undo();
    });
    expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameFirst);
  });

  it("carries a shot's shoot role with it when the board is reordered", async () => {
    const moka = withEveryFrame();
    moka.stories![0].chapters[0]!.acts[0]!.keyframes[1]!.filmRole =
      "firstFrame";
    openAtBoard(moka);

    fireEvent.click(screen.getByTestId("story-kf-down-0"));
    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameSecond),
    );
    // The role belongs to the shot rather than to its place: the shot was
    // moved rather than written again, so what it is filmed as travels with it.
    expect(acts()[0]?.keyframes[0]?.filmRole).toBe("firstFrame");
    expect(
      (screen.getByTestId("story-kf-role-0") as HTMLSelectElement).value,
    ).toBe("firstFrame");
  });

  it("adds an act at the seam it was asked for, ready to be written into", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-act-insert-1"));
    await waitFor(() => expect(acts()).toHaveLength(2));

    // The act that was there stays whole, with its shots where they stood; the
    // new one is named by its place and is nobody's work yet.
    expect(acts()[0]?.id).toBe(ids.act);
    expect(acts()[0]?.keyframes).toHaveLength(2);
    expect(acts()[1]?.title).toBe("Act 2");
    expect(acts()[1]?.keyframes).toHaveLength(0);
    expect(screen.getByTestId("story-act-insert-0")).toBeDefined();
    expect(screen.getByTestId("story-act-insert-2")).toBeDefined();

    act(() => {
      undo();
    });
    expect(acts()).toHaveLength(1);
  });

  it("cuts an act in two at the seam between two of its shots", async () => {
    openAtBoard(withEveryFrame());
    const before = acts()[0]!;
    const [head, tail] = before.keyframes;

    fireEvent.click(screen.getByTestId("story-kf-split-1"));
    await waitFor(() => expect(acts()).toHaveLength(2));

    // The shots keep the acts they were written into: the first frame above
    // the cut, the second below it, pictures and all.
    expect(acts()[0]?.keyframes.map((frame) => frame.id)).toEqual([head?.id]);
    expect(acts()[1]?.keyframes.map((frame) => frame.id)).toEqual([tail?.id]);
    expect(acts()[0]?.keyframes[0]?.art.takes[0]?.assetIds[0]).toBe(
      head?.art.takes[0]?.assetIds[0],
    );
    expect(acts()[1]?.keyframes[0]?.art.takes[0]?.assetIds[0]).toBe(
      tail?.art.takes[0]?.assetIds[0],
    );
    // What the old act was filmed as belonged to neither half.
    expect(acts()[0]?.video.takes).toHaveLength(0);
    expect(acts()[1]?.video.takes).toHaveLength(0);
    expect(acts()[1]?.title).toContain("(cont.)");
    expect(acts()[0]?.id).not.toBe(before.id);
    expect(acts()[1]?.id).not.toBe(before.id);

    act(() => {
      undo();
    });
    expect(acts()).toHaveLength(1);
    expect(acts()[0]?.keyframes).toHaveLength(2);
  });

  it("joins two neighbouring acts at their seam, their shots running on", async () => {
    openAtBoard(withTwoDrawnActs());
    const [first, second] = acts();
    const frames = [...first!.keyframes, ...second!.keyframes];

    fireEvent.click(screen.getByTestId("story-act-merge-1"));
    await waitFor(() => expect(acts()).toHaveLength(1));

    expect(acts()[0]?.id).not.toBe(first?.id);
    expect(acts()[0]?.keyframes.map((frame) => frame.id)).toEqual(
      frames.map((frame) => frame.id),
    );
    expect(
      acts()[0]?.keyframes.every((frame) => frame.art.takes.length > 0),
    ).toBe(true);
    // One act, filmed again: the two clips the halves held are not it.
    expect(acts()[0]?.video.takes).toHaveLength(0);

    act(() => {
      undo();
    });
    expect(acts()).toHaveLength(2);
  });

  it("waits for the neighbouring clips before a bridge can be filmed", async () => {
    const moka = withTwoDrawnActs();
    // Neither neighbour has been filmed: the fixture's first act is cleared
    // of its clip so both ends are missing.
    moka.stories![0]!.chapters[0]!.acts[0]!.video = { takes: [] };
    openAtBoard(moka);

    fireEvent.click(screen.getByTestId("story-act-transition-1"));
    await waitFor(() => expect(acts()).toHaveLength(3));
    const bridge = acts()[1]!;
    expect(bridge.transition).toEqual({ prompt: "", durationMs: 3_000 });
    expect(bridge.keyframes).toHaveLength(0);
    expect(screen.getByTestId("story-transition-1")).toBeDefined();

    // Neither neighbour has been filmed, so neither end has a picture and the
    // bridge says what it is waiting for rather than offering an ask.
    expect(
      screen.getByTestId("story-transition-from-1").querySelector("img"),
    ).toBeNull();
    expect(
      screen.getByTestId("story-transition-to-1").querySelector("img"),
    ).toBeNull();
    expect(
      screen.getByTestId("story-transition-missing-1").textContent,
    ).toContain("no clip");
    expect(
      (screen.getByTestId("story-transition-video-go-1") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // The words and the length are still the reader's while it waits.
    fireEvent.change(screen.getByTestId("story-transition-prompt-1"), {
      target: { value: "灯管闪成一条白线" },
    });
    fireEvent.blur(screen.getByTestId("story-transition-prompt-1"));
    await waitFor(() =>
      expect(acts()[1]?.transition?.prompt).toBe("灯管闪成一条白线"),
    );
    fireEvent.change(screen.getByTestId("story-transition-seconds-1"), {
      target: { value: "5" },
    });
    fireEvent.blur(screen.getByTestId("story-transition-seconds-1"));
    await waitFor(() => expect(acts()[1]?.transition?.durationMs).toBe(5_000));

    // One step each for the bridge, its words and its length.
    act(() => {
      undo();
      undo();
      undo();
    });
    expect(acts()).toHaveLength(2);
  });

  it("films a bridge between the neighbouring clips' ends", async () => {
    openAtBoard(withTwoFilmedActs());
    fireEvent.click(screen.getByTestId("story-act-transition-1"));
    await waitFor(() => expect(acts()).toHaveLength(3));

    // The clip before the bridge is filmed in two pieces, so its tail is the
    // end of the second piece; the clip after begins at its first. Each end is
    // its own clip's picture, taken when the move is made.
    const from = screen
      .getByTestId("story-transition-from-1")
      .querySelector("img")
      ?.getAttribute("src");
    expect(from).toContain("asset-first-clip-two/frame");
    expect(from).toContain("edge=last");
    const to = screen
      .getByTestId("story-transition-to-1")
      .querySelector("img")
      ?.getAttribute("src");
    expect(to).toContain("asset-second-clip/frame");
    expect(to).toContain("edge=first");

    fireEvent.click(screen.getByTestId("story-transition-video-go-1"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(item?.inputs).toEqual([
      {
        role: "firstFrame",
        assetId: "asset-first-clip-two",
        frame: "last",
      },
      {
        role: "lastFrame",
        assetId: "asset-second-clip",
        frame: "first",
      },
    ]);

    await comesBack();
    // The bridge, once made, leads with its own first frame.
    const preview = screen
      .getByTestId("story-transition-video-1")
      .querySelector("img");
    expect(preview?.getAttribute("src")).toContain("asset-actVideo");
  });

  it("keeps an act with a pictureless shot filmed whole", () => {
    openAtBoard(withAPicturelessShot());

    // The act cannot be made shot-at-a-time, and neither can the default that
    // would reach it: a shot with no picture has no frame to open a clip on.
    expect(
      (
        screen.getByTestId(
          "story-act-granularity-keyframe-0",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("story-granularity-keyframe") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // The act-level choice stands, and the shot beside it can still be closed
    // without a picture.
    expect(
      (screen.getByTestId("story-act-granularity-act-0") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // A shot's picture is replaced or closed from the row's menu.
    fireEvent.click(
      within(screen.getByTestId("story-kf-more-1")).getByText("More"),
    );
    expect(screen.getByTestId("story-kf-slot-1-not-needed")).toBeTruthy();
  });

  it("offers no pictureless shot to an act filmed shot by shot", () => {
    const moka = withUndrawnFrames();
    moka.stories![0]!.chapters[0]!.acts[0]!.shotGranularity = "keyframe";
    openAtBoard(moka);

    fireEvent.click(
      within(screen.getByTestId("story-kf-more-0")).getByText("More"),
    );
    fireEvent.click(
      within(screen.getByTestId("story-kf-more-1")).getByText("More"),
    );
    expect(screen.queryByTestId("story-kf-slot-0-not-needed")).toBeNull();
    expect(screen.queryByTestId("story-kf-slot-1-not-needed")).toBeNull();
  });

  it("keeps the way back from a pictureless shot in a shot-by-shot act", () => {
    const moka = withAPicturelessShot();
    moka.stories![0]!.chapters[0]!.acts[0]!.shotGranularity = "keyframe";
    openAtBoard(moka);

    // A board written before the rule still reads as it stands, and its shot
    // can take a picture again — the only way out of that corner.
    expect(screen.getByTestId("story-kf-slot-0-not-needed-state")).toBeTruthy();
    fireEvent.click(
      within(screen.getByTestId("story-kf-more-0")).getByText("More"),
    );
    fireEvent.click(screen.getByTestId("story-kf-slot-0-need"));
    expect(acts()[0]?.keyframes[0]?.artNotNeeded).toBe(false);
  });

  it("moves an act up and down the episode, everything it holds travelling with it", async () => {
    openAtBoard(withASecondAct());
    const [first, second] = acts();
    expect(
      (screen.getByTestId("story-act-up-0") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("story-act-down-1") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("story-act-down-0"));
    await waitFor(() => expect(acts()[0]?.id).toBe(second!.id));
    // The act is moved rather than written again: its shots and the frames in
    // them are the ones it had.
    expect(acts()[1]?.id).toBe(first!.id);
    expect(acts()[0]?.keyframes).toHaveLength(1);
    expect(acts()[1]?.keyframes).toHaveLength(3);

    act(() => {
      undo();
    });
    expect(acts()[0]?.id).toBe(first!.id);
  });

  it("takes an act out whole once the reader has said so", async () => {
    openAtBoard(withASecondAct());
    const held = acts()[0]!;
    fireEvent.click(screen.getByTestId("story-act-remove-0"));
    const asked = screen.getByTestId("remove-act");
    expect(asked.textContent).toContain(held.title);
    expect(asked.textContent).toContain("3 shots");

    fireEvent.click(screen.getByTestId("remove-act-cancel"));
    expect(acts()).toHaveLength(2);

    fireEvent.click(screen.getByTestId("story-act-remove-0"));
    fireEvent.click(screen.getByTestId("remove-act-confirm"));
    await waitFor(() => expect(acts()).toHaveLength(1));
    expect(acts()[0]?.id).not.toBe(held.id);

    // Its shots go with it, and the whole of it comes back on undo.
    act(() => {
      undo();
    });
    expect(acts()).toHaveLength(2);
    expect(acts()[0]?.keyframes).toHaveLength(3);
  });

  it("reads a line aloud on its own, and shows the take that comes back", async () => {
    openAtBoard(boarded());
    // The first act says one line; the room counts it out on the button.
    const speak = screen.getByTestId("story-act-voice-go-0");
    expect(speak.textContent).toContain("1");
    fireEvent.click(speak);

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("voice");
    // One ask a line, named by the line it reads.
    expect(starts[0]!.items.map((item) => item.id)).toEqual([
      `lineVoice:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}:${ids.lineFirst}`,
    ]);
    expect(starts[0]!.items[0]!.prompt).toContain("车已经停运了。");
    // The words travel as the line's own, without the speaker or the tone
    // being read out: the tone rides in the instructions.
    expect(starts[0]!.items[0]!.prompt).not.toContain("林：");
    expect(String(starts[0]!.items[0]!.params?.instructions)).toContain("平静");

    await comesBack();
    const taken = `asset-lineVoice-${ids.chapterFirst}-${ids.act}-${ids.frameFirst}-${ids.lineFirst}`;
    await waitFor(() => expect(lineVoice()).toBe(taken));
    // A take that came back is played where it lies, and can be replaced.
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(
      screen.getByTestId("story-line-voice-take-0").getAttribute("src"),
    ).toContain(taken);
    expect(
      screen.getByTestId("story-line-voice-state-0").textContent,
    ).toContain("Read");
    // And the act's own button has nothing left to count.
    expect(screen.queryByTestId("story-act-voice-go-0")).toBeNull();
    expect(screen.getByTestId("story-act-voice-count-0").textContent).toContain(
      "1",
    );
  });

  it("counts a line whose words changed, and asks for it again alone", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-act-voice-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() => expect(lineVoice()).toBeDefined());

    // The line as it stands has its reading, so the button is gone.
    expect(screen.queryByTestId("story-act-voice-go-0")).toBeNull();
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(
      screen.getByTestId("story-line-voice-state-0").textContent,
    ).toContain("Read");

    // Rewritten, it is short of a reading again — and says why.
    fireEvent.change(screen.getByTestId("story-line-text-0"), {
      target: { value: "车不会来了。" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));
    await waitFor(() => expect(storyLine()?.text).toBe("车不会来了。"));
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(
      screen.getByTestId("story-line-voice-state-0").textContent,
    ).toContain("The words changed");
    // The act counts it again, and the old take is still there to hear.
    const speak = screen.getByTestId("story-act-voice-go-0");
    expect(speak.textContent).toContain("1");
    expect(
      screen.getByTestId("story-line-voice-take-0").getAttribute("src"),
    ).toContain("asset-lineVoice");

    // Asking again is another take for the line, not a replacement of what was
    // said before: the room waits out this batch, so the answer has to be ready
    // before the ask goes out.
    landed[
      `lineVoice:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}:${ids.lineFirst}`
    ] = ["asset-lineVoice-reread"];
    fireEvent.click(screen.getByTestId("story-line-voice-go-0"));
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]!.items.map((item) => item.id)).toEqual([
      `lineVoice:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}:${ids.lineFirst}`,
    ]);
    await comesBack();
    await waitFor(() => expect(lineVoice()).toBe("asset-lineVoice-reread"));
    expect(acts()[0]!.keyframes[0]!.voices?.[0]?.slot.takes).toHaveLength(2);
  });

  it("keeps an older reading of a line over the one made last", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-act-voice-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() => expect(lineVoice()).toBeDefined());
    const first = lineVoice()!;

    // Rewritten, the line is read again: the reading it had is kept beside the
    // new one rather than replaced by it.
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    fireEvent.change(screen.getByTestId("story-line-text-0"), {
      target: { value: "车不会来了。" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));
    await waitFor(() => expect(storyLine()?.text).toBe("车不会来了。"));
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    landed[
      `lineVoice:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}:${ids.lineFirst}`
    ] = ["asset-lineVoice-reread"];
    fireEvent.click(screen.getByTestId("story-line-voice-go-0"));
    await waitFor(() => expect(starts).toHaveLength(2));
    await comesBack();
    await waitFor(() => expect(lineVoice()).toBe("asset-lineVoice-reread"));

    // A line read more than once is a choice: the older reading is played in
    // the list and kept from it, and the row reads it from then on.
    fireEvent.click(screen.getByTestId("story-line-voice-pick-0"));
    expect(screen.getByTestId("story-audio-picks")).toBeDefined();
    fireEvent.click(screen.getByTestId(`story-audio-keep-${first}`));
    await waitFor(() => expect(lineVoice()).toBe(first));
    expect(
      screen.getByTestId("story-line-voice-take-0").getAttribute("src"),
    ).toContain(first);
    expect(screen.queryByTestId("story-audio-picks")).toBeNull();
  });

  it("asks for the score once the board says what the act sounds like", async () => {
    const moka = boarded();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    act.sound = { music: "", sfx: "", ambience: "" };
    openAtBoard(moka);
    const score = screen.getByTestId("story-act-music-go-0");
    expect((score as HTMLButtonElement).disabled).toBe(true);
    expect(score.getAttribute("title")).toContain("sounds like");

    fireEvent.change(screen.getByTestId("story-act-sound-music-0"), {
      target: { value: "低音提琴" },
    });
    fireEvent.blur(screen.getByTestId("story-act-sound-music-0"));
    await waitFor(() => expect(acts()[0]?.sound.music).toBe("低音提琴"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("story-act-music-go-0") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByTestId("story-act-music-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.kind).toBe("music");
    expect(starts[0]!.items[0]?.capability).toBe("music");
    expect(starts[0]!.items[0]?.params).toEqual({ instrumental: true });
  });

  it("says when an episode has sound, since assembling carries it", async () => {
    const moka = boarded();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    act.voice = {
      takes: [{ assetIds: ["asset-act-voice"], createdAt: T0 }],
    };
    openAtBoard(moka);
    expect(screen.getByTestId("story-board-sound").textContent).toContain(
      "goes on the timeline",
    );
    // A reading of the whole act, made before its lines had voices of their
    // own, is kept and playable where it was — and named for what it is.
    expect(
      screen.getByTestId("story-act-voice-0").getAttribute("src"),
    ).toContain("asset-act-voice");
    expect(
      screen.getByTestId("story-act-voice-0").parentElement?.textContent,
    ).toContain("whole act");
  });
});

describe("a reading too long for its shot", () => {
  it("says how much faster it will be read before the cut is made", () => {
    // The shot runs two seconds and the reading is two and two fifths: the
    // card says what fitting it will cost while there is still time to shorten
    // the words or lengthen the shot.
    openAtBoard(withReadLine(2_400));
    expect(openLine().textContent).toContain(
      "0.4s longer than its shot · read 1.20× faster",
    );
  });

  it("says which way a reading past the fastest read runs over", () => {
    openAtBoard(withReadLine(3_400));
    expect(openLine().textContent).toContain(
      "1.4s longer than its shot · read as fast as it may, 0.5s over the shot",
    );
  });

  it("says when nobody measured the reading at all", () => {
    openAtBoard(withReadLine());
    expect(openLine().textContent).toContain(
      "No measured length · laid at the shot's own length",
    );
  });

  it("keeps quiet about a reading that fits its shot", () => {
    openAtBoard(withReadLine(1_200));
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(screen.queryByTestId("story-line-voice-fit-0")).toBeNull();
  });
});

describe("a telling at the stress ceilings", () => {
  it("draws the episode it stands on and no other", () => {
    const moka = buildLongStory();
    const standing = moka.stories![0].chapters[0]!;
    openAtBoard(moka);

    // Every episode is a button in the strip; the board under it is the one
    // the room stands on. The other fifty-nine cost a button each, not a
    // table each, which is what makes sixty episodes openable at all.
    expect(screen.getAllByTestId(/^story-board-chapter-\d+$/)).toHaveLength(
      moka.stories![0].chapters.length,
    );
    expect(screen.getAllByTestId(/^story-act-\d+$/)).toHaveLength(
      standing.acts.length,
    );
    expect(screen.queryByTestId("story-act-30")).toBeNull();

    // A budget per shot rather than one flat number: the board is a row of
    // cells with its slots and its words, and how many rows an episode holds
    // is the telling's business. Measured at about ninety nodes a shot, the
    // fold's drawn chevron included.
    const shots = standing.acts.reduce(
      (sum, act) => sum + act.keyframes.length,
      0,
    );
    expect(document.querySelectorAll("body *").length).toBeLessThan(shots * 95);
  });
});

describe("the clock each act keeps", () => {
  /** Sets a batch's own clock, so a bar can be read without waiting a minute. */
  function startedAgo(jobId: string, seconds: number): void {
    const at = new Date(Date.now() - seconds * 1000).toISOString();
    useStoryJobStore.setState({
      jobs: useStoryJobStore
        .getState()
        .jobs.map((job) =>
          job.id === jobId ? { ...job, createdAt: at } : job,
        ),
    });
  }

  /** The bars standing in one act, which is what that act is waiting on. */
  function barsIn(index: number): HTMLElement[] {
    return within(card(index)).queryAllByTestId("story-act-running");
  }

  it("stands a batch's bar in the act it works in, and leaves the acts beside it alone", async () => {
    openAtBoard(withASecondAct());
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(1));
    // A bar is one act's own: the act beside it, whose shot nobody is drawing,
    // has nothing to say.
    expect(barsIn(1)).toHaveLength(0);
    // And what it says is that act's own work, counted in pieces and from the
    // batch's clock: three shots out, none of them home.
    startedAgo("job-1", 180);
    await waitFor(() => expect(barsIn(0)[0]!.textContent).toMatch(/03:0\d/));
    expect(barsIn(0)[0]!.textContent).toContain("0/3…");

    // A second ask, this time for the other act's shot: it gets a bar of its
    // own, and the first act's bar is not written over by it.
    fireEvent.click(screen.getByTestId("story-act-draw-1"));
    await waitFor(() => expect(barsIn(1)).toHaveLength(1));
    startedAgo("job-2", 60);
    await waitFor(() => expect(barsIn(1)[0]!.textContent).toMatch(/01:0\d/));
    expect(barsIn(0)).toHaveLength(1);
    expect(barsIn(0)[0]!.textContent).toMatch(/03:0\d/);
  });

  it("keeps one bar per batch when one act has two things out at once", async () => {
    openAtBoard(withUndrawnFrames());
    // Nothing comes home while the test watches, so both waits stand.
    landed["never-asked"] = ["asset-unused"];
    const first = card(0);
    // Two asks of the same act: its two shots drawn, and its line read aloud.
    // Neither is the newer word on the other — they are two waits.
    fireEvent.click(within(first).getByTestId("story-act-draw-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(1));
    fireEvent.click(within(first).getByTestId("story-act-voice-go-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(2));

    startedAgo("job-1", 300);
    startedAgo("job-2", 60);
    await waitFor(() => {
      const said = barsIn(0).map((bar) => bar.textContent ?? "");
      expect(said.some((text) => /05:0\d/.test(text))).toBe(true);
      expect(said.some((text) => /01:0\d/.test(text))).toBe(true);
    });

    // The batch of two pictures counts its pieces; a one-line ask has no
    // count to give.
    expect(barsIn(0).some((bar) => bar.textContent?.includes("0/2…"))).toBe(
      true,
    );
  });

  it("keeps an episode's board bar over its acts, and off the episode beside it", async () => {
    // The second episode has no board: the header's ask writes one straight
    // away, and the bar it puts up belongs to the episode rather than to any
    // act inside it.
    openAtBoard(boarded(), 1);
    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() =>
      expect(screen.getAllByTestId("story-board-running")).toHaveLength(1),
    );
    const bar = screen.getByTestId("story-board-running");
    expect(bar.textContent).toContain("Writing");
    startedAgo("job-1", 120);
    await waitFor(() => expect(bar.textContent).toMatch(/02:0\d/));

    // The episode beside it is not being written and does not say it is: a
    // board's bar stands over the board it is writing, and what the acts there
    // are having made is each act's own bar.
    fireEvent.click(screen.getByTestId("story-board-chapter-0"));
    expect(screen.queryAllByTestId("story-board-running")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(barsIn(0)).toHaveLength(1));
    expect(screen.queryAllByTestId("story-board-running")).toHaveLength(0);
  });
});

describe("a board bigger than one batch", () => {
  /** One act whose forty-five shots are all still waiting for a picture. */
  function withoutFortyFiveFrames(): MokaFile {
    const moka = withUndrawnFrames();
    const act = moka.stories![0]!.chapters[0]!.acts[0]!;
    act.keyframes = Array.from({ length: 45 }, (_, at) => createKeyframe(at));
    return moka;
  }

  it("asks every missing frame in waves the server takes", async () => {
    openAtBoard(withoutFortyFiveFrames());

    fireEvent.click(screen.getByTestId("story-board-draw-missing"));

    await waitFor(() => expect(starts).toHaveLength(2), { timeout: 5_000 });
    expect(starts.map((held) => held.items.length)).toEqual([40, 5]);
  });

  it("asks one act's shots in waves the server takes", async () => {
    openAtBoard(withoutFortyFiveFrames());

    fireEvent.click(screen.getByTestId("story-act-draw-0"));

    await waitFor(() => expect(starts).toHaveLength(2), { timeout: 5_000 });
    expect(starts.map((held) => held.items.length)).toEqual([40, 5]);
  });
});

describe("revising a board from a newer outline", () => {
  const revisionId = `outlineRevision:${ids.chapterFirst}:2`;

  /** The fixture's first episode, with its outline now standing at v2. */
  function withOutlineAhead(): MokaFile {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0]!;
    const chapter = story.chapters[0]!;
    chapter.revision = 2;
    chapter.boardRevision = 1;
    chapter.boardOutline = {
      title: chapter.title,
      synopsis: "旧梗概：灯还亮着。",
    };
    chapter.synopsis = "新梗概：灯忽然全灭了。";
    // The frame on file was drawn from the words the board still holds, which
    // is what makes the revised words show up as a drift afterwards.
    const frame = chapter.acts[0]!.keyframes[0]!;
    const planned = planKeyframeArt(story, [
      { chapterId: chapter.id, actId: ids.act, keyframeId: frame.id },
    ])[0]!.prompt;
    const asset = moka.resources.images.find(
      (entry) => entry.id === ids.frameArt,
    )!;
    asset.provenance = {
      createdAt: T0,
      parameterSnapshot: { prompt: planned },
    };
    return moka;
  }

  function revisionAnswer(
    patches: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      summary: "灯灭了。",
      needsRebuild: false,
      unmapped: [],
      acts: [],
      keyframes: patches,
      ...overrides,
    });
  }

  async function openTheProposal(): Promise<void> {
    fireEvent.click(screen.getByTestId("story-board-outline-update"));
    fireEvent.click(screen.getByTestId("story-outline-sync-start"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    fireEvent.click(screen.getByTestId("story-board-revision-review"));
  }

  it("asks for a revision, previews it, and brings the board up to date", async () => {
    openAtBoard(withOutlineAhead());
    expect(
      screen.getByTestId("story-board-outline-ahead").textContent,
    ).toContain("v2");

    fireEvent.click(screen.getByTestId("story-board-outline-update"));
    expect(screen.getByTestId("story-outline-sync")).toBeTruthy();
    fireEvent.click(screen.getByTestId("story-outline-sync-start"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.kind).toBe("outlineRevision");
    expect(starts[0]?.items[0]?.id).toBe(revisionId);
    expect(starts[0]?.items[0]?.prompt).toContain("旧梗概：灯还亮着。");
    expect(starts[0]?.items[0]?.prompt).toContain("新梗概：灯忽然全灭了。");

    answers[revisionId] = revisionAnswer([
      {
        actId: ids.act,
        keyframeId: ids.frameFirst,
        reason: "灯灭了",
        content: "`林`立在熄灭的灯下。",
      },
    ]);
    await comesBack();
    await waitFor(() =>
      expect(screen.getByTestId("story-board-revision-pending")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("story-board-revision-review"));

    const apply = screen.getByTestId(
      "story-board-revision-apply",
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toContain("v2");
    fireEvent.click(apply);

    await waitFor(() => expect(story().chapters[0]?.revision).toBe(2));
    const chapter = story().chapters[0]!;
    expect(chapter.boardRevision).toBe(2);
    expect(chapter.boardOutline).toBeUndefined();
    expect(chapter.acts[0]?.keyframes[0]?.content).toBe("`林`立在熄灭的灯下。");
    expect(chapter.acts[0]?.keyframes[0]?.art.takes[0]?.assetIds).toEqual([
      ids.frameArt,
    ]);
    // The picture still on file was drawn from the old words, and the board
    // says so beside the shot, with a way to redraw the shots that drifted.
    expect(
      screen.getByTestId(`story-frame-prompt-drift-${ids.frameFirst}`),
    ).toBeTruthy();
    expect(
      screen.getByTestId("story-board-redraw-drifted").textContent,
    ).toContain("1");
    expect(screen.queryByTestId("story-board-outline-ahead")).toBeNull();
  });

  it("leaves the outline ahead when a suggested change is left out", async () => {
    openAtBoard(withOutlineAhead());
    answers[revisionId] = revisionAnswer([
      {
        actId: ids.act,
        keyframeId: ids.frameFirst,
        content: "`林`立在熄灭的灯下。",
      },
      {
        actId: ids.act,
        keyframeId: ids.frameSecond,
        content: "`周`在黑暗里转过身来。",
      },
    ]);
    await openTheProposal();

    fireEvent.click(screen.getByTestId("story-board-revision-frame-frame-2"));
    const apply = screen.getByTestId(
      "story-board-revision-apply",
    ) as HTMLButtonElement;
    expect(apply.textContent).toContain("stays at v1");
    fireEvent.click(apply);

    await waitFor(() =>
      expect(story().chapters[0]?.acts[0]?.keyframes[0]?.content).toBe(
        "`林`立在熄灭的灯下。",
      ),
    );
    expect(story().chapters[0]?.boardRevision).toBe(1);
    expect(story().chapters[0]?.acts[0]?.keyframes[1]?.content).toBe(
      "`周`转过身来。",
    );
    expect(screen.getByTestId("story-board-outline-ahead")).toBeTruthy();
  });

  it("offers a rebuild when the change cannot be carried by shot words", async () => {
    openAtBoard(withOutlineAhead());
    answers[revisionId] = revisionAnswer([], {
      needsRebuild: true,
      unmapped: ["换到了车厢外"],
    });
    await openTheProposal();

    expect(screen.getByTestId("story-board-revision-rebuild")).toBeTruthy();
    expect(screen.queryByTestId("story-board-revision-apply")).toBeNull();
  });

  it("rebuilds the episode from the chooser and brings the version up to date", async () => {
    openAtBoard(withOutlineAhead());
    fireEvent.click(screen.getByTestId("story-board-outline-update"));
    fireEvent.click(screen.getByTestId("story-outline-sync-rebuild"));
    fireEvent.click(screen.getByTestId("story-outline-sync-start"));

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.kind).toBe("storyboard");
    expect(starts[0]?.items[0]?.id).toBe(`storyboard:${ids.chapterFirst}`);

    answers[`storyboard:${ids.chapterFirst}`] = boardAnswer("wide", "close");
    await comesBack();

    await waitFor(() => expect(story().chapters[0]?.boardRevision).toBe(2));
    expect(story().chapters[0]?.boardOutline).toBeUndefined();
    expect(
      story().chapters[0]?.acts[0]?.keyframes[0]?.art.takes[0]?.assetIds,
    ).toEqual([ids.frameArt]);
  });
});
