import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addNode,
  APP,
  configureTextModel,
  createProject,
  projectHome,
} from "./helpers";
import {
  PROVIDER_ORIGIN,
  providerCalls,
  SENTENCE,
  STORYTELLER,
} from "./mock-provider";

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  data: {
    content?: string;
    extension?: {
      outputs?: Record<string, { type: string; text?: string }[]>;
      bindings?: Record<string, string>;
    };
    resultSlots?: { id: string; text?: string; isPrimary: boolean }[];
  };
}

interface Served {
  root: string;
  moka: {
    metadata: { revision: number };
    canvas: {
      id: string;
      schemaVersion: number;
      nodes: ServedNode[];
      edges: { id: string; source: { nodeId: string; portId: string } }[];
    }[];
  };
}

async function served(): Promise<Served> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) throw new Error(`reading the project: ${response.status}`);
  return (await response.json()) as Served;
}

/** The extension node the menu inserted, whichever id it was given. */
function extensionNode(project: Served): ServedNode {
  const node = project.moka.canvas[0].nodes.find(
    (candidate) => candidate.kind === "extension",
  );
  if (!node) throw new Error("the extension node is not on the canvas");
  return node;
}

test("an installed extension node expands a text through its own model slot", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextModel(STORYTELLER);
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("extension-nodes"), "project"),
    "Extension Nodes",
  );

  // A text card to feed the extension. The node is selected when it is made,
  // so Enter opens the body editor the reader would use.
  const surface = page.getByTestId("canvas-surface");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  // A blank corner away from the card the menu just placed.
  const blank = {
    x: box!.x + box!.width * 0.85,
    y: box!.y + box!.height * 0.18,
  };

  await addNode(page, "Text");
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const body = page.getByLabel("Edit Text");
  await body.fill("A lighthouse at dusk");
  // Blur commits, which is what a reader clicking away does.
  await page.mouse.click(blank.x, blank.y);
  await expect
    .poll(
      async () => (await served()).moka.canvas[0].nodes[0]?.data.content ?? "",
    )
    .toBe("A lighthouse at dusk");

  // The menu reads the installed definitions on opening, so the built-in node
  // is offered without a restart.
  await page.mouse.dblclick(blank.x, blank.y);
  const menu = page.getByRole("menu", { name: "Add node" });
  await menu
    .getByRole("menuitem", { name: "Expand image prompt", exact: true })
    .click({ timeout: 10_000 });

  const section = page
    .locator(".inspector-section")
    .filter({ has: page.getByRole("heading", { name: "Extension node" }) });
  await expect(section).toBeVisible({ timeout: 10_000 });
  // The definition arrived from the directory endpoint, not from the document.
  await expect(section.getByText("Expand image prompt")).toBeVisible();
  await expect(section.getByText("Ready", { exact: true })).toBeVisible();

  // One slot, one model: the reader's choice is saved onto the node, and the
  // script never sees which protocol or endpoint stands behind it.
  await section.getByLabel("Writer").selectOption(STORYTELLER);
  await expect
    .poll(
      async () =>
        (await served()).moka.canvas[0].nodes.find(
          (node) => node.kind === "extension",
        )?.data.extension?.bindings,
    )
    .toEqual({ writer: STORYTELLER });

  // The upstream edge is written through the document pipeline, the way the
  // canvas writes one. The panel is what a reader uses; the wire is what this
  // test needs to get a value onto the port without dragging a Leafer port.
  const before = await served();
  const canvas = before.moka.canvas[0];
  const text = canvas.nodes.find((node) => node.kind === "text")!;
  const extension = extensionNode(before);
  const response = await fetch(`${APP}/api/v1/projects/current/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: before.moka.metadata.revision,
      commands: [
        {
          type: "addEdge",
          canvasId: canvas.id,
          edge: {
            id: "edge-extension",
            source: { nodeId: text.id, portId: "out" },
            target: { nodeId: extension.id, portId: "text" },
            createdAt: new Date().toISOString(),
          },
        },
      ],
    }),
  });
  expect(response.ok, await response.text()).toBe(true);

  await page.getByRole("button", { name: "Run this node" }).click();

  // The server writes the answer onto the node's port snapshot and its result
  // slots; the panel renders both.
  await expect
    .poll(
      async () =>
        (await served()).moka.canvas[0].nodes.find(
          (node) => node.kind === "extension",
        )?.data.extension?.outputs,
      { timeout: 30_000 },
    )
    .toEqual({
      prompt: [{ type: "text", text: SENTENCE }],
    });
  const written = extensionNode(await served());
  expect(written.data.resultSlots).toEqual([
    expect.objectContaining({ id: "prompt", text: SENTENCE, isPrimary: true }),
  ]);

  await expect(section.getByText(SENTENCE, { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    section.getByText(/expanded \d+ characters in photographic style/),
  ).toBeVisible();

  // One text call, carrying the input and the definition's own direction. The
  // slot's model name is a display name in the log, never the endpoint.
  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/v1/chat/completions");
  expect(calls[0].prompt).toContain("A lighthouse at dusk");
  expect(calls[0].prompt).toContain("photographic");
  expect(calls[0].model).toBe(STORYTELLER);
});
