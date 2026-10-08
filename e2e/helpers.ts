import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  MUSICIAN,
  PAINTER,
  PROVIDER_ADDRESS,
  PROVIDER_ORIGIN,
  SPEAKER,
  STORYTELLER,
  VIDEOGRAPHER,
} from "./mock-provider";

/** The server under test, for the calls a test makes beside the browser's. */
export const APP = `http://127.0.0.1:${process.env.MOKA_E2E_PORT ?? 8971}`;

export function projectHome(name: string) {
  return mkdtempSync(join(tmpdir(), `moka-e2e-${name}-`));
}

/**
 * Takes a scratch home away once a test is done with it.
 *
 * A room's autosave can still be landing when its test ends, and a directory
 * removed under a write that is on its way is refused with ENOTEMPTY on macOS —
 * a teardown error over work that was done correctly. The retries are
 * `rmSync`'s own, for exactly that kind of refusal.
 */
export function forgetHome(home: string): void {
  rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  });
}

/** Forget every project this server boot has opened.
 *
 * One server answers the whole suite, so the launcher's list is state that
 * carries across spec files: a check that the launcher has nothing to offer
 * has to clear the list rather than trust that its file ran first.
 */
export async function forgetProjects(): Promise<void> {
  const listed = (await (
    await fetch(`${APP}/api/v1/recent-projects`)
  ).json()) as { id: string }[];
  await Promise.all(
    listed.map(async (project) => {
      await fetch(`${APP}/api/v1/recent-projects/${project.id}`, {
        method: "DELETE",
      });
    }),
  );
}

/** Open the launcher's create dialog and scaffold a new project. */
export async function createProject(
  page: Page,
  directory: string,
  name: string,
) {
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Folder").fill(directory);
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "New project" }).click();
  // A folder that already holds something is asked about before the project
  // goes into a subfolder of its own; answer the question if it is there.
  const opened = page.getByRole("banner").getByText(name, { exact: true });
  const confirm = dialog.getByRole("button", { name: "Create", exact: true });
  const asked = await Promise.race([
    confirm.waitFor({ state: "visible", timeout: 15_000 }).then(() => true),
    opened.waitFor({ state: "visible", timeout: 15_000 }).then(() => false),
  ]).catch(() => false);
  if (asked) {
    await confirm.click();
  }
  await expect(opened).toBeVisible({ timeout: 10_000 });
  // A new project opens onto its story room, which is the room it was made
  // for; the board is where a suite that says nothing else starts and is what
  // this helper has always left the reader on, so step there rather than leave
  // every canvas spec to find its own way back.
  await page.getByRole("button", { name: "Projects menu" }).click();
  await page.getByRole("menuitem", { name: "Canvas" }).click();
  await expect(page.getByTestId("canvas-surface")).toBeVisible({
    timeout: 15_000,
  });
}

/** Double-click empty canvas and add a node of the given kind. */
export async function addNode(page: Page, kind: string) {
  const surface = page.getByTestId("canvas-surface");
  const menu = page.getByRole("menu", { name: "Add node" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.dblclick(
      box!.x + box!.width * (0.55 + attempt * 0.08),
      box!.y + box!.height * 0.5,
    );
    // Waited for rather than asked about at once: an instant visibility check
    // races the render that brings the menu up, and the next attempt's double
    // click closes the menu that was on its way — under load every attempt
    // then reads "not open" and the helper gives up on a canvas that works.
    const opened = await menu
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      await menu.getByRole("menuitem", { name: kind, exact: true }).click();
      return;
    }
  }
  throw new Error(`quick-add menu did not open for ${kind}`);
}

/**
 * How far the words of an element stand from the ground they are read on, as a
 * ratio: 1 is one colour twice, and 4.5 is the floor a reader reads at.
 *
 * The ground is the element's own where it has one and the nearest ancestor's
 * otherwise, because a transparent thing is read against whatever stands
 * behind it rather than against nothing.
 */
export async function contrastOf(locator: Locator): Promise<number> {
  const drawn = await locator.evaluate((node) => {
    type Drawn = { parentElement: Drawn | null };
    const Browser = globalThis as unknown as {
      getComputedStyle(target: Drawn): {
        color: string;
        backgroundColor: string;
      };
    };
    const words = Browser.getComputedStyle(node as unknown as Drawn).color;
    let behind: Drawn | null = node as unknown as Drawn;
    let ground = "rgba(0, 0, 0, 0)";
    while (behind !== null && ground === "rgba(0, 0, 0, 0)") {
      ground = Browser.getComputedStyle(behind).backgroundColor;
      behind = behind.parentElement;
    }
    return [words, ground] as const;
  });
  const luminance = (colour: string) => {
    const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).map(Number);
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [light, dark] = [luminance(drawn[0]), luminance(drawn[1])].sort(
    (a, b) => b - a,
  );
  return (light + 0.05) / (dark + 0.05);
}

/** Node count of the first canvas as persisted server-side. */
export async function persistedNodeCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { canvas?: { nodes?: unknown[] }[] };
    };
    return (body.moka?.canvas?.[0]?.nodes ?? []).length;
  });
}

/**
 * Open a recent project from the launcher by its card label.
 *
 * A card asks which room the project is meant for before it is put on, and the
 * board is the room a test that says nothing else means.
 */
export async function openRecent(
  page: Page,
  name: string,
  room: "Story" | "Canvas" | "Clip" | "Assets" = "Canvas",
) {
  await page
    .locator("button.launcher-recent")
    .filter({ hasText: name })
    .click();
  await page
    .getByRole("group", { name: `Open ${name}`, exact: true })
    .getByRole("button", { name: room, exact: true })
    .click();
}

/**
 * Step into the cutting room from whichever working page is open.
 *
 * The project stays open across the step: the coffee button is the way between
 * the two pages, and the Clip row is where the reader arrives.
 */
export async function openClipRoom(page: Page) {
  await page.getByRole("button", { name: "Projects menu" }).click();
  await page.getByRole("menuitem", { name: "Clip" }).click();
  await expect(page.getByTestId("clip-page")).toBeVisible({ timeout: 10_000 });
}

/**
 * Step into the story room from whichever working page is open.
 *
 * The project stays open across the step, exactly as it does on the way to the
 * cutting room: the coffee button is the way between the pages, and the Story
 * row is where the reader arrives.
 */
export async function openStoryRoom(page: Page) {
  await page.getByRole("button", { name: "Projects menu" }).click();
  await page.getByRole("menuitem", { name: "Story" }).click();
  await expect(page.getByTestId("story-page")).toBeVisible({ timeout: 10_000 });
}

/**
 * Step into the files room from whichever working page is open.
 *
 * The project stays open across the step, as it does for every other room:
 * the coffee button is the way between the pages, and the Assets row is where
 * the reader arrives.
 */
export async function openAssetsRoom(page: Page) {
  await page.getByRole("button", { name: "Projects menu" }).click();
  await page.getByRole("menuitem", { name: "Assets" }).click();
  await expect(page.getByTestId("assets-page")).toBeVisible({
    timeout: 10_000,
  });
}

/** Begin a story under a name, from the door that stands open. */
export async function newStory(page: Page, name: string) {
  // Two doors do the same thing: the empty room's own button, and the + over
  // the column once the project tells a story already.
  const empty = page.getByTestId("story-empty-new");
  if ((await empty.count()) > 0) {
    await empty.click();
  } else {
    await page.getByTestId("story-new").click();
  }
  const dialog = page.getByRole("dialog", { name: "New story" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(
    page.locator(".story-row-name").filter({ hasText: name }),
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * Add a timeline through the dialog, whichever door stands open: the first-run
 * empty state's own button, or the + at the end of the strip once there is one.
 */
export async function newTimeline(page: Page, name: string) {
  const first = page.getByRole("button", { name: "New timeline", exact: true });
  if ((await first.count()) > 0) {
    await first.click();
  } else {
    await page.getByRole("button", { name: "Add timeline" }).click();
  }
  const dialog = page.getByRole("dialog", { name: "New timeline" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create timeline" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(
    page.getByRole("tablist", { name: "Timelines" }).getByRole("tab", { name }),
  ).toBeVisible({ timeout: 10_000 });
}

/** The story names as the server has them written down, in document order. */
export async function persistedStoryNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { stories?: { name?: string }[] };
    };
    return (body.moka?.stories ?? []).map((story) => story.name ?? "");
  });
}

/** The timeline names as the server has them written down, in document order. */
export async function persistedTimelineNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: { timelines?: { name?: string }[] };
    };
    return (body.moka?.timelines ?? []).map((timeline) => timeline.name ?? "");
  });
}

/**
 * Turn the column beside the canvas over to its assets face.
 *
 * The column holds two faces — the project's canvases and the files it is made
 * of — and opens on the tree, so anything asked of the shelf (importing a file,
 * reading a row) says so first rather than assuming which face is showing.
 */
export async function showAssets(page: Page) {
  const tab = page.getByTestId("left-tab-assets");
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    await tab.click();
  }
  await expect(page.getByLabel("Import files", { exact: true })).toBeAttached();
}

/** Open the question an export asks about what the package should carry. */
export async function askToExport(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export project" }).click();
  const asked = page.getByRole("dialog", { name: "Export package" });
  await expect(asked).toBeVisible({ timeout: 10_000 });
  return asked;
}

/**
 * Answer the save dialog the browser draws for itself: take the name it
 * offers where it opened, or the folder and name a test names first.
 *
 * Answers with the absolute path the button said it would take, read off the
 * dialog rather than guessed at, so a test can look at the file that landed
 * there.
 */
export async function chooseSavePath(
  page: Page,
  options: { folder?: string; name?: string } = {},
): Promise<string> {
  const dialog = page.getByTestId("path-browser");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  if (options.folder !== undefined) {
    await dialog.getByTestId("path-browser-typed").fill(options.folder);
    await dialog.getByRole("button", { name: "List" }).click();
    await expect(dialog.getByTestId("path-browser-typed")).toHaveValue(
      new RegExp(`${basename(options.folder)}$`),
      { timeout: 10_000 },
    );
  }
  if (options.name !== undefined) {
    await dialog.getByTestId("path-browser-name").fill(options.name);
  }
  const choose = dialog.getByTestId("path-browser-choose");
  await expect(choose).toBeEnabled({ timeout: 10_000 });
  const path =
    (await dialog.getByTestId("path-browser-choice").getAttribute("title")) ??
    "";
  await choose.click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  return path;
}

/**
 * Answer it with both choices left off: the work, and nothing about the
 * machine that made it. Answers with where the package landed.
 */
export async function exportWorkPackage(
  page: Page,
  options: { folder?: string; name?: string } = {},
): Promise<string> {
  const asked = await askToExport(page);
  await asked.getByRole("button", { name: "Export package" }).click();
  return chooseSavePath(page, options);
}

/**
 * Leave the editor for the launcher. If a pending autosave raced the click,
 * the unsaved-work guard appears — resolve it by saving, like a user would.
 */
export async function backToLauncher(page: Page) {
  await page.getByRole("button", { name: "Projects menu" }).click();
  await page.getByRole("menuitem", { name: "Projects" }).click();
  const guard = page.getByRole("alertdialog", { name: "Unsaved changes" });
  const guarded = await guard
    .waitFor({ state: "visible", timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (guarded) {
    await guard.getByRole("button", { name: "Save and close" }).click();
  }
  await expect(page.getByRole("heading", { name: "Moka Canvas" })).toBeVisible({
    timeout: 10_000,
  });
}

/** The credential the stand-in is sent. */
export const CHANNEL_KEY = "e2e-stand-in-credential";

/**
 * The full endpoint address each category speaks at on the stand-in.
 *
 * Music is not among them: a score is asked of a converter, and its address is
 * the one that converter's own document gives — a stand-in shape of the
 * capability's own would be an address no provider actually serves.
 */
function endpoint(capability: Capability): string {
  switch (capability) {
    case "text":
      return `${PROVIDER_ADDRESS}/chat/completions`;
    case "image":
      return `${PROVIDER_ADDRESS}/images/generations`;
    case "video":
      return `${PROVIDER_ADDRESS}/videos`;
    case "speech":
      return `${PROVIDER_ADDRESS}/audio/speech`;
  }
  throw new Error(`no stand-in address for a ${capability} model of its own`);
}

/**
 * Where a script-backed protocol is spoken to on the stand-in. The built-in
 * shapes are derived from the capability; a converter's shape is the path its
 * own model.json gives as an example, which the stand-in serves too — measured
 * from the origin, since a converter's address is the whole endpoint.
 */
const CONVERTER_ENDPOINTS: Record<string, string> = {
  bailianMusic: "/api/v1/services/audio/music/generation",
};

/**
 * How each category is spoken to, which is one protocol per shape. Music has
 * no shape of its own here for the reason `endpoint` gives: a score names the
 * converter it is asked of.
 */
function protocolOf(capability: Capability): string {
  switch (capability) {
    case "text":
      return "openaiChat";
    case "image":
      return "openaiImages";
    case "video":
      return "openaiVideos";
    case "speech":
      return "openaiSpeech";
  }
  throw new Error(`no stand-in protocol for a ${capability} model of its own`);
}

/**
 * Points one model configuration per entry at the stand-in and makes each the
 * default for its category.
 *
 * An upsert replaces rather than appends, so two specs configuring the same
 * model never race over a revision. A speech entry also gives the machine a
 * voice: every speech converter this build deploys is asked for one, and a
 * voiceless ask is refused before it leaves — the stand-in deployment speaks
 * in "alloy" so that a spec about dubbing is about dubbing.
 */
export async function configureModels(
  models: readonly {
    id: string;
    capability: Capability;
    alias: string;
    /**
     * The converter a script-backed model speaks, where it is not the built-in
     * shape of its category. The address follows from it, since the converter's
     * model.json is what says which endpoint it is asked at.
     */
    converter?: keyof typeof CONVERTER_ENDPOINTS;
  }[],
): Promise<void> {
  for (const model of models) {
    const url =
      model.converter === undefined
        ? endpoint(model.capability)
        : `${PROVIDER_ORIGIN}${CONVERTER_ENDPOINTS[model.converter]}`;
    const put = await fetch(`${APP}/api/v1/models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: model.id,
        category: model.capability,
        protocol: model.converter ?? protocolOf(model.capability),
        url,
        model: model.id,
        displayName: model.alias,
        enabled: true,
        apiKey: CHANNEL_KEY,
      }),
    });
    if (!put.ok) {
      throw new Error(
        `configuring the model ${model.id}: ${put.status} ${await put.text()}`,
      );
    }
  }
  const defaults = Object.fromEntries(
    models.map((model) => [model.capability, model.id]),
  );
  const patched = await fetch(`${APP}/api/v1/models/defaults`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  if (!patched.ok) {
    throw new Error(
      `setting the default: ${patched.status} ${await patched.text()}`,
    );
  }
  if (models.some((model) => model.capability === "speech")) {
    await setMachineVoice("alloy");
  }
}

/**
 * What the machine reads lines in, as the preferences form would say it.
 *
 * An empty voice is a machine that has set none, which is the state a speech
 * ask is refused in — reachable here, and not by pressing anything on the
 * steps a spec walks.
 */
export async function setMachineVoice(voice: string): Promise<void> {
  const set = await fetch(`${APP}/api/v1/models/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speech: { voice } }),
  });
  if (!set.ok) {
    throw new Error(
      `setting the machine voice: ${set.status} ${await set.text()}`,
    );
  }
}

/** Words only, which is what a conversation asked of a card needs. */
export async function configureTextModel(model: string): Promise<void> {
  await configureModels([
    { id: model, capability: "text", alias: "Storyteller" },
  ]);
}

/**
 * A text model that is configured and holds no credential.
 *
 * What a reader who named a model and has not filled its key in yet has: the
 * ask reaches the model and is refused there, which is a failure the room has
 * to say in the reader's own words.
 */
export async function configureTextModelWithoutKey(
  model: string,
): Promise<void> {
  const put = await fetch(`${APP}/api/v1/models`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: model,
      category: "text",
      protocol: protocolOf("text"),
      url: endpoint("text"),
      model,
      displayName: "Storyteller",
      enabled: true,
    }),
  });
  if (!put.ok) {
    throw new Error(
      `configuring the model ${model}: ${put.status} ${await put.text()}`,
    );
  }
  // A write leaves a stored credential alone by design, and one server answers
  // the whole suite: the model this needs is one an earlier spec has already
  // given a key to, so the key goes by its own call — the only one that
  // removes one.
  const cleared = await fetch(`${APP}/api/v1/models/${model}/key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: null }),
  });
  if (!cleared.ok) {
    throw new Error(
      `clearing the key of ${model}: ${cleared.status} ${await cleared.text()}`,
    );
  }
  const patched = await fetch(`${APP}/api/v1/models/defaults`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: model }),
  });
  if (!patched.ok) {
    throw new Error(
      `defaulting the model ${model}: ${patched.status} ${await patched.text()}`,
    );
  }
}

/** A picture as well, for an ask that wants one put on the canvas. */
export async function configureWordsAndPictures(): Promise<void> {
  await configureModels([
    { id: PAINTER, capability: "image", alias: "Painter" },
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
  ]);
}

/**
 * Pictures, words, clips and sound: everything a telling is made of, up to the
 * point where the shots are filmed. Two sound capabilities, because a telling
 * asks two things of sound — a voice reads its lines and a composer writes the
 * music under them.
 */
export async function configureTheWholeStudio(): Promise<void> {
  await configureModels([
    { id: PAINTER, capability: "image", alias: "Painter" },
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
    { id: VIDEOGRAPHER, capability: "video", alias: "Videographer" },
    { id: SPEAKER, capability: "speech", alias: "Speaker" },
    {
      id: MUSICIAN,
      capability: "music",
      alias: "Musician",
      converter: "bailianMusic",
    },
  ]);
}

/** Which of the things a model is asked for. */
type Capability = "text" | "image" | "video" | "speech" | "music";
