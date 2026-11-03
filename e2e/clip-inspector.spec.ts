import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  projectHome,
} from "./helpers";

// A tiny valid PNG (1x1 transparent pixel), as the other clip specs use.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const ASSET_DRAG_MIME = "application/x-moka-asset";
/** Where a dropped clip's head lands and where a press lands inside its body. */
const DROP_X = 300;
const BODY_X = 420;

/** A small valid WAV: a header, then a few seconds of silence. */
function tinyWav(seconds = 6): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

interface DragData {
  setData(type: string, value: string): void;
}

function timeline(page: Page) {
  return page.locator(".clip-timeline");
}

async function canvasBox(page: Page) {
  const box = await page.locator(".clip-tl-canvas").boundingBox();
  if (!box) throw new Error("the timeline canvas is not there");
  return box;
}

/** Drops a shelf asset on the timeline by dispatch, as the gesture specs do. */
async function dropAssetOnTimeline(
  page: Page,
  assetId: string,
  at: { x: number; y: number },
) {
  const box = await canvasBox(page);
  await page.evaluate(
    ({ assetId, clientX, clientY, mime }) => {
      const Browser = globalThis as unknown as {
        DataTransfer: new () => DragData;
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

/** Where a row's centre sits on the page, read off the header beside it. */
async function rowCenter(page: Page, trackName: string) {
  const box = await page
    .locator(".clip-tl-header-row", { hasText: trackName })
    .boundingBox();
  if (!box) throw new Error(`the ${trackName} header is not there`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** One block as the timeline's own seam writes it: `id@trackId:start:duration`. */
interface Span {
  id: string;
  trackId: string;
  startMs: number;
  durationMs: number;
}

async function spans(page: Page): Promise<Span[]> {
  const raw = (await timeline(page).getAttribute("data-clip-spans")) ?? "";
  return raw
    .split(";")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [id, rest] = entry.split("@");
      const [trackId, start, duration] = rest.split(":");
      return {
        id,
        trackId,
        startMs: Number(start),
        durationMs: Number(duration),
      };
    });
}

/** A fresh project already standing in the cutting room, with room to cut in. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-inspector");
  await forgetProjects();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/** Imports one file through the shelf's own input, and waits for its row. */
async function importFile(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page
    .getByLabel("Import files", { exact: true })
    .setInputFiles({ name, mimeType, buffer });
  // A shelf opens on pictures, so a sound arriving is waited for under the
  // audio tab of the face it lands on. The tab is pressed right after the
  // import rather than before it: what arrived waits in the tray above the
  // cut's own list, and a tab turned over too early would be left behind.
  if (mimeType.startsWith("audio/")) {
    await page.getByTestId("asset-kind-audio").click();
  }
  await expect(
    page.getByRole("button", { name: new RegExp(`^${escaped} `) }),
  ).toBeVisible({ timeout: 10_000 });
}

/** The id the document filed a file under, read from the server. */
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

/** One file dropped at a canvas x on the row of the given kind. */
async function dropOne(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
  trackName: string,
) {
  await importFile(page, name, mimeType, buffer);
  const assetId = await filedId(page, name);
  expect(assetId).not.toBe("");
  const box = await canvasBox(page);
  const row = await rowCenter(page, trackName);
  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: row.y - box.y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");
  return assetId;
}

/** A press inside the dropped block, which chooses it. */
async function chooseTheClip(page: Page, trackName: string) {
  const box = await canvasBox(page);
  const row = await rowCenter(page, trackName);
  await page
    .locator(".clip-tl-canvas")
    .click({ position: { x: BODY_X, y: row.y - box.y } });
}

/** The pixel at a fraction of the preview canvas, read back from the drawing. */
async function pixelAt(
  page: Page,
  fraction: { x: number; y: number },
): Promise<number[]> {
  return page.locator("canvas.clip-preview-canvas").evaluate((element, at) => {
    // Typed structurally: this suite's tsconfig carries no DOM lib.
    const canvas = element as unknown as {
      width: number;
      height: number;
      getContext(type: "2d"): {
        getImageData(
          x: number,
          y: number,
          w: number,
          h: number,
        ): { data: ArrayLike<number> };
      } | null;
    };
    const context = canvas.getContext("2d");
    if (!context) throw new Error("the preview canvas has no 2d context");
    const data = context.getImageData(
      Math.floor(canvas.width * at.x),
      Math.floor(canvas.height * at.y),
      1,
      1,
    ).data;
    return [data[0], data[1], data[2]];
  }, fraction);
}

function isColour(pixel: number[], wanted: number[], tolerance: number) {
  return (
    pixel.length === 3 &&
    pixel.every((value, at) => Math.abs(value - wanted[at]) <= tolerance)
  );
}

test("a speed preset changes how long a sound runs, and undo puts it back", async ({
  page,
}) => {
  const home = await clipRoom(page, "Inspector Speed");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "tiny.wav", "audio/wav", tinyWav(), "Audio 1");
  await chooseTheClip(page, "Audio 1");

  await expect(page.getByLabel("Duration")).toBeVisible();
  const before = (await spans(page))[0].durationMs;
  expect(before).toBeGreaterThan(0);

  await page.getByRole("button", { name: "2×" }).click();
  await expect
    .poll(async () => (await spans(page))[0].durationMs)
    .toBe(Math.round(before / 2));

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await spans(page))[0].durationMs).toBe(before);

  forgetHome(home);
});

test("the Adjust sliders are dragged live and one undo brings the grade back", async ({
  page,
}) => {
  const home = await clipRoom(page, "Inspector Adjust");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "look.png", "image/png", TINY_PNG, "Video 1");
  await chooseTheClip(page, "Video 1");

  await page.getByTestId("clip-face-adjust").click();
  const brightness = page.getByLabel("Brightness");
  await expect(brightness).toBeVisible();

  // The slider is dragged while the pointer is down; the release is what
  // writes the one command, so the value is read back from the document.
  await brightness.fill("50");
  await brightness.blur();
  await expect(brightness).toHaveValue("50");

  await page.keyboard.press("Control+z");
  await expect(brightness).toHaveValue("0");

  forgetHome(home);
});

test("a look is applied by its tile, taken off by pressing it again, and undone", async ({
  page,
}) => {
  const home = await clipRoom(page, "Inspector Filters");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "look.png", "image/png", TINY_PNG, "Video 1");
  await chooseTheClip(page, "Video 1");

  await page.getByTestId("clip-face-filters").click();
  const mono = page.getByTestId("clip-filter-mono");
  await expect(mono).toBeVisible();
  await mono.click();
  await expect(mono).toHaveAttribute("aria-pressed", "true");

  await mono.click();
  await expect(mono).toHaveAttribute("aria-pressed", "false");

  // One undo takes the clearing back, and the look is worn again.
  await page.keyboard.press("Control+z");
  await expect(mono).toHaveAttribute("aria-pressed", "true");

  forgetHome(home);
});

test("with nothing chosen the timeline card is shown and its background reaches the frame", async ({
  page,
}) => {
  const home = await clipRoom(page, "Inspector Timeline");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "look.png", "image/png", TINY_PNG, "Video 1");

  // A press on an empty row lets go of everything, and the card is the cut's.
  const box = await canvasBox(page);
  const text = await rowCenter(page, "Text 1");
  await page
    .locator(".clip-tl-canvas")
    .click({ position: { x: 100, y: text.y - box.y } });
  const background = page.getByLabel("Background");
  await expect(background).toBeVisible();

  await background.fill("#223344");
  await background.blur();
  // The playhead stands ahead of the dropped block, so the frame is the
  // background alone — the timeline's own colour, read back from the canvas.
  await expect
    .poll(async () =>
      isColour(await pixelAt(page, { x: 0.5, y: 0.5 }), [34, 51, 68], 4),
    )
    .toBe(true);

  forgetHome(home);
});

test("a file chosen on the shelf is read by the inspector as material", async ({
  page,
}) => {
  const home = await clipRoom(page, "Inspector Media");
  await newTimeline(page, "Timeline 1");
  await importFile(page, "still.png", "image/png", TINY_PNG);

  await page.getByRole("button", { name: /^still\.png / }).click();
  await expect(page.getByRole("heading", { name: "still.png" })).toBeVisible();
  await expect(page.getByLabel("Tags")).toBeVisible();

  forgetHome(home);
});
