import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  addNode,
  APP,
  configureModels,
  createProject,
  forgetHome,
  openRecent,
  persistedNodeCount,
  projectHome,
  showAssets,
} from "./helpers";
import { PROVIDER_ORIGIN, providerCalls } from "./mock-provider";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A recording of somebody's own, one second of sound in a real WAV.
 *
 * The shelf measures what it files, so the fixture is a file that can be
 * measured rather than bytes with the right header, and the converter down the
 * wire is handed the very same one.
 */
const RECORDING = readFileSync(join(HERE, "fixtures", "voice.wav"));

/** The speech model this spec configures: one that copies a recording. */
const CLONER = "clone-speaker";

interface ServedAsset {
  id: string;
  name: string;
  path: string;
}

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  data: Record<string, unknown>;
  ports: { id: string; direction: string; dataTypes: string[] }[];
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

/** The id the document filed a file under, whichever shelf it landed on. */
async function filedId(name: string): Promise<string> {
  const held = await served();
  for (const entries of Object.values(held.moka.resources)) {
    const found = entries.find((entry) => entry.name === name);
    if (found) return found.id;
  }
  return "";
}

/** Waits for the filing to land and answers the id it landed under. */
async function waitForFiled(name: string): Promise<string> {
  let found = "";
  await expect
    .poll(
      async () => {
        found = await filedId(name);
        return found !== "";
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return found;
}

/**
 * Writes a spec onto the project's only node.
 *
 * Through the command endpoint rather than through the page, so what a test
 * proves starts from a spec that exists rather than from the typing of one: the
 * panel that writes a spec is driven in generation.spec.ts.
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
 * Same walk as generation.spec.ts's helper, widened by the one kind that asks
 * for a voice: a speech node is an audio card asking for sound.
 */
async function openWithASpec(
  page: Page,
  name: string,
  directory: string,
  kind: "Image" | "Text" | "Audio",
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

/**
 * A read-aloud ask whose voice is copied from a recording, end to end.
 *
 * The model the spec configures declares that it reads a voice from a
 * recording, so an ask without one is refused before any provider is troubled
 * — and the refusal is asked for where a reader points at the failed card.
 * The recording is then brought in the way a reader brings one in — filed
 * through the shelf, pointed at from the card's own panel — and the same press
 * that was refused goes through with the recording in hand: what the stand-in
 * down the wire is handed is the file itself, not a name it could not copy.
 */
test("a read-aloud ask refused for a missing recording carries the one given", async ({
  page,
}) => {
  const home = projectHome("canvas-speech-reference");
  await configureModels([
    {
      id: CLONER,
      capability: "speech",
      alias: "Cloner",
      converter: "e2eCloneSpeech",
    },
  ]);
  // The stand-in's log carries across specs, so this one starts from an empty
  // one and — because story-dubbing.spec.ts reads the log whole and expects
  // only its own voices in it — leaves an empty one behind.
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  try {
    const nodeId = await openWithASpec(
      page,
      "Copied Voice",
      join(home, "project"),
      "Audio",
      {
        capability: "speech",
        mode: "generate",
        model: CLONER,
        prompt: "Read this in the recording's voice.",
        inputMode: "manual",
        params: {},
        referenceNodeIds: [],
      },
    );

    // A machine voice is set — the model was configured like any other — and
    // it is not what this ask needs: the converter copies a recording, and the
    // canvas holds none. The refusal comes before the provider is troubled.
    await page
      .getByRole("button", { name: "Run this node", exact: false })
      .click();
    await expect(page.getByText("Run did not finish")).toBeVisible({
      timeout: 20_000,
    });
    expect(await providerCalls(), "the refusal came first").toHaveLength(0);

    // The mark on the card is read by pointing at it, and the note says what
    // is missing in the words of the thing that knows — a reference recording.
    await page.keyboard.press("Escape");
    const surface = await page.getByTestId("canvas-surface").boundingBox();
    await page.mouse.move(
      surface!.x + surface!.width * 0.55,
      surface!.y + surface!.height * 0.5,
    );
    const note = page.getByTestId("run-note");
    await expect(note).toBeVisible({ timeout: 10_000 });
    await expect(note).toContainText("reference recording");

    // The repair, the way a reader does it: the recording is filed through the
    // shelf first, because the card's picker offers what the project holds and
    // has no door of its own for a file on this machine.
    await showAssets(page);
    await page.getByLabel("Import files", { exact: true }).setInputFiles({
      name: "voice.wav",
      mimeType: "audio/wav",
      buffer: RECORDING,
    });
    const recordingId = await waitForFiled("voice.wav");
    // Filing the file put a card of it on the canvas and chose it, so the
    // speech card is picked out again by pointing at where it stands: the
    // cards never overlap, and the speech card is where it was made.
    const again = await page.getByTestId("canvas-surface").boundingBox();
    await page.mouse.click(
      again!.x + again!.width * 0.55,
      again!.y + again!.height * 0.5,
    );
    await expect(
      page.getByRole("heading", { name: "Generation", exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Pointed at from the card's own panel: the picker offers what the shelf
    // holds, and what it adds is a list entry the ask reads.
    const bar = page.getByTestId("reference-bar");
    await bar.getByRole("button", { name: "From assets…" }).click();
    const picker = page.getByTestId("asset-picker");
    await expect(picker).toBeVisible();
    await picker.getByTestId(`asset-pick-${recordingId}`).check();
    await picker.getByRole("button", { name: "Add", exact: true }).click();
    await expect(picker).toHaveCount(0);

    // The list the run reads lives in the document, and the document is saved
    // on its own clock: wait for the server's copy to hold the recording
    // before the press, or the run would be served the copy without it.
    await expect
      .poll(
        async () => {
          const held = await served();
          const node = held.moka.canvas[0].nodes.find(
            (one) => one.id === nodeId,
          );
          const spec = node?.data.generation as
            { referenceNodeIds?: string[] } | undefined;
          return spec?.referenceNodeIds?.length ?? 0;
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    // The same press again, with the recording in hand: the ask goes out, and
    // what the provider is handed is the recording's own file.
    await page
      .getByRole("button", { name: "Run this node", exact: false })
      .click();
    await expect(page.getByText("Filed under Voice (1)")).toBeVisible({
      timeout: 20_000,
    });

    const calls = await providerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/v1/audio/speech");
    expect(calls[0].model).toBe(CLONER);
    expect(calls[0].prompt).toBe("Read this in the recording's voice.");
    expect(calls[0].credentialed, "a credential travelled").toBe(true);
    expect(
      calls[0].voice,
      "the recording travelled where a name would have been",
    ).toBe("ref:voice.wav");

    // And the node this was asked of is a card that can be given sound at all:
    // the input the recording is pointed at is part of the document itself.
    const after = await served();
    const spoken = after.moka.canvas[0].nodes.find((one) => one.id === nodeId);
    const intake = spoken?.ports.find(
      (port) => port.id === "audio" && port.direction === "input",
    );
    expect(intake?.dataTypes, "the sound input accepts sound").toContain(
      "audio",
    );
  } finally {
    await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
    forgetHome(home);
  }
});
