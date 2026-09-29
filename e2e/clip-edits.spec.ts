import { join } from "node:path";
import process from "node:process";
import { expect, test, type Page } from "@playwright/test";
import { RULER_H, TRACK_HEIGHT } from "../src/features/clip/timeline/geometry";
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
 * Where the rows' centres sit in canvas pixels.
 *
 * Read from the timeline's own constants rather than written down: the rows
 * draw top-down in display order — Text, then Audio, then Video — and a test
 * that hard-coded the arithmetic would go quietly wrong the day a row grows.
 */
const TEXT_ROW_Y = RULER_H + TRACK_HEIGHT.text / 2;
const AUDIO_ROW_Y = RULER_H + TRACK_HEIGHT.text + TRACK_HEIGHT.audio / 2;
const VIDEO_ROW_Y =
  RULER_H + TRACK_HEIGHT.text + TRACK_HEIGHT.audio + TRACK_HEIGHT.video / 2;

/** Where a file was dropped, and where the piece it made begins on screen. */
const DROP_X = 300;
const MID_CLIP_X = 420;

/** The key that adds one clip to the selection rather than taking a click of its own. */
const TOGGLE_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

/** The browser's drag data, as much of it as this suite uses. */
interface DragData {
  setData(type: string, value: string): void;
}

/**
 * Drops a shelf asset on the canvas by dispatch rather than by mouse.
 *
 * A real drag from the shelf is the platform's own machinery, and a synthetic
 * one states exactly what the room reads: the id under the shelf's type, and
 * the pointer where the reader let go. The drop answers on the canvas itself,
 * which is the element the shelf's drag-out is contracted with. The browser's
 * own names are taken through a local shape, since this suite is checked
 * without a DOM lib; the point comes from the canvas's box, in viewport terms.
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

/** A fresh project already standing in the cutting room. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-edits");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/** Imports one picture through the shelf's own input, and waits for its row. */
async function importPicture(page: Page) {
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "one.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(page.getByRole("button", { name: /^one\.png / })).toBeVisible({
    timeout: 10_000,
  });
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

/** The cut as the server has it written down, for the last test's wait. */
async function persistedClipCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { timelines?: { clips?: unknown[] }[] };
    };
    return body.moka?.timelines?.[0]?.clips?.length ?? -1;
  });
}

function selectedClipIds(page: Page) {
  return timeline(page).getAttribute("data-selected-clip-ids");
}

/** The chosen clips as the ids they are, empty when nothing is chosen. */
async function selectedIds(page: Page): Promise<string[]> {
  return ((await selectedClipIds(page)) ?? "").split(",").filter(Boolean);
}

/** Puts the pointer in the room, so the keys land on the page and not on a field. */
async function focusRoom(page: Page) {
  // On an empty row near the far edge of the drawn screen, whatever width the
  // window leaves it: the point is only to take the focus off any field.
  const canvas = page.locator(".clip-tl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the timeline canvas is not there");
  await canvas.click({
    position: { x: box.width - 20, y: TEXT_ROW_Y },
  });
}

test("a picture dropped on the video row lands a clip, and undo takes it away", async ({
  page,
}) => {
  const home = await clipRoom(page, "Edits Drop");
  await newTimeline(page, "Timeline 1");
  await importPicture(page);
  const assetId = await filedId(page, "one.png");
  expect(assetId).not.toBe("");

  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: VIDEO_ROW_Y });

  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");
  await expect.poll(() => selectedClipIds(page)).not.toBe("");

  await focusRoom(page);
  await page.keyboard.press("Control+z");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "0");
  await page.keyboard.press("Control+Shift+z");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  forgetHome(home);
});

test("a picture dropped on the audio row is refused, and the room says why", async ({
  page,
}) => {
  const home = await clipRoom(page, "Edits Kind");
  await newTimeline(page, "Timeline 1");
  await importPicture(page);
  const assetId = await filedId(page, "one.png");

  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: AUDIO_ROW_Y });

  await expect(page.locator(".toast")).toContainText(
    "A video or an image goes on a video track",
  );
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "0");

  forgetHome(home);
});

test("the toolbar's scissors cuts the clip the playhead stands in", async ({
  page,
}) => {
  const home = await clipRoom(page, "Edits Split");
  await newTimeline(page, "Timeline 1");
  await importPicture(page);
  const assetId = await filedId(page, "one.png");
  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: VIDEO_ROW_Y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  // The ruler carries the playhead into the middle of the piece.
  const canvas = page.locator(".clip-tl-canvas");
  await canvas.click({ position: { x: MID_CLIP_X, y: 10 } });
  const split = page.getByTestId("clip-split");
  await expect(split).toBeEnabled();

  await split.click();
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");
  await expect.poll(() => selectedClipIds(page)).not.toBe("");
  const splitId = (await selectedIds(page))[0];

  // The two pieces are chosen and unchosen as the modifiers ask: a plain click
  // takes one, Shift reaches from it along the row, and the platform's
  // command key takes one back out. The attribute trails the click by a frame,
  // so every read waits for the draw rather than asking at the instant — and
  // the click that takes the left piece is waited for as a *change* of the
  // selection, since the split had left the right piece chosen already.
  await canvas.click({ position: { x: 360, y: VIDEO_ROW_Y } });
  await expect
    .poll(async () => {
      const ids = await selectedIds(page);
      return ids.length === 1 && ids[0] !== splitId;
    })
    .toBe(true);
  const leftId = (await selectedIds(page))[0];

  await canvas.click({
    modifiers: ["Shift"],
    position: { x: 480, y: VIDEO_ROW_Y },
  });
  await expect.poll(async () => (await selectedIds(page)).length).toBe(2);
  expect(await selectedIds(page)).toContain(leftId);

  await canvas.click({
    modifiers: [TOGGLE_MODIFIER],
    position: { x: 480, y: VIDEO_ROW_Y },
  });
  await expect.poll(() => selectedIds(page)).toEqual([leftId]);

  await page.keyboard.press("Control+z");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  forgetHome(home);
});

test("a click on a clip chooses it, and Delete takes it off the cut", async ({
  page,
}) => {
  const home = await clipRoom(page, "Edits Delete");
  await newTimeline(page, "Timeline 1");
  await importPicture(page);
  const assetId = await filedId(page, "one.png");
  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: VIDEO_ROW_Y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  const canvas = page.locator(".clip-tl-canvas");
  await canvas.click({ position: { x: DROP_X + 10, y: VIDEO_ROW_Y } });
  await expect.poll(() => selectedClipIds(page)).not.toBe("");

  await page.keyboard.press("Delete");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "0");

  await page.keyboard.press("Control+z");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  forgetHome(home);
});

test("Ctrl+D lays the chosen clip down again on its own tail", async ({
  page,
}) => {
  const home = await clipRoom(page, "Edits Duplicate");
  await newTimeline(page, "Timeline 1");
  await importPicture(page);
  const assetId = await filedId(page, "one.png");
  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: VIDEO_ROW_Y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  const canvas = page.locator(".clip-tl-canvas");
  await canvas.click({ position: { x: DROP_X + 10, y: VIDEO_ROW_Y } });
  await page.keyboard.press("Control+d");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");

  await page.keyboard.press("Control+z");
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  forgetHome(home);
});

test("? lists the room's keys, and Escape closes the list", async ({
  page,
}) => {
  const home = await clipRoom(page, "Edits Help");
  await newTimeline(page, "Timeline 1");
  await focusRoom(page);

  await page.keyboard.press("?");
  const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(list).toBeVisible();
  await expect(list).toContainText("Split at the playhead");

  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();

  forgetHome(home);
});

test("the edits reach the document on disk, and the badge says Saved", async ({
  page,
}) => {
  const home = await clipRoom(page, "Edits Saved");
  await newTimeline(page, "Timeline 1");
  await importPicture(page);
  const assetId = await filedId(page, "one.png");
  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: VIDEO_ROW_Y });

  // The command rides the same pipeline everything else does, so it is on the
  // server's copy by the time the badge settles.
  await expect.poll(() => persistedClipCount(page)).toBe(1);
  await expect(page.locator(".save-status")).toHaveText("Saved", {
    timeout: 10_000,
  });

  forgetHome(home);
});
