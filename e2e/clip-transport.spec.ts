import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { RULER_H, TRACK_HEIGHT } from "../src/features/clip/timeline/geometry";
import {
  chooseSavePath,
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  openRecent,
  persistedTimelineNames,
  projectHome,
} from "./helpers";

/**
 * The transport plays the cut: the clock runs, the skips and the arrow keys
 * place the playhead, the quality tier is remembered, the repeat comes round,
 * and the camera saves a frame.
 *
 * Nothing here asks about sound: a headless browser is silent, so what is
 * checked is what the room can be observed to do — the playhead's moment and
 * the state of its controls.
 */

// A one-pixel PNG of pure red, as the preview spec's picture is written.
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const ASSET_DRAG_MIME = "application/x-moka-asset";

/** The video row's centre, in canvas pixels, from the timeline's own constants. */
const VIDEO_ROW_Y =
  RULER_H + TRACK_HEIGHT.text + TRACK_HEIGHT.audio + TRACK_HEIGHT.video / 2;

/** Where a clip is dropped: five seconds in at the default scale, or at the head. */
const MID_X = 300;
const HEAD_X = 6;
/** The ruler's moment five seconds into the cut, and three and a half. */
const AT_5S_X = 300;
const AT_3_5S_X = 210;

/** The browser's drag data, as much of it as this suite uses. */
interface DragData {
  setData(type: string, value: string): void;
}

/** A fresh project already standing in the cutting room. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-transport");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/**
 * Drops a shelf asset on the timeline by dispatch rather than by mouse, as the
 * preview spec does: the id under the shelf's own type, and the pointer where
 * the reader let go.
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

/** The id the document filed the picture under, read from the server. */
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

function timeline(page: Page) {
  return page.locator(".clip-timeline");
}

/** The player's own row, so a button's name cannot be taken for a tool's. */
function transport(page: Page) {
  return page.locator(".clip-transport");
}

/** A button of the transport by its label, exactly as the row writes it. */
function transportButton(page: Page, name: string) {
  return transport(page).getByRole("button", { name, exact: true });
}

/** A four-second picture on the cut, dropped at the head or five seconds in. */
async function pictureOnTheCut(page: Page, atX: number): Promise<void> {
  await newTimeline(page, "Timeline 1");
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "red.png",
    mimeType: "image/png",
    buffer: RED_PNG,
  });
  await expect(page.getByRole("button", { name: /^red\.png / })).toBeVisible({
    timeout: 10_000,
  });
  const assetId = await filedId(page, "red.png");
  expect(assetId).not.toBe("");
  await dropAssetOnTimeline(page, assetId, { x: atX, y: VIDEO_ROW_Y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");
}

/** Where the playhead is put by a click on the ruler. */
async function seek(page: Page, x: number): Promise<void> {
  await page.locator(".clip-tl-canvas").click({ position: { x, y: 10 } });
}

/** The moment the room is standing on, as its own attribute reads it. */
async function playheadMs(page: Page): Promise<number> {
  return Number(
    (await timeline(page).getAttribute("data-playhead-ms")) ?? "-1",
  );
}

/** Puts the pointer in the room, so the keys land on the page and not on a field. */
async function focusRoom(page: Page) {
  const canvas = page.locator(".clip-tl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the timeline canvas is not there");
  await canvas.click({ position: { x: box.width - 20, y: VIDEO_ROW_Y } });
}

test("the play button runs the clock, and the pause button holds it", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transport Clock");
  await pictureOnTheCut(page, MID_X);

  await transportButton(page, "Play").click();
  await expect
    .poll(() => playheadMs(page), { timeout: 5_000 })
    .toBeGreaterThan(500);

  await transportButton(page, "Pause").click();
  const held = await playheadMs(page);
  expect(held).toBeGreaterThan(500);
  // Waited a beat on: a stopped clock does not creep.
  await page.waitForTimeout(300);
  expect(await playheadMs(page)).toBe(held);

  forgetHome(home);
});

test("Space starts and stops the clock", async ({ page }) => {
  const home = await clipRoom(page, "Transport Space");
  await pictureOnTheCut(page, MID_X);
  await focusRoom(page);

  await page.keyboard.press("Space");
  await expect
    .poll(() => playheadMs(page), { timeout: 5_000 })
    .toBeGreaterThan(300);

  await page.keyboard.press("Space");
  const held = await playheadMs(page);
  await page.waitForTimeout(300);
  expect(await playheadMs(page)).toBe(held);

  forgetHome(home);
});

test("playing to the tail stops the clock there", async ({ page }) => {
  const home = await clipRoom(page, "Transport Tail");
  // The picture runs from a hundred milliseconds in: it ends at 4.1s.
  await pictureOnTheCut(page, HEAD_X);

  // From near the end, so the stop is a second's wait rather than five.
  await seek(page, AT_3_5S_X);
  await transportButton(page, "Play").click();

  // The clock stops on the last frame and the button says so again.
  await expect
    .poll(() => playheadMs(page), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(4_000);
  await expect(transportButton(page, "Play")).toBeVisible();
  const stopped = await playheadMs(page);
  await page.waitForTimeout(300);
  expect(await playheadMs(page)).toBe(stopped);

  forgetHome(home);
});

test("the arrow keys walk the playhead a frame and a second at a time", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transport Keys");
  await pictureOnTheCut(page, MID_X);
  await seek(page, AT_5S_X);
  await expect.poll(() => playheadMs(page)).toBe(5_000);

  await page.keyboard.press("ArrowRight");
  await expect.poll(() => playheadMs(page)).toBe(5_033);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => playheadMs(page)).toBe(5_000);

  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => playheadMs(page)).toBe(6_000);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => playheadMs(page)).toBe(5_000);

  forgetHome(home);
});

test("the quality tier takes effect and is remembered across a page load", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transport Quality");
  await pictureOnTheCut(page, MID_X);
  const preview = page.locator(".clip-preview");
  await expect(preview).toHaveAttribute("data-quality", "full");

  await page.getByLabel("Preview quality").selectOption("quarter");
  await expect(preview).toHaveAttribute("data-quality", "quarter");

  // The cut has to be on the server's copy before the page is read again: a
  // reload that beats the save opens onto a document without the timeline.
  await expect.poll(() => persistedTimelineNames(page)).toContain("Timeline 1");

  await page.reload();
  await openRecent(page, "Transport Quality");
  await openClipRoom(page);
  await expect(page.locator(".clip-preview")).toHaveAttribute(
    "data-quality",
    "quarter",
  );

  forgetHome(home);
});

test("the repeat comes round at the tail, and the camera saves the frame", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transport Repeat");
  await pictureOnTheCut(page, HEAD_X);

  const repeat = transportButton(page, "Repeat the cut");
  await repeat.click();
  await expect(repeat).toHaveAttribute("aria-pressed", "true");

  // Start near the tail, so the wrap comes within a second.
  await seek(page, AT_3_5S_X);
  await transportButton(page, "Play").click();

  // The playhead has been carried back to the head instead of stopping there.
  await expect
    .poll(() => playheadMs(page), { timeout: 5_000 })
    .toBeLessThan(3_500);
  const wrapped = await playheadMs(page);
  expect(wrapped).toBeLessThan(3_500);
  // And it is climbing again: the repeat is a play, not a stop.
  await expect
    .poll(() => playheadMs(page), { timeout: 3_000 })
    .toBeGreaterThan(wrapped);

  await transportButton(page, "Pause").click();

  // The camera takes the frame under the playhead out as a PNG, saved where
  // the dialog said: the project's own output folder, named for the moment.
  await transportButton(page, "Save snapshot").click();
  const dialog = page.getByTestId("path-browser");
  await expect(dialog.getByTestId("path-browser-name")).toHaveValue(
    /^Timeline 1-.*\.png$/,
  );
  const destination = await chooseSavePath(page);
  expect(destination).toContain(join(home, "project", "output"));
  await expect(page.getByText(`Snapshot saved to ${destination}`)).toBeVisible({
    timeout: 10_000,
  });
  const bytes = readFileSync(destination);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  forgetHome(home);
});
