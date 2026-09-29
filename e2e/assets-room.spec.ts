import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openAssetsRoom,
  openClipRoom,
  openRecent,
  projectHome,
  showAssets,
} from "./helpers";

/**
 * The files room, walked from end to end.
 *
 * Files are brought in and read whole in the room that manages the project's
 * material, placed from the columns that manage only a board's or a cut's own,
 * followed back from a file's uses to the things that hold it, and refused the
 * delete a cut will not allow — the boundary the room exists to draw, told as
 * one reader's journey rather than one assertion per panel.
 */

// A tiny valid PNG (1x1 transparent pixel), as the other specs use.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** A small valid WAV: a header, then a few seconds of silence. */
function tinyWav(seconds = 5): Buffer {
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

/** The row of a file, found by the name the row leads with. */
function rowFor(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped} `) });
}

/** Imports one file through the shelf's own door, and waits for its row. */
async function importFile(
  page: Page,
  kind: string,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  await page.getByTestId(`asset-kind-${kind}`).click();
  await page
    .getByLabel("Import files", { exact: true })
    .setInputFiles({ name, mimeType, buffer });
  await expect(rowFor(page, name)).toBeVisible({ timeout: 10_000 });
}

/** The room's list, apart from the tray of files still waiting for a place. */
function placedList(page: Page) {
  return page.locator(
    ".side-assets .side-resource-group:not(.side-resource-tray)",
  );
}

test("a project's files are read whole in one room and placed from the rooms that use them", async ({
  page,
}) => {
  const home = projectHome("assets-room");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Files Room");

  // Where the bar's last button ends on a board, to be looked for again in the
  // room: the bar is one bar, and the corner it ends in is its own.
  const boardCorner = await page.locator(".export-menu").boundingBox();
  expect(boardCorner).not.toBeNull();

  // The room is one of the four a recent project offers on the launcher, so
  // that is the way in — and the board is never stood on on the way past it.
  await page.reload();
  await openRecent(page, "Files Room", "Assets");
  await expect(page.getByTestId("assets-page")).toBeVisible({
    timeout: 10_000,
  });

  // The bar stands the same here as it does over a board: the status and the
  // tools keep the corner they keep on every page, and the Export button keeps
  // its place in that corner too — grayed, since nothing leaves the project
  // from the files room, rather than opening a menu with nothing in it.
  const roomCorner = await page.locator(".export-menu").boundingBox();
  expect(roomCorner).not.toBeNull();
  expect(Math.round(roomCorner!.x + roomCorner!.width)).toBe(
    Math.round(boardCorner!.x + boardCorner!.width),
  );
  const exportButton = page.getByTestId("export-menu-button");
  await expect(exportButton).toBeDisabled();
  await expect(exportButton).toHaveAttribute(
    "title",
    "Nothing to export from this page",
  );

  // Nothing is chosen yet, so the stage reads the project: nothing in it.
  await expect(page.getByTestId("assets-overview-total")).toHaveText(
    "0 files · 0 used · 0 unused · 0 B",
  );

  // Files come in through the column's own door: two pictures, so the search
  // has two rows to narrow between, and a sound.
  await importFile(page, "image", "still.png", "image/png", TINY_PNG);
  await importFile(page, "image", "plate.png", "image/png", TINY_PNG);
  await importFile(page, "audio", "tone.wav", "audio/wav", tinyWav());

  // The kind tabs count what the project holds, and the search narrows the
  // rows to what it says.
  await expect(page.getByTestId("asset-kind-image")).toContainText("2");
  await expect(page.getByTestId("asset-kind-audio")).toContainText("1");
  await page.getByTestId("asset-kind-image").click();
  const asked = page.getByTestId("shelf-asked");
  await asked.fill("plate");
  await expect(rowFor(page, "plate.png")).toBeVisible();
  await expect(rowFor(page, "still.png")).toHaveCount(0);
  await asked.fill("");
  await expect(rowFor(page, "still.png")).toBeVisible();

  // Nothing holds any of them yet, so the unused view counts the whole shelf.
  await page.getByTestId("assets-view-unused").click();
  await expect(
    page.getByTestId("assets-view-unused").locator(".assets-view-count"),
  ).toHaveText("3");
  await expect(rowFor(page, "still.png")).toBeVisible();
  await page.getByTestId("asset-kind-audio").click();
  await expect(rowFor(page, "tone.wav")).toBeVisible();
  await page.getByTestId("assets-view-all").click();

  // The board's column is about what the board holds rather than the project:
  // it holds nothing, so both pictures wait in the tray above its list.
  await page.getByRole("button", { name: "Projects menu" }).click();
  await page.getByRole("menuitem", { name: "Canvas" }).click();
  await expect(page.getByTestId("canvas-host")).toBeVisible({
    timeout: 10_000,
  });
  await showAssets(page);
  const tray = page.getByTestId("shelf-tray");
  await expect(tray).toContainText("Imported, not placed · 2");
  await expect(tray).toContainText("still.png");
  await expect(tray).toContainText("plate.png");
  await expect(placedList(page)).toHaveCount(0);

  // One press lands a waiting file on the board as a card, and the file leaves
  // the tray for the board's own list.
  const hint = page.getByTestId("canvas-host").locator(".editor-canvas-hint");
  await tray
    .getByRole("button", { name: "Add still.png to the canvas" })
    .click();
  await expect(hint).toHaveText("1 nodes · 0 edges");
  await expect(tray.getByText("still.png")).toHaveCount(0);
  await expect(placedList(page)).toContainText("still.png");

  // The second picture follows, so nothing is left waiting and the board holds
  // both cards.
  await tray
    .getByRole("button", { name: "Add plate.png to the canvas" })
    .click();
  await expect(hint).toHaveText("2 nodes · 0 edges");
  await expect(page.getByTestId("shelf-tray")).toHaveCount(0);

  // Back in the files room, the picture says where it is used, and the use is
  // a door to the board: the card framed and chosen.
  await openAssetsRoom(page);
  await page.getByTestId("asset-kind-image").click();
  await rowFor(page, "still.png").click();
  const usedByCanvas = page.getByTestId("assets-uses-canvas");
  await expect(usedByCanvas).toContainText("Canvas 1 · still.png");
  await usedByCanvas
    .getByRole("button", { name: "Open Canvas 1 · still.png" })
    .click();
  await expect(page.getByTestId("canvas-host")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByLabel("Node title")).toHaveValue("still.png");

  // The cut is the other room's own column: it starts empty, and the sound is
  // taken from the whole project through the picker rather than brought in
  // again — a file already in the project is placed, not imported twice.
  await openClipRoom(page);
  await newTimeline(page, "Timeline 1");
  await expect(
    page.getByText(
      "This cut holds no material yet — import files, or take them from the project.",
    ),
  ).toBeVisible();
  await page.getByTestId("clip-from-project").click();
  const picker = page.getByTestId("asset-picker");
  await expect(picker).toBeVisible();
  await picker
    .locator(".asset-pick-row")
    .filter({ hasText: "tone.wav" })
    .locator("input[type=checkbox]")
    .check();
  await expect(picker.getByTestId("asset-pick-count")).toContainText(
    "Will be added as 1 clip, from the playhead",
  );
  await picker.getByRole("button", { name: "Place" }).click();
  await expect(page.getByTestId("asset-picker")).toHaveCount(0);

  // The sound is the cut's material now: on the timeline, and listed by the
  // cut's own column.
  await expect(page.locator(".clip-timeline")).toHaveAttribute(
    "data-clip-count",
    "1",
  );
  await page.getByTestId("asset-kind-audio").click();
  await expect(rowFor(page, "tone.wav")).toBeVisible();

  // The sound's use is read the same way, and its door lands in the cutting
  // room with that clip chosen.
  await openAssetsRoom(page);
  await page.getByTestId("asset-kind-audio").click();
  await rowFor(page, "tone.wav").click();
  const usedByClip = page.getByTestId("assets-uses-clip");
  await expect(usedByClip).toContainText("Timeline 1 · tone.wav");
  await usedByClip
    .getByRole("button", { name: "Open Timeline 1 · tone.wav" })
    .click();
  await expect(page.getByTestId("clip-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("clip-fields")).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "Timelines" }).getByRole("tab", {
      name: "Timeline 1",
    }),
  ).toHaveAttribute("aria-selected", "true");

  // A file a cut is holding is refused the delete outright — by name, rather
  // than taken away from under the clip — and nothing is taken from the room.
  await openAssetsRoom(page);
  await page.getByTestId("asset-kind-audio").click();
  await rowFor(page, "tone.wav").click();
  const stage = page.getByTestId("assets-stage-file");
  await expect(stage).toContainText("tone.wav");
  await stage.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator(".toast-error")).toContainText(
    "The asset cannot be deleted",
  );
  await expect(page.locator(".toast-error")).toContainText("Timeline 1");
  await expect(stage).toContainText("tone.wav");

  // Every file is placed now, so the unused view has nothing to count and says
  // so rather than showing an empty shelf.
  await page.getByTestId("assets-view-unused").click();
  await expect(
    page.getByText("Nothing is unused — every file is placed somewhere."),
  ).toBeVisible();

  forgetHome(home);
});
