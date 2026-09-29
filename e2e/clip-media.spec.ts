import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  projectHome,
} from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));

// A tiny valid PNG (1x1 transparent pixel), as the assets shelf spec uses.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A small valid WAV: a header, then a few seconds of silence, so a preview
 * has something long enough to be seen playing and stopping.
 */
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

/**
 * The browser's drag data, as much of it as these tests use.
 *
 * `DataTransfer` is the browser's own and the node-side types this suite is
 * checked against do not carry it, so the constructor is named through a local
 * shape inside each dispatched drag rather than taken from a global type that
 * is not there.
 */
interface DragData {
  items: { add(file: File): void };
  effectAllowed: string;
  getData(type: string): string;
}

/** A fresh project already standing in the cutting room. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-media");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/** The same, with a cut to place material on: what a test that lands something needs. */
async function cutRoom(page: Page, name: string): Promise<string> {
  const home = await clipRoom(page, name);
  await newTimeline(page, "Timeline 1");
  return home;
}

/** The row of a file, found by the name the row leads with. */
function rowFor(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`^${escaped} `) });
}

/** Imports one file through the shelf's own input, and waits for its row. */
async function importFile(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  await page
    .getByLabel("Import files", { exact: true })
    .setInputFiles({ name, mimeType, buffer });
  await expect(rowFor(page, name)).toBeVisible({ timeout: 10_000 });
}

/** The id the document filed a file under, read from the server. */
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

test("the cut's face reads the cut's own material", async ({ page }) => {
  const home = await cutRoom(page, "Media Faces");

  // A file brought in is held by no clip yet, so it waits in the tray above
  // the cut's own list rather than being the cut's material already.
  await importFile(page, "one.png", "image/png", TINY_PNG);
  const tray = page.getByTestId("shelf-tray");
  await expect(tray).toContainText("one.png");
  // The face has answered which cut the material is for, not where a file
  // came from, so the shelf still asks that question.
  await expect(page.getByTestId("shelf-where")).toHaveCount(1);

  // Landing it on the cut moves it out of the tray and into the cut's list.
  await tray
    .getByRole("button", { name: "Add one.png at the playhead" })
    .click();
  await expect(page.getByTestId("shelf-tray")).toHaveCount(0);
  await expect(page.locator(".clip-timeline")).toHaveAttribute(
    "data-clip-count",
    "1",
  );
  await expect(rowFor(page, "one.png")).toBeVisible();

  forgetHome(home);
});

test("the whole project is reached from the cut through the picker", async ({
  page,
}) => {
  const home = await cutRoom(page, "Media From Project");
  await importFile(page, "one.png", "image/png", TINY_PNG);

  // The cut's column holds this cut's material; everything the project holds
  // is the picker's question, asked from the head of the column.
  await page.getByTestId("clip-from-project").click();
  const dialog = page.getByTestId("asset-picker");
  await expect(dialog).toBeVisible();

  // Choosing from the whole project and placing lands clips on the cut.
  await dialog
    .locator(".asset-pick-row")
    .filter({ hasText: "one.png" })
    .locator("input[type=checkbox]")
    .check();
  await expect(dialog.getByTestId("asset-pick-count")).toContainText(
    "Will be added as 1 clip, from the playhead",
  );
  await dialog.getByRole("button", { name: "Place" }).click();
  await expect(page.getByTestId("asset-picker")).toHaveCount(0);

  // The file is the cut's material now: out of the tray, in the list.
  await expect(page.getByTestId("shelf-tray")).toHaveCount(0);
  await expect(page.locator(".clip-timeline")).toHaveAttribute(
    "data-clip-count",
    "1",
  );
  await expect(rowFor(page, "one.png")).toBeVisible();

  forgetHome(home);
});

test("the search narrows the face and says so when nothing says it", async ({
  page,
}) => {
  const home = await cutRoom(page, "Media Search");
  await importFile(page, "one.png", "image/png", TINY_PNG);
  // Landed rather than left waiting: what the search narrows is the cut's own
  // material, and a file still in the tray is not the face's question yet.
  await page
    .getByRole("button", { name: "Add one.png at the playhead" })
    .click();
  await expect(rowFor(page, "one.png")).toBeVisible();

  const asked = page.getByTestId("shelf-asked");
  await asked.fill("one");
  await expect(rowFor(page, "one.png")).toBeVisible();

  await asked.fill("zzz");
  await expect(page.getByTestId("shelf-no-match")).toBeVisible();
  await expect(page.getByText("Nothing on this shelf says that")).toBeVisible();

  await asked.fill("");
  await expect(rowFor(page, "one.png")).toBeVisible();

  // The keeper mark narrows the shelf too, and Clear lets the rest back in.
  await page.getByRole("button", { name: "Keep one.png to hand" }).click();
  await page.getByTestId("shelf-keepers").check();
  await expect(page.getByTestId("shelf-clear")).toBeVisible();
  await expect(rowFor(page, "one.png")).toBeVisible();
  await page.getByTestId("shelf-clear").click();
  await expect(rowFor(page, "one.png")).toBeVisible();

  forgetHome(home);
});

test("a row carries the drag-out contract the timeline will take", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Drag");
  await importFile(page, "one.png", "image/png", TINY_PNG);

  const listed = await filedId(page, "one.png");
  expect(listed).not.toBe("");
  const row = page.locator(".resource-row").filter({ hasText: "one.png" });
  await expect(row).toHaveAttribute("draggable", "true");
  await expect(row).toHaveAttribute("data-asset-id", listed);

  // What a drag carries: the id, under the shelf's own type. (The copy
  // effect is set on the same handler; a drag that never happened is not a
  // drag the platform lets say so.)
  const carried = await page.evaluateHandle(() => {
    const Browser = (
      globalThis as unknown as { DataTransfer: new () => DragData }
    ).DataTransfer;
    return new Browser();
  });
  await row.dispatchEvent("dragstart", { dataTransfer: carried });
  expect(
    await carried.evaluate((data) => data.getData("application/x-moka-asset")),
  ).toBe(listed);

  forgetHome(home);
});

test("files dropped over the column are imported, and wait in the tray", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Drop");

  const carried = await page.evaluateHandle((base64) => {
    const Browser = (
      globalThis as unknown as { DataTransfer: new () => DragData }
    ).DataTransfer;
    const bytes = Uint8Array.from(atob(base64), (letter) =>
      letter.charCodeAt(0),
    );
    const data = new Browser();
    data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
    return data;
  }, TINY_PNG.toString("base64"));

  await page.dispatchEvent(".clip-column", "dragover", {
    dataTransfer: carried,
  });
  await expect(page.locator(".clip-media-drop")).toHaveText("Drop to import");
  await page.dispatchEvent(".clip-column", "drop", { dataTransfer: carried });

  // No clip holds it yet, so it waits in the tray above the cut's own list.
  await expect(page.getByTestId("shelf-tray")).toContainText("dropped.png", {
    timeout: 10_000,
  });
  await expect(rowFor(page, "dropped.png")).toBeVisible();

  forgetHome(home);
});

test("a sound on a row is tried before it is used, one at a time", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Sound");
  // A shelf opens on pictures, so the arriving sound is waited for under the
  // audio tab of the face it lands on.
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "tiny.wav",
    mimeType: "audio/wav",
    buffer: tinyWav(),
  });
  await page.getByTestId("asset-kind-audio").click();
  await expect(rowFor(page, "tiny.wav")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Play tiny.wav" }).click();
  const pause = page.getByRole("button", { name: "Pause tiny.wav" });
  await expect(pause).toHaveClass(/is-playing/);

  // The same button stops it again.
  await pause.click();
  await expect(
    page.getByRole("button", { name: "Play tiny.wav" }),
  ).not.toHaveClass(/is-playing/);

  // The row's own click reads the file, and the card leads with the sound's
  // own shape, measured from the file itself.
  await rowFor(page, "tiny.wav").click();
  const wave = page.getByTestId("clip-media-preview-waveform");
  await expect(wave).toBeVisible();
  await expect(wave).toHaveAttribute("data-waveform", "peaks", {
    timeout: 10_000,
  });

  forgetHome(home);
});

test("a video row opens its player in the card beside the shelf", async ({
  page,
}) => {
  const home = await clipRoom(page, "Media Video");
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "tiny.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync(join(HERE, "..", "fixtures", "tiny.mp4")),
  });
  await page.getByTestId("asset-kind-video").click();
  await expect(rowFor(page, "tiny.mp4")).toBeVisible({ timeout: 10_000 });

  // The row's play asks for the file, and the card shows it playing in place.
  await page.getByRole("button", { name: "Play tiny.mp4" }).click();
  await expect(page.getByRole("heading", { name: "tiny.mp4" })).toBeVisible();
  const player = page.getByTestId("clip-media-preview-video");
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute("controls", "");
  await expect(player).toHaveAttribute(
    "src",
    /\/api\/v1\/projects\/current\/assets\//,
  );

  forgetHome(home);
});
