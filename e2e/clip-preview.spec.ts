import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { RULER_H, TRACK_HEIGHT } from "../src/features/clip/timeline/geometry";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  projectHome,
} from "./helpers";

/**
 * The preview shows the frame the playhead is standing on.
 *
 * What is drawn is pixels, so the picture is read back from the canvas itself:
 * the file on the cut is one pixel of pure red, which is a colour no part of
 * the room paints, and the frame outside it is the timeline's own background.
 * Only the image path is exercised here — the browser this suite drives has no
 * H.264, so the decoder path is the plan's own business to leave to a machine
 * with one — but the attribute that names the engine is checked all the same.
 */

// A one-pixel PNG of pure red (8-bit RGB, no filter), as the shelf spec's
// transparent pixel is written beside it.
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const ASSET_DRAG_MIME = "application/x-moka-asset";

/** The video row's centre, in canvas pixels, from the timeline's own constants. */
const VIDEO_ROW_Y =
  RULER_H + TRACK_HEIGHT.text + TRACK_HEIGHT.audio + TRACK_HEIGHT.video / 2;

/** Where the shelf asset is dropped: five seconds into the cut at the default scale. */
const DROP_X = 300;
/** Inside the piece it made (60px a second, four seconds long). */
const INSIDE_X = 420;
/** Before it: a moment with nothing on the cut. */
const BEFORE_X = 60;

/** The browser's drag data, as much of it as this suite uses. */
interface DragData {
  setData(type: string, value: string): void;
}

/** A fresh project already standing in the cutting room. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-preview");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/**
 * Drops a shelf asset on the timeline by dispatch rather than by mouse, as the
 * edits spec does: the id under the shelf's own type, and the pointer where the
 * reader let go.
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

/** A picture on the cut, and the playhead left wherever the caller puts it. */
async function pictureOnTheCut(page: Page): Promise<void> {
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
  await dropAssetOnTimeline(page, assetId, { x: DROP_X, y: VIDEO_ROW_Y });
  await expect(page.locator(".clip-timeline")).toHaveAttribute(
    "data-clip-count",
    "1",
  );
}

/** Where the playhead is put by a click on the ruler. */
async function seek(page: Page, x: number): Promise<void> {
  await page.locator(".clip-tl-canvas").click({ position: { x, y: 10 } });
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

function isColour(
  pixel: number[],
  wanted: number[],
  tolerance: number,
): boolean {
  return (
    pixel.length === 3 &&
    pixel.every((value, at) => Math.abs(value - wanted[at]) <= tolerance)
  );
}

test("the picture under the playhead shows, and the frame outside it is the background", async ({
  page,
}) => {
  const home = await clipRoom(page, "Preview Picture");
  await pictureOnTheCut(page);

  // Five seconds of cut, four seconds of piece: a moment inside it shows the
  // picture, and a moment before it shows the timeline's own black.
  await seek(page, INSIDE_X);
  const preview = page.locator(".clip-preview");
  await expect(preview).toHaveAttribute("data-frame-ms", "7000");
  await expect(preview).toHaveAttribute("data-engine", "image");
  await expect
    .poll(async () =>
      isColour(await pixelAt(page, { x: 0.5, y: 0.5 }), [255, 0, 0], 8),
    )
    .toBe(true);

  await seek(page, BEFORE_X);
  await expect(preview).toHaveAttribute("data-frame-ms", "1000");
  await expect
    .poll(async () =>
      isColour(await pixelAt(page, { x: 0.5, y: 0.5 }), [0, 0, 0], 2),
    )
    .toBe(true);

  // A picture read from its own file is exact, so nothing is claimed to be an
  // approximation of it.
  await expect(page.locator(".clip-preview-badge")).toHaveCount(0);

  forgetHome(home);
});

test("the timecode reads the playhead, on the frame's own clock", async ({
  page,
}) => {
  const home = await clipRoom(page, "Preview Timecode");
  await pictureOnTheCut(page);
  const timecode = page.getByTestId("preview-timecode");
  await expect(timecode).toHaveText("00:00:00:00");

  await seek(page, INSIDE_X);
  await expect(timecode).toHaveText("00:00:07:00");

  // A drag along the ruler carries the timecode with it, frame by frame.
  const canvas = page.locator(".clip-tl-canvas");
  const box = (await canvas.boundingBox())!;
  await canvas.hover({ position: { x: INSIDE_X, y: 10 } });
  await page.mouse.down();
  await page.mouse.move(box.x + 480, box.y + 10, { steps: 4 });
  await page.mouse.up();
  await expect(timecode).toHaveText("00:00:08:00");

  forgetHome(home);
});
