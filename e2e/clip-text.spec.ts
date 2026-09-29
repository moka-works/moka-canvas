import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { parseSrt } from "../src/features/clip/subtitles/srt";
import { frameAligned } from "../src/features/clip/timeline/timecode";
import {
  chooseSavePath,
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  projectHome,
} from "./helpers";

/**
 * Words on the cut: writing a text clip on the Text page, editing one in the
 * inspector with a live preview and one undo per commit, and bringing a
 * subtitle file in and out.
 *
 * The room's own seam is what the assertions read — `data-clip-spans` for
 * where the blocks are, `data-selected-clip-ids` and `data-playhead-ms` for
 * the choice — and the preview is read back as pixels for the two claims that
 * are about the picture rather than the document.
 *
 * A subtitle file travels as an inline buffer through the hidden input the
 * page keeps for it, exactly as a reader's own file would.
 */

/** Two cues that do not touch: the batch the round trip is written around. */
const CUES_SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "The first words of the cue",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,500",
  "And then some more",
  "",
].join("\n");

/** Two cues that run into each other: the batch the room refuses. */
const OVERLAPPING_SRT = [
  "1",
  "00:00:01,000 --> 00:00:05,000",
  "One",
  "",
  "2",
  "00:00:04,000 --> 00:00:08,000",
  "Two",
  "",
].join("\n");

/** One cue laid over a clip already on the row. */
const ON_TOP_SRT = [
  "1",
  "00:00:01,000 --> 00:00:02,000",
  "On the clip already there",
  "",
].join("\n");

/** The moment the overlapping pair meets, as the toast names it. */
const OVERLAP_MESSAGE = "The subtitles overlap each other at 00:00:04:00.";

function timeline(page: Page) {
  return page.locator(".clip-timeline");
}

/** The moment the room is standing on. */
async function playheadMs(page: Page): Promise<number> {
  return Number(
    (await timeline(page).getAttribute("data-playhead-ms")) ?? "-1",
  );
}

/** One block as the timeline's seam writes it: `id@trackId:start:duration`. */
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

/** The blocks on one track, which is how a batch of cues is counted. */
async function spansOnTrack(page: Page, trackId: string): Promise<Span[]> {
  return (await spans(page)).filter((span) => span.trackId === trackId);
}

/**
 * The blocks once the room's own seam has caught up.
 *
 * The attributes are written a moment behind the frame that drew them, so a
 * read taken straight after an edit can still be the one before it.
 */
async function drawnSpans(page: Page, count: number): Promise<Span[]> {
  await expect.poll(async () => (await spans(page)).length).toBe(count);
  return spans(page);
}

async function selectedIds(page: Page): Promise<string[]> {
  const raw =
    (await timeline(page).getAttribute("data-selected-clip-ids")) ?? "";
  return raw.split(",").filter((id) => id.length > 0);
}

/** A fresh project already standing in the cutting room. */
async function clipRoom(page: Page, name: string): Promise<string> {
  const home = projectHome("clip-text");
  await forgetProjects();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openClipRoom(page);
  return home;
}

/** The Text page turned over, with a timeline to write on. */
async function textPage(page: Page): Promise<void> {
  await newTimeline(page, "Timeline 1");
  await page.getByTestId("clip-face-text").click();
  await expect(page.getByTestId("clip-text-panel")).toBeVisible();
}

const panel = (page: Page) => page.getByTestId("clip-text-panel");
const inspectorFields = (page: Page) =>
  page.getByTestId("clip-fields").getByTestId("clip-text-fields");
const cueRows = (page: Page) => page.getByTestId("clip-subtitle-row");

/** The composer writes its words and lays the clip at the playhead. */
async function addText(page: Page, words: string, atX = 6) {
  await page.locator(".clip-tl-canvas").click({ position: { x: atX, y: 10 } });
  await panel(page).getByTestId("clip-text-content").fill(words);
  await page.getByRole("button", { name: "Add at the playhead" }).click();
}

/** Bar none: the whole shape this suite imports a subtitle file with. */
async function importFile(page: Page, name: string, text: string) {
  await page
    .getByLabel("Import subtitles")
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
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

/** A text clip's own style, as the server has the document written down. */
async function persistedTextStyle(
  page: Page,
): Promise<{ strokeWidth?: number; strokeColor?: string } | null> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        timelines?: {
          clips?: {
            kind?: string;
            text?: {
              style?: { strokeWidth?: number; strokeColor?: string };
            };
          }[];
        }[];
      };
    };
    const clips = body.moka?.timelines?.[0]?.clips ?? [];
    const clip = clips.find((each) => each.kind === "text");
    return clip?.text?.style ?? null;
  });
}

test("Add at the playhead lands a text clip on the frame clock, and the cue list shows it", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Add");
  await textPage(page);

  // The playhead is put off a round moment, so the landing place can be read
  // as the frame clock's own answer rather than as the click's.
  await addText(page, "The first words", 213);
  const playhead = await playheadMs(page);
  const landed = await drawnSpans(page, 1);
  expect(landed[0].startMs).toBe(frameAligned(playhead, 30));
  expect(Math.abs(landed[0].startMs - playhead)).toBeLessThanOrEqual(34);
  expect(landed[0].durationMs).toBe(2_000);

  // The cue list reads the text track back, one row for the one clip.
  await expect(cueRows(page)).toHaveCount(1);
  await expect(cueRows(page).first()).toContainText("The first words");

  // The words are spent on the clip; the composer is empty for the next line.
  await expect(panel(page).getByTestId("clip-text-content")).toHaveValue("");

  forgetHome(home);
});

test("a cue row chooses its clip and takes the playhead to its words", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Cue Jump");
  await textPage(page);
  await addText(page, "Jump to me", 6);
  const [clip] = await drawnSpans(page, 1);
  expect(await playheadMs(page)).toBe(clip.startMs);

  // The playhead is moved away first, so the row's jump is a change.
  await page.locator(".clip-tl-canvas").click({ position: { x: 300, y: 10 } });
  await expect.poll(() => playheadMs(page)).toBe(5_000);

  await cueRows(page).first().click();
  await expect.poll(() => selectedIds(page)).toEqual([clip.id]);
  await expect.poll(() => playheadMs(page)).toBe(clip.startMs);

  // The inspector is the same form, over the chosen clip.
  await expect(inspectorFields(page)).toBeVisible();
  await expect(
    inspectorFields(page).getByTestId("clip-text-content"),
  ).toHaveValue("Jump to me");

  forgetHome(home);
});

test("a red plate at centre shows through the preview's middle", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Plate");
  await textPage(page);
  await addText(page, "The first words", 6);
  await cueRows(page).first().click();

  // The plate and the words are made the same red, so the middle of the frame
  // is red whatever part of the block the sample lands on.
  await inspectorFields(page)
    .getByLabel("Plate color", { exact: true })
    .fill("#ff0000");
  await inspectorFields(page)
    .getByLabel("Color", { exact: true })
    .fill("#ff0000");
  await inspectorFields(page)
    .getByRole("button", { name: "Position center" })
    .click();

  await expect
    .poll(async () =>
      isColour(await pixelAt(page, { x: 0.5, y: 0.5 }), [255, 0, 0], 10),
    )
    .toBe(true);

  forgetHome(home);
});

test("typing in the inspector commits once, and one undo puts the words back", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Undo");
  await textPage(page);
  await addText(page, "First cut line", 6);
  await cueRows(page).first().click();

  // A burst of typing lands as one value, and the blur is the commit.
  await inspectorFields(page)
    .getByTestId("clip-text-content")
    .fill("Rewritten words");
  await cueRows(page).first().click();
  await expect(cueRows(page).first()).toContainText("Rewritten words");

  // One undo takes the whole burst back — not one undo per keystroke.
  await page.keyboard.press("Control+z");
  await expect(cueRows(page).first()).toContainText("First cut line");
  await expect(
    inspectorFields(page).getByTestId("clip-text-content"),
  ).toHaveValue("First cut line");

  forgetHome(home);
});

/** The middle of the text row, which is the top row under the ruler's 28px. */
const TEXT_ROW_Y = 46;

test("a cue is rewritten where it stands on the timeline, and one undo puts the words back", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text In Place");
  await textPage(page);
  await addText(page, "First cut line", 6);
  const [clip] = await drawnSpans(page, 1);

  // The cue is doubled where it draws, not where the panel lists it.
  await page.locator(".clip-tl-canvas").dblclick({
    position: { x: 60, y: TEXT_ROW_Y },
  });
  const editor = page.locator(".clip-tl-cue-input");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("First cut line");

  await editor.fill("Rewritten where it stands");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);

  // The words are the document's now: the cue list reads them back, and the
  // block has not moved.
  await expect(cueRows(page).first()).toContainText(
    "Rewritten where it stands",
  );
  expect(await spans(page)).toEqual([clip]);

  // One session, one step of history.
  await page.keyboard.press("Control+z");
  await expect(cueRows(page).first()).toContainText("First cut line");

  forgetHome(home);
});

test("Enter opens the chosen cue in place, and Escape lets it go unwritten", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text In Place Escape");
  await textPage(page);
  await addText(page, "A line kept as it is", 6);
  const [clip] = await drawnSpans(page, 1);

  // The cue is chosen by its own block, which is what the key is about.
  await page
    .locator(".clip-tl-canvas")
    .click({ position: { x: 60, y: TEXT_ROW_Y } });
  await expect.poll(() => selectedIds(page)).toEqual([clip.id]);

  await page.keyboard.press("Enter");
  const editor = page.locator(".clip-tl-cue-input");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("A line kept as it is");

  await editor.fill("Words nobody kept");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(cueRows(page).first()).toContainText("A line kept as it is");

  // Nothing was written, so the one step of history is still the landing:
  // one undo takes the whole cue away, and no step was spent on the session.
  await page.keyboard.press("Control+z");
  await expect(cueRows(page)).toHaveCount(0);
  await expect.poll(async () => (await spans(page)).length).toBe(0);

  forgetHome(home);
});

test("a blank stretch of the text row takes a new cue, and one undo takes it away", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Write In Place");
  await textPage(page);

  // The right-click on the same blank offers the writing by name.
  await page
    .locator(".clip-tl-canvas")
    .click({ button: "right", position: { x: 400, y: TEXT_ROW_Y } });
  const addHere = page.getByRole("menuitem", { name: "Add subtitle here" });
  await expect(addHere).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(addHere).toHaveCount(0);

  // Nowhere to land: the row is blank, and the double click says where a cue
  // would go — 120px at the default zoom is the 2s mark on the frame clock.
  await page.locator(".clip-tl-canvas").dblclick({
    position: { x: 120, y: TEXT_ROW_Y },
  });
  const editor = page.locator(".clip-tl-cue-input");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("");

  await editor.fill("Written on the spot");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);

  const [clip] = await drawnSpans(page, 1);
  expect(clip.startMs).toBe(2_000);
  expect(clip.durationMs).toBe(2_000);
  await expect(cueRows(page)).toHaveCount(1);
  await expect(cueRows(page).first()).toContainText("Written on the spot");

  // The cue's own right-click offers to rewrite the same words in place.
  await page
    .locator(".clip-tl-canvas")
    .click({ button: "right", position: { x: 180, y: TEXT_ROW_Y } });
  const editHere = page.getByRole("menuitem", { name: "Edit subtitle" });
  await expect(editHere).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editHere).toHaveCount(0);

  // One gesture, one step of history: a single undo takes the cue away.
  await page.keyboard.press("Control+z");
  await expect(cueRows(page)).toHaveCount(0);
  await expect.poll(async () => (await spans(page)).length).toBe(0);

  forgetHome(home);
});

test("the words of a new cue are let go with Escape, and nothing is written", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Write In Place Escape");
  await textPage(page);

  await page.locator(".clip-tl-canvas").dblclick({
    position: { x: 120, y: TEXT_ROW_Y },
  });
  const editor = page.locator(".clip-tl-cue-input");
  await expect(editor).toBeVisible();
  await editor.fill("Words nobody kept");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);

  // The session was let go before any command could be built: the row is as
  // blank as it was, and there is no step of history to take back.
  await expect(cueRows(page)).toHaveCount(0);
  await expect.poll(async () => (await spans(page)).length).toBe(0);

  forgetHome(home);
});

test("Import .srt lands every cue in one step, and a row jumps to its time", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Import");
  await textPage(page);
  await importFile(page, "cues.srt", CUES_SRT);

  await expect(page.locator(".toast").last()).toContainText("Imported 2 cues.");
  const landed = await drawnSpans(page, 2);
  expect(landed.map((span) => [span.startMs, span.durationMs])).toEqual([
    [1_000, 2_000],
    [4_000, 2_500],
  ]);
  // Both cues are on the one row, which is the first text track.
  expect(new Set(landed.map((span) => span.trackId)).size).toBe(1);
  expect(await spansOnTrack(page, landed[0].trackId)).toHaveLength(2);

  await expect(cueRows(page)).toHaveCount(2);
  await expect(cueRows(page).nth(1)).toContainText("And then some more");

  await cueRows(page).nth(1).click();
  await expect.poll(() => playheadMs(page)).toBe(4_000);
  await expect.poll(() => selectedIds(page)).toEqual([landed[1].id]);

  forgetHome(home);
});

test("an .srt that runs into itself, or into the row, is refused whole", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Refuse");
  await textPage(page);
  await importFile(page, "first.srt", ON_TOP_SRT);
  await expect(cueRows(page)).toHaveCount(1);

  // The cues of the second file run into each other: the batch is refused
  // whole, so the timeline keeps the one clip it had.
  await importFile(page, "overlapping.srt", OVERLAPPING_SRT);
  await expect(page.locator(".toast").last()).toContainText(OVERLAP_MESSAGE);
  await expect(cueRows(page)).toHaveCount(1);

  // A batch that would land on the row's own clip is refused with the row named.
  await importFile(page, "on-top.srt", ON_TOP_SRT);
  await expect(page.locator(".toast").last()).toContainText(
    "The subtitles overlap a clip already on Text 1.",
  );
  await expect(cueRows(page)).toHaveCount(1);

  forgetHome(home);
});

test("Export .srt writes the cues back out, and they read again", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Export");
  await textPage(page);
  await importFile(page, "cues.srt", CUES_SRT);
  await expect(cueRows(page)).toHaveCount(2);

  await page.getByRole("button", { name: "Export .srt" }).click();
  const dialog = page.getByTestId("path-browser");
  await expect(dialog.getByTestId("path-browser-name")).toHaveValue(
    "Timeline 1.srt",
  );
  const destination = await chooseSavePath(page);
  // The write is the server's and lands a moment after the dialog is answered,
  // so the file is read once the save has said where it went.
  await expect(page.getByText(`Subtitles saved to ${destination}`)).toBeVisible(
    {
      timeout: 10_000,
    },
  );
  const written = readFileSync(destination, "utf8");
  expect(written).toContain("00:00:01,000 --> 00:00:03,000");
  expect(written).toContain("00:00:04,000 --> 00:00:06,500");
  expect(written).toContain("The first words of the cue");
  expect(written).toContain("And then some more");

  // What was written is what was read: the same cues come back out of it.
  const parsed = parseSrt(written);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.cues.map((cue) => [cue.startMs, cue.endMs])).toEqual([
    [1_000, 3_000],
    [4_000, 6_500],
  ]);

  forgetHome(home);
});

test("a stroke width and colour are one command each, and survive the save", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Stroke");
  await textPage(page);
  await addText(page, "Outlined words", 6);
  await cueRows(page).first().click();
  const [clip] = await drawnSpans(page, 1);

  await inspectorFields(page)
    .getByLabel("Stroke width", { exact: true })
    .fill("4");
  await inspectorFields(page)
    .getByLabel("Stroke width", { exact: true })
    .press("Enter");
  await inspectorFields(page)
    .getByLabel("Stroke color", { exact: true })
    .fill("#ff0000");

  // The document holds both, once the save has carried them to the server.
  await expect
    .poll(async () => (await persistedTextStyle(page))?.strokeWidth)
    .toBe(4);
  await expect
    .poll(async () => (await persistedTextStyle(page))?.strokeColor)
    .toBe("#ff0000");
  await expect.poll(() => selectedIds(page)).toEqual([clip.id]);

  // Two gestures, two steps of history: one undo takes the colour back and
  // leaves the width where it was set. The field gives up its focus first —
  // a key pressed inside a field is the field's own.
  await cueRows(page).first().click();
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await persistedTextStyle(page))?.strokeColor)
    .toBe("#000000");
  expect((await persistedTextStyle(page))?.strokeWidth).toBe(4);

  forgetHome(home);
});

/** A playable WAV of a few seconds, so the shelf takes it as a real sound. */
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
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

test("auto subtitles read the sound on the cut, and a missing model is a place to go", async ({
  page,
}) => {
  const home = await clipRoom(page, "Text Transcribe");
  await textPage(page);

  // Nothing on the cut is audible yet, so the row says what it would need
  // rather than asking a provider about a text clip.
  const go = page.locator(".clip-text-transcribe-go");
  await expect(go).toBeDisabled();
  await expect(go).toHaveAttribute(
    "title",
    "Nothing to recognize — choose a sound or a shot, or move the playhead onto one.",
  );

  // A sound laid at the playhead is what the ask is about. The shelf is a
  // face of the same column the text page is, so the file is brought in from
  // the Local face and the page is turned back to afterwards.
  await page.getByTestId("clip-face-local").click();
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: "tiny.wav",
    mimeType: "audio/wav",
    buffer: tinyWav(),
  });
  await page.getByTestId("asset-kind-audio").click();
  await page
    .getByRole("button", { name: "Add tiny.wav at the playhead" })
    .click();
  await page.getByTestId("clip-face-text").click();
  await expect(go).toBeEnabled();

  // No recognition model is set up, and the refusal is answered with what is
  // missing and the place it is set up, rather than with a sentence and a dead
  // end.
  await go.click();
  const told = page.locator(".toast").last();
  await expect(told).toContainText("Cannot transcribe yet:");
  await expect(told).toContainText("no asr model is configured");
  await expect(told).toContainText("Set up models");
  await told.click();

  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("tab", { name: "Speech recognition" }),
  ).toHaveAttribute("aria-selected", "true");

  forgetHome(home);
});
