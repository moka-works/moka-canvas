import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  configureModels,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";
import {
  MUSICIAN,
  PAINTER,
  providerCalls,
  READER,
  SPEAKER,
  STORYTELLER,
  VIDEOGRAPHER,
} from "./mock-provider";

// The whole telling is walked in one test — five steps, every ask through a
// stand-in — which needs longer than the suite's own budget for one case.
test.describe.configure({ timeout: 90_000 });

/**
 * The telling read aloud line by line, in the voice of whoever says each line.
 *
 * The room the test walks is the one a reader works in when a telling has more
 * than one speaking part: two characters are given two voices on the third
 * step, the lines are read one ask at a time, and the film is assembled with
 * every reading laid down inside the shot it is said in — how long it is, how
 * fast it has to be read to fit, and where the words on screen begin.
 */

/** The voices the story carries, by the name of the character wearing them. */
async function persistedVoices(
  page: Page,
): Promise<Array<{ name: string; model?: string; voice?: string }>> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          elements?: Array<{
            name?: string;
            voice?: { model?: string; voice?: string };
          }>;
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.elements ?? []).map((element) => ({
      name: element.name ?? "",
      ...(element.voice?.model === undefined
        ? {}
        : { model: element.voice.model }),
      ...(element.voice?.voice === undefined
        ? {}
        : { voice: element.voice.voice }),
    }));
  });
}

/** The lines the story holds and what has been read for them, shot by shot. */
async function persistedReadings(page: Page): Promise<
  Array<{
    lineId: string;
    text: string;
    takes: number;
  }>
> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            acts?: {
              keyframes?: Array<{
                dialogue?: Array<{ id?: string; text?: string }>;
                voices?: Array<{
                  lineId?: string;
                  slot?: { takes?: unknown[] };
                }>;
              }>;
            }[];
          }[];
        }[];
      };
    };
    const shots = (body.moka?.stories?.[0]?.chapters ?? []).flatMap((chapter) =>
      (chapter.acts ?? []).flatMap((act) => act.keyframes ?? []),
    );
    return shots.flatMap((shot) =>
      (shot.dialogue ?? []).map((line) => ({
        lineId: line.id ?? "",
        text: line.text ?? "",
        takes:
          (shot.voices ?? []).find((voice) => voice.lineId === line.id)?.slot
            ?.takes?.length ?? 0,
      })),
    );
  });
}

/** The clips of the timeline the telling was assembled onto, in order. */
async function persistedClips(page: Page): Promise<
  Array<{
    kind: string;
    assetId: string;
    startMs: number;
    durationMs: number;
    speed: number;
  }>
> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: { edit?: { timelineId?: string } }[];
        timelines?: {
          id?: string;
          clips?: Array<{
            kind?: string;
            assetId?: string;
            startMs?: number;
            durationMs?: number;
            speed?: number;
          }>;
        }[];
      };
    };
    const wanted = body.moka?.stories?.[0]?.edit?.timelineId;
    const timeline = (body.moka?.timelines ?? []).find(
      (held) => held.id === wanted,
    );
    return (timeline?.clips ?? []).map((clip) => ({
      kind: clip.kind ?? "",
      assetId: clip.assetId ?? "",
      startMs: clip.startMs ?? 0,
      durationMs: clip.durationMs ?? 0,
      speed: clip.speed ?? 1,
    }));
  });
}

test("a telling is read line by line, each in the voice of whoever says it", async ({
  page,
}) => {
  const home = projectHome("story-dubbing");
  await forgetProjects();
  // Two speech models, because the telling has two speaking parts and a batch
  // carries one model: the room has to ask each character's lines of its own.
  await configureModels([
    { id: PAINTER, capability: "image", alias: "Painter" },
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
    { id: VIDEOGRAPHER, capability: "video", alias: "Videographer" },
    { id: SPEAKER, capability: "speech", alias: "Speaker" },
    { id: READER, capability: "speech", alias: "Reader" },
    {
      id: MUSICIAN,
      capability: "music",
      alias: "Musician",
      converter: "bailianMusic",
    },
  ]);
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Dubbing");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // Steps one and two: a premise, and the chapters it is told in.
    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.getByTestId("story-confirm-outline").click();

    // Step three: the cast, each speaking part with a voice of its own. Keeper
    // reads for a second and Traveller for four — the stand-in's own rule for
    // a voice named "long" — which is what the last part of this test needs.
    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await page
      .getByTestId("story-voice-Keeper-model")
      .locator("select")
      .selectOption(SPEAKER);
    await page.getByTestId("story-voice-Keeper-tone").fill("plain");
    await page.getByTestId("story-voice-Keeper-tone").press("Enter");
    await page
      .getByTestId("story-voice-Traveller-model")
      .locator("select")
      .selectOption(READER);
    await page.getByTestId("story-voice-Traveller-tone").fill("long");
    await page.getByTestId("story-voice-Traveller-tone").press("Enter");
    // Both cards say what they are now: a voice of this character's own, and
    // not the fallback the narrator and the unchosen keep.
    await expect(page.getByTestId("story-voice-Keeper-state")).toHaveText(
      "Voice set",
    );
    await expect(page.getByTestId("story-voice-Traveller-state")).toHaveText(
      "Voice set",
    );
    // Written down rather than only drawn: the voices are read back from the
    // server, once the change has landed there.
    await expect
      .poll(async () => (await persistedVoices(page)).length, {
        timeout: 30_000,
      })
      .toBe(4);
    await expect
      .poll(
        async () =>
          (await persistedVoices(page)).filter(
            (held) => held.model !== undefined,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(2);
    const voices = await persistedVoices(page);
    expect(voices).toEqual(
      expect.arrayContaining([
        { name: "Keeper", model: SPEAKER, voice: "plain" },
        { name: "Traveller", model: READER, voice: "long" },
      ]),
    );

    // The drawings the step waits on, and then the board.
    await page.getByTestId("story-elements-draw-all").click();
    await expect(page.getByTestId("story-elements-views-all")).toBeEnabled({
      timeout: 60_000,
    });
    await page.getByTestId("story-elements-views-all").click();
    await expect(
      page
        .getByTestId("story-element-character-Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByTestId("story-step-storyboard").click();
    const firstAct = page.getByTestId("story-act-0");
    await page.getByTestId("story-board-generate").click();
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });

    // Step four: the act says two lines, by two characters, and the room counts
    // them out on the button. One press reads both, one ask a line, each of the
    // model its own speaker was given.
    const speak = firstAct.getByTestId("story-act-voice-go-0");
    await expect(speak).toContainText("2");
    await speak.click();
    await expect(firstAct.getByTestId("story-act-voice-count-0")).toBeVisible({
      timeout: 60_000,
    });
    // Both lines came home with a reading of their own, and no further ask is
    // made now that they have: the button is gone and the act says so.
    await expect
      .poll(
        async () => (await persistedReadings(page)).map((line) => line.takes),
        { timeout: 30_000 },
      )
      .toEqual([1, 1]);
    await expect(firstAct.getByTestId("story-act-voice-go-0")).toHaveCount(0);
    await expect(firstAct.getByTestId("story-act-voice-count-0")).toContainText(
      "2",
    );
    // Each line was asked in turn, in the words of that line alone, of the
    // character's own model: two models, one ask each.
    const spoken = (await providerCalls()).filter(
      (call) => call.path === "/v1/audio/speech",
    );
    expect(spoken.map((call) => call.model).sort()).toEqual([READER, SPEAKER]);
    const keeperAsk = spoken.find((call) => call.model === SPEAKER);
    const travellerAsk = spoken.find((call) => call.model === READER);
    expect(keeperAsk?.prompt).toContain("It stopped running years ago.");
    expect(keeperAsk?.prompt).not.toContain("Then we walk.");
    expect(travellerAsk?.prompt).toContain("Then we walk.");
    expect(travellerAsk?.prompt).not.toContain("It stopped running");
    // A line read once is a line read: pressing again asks for nothing.
    await firstAct.getByTestId("story-kf-dialogue-0").click();
    await expect(
      firstAct.getByTestId("story-line-voice-state-0"),
    ).toContainText("Read");
    await expect(firstAct.getByTestId("story-line-voice-take-0")).toBeVisible();
    await firstAct.getByTestId("story-kf-dialogue-1").click();
    await expect(
      firstAct.getByTestId("story-line-voice-state-0"),
    ).toContainText("Read");
    await firstAct.getByTestId("story-kf-dialogue-0").click();

    // Every frame of both acts is drawn and filmed, which is what the fifth
    // step lays down.
    await firstAct.getByTestId("story-act-draw-0").click();
    await expect(
      firstAct.getByTestId("story-kf-slot-0").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      firstAct.getByTestId("story-kf-slot-1").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await firstAct.getByTestId("story-act-video-go-0").click();
    await expect(firstAct.getByTestId("story-act-video-0")).toBeVisible({
      timeout: 60_000,
    });
    const secondAct = page.getByTestId("story-act-1");
    await secondAct.getByTestId("story-act-draw-1").click();
    await expect(
      secondAct.getByTestId("story-kf-slot-0").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await secondAct.getByTestId("story-act-video-go-1").click();
    await expect(secondAct.getByTestId("story-act-video-1")).toBeVisible({
      timeout: 60_000,
    });
    await page.getByTestId("story-confirm-storyboard").click();
    await expect(page.getByTestId("story-step-body-edit")).toBeVisible();

    // Step five: nothing has been laid down yet, so the film is behind the
    // telling — and the card says so, says what a film would carry, and says
    // that pressing export would assemble first rather than render the older
    // one. (This machine has no ffmpeg, so the press itself is not the test.)
    await page.getByTestId("story-step-edit").click();
    await expect(page.getByTestId("story-step-edit-body")).toBeVisible();
    await expect(page.getByTestId("story-film-freshness")).toContainText(
      "behind the telling",
    );
    await expect(page.getByTestId("story-film-export")).toContainText(
      "assemble first",
    );
    await expect(page.getByTestId("story-film-carries")).toContainText(
      "2 readings",
    );

    // Assembled, the film is the telling as it stands: every reading is laid
    // down inside the shot it is said in, and the words follow the voices.
    await page.getByTestId("story-film-reassemble").click();
    await expect(page.getByTestId("story-film-freshness")).toContainText(
      "as it stands",
      { timeout: 30_000 },
    );
    // The timeline is the server's, so what was assembled is read back once it
    // has landed there: two pictures, two readings, and the words said in it.
    await expect
      .poll(async () => (await persistedClips(page)).length, {
        timeout: 30_000,
      })
      .toBe(6);
    const clips = await persistedClips(page);
    const readings = clips.filter((clip) => clip.kind === "audio");
    expect(readings).toHaveLength(2);
    // Keeper's line opens the act and fits its three-second shot at the length
    // it was read; Traveller's opens the second shot, which is two seconds
    // long, and its four seconds are read as fast as a voice may be: 1.35×,
    // rounded to 2963ms, which is 963ms past the shot it was said in.
    expect(readings.map((clip) => [clip.startMs, clip.durationMs])).toEqual([
      [0, 1_000],
      [3_000, 2_963],
    ]);
    expect(readings[0]?.speed).toBeCloseTo(1, 5);
    expect(readings[1]?.speed).toBeCloseTo(1.35, 2);
    expect(Math.round(readings[1]!.durationMs * readings[1]!.speed)).toBe(
      4_000,
    );
    // The words on screen begin where their voices do, and last as long as
    // what was said: the second caption is the reading that ran over.
    const captions = clips.filter((clip) => clip.kind === "text");
    expect(captions.map((clip) => [clip.startMs, clip.durationMs])).toEqual([
      [0, 3_000],
      [3_000, 2_963],
    ]);
    // And the second act, which says nothing, carries no voice at all.
    expect(readings).toHaveLength(2);
  } finally {
    forgetHome(home);
  }
});
