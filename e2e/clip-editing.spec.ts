import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  projectHome,
} from "./helpers";

// A tiny valid PNG (1x1 transparent pixel), as the media shelf spec uses.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const ASSET_DRAG_MIME = "application/x-moka-asset";

/**
 * Pixel positions the gestures are measured in.
 *
 * The scale is the room's default 60px/s, so a hundred pixels is five
 * seconds of cut and the arithmetic in the assertions reads straight off
 * them: a picture dropped at 300 starts at 5,000ms and is four seconds long,
 * and one dropped at 600 starts at 10,000ms — two seconds past its tail.
 */
const PX_PER_SEC = 60;
const DROP_X = 300;
const SECOND_DROP_X = 600;
/** A press in the middle of a block, clear of either edge's six pixels. */
const CLIP_BODY_X = 400;
const SECOND_BODY_X = 630;
/** How far the second block is dragged to bring its head 50ms off the tail. */
const SNAP_SHIFT_MS = 950;

/** The browser's drag data, as much of it as this suite uses. */
interface DragData {
  setData(type: string, value: string): void;
}

/**
 * Drops a shelf asset on the canvas by dispatch rather than by mouse.
 *
 * A real drag from the shelf is the platform's own machinery, and a synthetic
 * one states exactly what the room reads: the id under the shelf's type, and
 * the pointer where the reader let go. This is the same helper the edits spec
 * uses; the gestures below are the real mouse, since a canvas pointer session
 * is not HTML5 drag and drop.
 */
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

function timeline(page: Page) {
  return page.locator(".clip-timeline");
}

async function canvasBox(page: Page) {
  const box = await page.locator(".clip-tl-canvas").boundingBox();
  if (!box) throw new Error("the timeline canvas is not there");
  return box;
}

/** Where a row's centre sits on the page, read off the header drawn beside it. */
async function rowCenter(page: Page, trackName: string) {
  const box = await page
    .locator(".clip-tl-header-row", { hasText: trackName })
    .boundingBox();
  if (!box) throw new Error(`the ${trackName} header is not there`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** One block as the test seam writes it: `id@trackId:start:duration`. */
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

/** The block at a start time, within the frame a pointer lands on. */
function atStart(list: Span[], startMs: number): Span | undefined {
  return list.find((span) => Math.abs(span.startMs - startMs) <= 50);
}

/** A fresh project already standing in the cutting room, with room to cut in. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-editing");
  await forgetProjects();
  // A window tall enough that four rows and the ruler are all on screen:
  // the rows are addressed by their header's own box, which is only true of
  // a row that has not been scrolled under the toolbar.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/** Imports one picture through the shelf's own input, and waits for its row. */
async function importPicture(page: Page, name: string) {
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name,
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^${name.replace(/\./g, "\\.")} `),
    }),
  ).toBeVisible({ timeout: 10_000 });
}

/** The id the document filed the picture under, read from the server. */
async function filedId(page: Page, name: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { resources?: Record<string, { id: string; name: string }[]> };
    };
    const books = Object.values(body.moka?.resources ?? {});
    for (const entries of books) {
      const found = entries.find((entry) => entry.name === wanted);
      if (found) return found.id;
    }
    return "";
  }, name);
}

/** A drag of the real mouse, in steps: a session needs the moves between. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

/** Drops one picture at the given canvas x, on the Video 1 row. */
async function dropOne(page: Page, name: string, canvasX: number) {
  await importPicture(page, name);
  const assetId = await filedId(page, name);
  expect(assetId).not.toBe("");
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await dropAssetOnTimeline(page, assetId, {
    x: canvasX,
    y: video.y - box.y,
  });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");
  return assetId;
}

test("a block dragged along its row moves by the pointer's own distance", async ({
  page,
}) => {
  const home = await clipRoom(page, "Editing Drag");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "one.png", DROP_X);

  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  // 120px at 60px/s is two seconds; the magnet has nothing to catch on, so
  // the block lands on the frame the pointer's distance names. A pointer
  // coordinate rounds to a device pixel, hence the frame's own tolerance.
  await drag(
    page,
    { x: box.x + CLIP_BODY_X, y: video.y },
    { x: box.x + CLIP_BODY_X + 120, y: video.y },
  );
  await expect
    .poll(async () => atStart(await spans(page), 7_000))
    .toBeDefined();
  expect((await spans(page))[0].startMs).not.toBe(5_000);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await spans(page))[0]?.startMs).toBe(5_000);

  forgetHome(home);
});

test("the right edge pulled left shortens the block", async ({ page }) => {
  const home = await clipRoom(page, "Editing Trim");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "one.png", DROP_X);

  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  const start = (await spans(page))[0].startMs;
  const end = start + (await spans(page))[0].durationMs;
  const endX = (end / 1_000) * PX_PER_SEC;
  // The margin inside the tail: a press exactly on the edge reads as the
  // empty space past it, so the grab is a few pixels in from it. 120px at
  // 60px/s takes two of the four seconds away, within a frame.
  await drag(
    page,
    { x: box.x + endX - 4, y: video.y },
    { x: box.x + endX - 4 - 120, y: video.y },
  );
  await expect
    .poll(async () => {
      const clip = (await spans(page))[0];
      return clip === undefined
        ? false
        : Math.abs(clip.startMs + clip.durationMs - 7_000) <= 50;
    })
    .toBe(true);
  await expect
    .poll(async () =>
      Math.abs(((await spans(page))[0]?.durationMs ?? 0) - 2_000),
    )
    .toBeLessThanOrEqual(50);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await spans(page))[0]?.durationMs).toBe(4_000);

  forgetHome(home);
});

/**
 * A small valid WAV: a header, then a few seconds of silence.
 *
 * A file with a real length, which the server's probe measures on import —
 * what a trim is bounded by is part of what the test below is about.
 */
function toneWav(seconds: number): Buffer {
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

/** The block's own window into its file, as the document has it written down. */
interface ClipWindow {
  startMs: number;
  durationMs: number;
  inPointMs: number;
  outPointMs: number;
}

async function clipWindow(page: Page): Promise<ClipWindow | null> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        timelines?: {
          clips?: {
            startMs: number;
            durationMs: number;
            inPointMs: number;
            outPointMs: number;
          }[];
        }[];
      };
    };
    const clip = body.moka?.timelines?.[0]?.clips?.[0];
    return clip
      ? {
          startMs: clip.startMs,
          durationMs: clip.durationMs,
          inPointMs: clip.inPointMs,
          outPointMs: clip.outPointMs,
        }
      : null;
  });
}

/** Waits for the document to read the block's window as wanted, within a frame. */
async function expectWindow(
  page: Page,
  wanted: Partial<ClipWindow>,
): Promise<void> {
  const keys = Object.keys(wanted) as (keyof ClipWindow)[];
  await expect
    .poll(async () => {
      const window = await clipWindow(page);
      if (!window) return false;
      return keys.every((key) => Math.abs(window[key] - wanted[key]!) <= 40);
    })
    .toBe(true);
}

test("a sound block is trimmed to a piece of its own file", async ({
  page,
}) => {
  const home = await clipRoom(page, "Editing Sound Trim");
  await newTimeline(page, "Timeline 1");
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "tone.wav",
    mimeType: "audio/wav",
    buffer: toneWav(5),
  });
  await page.getByTestId("asset-kind-audio").click();
  await expect(page.getByRole("button", { name: /^tone\.wav / })).toBeVisible({
    timeout: 10_000,
  });
  const assetId = await filedId(page, "tone.wav");
  expect(assetId).not.toBe("");
  const box = await canvasBox(page);
  const audio = await rowCenter(page, "Audio 1");
  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: audio.y - box.y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  // Dropped whole: the block reads its file from head to tail.
  await expectWindow(page, { inPointMs: 0, outPointMs: 5_000 });
  const dropped = (await clipWindow(page))!;
  expect(dropped.startMs).toBe(5_000);
  const tailX = (window: ClipWindow) =>
    box.x + ((window.startMs + window.durationMs) / 1_000) * PX_PER_SEC - 4;
  const headX = (window: ClipWindow) =>
    box.x + (window.startMs / 1_000) * PX_PER_SEC + 4;

  // The tail pulled left leaves the block reading less of the file: the
  // block shrinks and the window's far end moves in with it.
  await drag(
    page,
    { x: tailX(dropped), y: audio.y },
    { x: tailX(dropped) - 120, y: audio.y },
  );
  await expectWindow(page, {
    startMs: 5_000,
    inPointMs: 0,
    outPointMs: 3_000,
  });

  // The same edge pulled right stops at the file's own end, whatever the
  // pointer asks for.
  const shortened = (await clipWindow(page))!;
  await drag(
    page,
    { x: tailX(shortened), y: audio.y },
    { x: tailX(shortened) + 240, y: audio.y },
  );
  await expectWindow(page, { outPointMs: 5_000, durationMs: 5_000 });

  // The head pulled right skips into the file: the block starts later on
  // the cut and reads from further in...
  const whole = (await clipWindow(page))!;
  await drag(
    page,
    { x: headX(whole), y: audio.y },
    { x: headX(whole) + 60, y: audio.y },
  );
  await expectWindow(page, {
    startMs: 6_000,
    durationMs: 4_000,
    inPointMs: 1_000,
    outPointMs: 5_000,
  });

  // ...and pulled left it stops where the file's own head is.
  const skipped = (await clipWindow(page))!;
  await drag(
    page,
    { x: headX(skipped), y: audio.y },
    { x: headX(skipped) - 120, y: audio.y },
  );
  await expectWindow(page, { startMs: 5_000, inPointMs: 0 });

  forgetHome(home);
});

test("a block is dragged onto another row of the same kind", async ({
  page,
}) => {
  const home = await clipRoom(page, "Editing Cross Track");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "one.png", DROP_X);

  // The corner's plus grows the cut a row; it lands at the top of the stack.
  await page.getByTestId("track-add").click();
  await page
    .getByRole("menu", { name: "Add track" })
    .getByRole("menuitem", { name: "Video track", exact: true })
    .click();
  await expect(timeline(page)).toHaveAttribute("data-track-count", "4");
  const secondId = await page
    .locator(".clip-tl-header-row", { hasText: "Video 2" })
    .getAttribute("data-track-id");
  expect(secondId).not.toBeNull();

  const box = await canvasBox(page);
  const first = await rowCenter(page, "Video 1");
  const second = await rowCenter(page, "Video 2");
  await drag(
    page,
    { x: box.x + CLIP_BODY_X, y: first.y },
    { x: box.x + CLIP_BODY_X, y: second.y },
  );
  await expect.poll(async () => (await spans(page))[0]?.trackId).toBe(secondId);

  forgetHome(home);
});

test("the magnet catches a head on the block ahead, and its absence does not", async ({
  page,
}) => {
  const home = await clipRoom(page, "Editing Snap");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "one.png", DROP_X);
  // A second picture lands two seconds past the first one's tail. The canvas
  // is only as wide as the room leaves it, so both blocks and the drag are
  // measured inside the same screenful.
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await importPicture(page, "two.png");
  const second = await filedId(page, "two.png");
  await dropAssetOnTimeline(page, second, {
    x: SECOND_DROP_X,
    y: video.y - box.y,
  });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");
  await expect
    .poll(async () => (await spans(page)).map((span) => span.startMs))
    .toContain(10_000);

  // The drag leaves the second head 50ms past the first tail — inside the
  // eight pixels the magnet reaches — so the release lands exactly on it.
  const shiftPx = (SNAP_SHIFT_MS / 1_000) * PX_PER_SEC;
  await drag(
    page,
    { x: box.x + SECOND_BODY_X, y: video.y },
    { x: box.x + SECOND_BODY_X - shiftPx, y: video.y },
  );
  await expect
    .poll(async () =>
      (await spans(page)).some((span) => span.startMs === 9_000),
    )
    .toBe(true);
  expect((await spans(page)).some((span) => span.startMs === 5_000)).toBe(true);

  // With the magnet off the same drag lands where the pointer left it.
  await page.getByTestId("clip-snap").click();
  await expect(page.getByTestId("clip-snap")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await drag(
    page,
    { x: box.x + SECOND_BODY_X - shiftPx, y: video.y },
    { x: box.x + SECOND_BODY_X, y: video.y },
  );
  await expect
    .poll(async () =>
      (await spans(page)).some((span) => Math.abs(span.startMs - 9_950) <= 50),
    )
    .toBe(true);
  expect((await spans(page)).some((span) => span.startMs === 9_000)).toBe(
    false,
  );

  forgetHome(home);
});

/**
 * Hangs one shelf file over the canvas at a point, the way a drag would.
 *
 * The drag states itself the way a real one does: begun on the row that
 * carries the file, its data riding the shelf's own type. What the room
 * writes down as the block it would land as is read back after the frame
 * that draws it.
 */
async function hoverAssetOnTimeline(
  page: Page,
  assetId: string,
  at: { x: number; y: number },
): Promise<string> {
  const box = await canvasBox(page);
  return page.evaluate(
    async ({ assetId, clientX, clientY }) => {
      const Browser = globalThis as unknown as {
        DataTransfer: new () => DragData;
        DragEvent: new (type: string, init: Record<string, unknown>) => unknown;
        document: {
          querySelector(selector: string): {
            dispatchEvent(event: unknown): boolean;
            getAttribute(name: string): string | null;
          } | null;
        };
        requestAnimationFrame(callback: () => void): number;
      };
      const row = Browser.document.querySelector(
        `[data-asset-id="${assetId}"]`,
      );
      const canvas = Browser.document.querySelector(".clip-tl-canvas");
      const room = Browser.document.querySelector(".clip-timeline");
      if (!row || !canvas || !room) {
        throw new Error("the row or the timeline is not there");
      }
      const data = new Browser.DataTransfer();
      row.dispatchEvent(
        new Browser.DragEvent("dragstart", {
          bubbles: true,
          dataTransfer: data,
        }),
      );
      canvas.dispatchEvent(
        new Browser.DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer: data,
        }),
      );
      // The ghost is drawn on the frame the room schedules; this is that frame.
      await new Promise<void>((settle) =>
        Browser.requestAnimationFrame(() => settle()),
      );
      return room.getAttribute("data-drop-preview") ?? "";
    },
    { assetId, clientX: box.x + at.x, clientY: box.y + at.y },
  );
}

test("a file dragged over the rows wears the block it would land as", async ({
  page,
}) => {
  const home = await clipRoom(page, "Editing Ghost");
  await newTimeline(page, "Timeline 1");
  await importPicture(page, "one.png");
  const assetId = await filedId(page, "one.png");
  expect(assetId).not.toBe("");
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  const at = (canvasX: number) => ({ x: canvasX, y: video.y - box.y });

  // The pointer's own frame, and the picture's own four seconds.
  const drawn = await hoverAssetOnTimeline(page, assetId, at(DROP_X));
  const [trackId, startMs, durationMs] = drawn.split(":");
  expect(trackId).not.toBe("");
  expect(Math.abs(Number(startMs) - 5_000)).toBeLessThanOrEqual(50);
  expect(Number(durationMs)).toBe(4_000);

  // The ghost follows the pointer, and the release lands the very block it
  // wore — not a block a frame away from it.
  const moved = await hoverAssetOnTimeline(page, assetId, at(SECOND_DROP_X));
  expect(Math.abs(Number(moved.split(":")[1]) - 10_000)).toBeLessThanOrEqual(
    50,
  );
  await dropAssetOnTimeline(page, assetId, at(SECOND_DROP_X));
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");
  const landed = (await spans(page))[0];
  expect(`${landed.trackId}:${landed.startMs}:${landed.durationMs}`).toBe(
    moved,
  );
  await expect(timeline(page)).toHaveAttribute("data-drop-preview", "");

  forgetHome(home);
});

test("a marquee catches the blocks it covers, and Delete clears them", async ({
  page,
}) => {
  const home = await clipRoom(page, "Editing Marquee");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "one.png", DROP_X);
  await importPicture(page, "two.png");
  const second = await filedId(page, "two.png");
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await dropAssetOnTimeline(page, second, {
    x: SECOND_DROP_X,
    y: video.y - box.y,
  });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");

  // From the empty space ahead of the first block, across both of them,
  // staying inside the screenful the canvas holds.
  await drag(
    page,
    { x: box.x + 200, y: video.y },
    { x: box.x + 660, y: video.y },
  );
  await expect
    .poll(
      async () =>
        ((await timeline(page).getAttribute("data-selected-clip-ids")) ?? "")
          .split(",")
          .filter(Boolean).length,
    )
    .toBe(2);

  await page.keyboard.press("Delete");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "0");
  await page.keyboard.press("Control+z");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");

  forgetHome(home);
});

test("a locked row refuses the drag until it is unlocked", async ({ page }) => {
  const home = await clipRoom(page, "Editing Lock");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "one.png", DROP_X);
  const before = await timeline(page).getAttribute("data-clip-spans");

  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  const lock = page
    .locator(".clip-tl-header-row", { hasText: "Video 1" })
    .getByTestId("track-lock");
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");

  await drag(
    page,
    { x: box.x + CLIP_BODY_X, y: video.y },
    { x: box.x + CLIP_BODY_X + 120, y: video.y },
  );
  await expect(page.locator(".toast").first()).toContainText(
    "That track is locked",
  );
  expect(await timeline(page).getAttribute("data-clip-spans")).toBe(before);

  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await drag(
    page,
    { x: box.x + CLIP_BODY_X, y: video.y },
    { x: box.x + CLIP_BODY_X + 120, y: video.y },
  );
  await expect
    .poll(async () => ((await spans(page))[0]?.startMs ?? 0) > 6_500)
    .toBe(true);

  forgetHome(home);
});

test("the right-click menus duplicate a block and grow the stack", async ({
  page,
}) => {
  const home = await clipRoom(page, "Editing Menus");
  await newTimeline(page, "Timeline 1");
  await dropOne(page, "one.png", DROP_X);

  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await page.mouse.click(box.x + CLIP_BODY_X, video.y, { button: "right" });
  const clipMenu = page.getByRole("menu", { name: "Timeline menu" });
  await expect(clipMenu).toBeVisible();
  await clipMenu
    .getByRole("menuitem", { name: "Duplicate", exact: true })
    .click();
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");

  // A right-click on the empty space ahead offers the whole cut; the header's
  // own menu renames the row in place and grows the stack.
  await page.mouse.click(box.x + 100, video.y, { button: "right" });
  await expect(clipMenu).toBeVisible();
  await clipMenu
    .getByRole("menuitem", { name: "Select all", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        ((await timeline(page).getAttribute("data-selected-clip-ids")) ?? "")
          .split(",")
          .filter(Boolean).length,
    )
    .toBe(2);

  const header = page.locator(".clip-tl-header-row", { hasText: "Video 1" });
  await header.click({ button: "right" });
  const trackMenu = page.getByRole("menu", { name: "Track menu" });
  await expect(trackMenu).toBeVisible();
  await trackMenu
    .getByRole("menuitem", { name: "Add track above", exact: true })
    .click();
  await expect(timeline(page)).toHaveAttribute("data-track-count", "4");

  await page
    .locator(".clip-tl-header-row", { hasText: "Video 1" })
    .click({ button: "right" });
  await trackMenu
    .getByRole("menuitem", { name: "Rename…", exact: true })
    .click();
  const nameField = page.getByLabel("Track name");
  await nameField.fill("Main");
  await nameField.press("Enter");
  await expect(
    page.locator(".clip-tl-header-row", { hasText: "Main" }),
  ).toBeVisible();

  forgetHome(home);
});
