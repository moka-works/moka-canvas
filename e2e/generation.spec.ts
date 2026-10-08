import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addNode,
  APP,
  CHANNEL_KEY,
  configureWordsAndPictures,
  createProject,
  openRecent,
  persistedNodeCount,
  projectHome,
  showAssets,
} from "./helpers";
import {
  PAINTER,
  PROVIDER_ADDRESS,
  PROVIDER_ORIGIN,
  providerCalls,
  SENTENCE,
  STORYTELLER,
} from "./mock-provider";

interface ServedAsset {
  id: string;
  name: string;
  path: string;
  provenance?: {
    runId?: string;
    operationNodeId?: string;
    inputAssetIds?: string[];
    parameterSnapshot?: Record<string, unknown>;
  };
}

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  data: Record<string, unknown>;
}

interface Served {
  root: string;
  moka: {
    metadata: { revision: number };
    canvas: { id: string; nodes: ServedNode[] }[];
    resources: Record<string, ServedAsset[]>;
  };
}

/** Fails with what the server said, which is the only way to see a refusal. */
async function settled(response: Response, what: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${what}: ${response.status} ${await response.text()}`);
  }
}

async function json(
  url: string,
  what: string,
  init?: { method: string; body: unknown },
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  await settled(response, what);
  return response;
}

/** The document as the server holds it, which is the only copy that counts. */
async function served(): Promise<Served> {
  const response = await json(
    `${APP}/api/v1/projects/current`,
    "reading the project",
  );
  return (await response.json()) as Served;
}

/**
 * Writes a spec onto the project's only node.
 *
 * Through the command endpoint rather than through the page, so what a test
 * proves starts from a spec that exists rather than from the typing of one. The
 * panel that writes a spec is driven in its own test below.
 */
async function giveTheNodeASpec(
  spec: Record<string, unknown>,
): Promise<string> {
  const before = await served();
  const canvas = before.moka.canvas[0];
  const node = canvas.nodes[0];
  await json(`${APP}/api/v1/projects/current/commands`, "writing the spec", {
    method: "POST",
    body: {
      expectedRevision: before.moka.metadata.revision,
      commands: [
        {
          type: "updateNode",
          canvasId: canvas.id,
          nodeId: node.id,
          // A data patch replaces the whole object, so whatever the node holds
          // already travels with the spec being added to it.
          patch: {
            data: {
              ...node.data,
              generation: { ...spec, updatedAt: new Date().toISOString() },
            },
          },
        },
      ],
    },
  });
  return node.id;
}

/**
 * Opens a project holding one node that asks for something, and selects it.
 *
 * The reload is not ceremony: the spec was written behind the page's back, so
 * the page is holding a revision that has moved on, and reopening is what a user
 * would do to see a document somebody else changed.
 */
async function openWithASpec(
  page: Page,
  name: string,
  directory: string,
  kind: "Image" | "Text",
  spec: Record<string, unknown>,
): Promise<string> {
  await page.goto("/");
  await createProject(page, directory, name);
  await addNode(page, kind);
  await page.keyboard.press("Escape");
  // Autosave is debounced, and a spec written against a revision the node has
  // not reached yet is refused.
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  const nodeId = await giveTheNodeASpec(spec);

  await page.reload();
  await openRecent(page, name);
  await expect(
    page.getByRole("banner").getByText(name, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // The canvas is a Leafer surface with nothing a locator can point at, and the
  // document holds exactly one node, so selecting everything selects it.
  await page.keyboard.press("Control+a");
  await expect(
    page.getByRole("heading", { name: "Generation", exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  return nodeId;
}

/** The value beside a label in the inspector, which is how a user reads it. */
async function inspected(page: Page, label: string): Promise<string> {
  const row = page
    .locator(".inspector-row")
    .filter({ has: page.locator("span", { hasText: label }) })
    .first();
  return ((await row.locator("span").nth(1).textContent()) ?? "").trim();
}

/**
 * The words shown under one of the inspector's headings.
 *
 * A node that both says something and asks for something shows two excerpts, so
 * which is being read has to be said rather than left to the order they render.
 */
function excerptUnder(page: Page, heading: string) {
  return page
    .locator(".inspector-section")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) })
    .locator(".inspector-text-excerpt");
}

test("an image node asks the provider and files the answer as its own asset", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureWordsAndPictures();

  const prompt = "A lantern drifting over a quiet lake.";
  const nodeId = await openWithASpec(
    page,
    "Generated Image",
    join(projectHome("generation-image"), "project"),
    "Image",
    {
      capability: "image",
      mode: "generate",
      model: PAINTER,
      prompt,
      inputMode: "manual",
      params: { size: "1024x1024", count: 1 },
      referenceNodeIds: [],
    },
  );

  // What it would ask for is readable before anything is asked.
  await expect(await inspected(page, "Capability")).toBe("Image");
  await expect(await inspected(page, "Model")).toBe(PAINTER);
  await expect(excerptUnder(page, "Prompt")).toHaveText(prompt);

  await page
    .getByRole("button", { name: "Run this node", exact: false })
    .click();
  // The toast names the shelf the answer landed on, which it can only do once
  // the asset is in the registry: waiting on it waits on the whole of the filing.
  await expect(page.getByText("Filed under Images (1)")).toBeVisible({
    timeout: 20_000,
  });

  // The answer is a resource of the project, and the shelf says which node made
  // it — the link back that makes a generated asset navigable. The shelf is the
  // assets face of the column beside the canvas, which opens on the tree.
  await showAssets(page);
  const origin = page.getByRole("button", { name: /which made/ });
  await expect(origin).toBeVisible({ timeout: 10_000 });

  const after = await served();
  const images = after.moka.resources.images;
  expect(images).toHaveLength(1);
  const asset = images[0];
  expect(asset.path).toMatch(/^assets\/images\//);

  const node = after.moka.canvas[0].nodes.find((one) => one.id === nodeId);
  expect(node?.data.assetId, "the node holds what it made").toBe(asset.id);
  expect(asset.provenance?.operationNodeId).toBe(nodeId);
  expect(asset.provenance?.runId, "the run that made it is named").toBeTruthy();
  // A snapshot travels inside an exported package, so it is the one place a
  // credential would leave the machine if it were ever recorded.
  expect(JSON.stringify(asset.provenance?.parameterSnapshot)).not.toContain(
    CHANNEL_KEY,
  );
  expect(JSON.stringify(asset.provenance?.parameterSnapshot)).not.toContain(
    PROVIDER_ADDRESS,
  );

  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/v1/images/generations");
  expect(calls[0].model).toBe(PAINTER);
  expect(calls[0].prompt).toBe(prompt);
  expect(calls[0].count).toBe(1);
  expect(calls[0].credentialed, "a credential travelled").toBe(true);

  // Asking again is a second generation of its own, not a replay of the first:
  // the stand-in is called once more and the project ends up holding both.
  await page
    .getByRole("button", {
      name: "Run again with the parameters of the last generation",
    })
    .click();
  await expect
    .poll(async () => (await providerCalls()).length, { timeout: 20_000 })
    .toBe(2);
  await expect
    .poll(async () => (await served()).moka.resources.images.length, {
      timeout: 10_000,
    })
    .toBe(2);
});

test("a text node keeps what the provider said, word for word", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureWordsAndPictures();

  const nodeId = await openWithASpec(
    page,
    "Generated Text",
    join(projectHome("generation-text"), "project"),
    "Text",
    {
      capability: "text",
      mode: "generate",
      model: STORYTELLER,
      prompt: "Say one sentence about a lantern on a lake.",
      inputMode: "manual",
      params: { temperature: 0.4 },
      referenceNodeIds: [],
    },
  );

  await page
    .getByRole("button", { name: "Run this node", exact: false })
    .click();
  // The words are filed like any other answer, and the toast says which shelf
  // they went to.
  await expect(page.getByText("Filed under Texts (1)")).toBeVisible({
    timeout: 20_000,
  });
  await expect(excerptUnder(page, "Content")).toContainText(SENTENCE, {
    timeout: 10_000,
  });

  const after = await served();
  const node = after.moka.canvas[0].nodes.find((one) => one.id === nodeId);
  expect(node?.data.content, "the node says what was said").toBe(SENTENCE);

  // The words are a file in the project like any other asset, and it holds
  // exactly them: nothing wraps, escapes, or truncates an answer on the way in.
  const texts = after.moka.resources.texts;
  expect(texts).toHaveLength(1);
  const written = readFileSync(join(after.root, texts[0].path), "utf8");
  expect(written).toBe(SENTENCE);
  // A text node's own asset field is for media it shows; the words it says are
  // filed too, and named by the slot holding the answer.
  const slots = node?.data.resultSlots as { assetId?: string }[] | undefined;
  expect(slots?.[0]?.assetId).toBe(texts[0].id);

  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe(STORYTELLER);
  expect(calls[0].credentialed).toBe(true);
});

test("a run that gave up leaves its mark, and its reason where pointed at", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureWordsAndPictures();

  await openWithASpec(
    page,
    "Refused Image",
    join(projectHome("generation-refused"), "project"),
    "Image",
    {
      capability: "image",
      mode: "generate",
      model: PAINTER,
      prompt: "Something the stand-in will not paint. [refuse]",
      inputMode: "manual",
      params: { size: "1024x1024", count: 1 },
      referenceNodeIds: [],
    },
  );

  await page
    .getByRole("button", { name: "Run this node", exact: false })
    .click();
  await expect(page.getByText("Run did not finish")).toBeVisible({
    timeout: 20_000,
  });

  // The card keeps what it held and gains a mark in its corner. The mark is too
  // small to carry the reason, so pointing at the card asks for it. The panel
  // that came up with the selection hangs over the card, and the note is read
  // by pointing at the card itself, so the panel goes away first.
  await page.keyboard.press("Escape");
  const surface = await page.getByTestId("canvas-surface").boundingBox();
  await page.mouse.move(
    surface!.x + surface!.width * 0.55,
    surface!.y + surface!.height * 0.5,
  );
  const note = page.getByTestId("run-note");
  await expect(note).toBeVisible({ timeout: 10_000 });
  await expect(note).toContainText("the stand-in will not paint that");
});

test("a node is asked from the panel under it, and one of several answers shown", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureWordsAndPictures();

  await page.goto("/");
  await createProject(
    page,
    join(projectHome("generation-panel"), "project"),
    "Asked From The Panel",
  );
  await addNode(page, "Image");

  // A node arrives from the quick-add menu selected and holding nothing, which
  // is the state its panel comes up in on its own: what it holds becomes the
  // whole ask. Enter takes the keyboard for the prompt that is already up.
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("prompt-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.getByLabel("Prompt for Image").fill("Three lanterns on a lake.");

  await panel.getByRole("tab", { name: "Parameter" }).click();
  const asked = panel.getByLabel("Images");
  await asked.fill("3");
  // A number is a choice when focus leaves the field, not while it is typed.
  await asked.press("Enter");

  await panel.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Filed under Images (3)")).toBeVisible({
    timeout: 20_000,
  });

  const after = await served();
  expect(after.moka.resources.images).toHaveLength(3);
  const nodes = after.moka.canvas[0].nodes;
  expect(nodes, "an answer past the first is given a card each").toHaveLength(
    3,
  );

  const holder = nodes.find(
    (one) => (one.data.resultNodeIds as string[] | undefined)?.length === 2,
  );
  expect(holder, "one node holds the batch").toBeTruthy();
  const slots = holder!.data.resultSlots as {
    assetId?: string;
    isPrimary?: boolean;
  }[];
  expect(slots).toHaveLength(3);
  expect(
    slots.filter((slot) => slot.isPrimary),
    "one of them is the one shown",
  ).toHaveLength(1);
  expect(holder!.data.assetId).toBe(slots[0].assetId);

  // Which of the three the node shows is a choice, and taking it writes the
  // document rather than only the view of it.
  await page
    .getByRole("button", { name: "Show result 3", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await served()).moka.canvas[0].nodes.find(
          (one) => one.id === holder!.id,
        )?.data.assetId,
      { timeout: 10_000 },
    )
    .toBe(slots[2].assetId);

  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].count, "the panel's own parameter travelled").toBe(3);
});

/** What the text node says before anything is asked of it. */
const BRIEF = "A lantern drifts over a quiet lake at dusk.";

test("what the preview shows is what the provider is handed", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureWordsAndPictures();

  const name = "Shown To The Provider";
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("generation-shown"), "project"),
    name,
  );
  await addNode(page, "Text");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  // The words are written through the command endpoint rather than typed, so
  // what is proved starts from a document that exists.
  const before = await served();
  const canvas = before.moka.canvas[0];
  const words = canvas.nodes[0];
  await json(`${APP}/api/v1/projects/current/commands`, "writing the words", {
    method: "POST",
    body: {
      expectedRevision: before.moka.metadata.revision,
      commands: [
        {
          type: "updateNode",
          canvasId: canvas.id,
          nodeId: words.id,
          patch: { data: { ...words.data, content: BRIEF } },
        },
      ],
    },
  });

  await page.reload();
  await openRecent(page, name);
  await expect(
    page.getByRole("banner").getByText(name, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // The canvas is a Leafer surface with nothing a locator can point at. One node
  // is on it, so selecting all selects it, and fitting the selection puts it
  // where a click can reach it.
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Shift+1");
  // Fitting is animated, so the node is still travelling when the key comes up
  // and a click aimed at the middle of the surface would land wherever it was.
  // The readout moves while the camera does and settles when it stops, which is
  // the only thing on the page that says so.
  const readout = page.locator(".zoom-readout");
  await expect
    .poll(
      async () => {
        const before = await readout.textContent();
        await page.waitForTimeout(200);
        return before === (await readout.textContent());
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const surface = await page.getByTestId("canvas-surface").boundingBox();
  expect(surface).not.toBeNull();
  const middle = {
    x: surface!.x + surface!.width / 2,
    y: surface!.y + surface!.height / 2,
  };
  // The panel that came up with the selection covers the card it belongs to,
  // and the menu is asked for on the card itself, so the panel goes away first.
  await page.keyboard.press("Escape");
  await page.mouse.click(middle.x, middle.y, { button: "right" });

  // Words are a place to start from: what is made of them is fed by them and
  // comes up with its own panel, and nothing has been asked for yet.
  await page.getByRole("menuitem", { name: "Image from these words" }).click();
  const panel = page.getByTestId("prompt-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(
    (await providerCalls()).length,
    "a choice from a menu spends nothing",
  ).toBe(0);

  await panel.getByRole("tab", { name: "Preview" }).click();
  const shown = panel.getByTestId("input-preview");
  await expect(shown).toContainText("[Text 1]", { timeout: 10_000 });
  await expect(shown).toContainText(BRIEF);
  const previewed =
    (await shown.locator(".prompt-panel-preview-text").textContent()) ?? "";
  expect(previewed, "the words upstream are folded in").toContain(BRIEF);

  await panel.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Filed under Images (1)")).toBeVisible({
    timeout: 20_000,
  });

  // The whole point of the preview: what it showed is what left the building,
  // character for character, with nothing added or dropped on the way.
  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/v1/images/generations");
  expect(calls[0].prompt).toBe(previewed);
});

test("a panel squeezed small keeps the prompt box clear of what stands under it", async ({
  page,
}) => {
  await configureWordsAndPictures();
  await page.goto("/");
  // The panel hangs under its node, and it is its own bottom corner that is
  // dragged, so the window has to be tall enough to hold that corner.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await createProject(
    page,
    join(projectHome("generation-squeezed"), "project"),
    "Squeezed Panel",
  );
  await addNode(page, "Image");
  const panel = page.getByTestId("prompt-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });

  // Dragged to its shortest by its own corner: the panel a reader makes room
  // with over a crowded canvas is one with hardly any room left inside it.
  const grip = await panel.locator(".prompt-panel-grip").boundingBox();
  if (!grip) throw new Error("the panel has no corner to drag");
  await page.mouse.move(grip.x + 3, grip.y + 3);
  await page.mouse.down();
  await page.mouse.move(grip.x + 3, grip.y - 400, { steps: 8 });
  await page.mouse.up();

  // The prompt box keeps to the room it was given: the words scroll inside it
  // and the control under it — the model the ask is sent to — is not written
  // over, however little room the panel has.
  const input = await panel
    .locator(".prompt-panel-prompt .prompt-panel-input")
    .boundingBox();
  const picker = await panel
    .locator(".prompt-panel-prompt select")
    .boundingBox();
  if (!input || !picker)
    throw new Error("the panel lost its field or its model");
  expect(input.y + input.height).toBeLessThanOrEqual(picker.y + 1);

  // And what does not fit is scrolled to rather than hidden: the panel's own
  // page is where the rest of the controls live.
  const crowded = await panel.locator(".prompt-panel-body").evaluate((body) => {
    const box = body as unknown as {
      scrollHeight: number;
      clientHeight: number;
    };
    return { scroll: box.scrollHeight, client: box.clientHeight };
  });
  expect(crowded.scroll).toBeGreaterThan(crowded.client);
});
