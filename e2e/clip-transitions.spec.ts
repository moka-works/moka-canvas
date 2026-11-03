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

/**
 * The seams of a cut, and everything a reader can do to them.
 *
 * A seam is an overlap the document holds, so every assertion here reads the
 * two attributes the room writes: `data-clip-spans` for where the blocks are
 * and `data-transitions` for which seams carry what. The gestures are the
 * real mouse, since a canvas pointer session is not HTML5 drag and drop; only
 * the shelf drops are dispatched, as the edits spec does.
 */

// Two one-pixel PNGs, pure red and pure blue (8-bit RGB, no filter), written
// with a zlib deflate exactly as the preview spec's red pixel is. Opaque, so
// a crossfade of the two lands on the purple halfway between them.
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);

const ASSET_DRAG_MIME = "application/x-moka-asset";

/**
 * Pixel positions the gestures are measured in.
 *
 * The scale is the room's default 60px/s and the canvas is only as wide as
 * the window leaves it, so the cut is placed early: the first picture dropped
 * at 120 starts at 2,000 and ends at 6,000 (the 360th pixel), the second
 * dropped at 420 starts at 7,000, and the third — once the first seam has
 * pulled the second block back — lands at 9,500 (the 570th pixel). A press in
 * the middle of the second block is clear of its own edges' six pixels.
 */
const PX_PER_SEC = 60;
const DROP_X = 120;
const SECOND_DROP_X = 420;
const SECOND_BODY_X = 450;
/** How far the second block is dragged to leave its head 50ms off the tail. */
const SNAP_SHIFT_MS = 950;
/** The butted boundary of the two four-second pictures: 6,000ms. */
const SEAM_X = (6_000 / 1_000) * PX_PER_SEC;
/** The third picture lands exactly against the second one's pulled-back tail. */
const THIRD_DROP_X = (9_500 / 1_000) * PX_PER_SEC;

/** The browser's drag data, as much of it as this suite uses. */
interface DragData {
  setData(type: string, value: string): void;
}

/** Drops a shelf asset on the canvas by dispatch rather than by mouse. */
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

/** One transition as the test seam writes it. */
interface Seam {
  id: string;
  trackId: string;
  leaderId: string;
  windowStartMs: number;
  windowMs: number;
  kind: string;
}

async function seams(page: Page): Promise<Seam[]> {
  const raw = (await timeline(page).getAttribute("data-transitions")) ?? "";
  return raw
    .split(";")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [id, rest] = entry.split("@");
      const [trackId, leaderId, windowStart, windowMs, kind] = rest.split(":");
      return {
        id,
        trackId,
        leaderId,
        windowStartMs: Number(windowStart),
        windowMs: Number(windowMs),
        kind,
      };
    });
}

/** The clips in document order, which is the order they were dropped in. */
async function pair(page: Page): Promise<{ a: Span; b: Span }> {
  const list = await spans(page);
  return { a: list[0], b: list[1] };
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

/** Imports one picture through the shelf's own input, and waits for its row. */
async function importPicture(
  page: Page,
  name: string,
  buffer: Buffer = RED_PNG,
) {
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name,
    mimeType: "image/png",
    buffer,
  });
  await expect(
    page.getByRole("button", {
      name: new RegExp(`^${name.replace(/\./g, "\\.")} `),
    }),
  ).toBeVisible({ timeout: 10_000 });
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

/** A fresh project already standing in the cutting room, with room to cut in. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-transitions");
  await forgetProjects();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/**
 * Two four-second pictures butted exactly: the first dropped at 2,000 and the
 * second dragged from 7,000 until the magnet catches it on the first's tail.
 * The magnet's catch is what makes `B.start === A.end` exact; the test below
 * asserts it rather than assuming it.
 */
async function twoButted(page: Page) {
  await newTimeline(page, "Timeline 1");
  await importPicture(page, "one.png");
  const first = await filedId(page, "one.png");
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await dropAssetOnTimeline(page, first, { x: DROP_X, y: video.y - box.y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "1");

  await importPicture(page, "two.png");
  const second = await filedId(page, "two.png");
  await dropAssetOnTimeline(page, second, {
    x: SECOND_DROP_X,
    y: video.y - box.y,
  });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");
  const shiftPx = (SNAP_SHIFT_MS / 1_000) * PX_PER_SEC;
  await drag(
    page,
    { x: box.x + SECOND_BODY_X, y: video.y },
    { x: box.x + SECOND_BODY_X - shiftPx, y: video.y },
  );
  await expect.poll(async () => (await pair(page)).b.startMs).toBe(6_000);
}

/** Drops a third picture exactly against the second block's pulled-back tail. */
async function thirdButted(page: Page) {
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await importPicture(page, "three.png");
  const third = await filedId(page, "three.png");
  await dropAssetOnTimeline(page, third, {
    x: THIRD_DROP_X,
    y: video.y - box.y,
  });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "3");
  await expect
    .poll(async () => {
      const list = await spans(page);
      return list[2].startMs === list[1].startMs + list[1].durationMs;
    })
    .toBe(true);
}

/** Clicks a seam or a badge with the real mouse. */
async function clickAt(page: Page, x: number) {
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await page.mouse.move(box.x + x, video.y);
  await page.mouse.click(box.x + x, video.y);
}

/** Clicks a butted seam's `+` and waits for the transition count to move. */
async function clickSeam(page: Page, x: number, expected: number) {
  await clickAt(page, x);
  await expect.poll(async () => (await seams(page)).length).toBe(expected);
}

/** Chooses a seam by clicking its badge, which opens the card. */
async function selectSeam(page: Page, x: number) {
  await clickAt(page, x);
  await expect(page.getByTestId("clip-transition-card")).toBeVisible();
}

test("a click on a butted seam lays the default crossfade, pulled back by the command", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transitions Add");
  await twoButted(page);
  // The magnet's own promise: the head is exactly on the tail.
  const before = await pair(page);
  expect(before.b.startMs).toBe(before.a.startMs + before.a.durationMs);

  await clickSeam(page, SEAM_X, 1);

  const seam = (await seams(page))[0];
  expect(seam.kind).toBe("crossfade");
  expect(seam.windowMs).toBe(500);
  expect(seam.leaderId).toBe(before.a.id);
  // The pull-back is the document's own geometry, done by `addTransitions`.
  const after = await pair(page);
  expect(after.b.startMs).toBe(before.a.startMs + before.a.durationMs - 500);
  expect(seam.windowStartMs).toBe(after.b.startMs);

  forgetHome(home);
});

test("the badge chooses the seam and a kind tile changes it without moving the cut", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transitions Kind");
  await twoButted(page);
  await clickSeam(page, SEAM_X, 1);
  const before = await timeline(page).getAttribute("data-clip-spans");

  await selectSeam(page, SEAM_X);
  expect(
    await timeline(page).getAttribute("data-selected-transition-id"),
  ).not.toBe("");
  // Seven kinds to choose from, the current one pressed.
  await expect(page.locator('[data-testid^="transition-kind-"]')).toHaveCount(
    7,
  );
  await expect(page.getByTestId("transition-kind-crossfade")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("transition-kind-dipToBlack").click();
  await expect
    .poll(async () => (await seams(page))[0]?.kind)
    .toBe("dipToBlack");
  // A kind is a way of drawing the window, not a way of moving the clips.
  expect(await timeline(page).getAttribute("data-clip-spans")).toBe(before);
  await expect(page.getByTestId("transition-kind-dipToBlack")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  forgetHome(home);
});

test("the window slider reshapes the pull-back on release", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transitions Window");
  await twoButted(page);
  await clickSeam(page, SEAM_X, 1);
  await selectSeam(page, SEAM_X);

  const slider = page.getByRole("slider", { name: "Window" });
  await slider.fill("1000");
  await slider.blur();
  await expect.poll(async () => (await seams(page))[0]?.windowMs).toBe(1_000);
  const after = await pair(page);
  expect(after.b.startMs).toBe(after.a.startMs + after.a.durationMs - 1_000);

  forgetHome(home);
});

test("a chain edit is one command, and one undo puts the whole chain back", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transitions Chain");
  await twoButted(page);
  await clickSeam(page, SEAM_X, 1);
  // A third picture lands exactly against the second one's pulled-back tail.
  await thirdButted(page);

  // The second seam lands on the butted boundary of the third picture.
  await clickSeam(page, THIRD_DROP_X, 2);
  const chained = await timeline(page).getAttribute("data-clip-spans");

  // Change the first seam's kind: the whole suffix comes down and is laid back.
  await selectSeam(page, SEAM_X);
  await page.getByTestId("transition-kind-slideLeft").click();
  await expect
    .poll(async () => (await seams(page)).map((seam) => seam.kind))
    .toEqual(["slideLeft", "crossfade"]);
  expect(await timeline(page).getAttribute("data-clip-spans")).toBe(chained);

  // One step of history: the undo brings the old kind back with the chain.
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await seams(page)).map((seam) => seam.kind))
    .toEqual(["crossfade", "crossfade"]);
  expect(await timeline(page).getAttribute("data-clip-spans")).toBe(chained);
  expect(await seams(page)).toHaveLength(2);

  forgetHome(home);
});

test("removing a transition re-lays the seam that stays behind it", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transitions Remove");
  await twoButted(page);
  await clickSeam(page, SEAM_X, 1);
  await thirdButted(page);
  await clickSeam(page, THIRD_DROP_X, 2);

  // Take the first seam out: the second one is re-laid against the segment
  // ahead of it, which is the release the chain command's order makes safe.
  await selectSeam(page, SEAM_X);
  await page.getByTestId("transition-remove").click();
  await expect.poll(async () => (await seams(page)).length).toBe(1);
  const released = await spans(page);
  expect(released[1].startMs).toBe(6_000);
  expect(released[2].startMs).toBe(
    released[1].startMs + released[1].durationMs - 500,
  );
  expect((await seams(page))[0].windowStartMs).toBe(released[2].startMs);

  // The one that stayed has its badge on the second block's tail now; taking
  // it out leaves every block butted against the next.
  const restX =
    ((released[1].startMs + released[1].durationMs) / 1_000) * PX_PER_SEC;
  await selectSeam(page, restX);
  await page.getByTestId("transition-remove").click();
  await expect.poll(async () => (await seams(page)).length).toBe(0);
  const butted = await spans(page);
  expect(butted[1].startMs).toBe(6_000);
  expect(butted[2].startMs).toBe(butted[1].startMs + butted[1].durationMs);

  forgetHome(home);
});

test("dragging the badge reshapes the window with the pointer", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transitions Drag");
  await twoButted(page);
  await clickSeam(page, SEAM_X, 1);

  // 120px at 60px/s wants two seconds; the document's own ceiling is 2,000.
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  await drag(
    page,
    { x: box.x + SEAM_X, y: video.y },
    { x: box.x + SEAM_X + 120, y: video.y },
  );
  await expect.poll(async () => (await seams(page))[0]?.windowMs).toBe(2_000);
  const after = await pair(page);
  expect(after.b.startMs).toBe(after.a.startMs + after.a.durationMs - 2_000);

  forgetHome(home);
});

test("the frame inside a crossfade is the two pictures mixed", async ({
  page,
}) => {
  const home = await clipRoom(page, "Transitions Pixels");
  await newTimeline(page, "Timeline 1");
  const box = await canvasBox(page);
  const video = await rowCenter(page, "Video 1");
  // One pixel of pure red, one of pure blue, butted at 9,000ms exactly.
  await importPicture(page, "red.png", RED_PNG);
  const red = await filedId(page, "red.png");
  await dropAssetOnTimeline(page, red, { x: DROP_X, y: video.y - box.y });
  await importPicture(page, "blue.png", BLUE_PNG);
  const blue = await filedId(page, "blue.png");
  await dropAssetOnTimeline(page, blue, { x: SEAM_X, y: video.y - box.y });
  await expect(timeline(page)).toHaveAttribute("data-clip-count", "2");
  const butted = await pair(page);
  expect(butted.b.startMs).toBe(butted.a.startMs + butted.a.durationMs);

  await clickSeam(page, SEAM_X, 1);
  expect((await seams(page))[0].windowMs).toBe(500);

  // Halfway into the window: p = 0.5, so the frame is the two half and half.
  await page.locator(".clip-tl-canvas").click({
    position: { x: (5_750 / 1_000) * PX_PER_SEC, y: 10 },
  });
  const preview = page.locator(".clip-preview");
  await expect(preview).toHaveAttribute("data-frame-ms", "5750");
  await expect
    .poll(async () => {
      const pixel = await page
        .locator("canvas.clip-preview-canvas")
        .evaluate((element) => {
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
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            1,
            1,
          ).data;
          return [data[0], data[1], data[2]];
        });
      return (
        Math.abs(pixel[0] - 128) <= 10 &&
        Math.abs(pixel[1]) <= 10 &&
        Math.abs(pixel[2] - 128) <= 10
      );
    })
    .toBe(true);

  forgetHome(home);
});
