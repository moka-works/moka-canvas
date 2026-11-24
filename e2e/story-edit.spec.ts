import { expect, test, type Page } from "./fixtures";
import {
  configureTheWholeStudio,
  filmAct,
  forgetHome,
  forgetProjects,
  openSeededStory,
  projectHome,
} from "./helpers";

// The whole telling is walked in one test — five steps, every ask through a
// stand-in — which needs longer than the suite's own budget for one case.
test.describe.configure({ timeout: 90_000 });

/**
 * The fifth step: a telling's clips laid end to end as one timeline.
 *
 * The whole telling is taken there — premise, chapters, cast, board, both acts
 * framed and filmed, and the first act's sound — and assembled: what the step
 * is for is that the acts a reader has drawn and filmed come out as one cut, on
 * a timeline of its own that the cutting room can go on working on. The sound is
 * the part of the step that may be skipped (a telling with no score is still a
 * telling); it is walked here because a track nothing ever asks for is a track
 * nobody has seen work.
 */

/** The timeline the server has for the first story, as the document holds it. */
async function persistedTimeline(page: Page): Promise<{
  name: string;
  isTheStories: boolean;
  clips: Array<{
    kind: string;
    startMs: number;
    durationMs: number;
    label: string;
    fontSize?: number;
  }>;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: { edit?: { timelineId?: string } }[];
        timelines?: {
          id?: string;
          name?: string;
          clips?: {
            kind?: string;
            startMs?: number;
            durationMs?: number;
            label?: string;
            text?: { style?: { fontSize?: number } };
          }[];
        }[];
      };
    };
    const wanted = body.moka?.stories?.[0]?.edit?.timelineId;
    const timeline = (body.moka?.timelines ?? []).find(
      (held) => held.id === wanted,
    );
    return {
      name: timeline?.name ?? "",
      isTheStories: timeline !== undefined,
      clips: (timeline?.clips ?? []).map((clip) => ({
        kind: clip.kind ?? "",
        startMs: clip.startMs ?? 0,
        durationMs: clip.durationMs ?? 0,
        label: clip.label ?? "",
        ...(clip.text?.style?.fontSize === undefined
          ? {}
          : { fontSize: clip.text.style.fontSize }),
      })),
    };
  });
}

test("a telling is assembled into one timeline and handed to the cutting room", async ({
  page,
}) => {
  const home = projectHome("story-edit");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    // The telling stands at a boarded episode whose frames are drawn; the
    // films and sound below are what the fifth step lays down.
    await openSeededStory(page, home);
    const firstAct = page.getByTestId("story-act-0");
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });
    await filmAct(page, firstAct, 0);
    await expect(firstAct.getByTestId("story-act-video-0")).toBeVisible({
      timeout: 60_000,
    });

    // The sound of the act, asked for as two pieces of the whole act: the lines
    // read aloud in the voice of whoever says them, and the music and sound
    // under them.
    await firstAct.getByTestId("story-act-voice-go-0").click();
    await expect(firstAct.getByTestId("story-act-voice-count-0")).toBeVisible({
      timeout: 60_000,
    });
    await firstAct.getByTestId("story-act-music-go-0").click();
    await expect(firstAct.getByTestId("story-act-music-0")).toBeVisible({
      timeout: 60_000,
    });

    // The score is a take like any other: asking again keeps both, and the row
    // that plays one says which score the act is scored by — and is where an
    // older one leaves, its file with it.
    const score = firstAct.getByTestId("story-act-music-0");
    const firstScore = await score.getAttribute("src");
    await firstAct.getByTestId("story-act-music-again-0").click();
    await expect(score).not.toHaveAttribute("src", firstScore ?? "");
    const secondScore = await score.getAttribute("src");
    const fileOf = (url: string | null) =>
      url === null
        ? ""
        : (new URL(url, "http://localhost").pathname.split("/").pop() ?? "");
    await firstAct.getByTestId("story-act-music-pick-0").click();
    const scores = page.getByTestId("story-audio-picks");
    await expect(scores.locator(".story-pick-tile")).toHaveCount(2);
    await expect(
      scores.getByTestId(`story-audio-pick-${fileOf(secondScore)}`),
    ).toHaveClass(/is-current/);
    await scores.getByTestId(`story-audio-keep-${fileOf(firstScore)}`).click();
    await expect(page.getByTestId("story-audio-picks")).toHaveCount(0);
    await expect(score).toHaveAttribute("src", firstScore ?? "");

    await firstAct.getByTestId("story-act-music-pick-0").click();
    await scores
      .getByTestId(`story-audio-pick-remove-${fileOf(secondScore)}`)
      .click();
    await expect(page.getByTestId("story-pick-ask")).toContainText("recording");
    await page.getByTestId("story-pick-remove-confirm").click();
    await expect(scores.locator(".story-pick-tile")).toHaveCount(1);
    await expect(
      scores.getByTestId(`story-audio-pick-remove-${fileOf(firstScore)}`),
    ).toHaveCount(0);
    await scores.getByRole("button", { name: "Close" }).click();

    // The second act is framed and filmed too, which is what the step's own
    // press reads before it opens step five.
    const secondAct = page.getByTestId("story-act-1");
    await filmAct(page, secondAct, 1);
    await expect(secondAct.getByTestId("story-act-video-1")).toBeVisible({
      timeout: 60_000,
    });
    await page.getByTestId("story-confirm-storyboard").click();
    await expect(page.getByTestId("story-step-body-edit")).toBeVisible();

    // Step five: the filmed acts are laid down as a timeline of the telling's own.
    await page.getByTestId("story-step-edit").click();
    await expect(page.getByTestId("story-step-edit-body")).toBeVisible();
    await expect(page.getByTestId("story-assembly-summary")).toContainText("2");
    await expect(page.getByTestId("story-assembly-sound")).toBeVisible();
    // The card's own link is the way the clips are laid out; there is no
    // confirm button on this step and nothing above the card any more.
    await expect(page.getByTestId("story-confirm-edit")).toHaveCount(0);
    await page.getByTestId("story-film-reassemble").click();

    await expect
      .poll(async () => (await persistedTimeline(page)).name, {
        timeout: 30_000,
      })
      .toContain("Rain at Night");
    const timeline = await persistedTimeline(page);
    expect(timeline.isTheStories).toBe(true);
    // The clip of each act in telling order, the two lines read aloud inside
    // the shots they are said in, the score under the act, then the words said
    // in it — laid down from zero, the lengths coming from the material the
    // stand-in handed back.
    expect(timeline.clips.map((clip) => clip.kind)).toEqual([
      "video",
      "video",
      "audio",
      "audio",
      "audio",
      "text",
      "text",
    ]);
    expect(timeline.clips[0]?.startMs).toBe(0);
    expect(timeline.clips[0]?.durationMs).toBe(1_000);
    expect(timeline.clips[1]?.startMs).toBe(1_000);
    expect(timeline.clips[1]?.durationMs).toBe(1_000);
    // One reading a line: the first shot's second lies at the head of the act,
    // and the second shot's — whose shot opens three seconds into the act —
    // where that shot opens. The score runs under the whole act.
    expect(timeline.clips[2]?.startMs).toBe(0);
    expect(timeline.clips[2]?.durationMs).toBe(1_000);
    expect(timeline.clips[3]?.startMs).toBe(3_000);
    expect(timeline.clips[3]?.durationMs).toBe(1_000);
    expect(timeline.clips[4]?.startMs).toBe(0);
    // A caption begins with the voice over it and lasts at least as long as
    // the words do.
    expect(timeline.clips[5]?.startMs).toBe(0);
    expect(timeline.clips[5]?.durationMs).toBe(3_000);
    expect(timeline.clips[6]?.startMs).toBe(3_000);
    expect(timeline.clips[6]?.durationMs).toBe(2_000);

    // The e2e harness points MOKA_FFMPEG at a path that is never there, so
    // this is every machine at once: the film card reads once what the
    // machine can do and refuses the render with that reason rather than
    // failing when pressed. A real render belongs to whatever ffmpeg a host
    // has, and is not asserted here.
    await expect(page.getByTestId("story-film-capability")).toContainText(
      "ffmpeg was not found",
    );
    const render = page.getByTestId("story-film-export");
    await expect(render).toBeDisabled();
    await expect(render).toHaveAttribute("title", /ffmpeg was not found/);
    // And no save dialog either: the path is a question only a render that
    // can happen is worth asking.
    await expect(page.getByTestId("path-browser")).toHaveCount(0);

    // A cover for the open episode: a picture and its title at the episode's
    // start, laid by the story room and opened in the cutting room.
    await page.getByTestId("story-film-add-cover").click();
    await expect(page.getByTestId("clip-page")).toBeVisible({
      timeout: 10_000,
    });
    const covered = await persistedTimeline(page);
    const coverClips = covered.clips.filter((clip) =>
      clip.label.startsWith("Cover"),
    );
    expect(coverClips.map((clip) => clip.kind).sort()).toEqual([
      "text",
      "video",
    ]);
    expect(coverClips.every((clip) => clip.startMs === 0)).toBe(true);
    expect(coverClips.find((clip) => clip.kind === "text")?.fontSize).toBe(96);
    await expect(
      page
        .getByRole("tablist", { name: "Timelines" })
        .getByRole("tab", { name: /Rain at Night/ }),
    ).toHaveAttribute("aria-selected", "true");
  } finally {
    forgetHome(home);
  }
});
