import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "./fixtures";
import {
  APP,
  createProject,
  persistedNodeCount,
  projectHome,
  showAssets,
} from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A picture 64 by 48, which is the shape every number below is worked out
 * against.
 *
 * A file of its own rather than bytes drawn at run time, so it can be opened and
 * looked at: what the server is handed is the same every time the suite runs, and
 * the sizes it reports can be asserted rather than merely believed.
 */
const PICTURE = readFileSync(join(HERE, "fixtures", "lantern.png"));
const SOURCE_NAME = "lantern.png";

interface ServedAsset {
  id: string;
  name: string;
  path: string;
  probe?: { width?: number; height?: number };
  provenance?: {
    runId?: string;
    operationNodeId?: string;
    inputAssetIds?: string[];
    parameterSnapshot?: Record<string, unknown>;
  };
}

interface ServedEdge {
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  data: { assetId?: string; [field: string]: unknown };
}

interface Served {
  root: string;
  moka: {
    metadata: { revision: number };
    canvas: { id: string; nodes: ServedNode[]; edges: ServedEdge[] }[];
    resources: Record<string, ServedAsset[]>;
  };
}

/** The document as the server holds it, which is the only copy that counts. */
async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  return (await response.json()) as Served;
}

/** The card a picture is shown on, if the canvas holds one. */
function cardFor(nodes: ServedNode[], assetId: string): ServedNode | undefined {
  return nodes.find((node) => node.data.assetId === assetId);
}

/**
 * Reads the document until a card exists for a picture that is not the subject,
 * and gives back the reading that saw it.
 *
 * Filing a picture writes the registry as it lands and the canvas a beat later,
 * so waiting on the file would read a document that has not caught up with it and
 * find no card to ask about.
 */
async function settledBeside(subjectId: string): Promise<Served> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const snapshot = await served();
    const made = snapshot.moka.resources.images.find(
      (entry) => entry.id !== subjectId,
    );
    if (made && cardFor(snapshot.moka.canvas[0]?.nodes ?? [], made.id)) {
      return snapshot;
    }
    if (Date.now() > deadline) {
      throw new Error("no card was ever made for the picture the tool filed");
    }
    await new Promise((rest) => setTimeout(rest, 100));
  }
}

/** The value the inspector shows beside a label, which is how a reader sees it. */
async function inspected(page: Page, label: string): Promise<string> {
  const row = page
    .locator(".inspector-row")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();
  return ((await row.locator("span").nth(1).textContent()) ?? "").trim();
}

/** The row of tools that works on the picture a single node holds. */
function toolBar(page: Page): Locator {
  return page.getByTestId("node-action-bar");
}

/**
 * Puts a picture into a project of its own, with the node holding it selected.
 *
 * An import makes the node as it lands, so there is nothing to add by hand and
 * nothing to wire: the picture is on the canvas the way a reader would put it
 * there before asking anything of it.
 */
async function openWithAPicture(page: Page, name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  await page.goto("/");
  await createProject(page, join(projectHome(slug), "project"), name);

  await showAssets(page);
  await page.getByLabel("Import files", { exact: true }).setInputFiles({
    name: SOURCE_NAME,
    mimeType: "image/png",
    buffer: PICTURE,
  });
  await page.keyboard.press("Escape");
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  // The canvas is a Leafer surface with nothing a locator can point at, and the
  // project holds one node, so selecting everything selects it.
  await page.keyboard.press("Control+a");
  await expect(toolBar(page)).toBeVisible({ timeout: 10_000 });

  const before = await served();
  expect(before.moka.resources.images).toHaveLength(1);
  return before.moka.resources.images[0].id;
}

/** Asks a picture for a cut, and waits until the dialog has measured it. */
async function openCrop(page: Page): Promise<Locator> {
  await toolBar(page)
    .getByRole("button", { name: "Crop", exact: true })
    .click();
  const dialog = page.getByTestId("picture-tool-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // The dialog measures the picture itself once it has loaded, and everything it
  // offers is worked out from those two numbers rather than from the node's size.
  await expect(dialog.getByText("64 × 48 pixels")).toBeVisible({
    timeout: 10_000,
  });
  return dialog;
}

test("a cut is filed beside the picture it came from, which is left as it is", async ({
  page,
}) => {
  const sourceId = await openWithAPicture(page, "Cut From A Picture");
  const dialog = await openCrop(page);

  // The largest square this picture holds, which is what a proportion asks for.
  // The region itself is worked out where the pixels are rather than here, so
  // what the browser sends is the proportion and what comes back is the cut.
  const square = dialog.getByRole("button", { name: "1:1", exact: true });
  await square.click();
  await expect(square).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Crop", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[role="status"]')).toContainText(
    /Made lantern-48x48/,
    { timeout: 10_000 },
  );

  const after = await settledBeside(sourceId);
  const images = after.moka.resources.images;
  expect(images, "the cut is filed beside its subject").toHaveLength(2);
  const source = images.find((entry) => entry.id === sourceId)!;
  const cut = images.find((entry) => entry.id !== sourceId)!;

  // The picture that was cut is the picture that was there: a tool files a new
  // one and never rewrites the one it was given.
  expect(source.probe).toMatchObject({ width: 64, height: 48 });
  expect(cut.probe, "the cut is the region that was asked for").toMatchObject({
    width: 48,
    height: 48,
  });
  expect(cut.name).toBe("lantern-48x48.png");

  // Both are files in the project, and the cut is one of its own rather than a
  // view of the first held in memory.
  expect(cut.path).toMatch(/^assets\/images\//);
  expect(existsSync(join(after.root, cut.path)), "the cut is on disk").toBe(
    true,
  );
  expect(readFileSync(join(after.root, cut.path)).length).toBeGreaterThan(0);

  const canvas = after.moka.canvas[0];
  const holder = cardFor(canvas.nodes, cut.id)!;
  expect(holder.title).toBe(cut.name);

  // And it is wired to what it came from, so the canvas says what the record says.
  const wire = canvas.edges.find((edge) => edge.target.nodeId === holder.id);
  expect(wire?.source.portId).toBe("out");
  expect(wire?.target.portId).toBe("images");
  const feeder = canvas.nodes.find((node) => node.id === wire!.source.nodeId)!;
  expect(feeder.data.assetId).toBe(sourceId);

  // What made it is recorded against it: the tool, the picture it worked on, and
  // no run — nothing was asked of anybody, so there is none to name.
  const provenance = cut.provenance!;
  expect(provenance.parameterSnapshot).toMatchObject({
    tool: "crop",
    sourceAssetId: sourceId,
  });
  expect(provenance.inputAssetIds).toEqual([sourceId]);
  expect(provenance.runId, "a tool starts no run").toBeUndefined();
  expect(provenance.operationNodeId).toBeUndefined();

  // Which is what the inspector then says: the tool in the word the row of tools
  // uses, and the source by name rather than by an identifier to look up.
  expect(await inspected(page, "Made by")).toBe("Crop");
  expect(await inspected(page, "From")).toBe(SOURCE_NAME);
  expect(await inspected(page, "Dimensions")).toBe("48×48");

  // One step of history holds the whole of it, so letting go takes the card and
  // the wire with it. The file stays filed: undoing a cut does not delete what
  // was made, it puts the canvas back to the cards it had.
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);
  expect((await served()).moka.resources.images).toHaveLength(2);
});

/**
 * The same picture asked for something it cannot give, which is the other half of
 * a tool being trustworthy: it says no here rather than handing back a guess, or
 * leaving the refusal to arrive as a failed request.
 */
test("a region outside the picture is refused before anything is asked", async ({
  page,
}) => {
  await openWithAPicture(page, "Refused Cut");
  const dialog = await openCrop(page);

  await dialog.getByRole("button", { name: "An exact region" }).click();
  await dialog.getByLabel("How wide").fill("65");
  await expect(dialog).toContainText(
    "A region is four whole numbers inside the picture, which is 64 by 48",
  );
  await expect(
    dialog.getByRole("button", { name: "Crop", exact: true }),
  ).toBeDisabled();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // Nothing was filed for an ask that was never sent.
  expect((await served()).moka.resources.images).toHaveLength(1);
  expect(await persistedNodeCount(page)).toBe(1);
});
