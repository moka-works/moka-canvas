import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  DEFAULT_PX_PER_SEC,
  RULER_H,
  TRACK_HEIGHT,
} from "../src/features/clip/timeline/geometry";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  projectHome,
} from "./helpers";

/**
 * What the picture does as the clock crosses a cut, under a slow origin.
 *
 * The complaint this suite exists for: a piece's first seconds show the loading
 * place while the clock runs on without it. The fixture is four seconds of VP9
 * behind one keyframe, so a cold read pays for the whole group, and every
 * asset request is held up a tenth of a second — a real project's six
 * connections, shared by pictures, sounds and their parts.
 *
 * Nothing here reads pixels: where the picture really stands is published as
 * `data-frame-material-ms` and whether a loading place was drawn at all as
 * `data-picture-state`, so the fact the complaint is about can be asserted
 * directly. The clock itself is the timeline's own `data-playhead-ms`.
 *
 * The fixture was written once, and is remade the same way if it ever is:
 *
 *   ffmpeg -f lavfi -i color=c=0xFF0000:s=320x180:r=10:d=1 \
 *          -f lavfi -i color=c=0x00FF00:s=320x180:r=10:d=1 \
 *          -f lavfi -i color=c=0x0000FF:s=320x180:r=10:d=1 \
 *          -f lavfi -i color=c=0xFFFF00:s=320x180:r=10:d=1 \
 *     -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]" -map "[v]" \
 *     -c:v libvpx-vp9 -b:v 300k -g 40 -keyint_min 40 -movflags +faststart \
 *     -an e2e/fixtures/longgop.mp4
 */

/** How long each asset request is held, on top of the round trip. */
const ASSET_DELAY_MS = 150;
/** Two whole pieces, butted: the first at one second, the second at five. */
const FIRST_START_MS = 1_000;
const SECOND_START_MS = 5_000;
const PIECE_MS = 4_000;
/** How long the run is watched: both pieces and their two cuts. */
const WATCH_MS = 9_500;
/** How often the stage is read while the clock runs. */
const SAMPLE_MS = 100;
/** How long after a cut the picture is given to be live: the plan's own window. */
const CATCHUP_MS = 500;
/** How far behind the clock the picture may still be once that window is out. */
const CATCHUP_TOLERANCE_MS = 250;

const VIDEO_ROW_Y =
  RULER_H + TRACK_HEIGHT.text + TRACK_HEIGHT.audio + TRACK_HEIGHT.video / 2;
const ASSET_DRAG_MIME = "application/x-moka-asset";

/** Where a moment sits on the canvas, at the room's own default scale. */
function xFor(ms: number): number {
  return (ms / 1_000) * DEFAULT_PX_PER_SEC;
}

/** One reading of the room, taken while the clock runs. */
interface Sample {
  /** Where the room's clock stood. */
  clockMs: number;
  /** The material moment of the picture drawn, or null when none was. */
  materialMs: number | null;
  /** What the stage drew: a picture, a loading place, or nothing. */
  state: string;
  /** The engine the drawn frame came from. */
  engine: string;
}

/** A fresh project already standing in the cutting room. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-preview-cuts");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/** The id the document filed the fixture under, read from the server. */
async function filedId(page: Page, name: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { resources?: Record<string, { id: string; name: string }[]> };
    };
    for (const entries of Object.values(body.moka?.resources ?? {})) {
      const found = entries.find((entry) => entry.name === wanted);
      if (found) return found.id;
    }
    return "";
  }, name);
}

/**
 * Drops a shelf asset on the timeline by dispatch rather than by mouse, as the
 * other clip specs do: the id under the shelf's own type, and the pointer
 * where the reader let go.
 */
async function dropAssetOnTimeline(
  page: Page,
  assetId: string,
  at: { x: number; y: number },
) {
  const box = await page.locator(".clip-tl-canvas").boundingBox();
  if (!box) throw new Error("the timeline canvas is not there");
  await page.evaluate(
    ({ assetId, clientX, clientY, mime }) => {
      const Browser = globalThis as unknown as {
        DataTransfer: new () => { setData(type: string, value: string): void };
        DragEvent: new (type: string, init: Record<string, unknown>) => unknown;
        document: {
          querySelector(selector: string): {
            dispatchEvent(event: unknown): boolean;
          } | null;
        };
      };
      const canvas = Browser.document.querySelector(".clip-tl-canvas");
      if (!canvas) throw new Error("the timeline canvas is not there");
      const data = new Browser.DataTransfer();
      data.setData(mime, assetId);
      const init = {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        dataTransfer: data,
      };
      canvas.dispatchEvent(new Browser.DragEvent("dragover", init));
      canvas.dispatchEvent(new Browser.DragEvent("drop", init));
    },
    {
      assetId,
      clientX: box.x + at.x,
      clientY: box.y + at.y,
      mime: ASSET_DRAG_MIME,
    },
  );
}

/** One reading of the stage and the timeline's clock. */
async function readStage(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    // Typed structurally: this suite's tsconfig carries no DOM lib.
    const Browser = globalThis as unknown as {
      document: {
        querySelector(selector: string): {
          getAttribute(name: string): string | null;
        } | null;
      };
    };
    const stage = Browser.document.querySelector(".clip-preview");
    const timeline = Browser.document.querySelector(".clip-timeline");
    const material = stage?.getAttribute("data-frame-material-ms") ?? null;
    return {
      clockMs: Number(timeline?.getAttribute("data-playhead-ms") ?? "-1"),
      materialMs: material === null ? null : Number(material),
      state: stage?.getAttribute("data-picture-state") ?? "none",
      engine: stage?.getAttribute("data-engine") ?? "none",
    };
  });
}

/** Puts the pointer in the room, so the keys land on the page and not on a field. */
async function focusRoom(page: Page) {
  const canvas = page.locator(".clip-tl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the timeline canvas is not there");
  await canvas.click({ position: { x: box.width - 20, y: VIDEO_ROW_Y } });
}

test("both pieces show their picture as the clock crosses their cuts", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const home = await clipRoom(page, "Preview Cuts");
  await newTimeline(page, "Timeline 1");
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "longgop.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync("e2e/fixtures/longgop.mp4"),
  });
  const assetId = await expect
    .poll(() => filedId(page, "longgop.mp4"), { timeout: 15_000 })
    .not.toBe("")
    .then(() => filedId(page, "longgop.mp4"));

  // The slow origin goes up before the pieces land, so the whole run — the
  // shelf's own thumbnail reads included — is cold.
  await page.route("**/projects/current/assets/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ASSET_DELAY_MS));
    await route.continue();
  });

  for (const startMs of [FIRST_START_MS, SECOND_START_MS]) {
    await dropAssetOnTimeline(page, assetId, {
      x: xFor(startMs),
      y: VIDEO_ROW_Y,
    });
  }
  await expect(page.locator(".clip-timeline")).toHaveAttribute(
    "data-clip-count",
    "2",
  );

  await focusRoom(page);
  await page.keyboard.press("Space");
  const samples: Sample[] = [];
  const until = Date.now() + WATCH_MS;
  while (Date.now() < until) {
    samples.push(await readStage(page));
    await page.waitForTimeout(SAMPLE_MS);
  }
  await page.keyboard.press("Space");

  // The run is the reading: the clock has to have carried both cuts.
  const last = samples[samples.length - 1];
  expect(last.clockMs).toBeGreaterThan(
    SECOND_START_MS + CATCHUP_MS + PIECE_MS / 2,
  );

  // A loading place is the complaint itself: while the clock runs, the picture
  // is a picture, a piece that has not started, or a gap — never a spinner.
  const waiting = samples.filter((sample) => sample.state === "waiting");
  expect(
    waiting,
    `the clock ran past ${waiting.map((sample) => sample.clockMs).join(", ")}ms with a loading place`,
  ).toEqual([]);

  // The fallback engine draws an approximation of another moment; a fact this
  // suite is not measuring, and never what a cut of decodable files should be.
  const demoted = samples.filter((sample) => sample.engine === "element");
  expect(demoted.map((sample) => sample.clockMs)).toEqual([]);

  for (const startMs of [FIRST_START_MS, SECOND_START_MS]) {
    const band = samples.filter(
      (sample) =>
        sample.clockMs >= startMs && sample.clockMs <= startMs + CATCHUP_MS,
    );
    expect(
      band.length,
      `the clock was watched across ${startMs}ms`,
    ).toBeGreaterThan(0);
    const settled = band[band.length - 1];
    expect(
      settled.materialMs,
      `a picture is drawn by ${startMs + CATCHUP_MS}ms`,
    ).not.toBeNull();
    // How far behind the clock the picture still is, with the clock's own
    // distance past the cut taken out: a live picture reads zero.
    const lag = settled.clockMs - startMs - (settled.materialMs as number);
    expect(
      lag,
      `the picture is live ${CATCHUP_MS}ms after the cut at ${startMs}ms`,
    ).toBeLessThanOrEqual(CATCHUP_TOLERANCE_MS);
  }

  forgetHome(home);
});
