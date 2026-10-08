import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addNode,
  APP,
  configureTextModel,
  configureWordsAndPictures,
  createProject,
  openRecent,
  persistedNodeCount,
  projectHome,
} from "./helpers";
import {
  PAINTER,
  PROVIDER_ORIGIN,
  providerCalls,
  SENTENCE,
  STORYTELLER,
} from "./mock-provider";

interface ServedLine {
  role: string;
  text: string;
  references?: { nodeId: string; title: string; kind: string }[];
}

interface ServedSession {
  id: string;
  title: string;
  messages: ServedLine[];
}

/** The document as the server holds it, which is the only copy that counts. */
async function servedSessions(): Promise<ServedSession[]> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  const body = (await response.json()) as {
    moka?: { canvas?: { sessions?: ServedSession[] }[] };
  };
  return body.moka?.canvas?.[0]?.sessions ?? [];
}

interface ServedNode {
  id: string;
  kind: string;
  title: string;
  data?: {
    content?: string;
    assetId?: string;
    generation?: { prompt?: string };
  };
}

/** The cards the server holds, on the first canvas of the document. */
async function servedNodes(): Promise<ServedNode[]> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  const body = (await response.json()) as {
    moka?: { canvas?: { nodes?: ServedNode[] }[] };
  };
  return body.moka?.canvas?.[0]?.nodes ?? [];
}

/** The wires the server holds, on the first canvas of the document. */
async function servedEdges(): Promise<unknown[]> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  const body = (await response.json()) as {
    moka?: { canvas?: { edges?: unknown[] }[] };
  };
  return body.moka?.canvas?.[0]?.edges ?? [];
}

interface ServedImage {
  id: string;
  provenance?: {
    runId?: string;
    canvasId?: string;
    assistantSessionId?: string;
  };
}

/** The pictures the project has filed, and what each says it came from. */
async function servedImages(): Promise<ServedImage[]> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  const body = (await response.json()) as {
    moka?: { resources?: { images?: ServedImage[] } };
  };
  return body.moka?.resources?.images ?? [];
}

/**
 * Rewrites what a card was asked to make.
 *
 * Behind the page's back on purpose: asking a card again asks it for what the
 * card says, so a test that wants the second attempt to answer has to change the
 * asking rather than the answer.
 */
async function reaskTheCard(nodeId: string, prompt: string): Promise<void> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  if (!response.ok) {
    throw new Error(`reading the project: ${response.status}`);
  }
  const body = (await response.json()) as {
    moka: {
      metadata: { revision: number };
      canvas: { id: string; nodes: ServedNode[] }[];
    };
  };
  const canvas = body.moka.canvas[0];
  const card = canvas.nodes.find((node) => node.id === nodeId);
  const written = await fetch(`${APP}/api/v1/projects/current/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: body.moka.metadata.revision,
      commands: [
        {
          type: "updateNode",
          canvasId: canvas.id,
          nodeId,
          patch: {
            data: {
              ...card?.data,
              generation: {
                ...card?.data?.generation,
                prompt,
                updatedAt: new Date().toISOString(),
              },
            },
          },
        },
      ],
    }),
  });
  if (!written.ok) {
    throw new Error(`reasking the card: ${written.status}`);
  }
}

/**
 * Opens a project holding one text card that says something, and selects it.
 *
 * The words are written through the command endpoint rather than typed into the
 * card, so what is proved starts from a card that says something rather than
 * from the typing of one.
 */
async function openWithWords(
  page: Page,
  name: string,
  directory: string,
  words: string,
): Promise<void> {
  await page.goto("/");
  await createProject(page, directory, name);
  await addNode(page, "Text");
  await page.keyboard.press("Escape");
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(1);

  const before = await (await fetch(`${APP}/api/v1/projects/current`)).json();
  const document = before as {
    moka: {
      metadata: { revision: number };
      canvas: { id: string; nodes: { id: string }[] }[];
    };
  };
  const canvas = document.moka.canvas[0];
  const response = await fetch(`${APP}/api/v1/projects/current/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: document.moka.metadata.revision,
      commands: [
        {
          type: "updateNode",
          canvasId: canvas.id,
          nodeId: canvas.nodes[0].id,
          patch: { title: "Brief", data: { content: words } },
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`giving the card words: ${response.status}`);
  }

  await page.reload();
  await openRecent(page, name);
  await expect(
    page.getByRole("banner").getByText(name, { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // The canvas is a Leafer surface with nothing a locator can point at, and the
  // document holds exactly one card, so selecting everything selects it.
  await page.keyboard.press("Control+a");
}

function column(page: Page) {
  return page.getByTestId("assistant-panel");
}

test("the column beside the canvas turns over between its three faces", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("assistant-column"), "project"),
    "Three Faced Column",
  );

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const history = page.getByTestId("history-panel");
  await expect(inspector).toBeVisible();

  await page.getByRole("tab", { name: "Assistant" }).click();
  await expect(column(page)).toBeVisible();
  // One column rather than three: a canvas with all of them beside it has very
  // little of itself left to look at.
  await expect(inspector).not.toBeVisible();

  await page.getByRole("tab", { name: "History" }).click();
  await expect(history).toBeVisible();
  await expect(column(page)).not.toBeVisible();

  await page.getByRole("tab", { name: "Inspector" }).click();
  await expect(inspector).toBeVisible();
  await expect(history).not.toBeVisible();

  // The face already up stays up: the column is always beside the canvas, and
  // its tabs choose what it shows rather than whether it is there.
  await page.getByRole("tab", { name: "Inspector" }).click();
  await expect(inspector).toBeVisible();
});

test("a question asked over a card is answered and kept in the document", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextModel(STORYTELLER);

  const name = "Asked Over The Canvas";
  await openWithWords(
    page,
    name,
    join(projectHome("assistant-ask"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );

  await page.getByRole("tab", { name: "Assistant" }).click();
  await expect(column(page)).toBeVisible();
  await expect(page.getByTestId("assistant-about")).toHaveText("About 1 text");

  const asked = "What does the brief say?";
  await page.getByLabel("Ask about this canvas").fill(asked);
  await page.getByRole("button", { name: "Send: Ask" }).click();

  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
    { timeout: 15_000 },
  );
  await expect(page.locator(".assistant-line.is-user")).toContainText(asked);
  // What the card says travelled under the card's name, not as an id.
  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toContain("[Brief]");
  expect(calls[0].prompt).toContain(
    "A lantern floats over a quiet lake at dusk.",
  );
  expect(calls[0].prompt).toContain(asked);
  expect(calls[0].credentialed).toBe(true);

  // One turn, however many pieces it was shown in: one conversation holding two
  // lines, named after what was first asked.
  await expect.poll(servedSessions, { timeout: 10_000 }).toHaveLength(1);
  const held = (await servedSessions())[0];
  expect(held.title).toBe(asked);
  expect(held.messages.map((line) => line.role)).toEqual(["user", "assistant"]);
  expect(held.messages[1].text).toBe(SENTENCE);
  expect(held.messages[0].references).toEqual([
    expect.objectContaining({ title: "Brief", kind: "text" }),
  ]);

  // Carried by the document rather than by the panel that showed it.
  await page.reload();
  await openRecent(page, name);
  await page.getByRole("tab", { name: "Assistant" }).click();
  await expect(page.locator(".assistant-line.is-user")).toContainText(asked);
  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
  );
});

test("an answer goes back onto the canvas, over a card or as one of its own", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextModel(STORYTELLER);

  await openWithWords(
    page,
    "Answered Back On The Canvas",
    join(projectHome("assistant-file"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );
  await page.getByRole("tab", { name: "Assistant" }).click();
  await page
    .getByLabel("Ask about this canvas")
    .fill("What does the brief say?");
  await page.getByRole("button", { name: "Send: Ask" }).click();

  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
    { timeout: 15_000 },
  );

  // Named after the answer rather than after nothing, since a file called
  // "answer.txt" tells a reader nothing about which answer it holds.
  await expect(
    column(page).getByRole("link", { name: "Download" }),
  ).toHaveAttribute("download", `${SENTENCE}.txt`);

  // The card the question was about, chosen still, is the one offered to take
  // the words.
  await column(page).getByRole("button", { name: "Replace selection" }).click();
  await expect
    .poll(async () => (await servedNodes())[0]?.data?.content, {
      timeout: 10_000,
    })
    .toBe(SENTENCE);
  expect(await persistedNodeCount(page)).toBe(1);

  // And a card of its own, so the answer survives the card it was asked with.
  await column(page).getByRole("button", { name: "Insert on canvas" }).click();
  await expect
    .poll(() => persistedNodeCount(page), { timeout: 10_000 })
    .toBe(2);
  const laid = (await servedNodes()).find((node) => node.title === SENTENCE);
  expect(laid?.kind).toBe("text");
  expect(laid?.data?.content).toBe(SENTENCE);
});

test("a question already asked can be had back without asking it twice", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextModel(STORYTELLER);

  await openWithWords(
    page,
    "Asked Back Into The Field",
    join(projectHome("assistant-again"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );
  await page.getByRole("tab", { name: "Assistant" }).click();

  const asked = "What does the brief say?";
  const field = page.getByLabel("Ask about this canvas");
  await field.fill(asked);
  await page.getByRole("button", { name: "Send: Ask" }).click();
  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
    { timeout: 15_000 },
  );

  await page
    .locator(".assistant-line.is-user")
    .getByRole("button", { name: "Ask again" })
    .click();
  await expect(field).toHaveText(asked);
  // Having the words back is not an ask: nothing was sent and nothing was kept,
  // so the conversation is still the one turn it was.
  expect(await providerCalls()).toHaveLength(1);
  await expect
    .poll(async () => (await servedSessions())[0]?.messages.length, {
      timeout: 10_000,
    })
    .toBe(2);
});

test("a canvas holds several conversations, and reads the one it was pointed at", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureTextModel(STORYTELLER);

  const name = "Several Conversations";
  await openWithWords(
    page,
    name,
    join(projectHome("assistant-sessions"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );
  await page.getByRole("tab", { name: "Assistant" }).click();

  const first = "What does the brief say?";
  await page.getByLabel("Ask about this canvas").fill(first);
  await page.getByRole("button", { name: "Send: Ask" }).click();
  await expect(page.locator(".assistant-line.is-assistant")).toContainText(
    SENTENCE,
    { timeout: 15_000 },
  );

  // The answer is read as it arrives, so it is on the page while the turn is
  // still going. A conversation a turn opens becomes the one on show when that
  // turn lands, so the switch below waits for this one to be kept rather than
  // being undone by it a moment later.
  await expect.poll(servedSessions, { timeout: 10_000 }).toHaveLength(1);

  // A conversation kept is something to go back to rather than only to carry on,
  // so another can be opened beside it over the same cards.
  const listing = page.getByLabel("Conversation", { exact: true });
  await listing.selectOption({ label: "New conversation" });
  await expect(listing.locator("option:checked")).toHaveText(
    "New conversation",
  );
  await expect(
    column(page).getByText("A new conversation, nothing said in it yet"),
  ).toBeVisible();

  const second = "Is it dusk there?";
  await page.getByLabel("Ask about this canvas").fill(second);
  await page.getByRole("button", { name: "Send: Ask" }).click();
  await expect
    .poll(async () => (await servedSessions()).length, { timeout: 10_000 })
    .toBe(2);

  // Only the second is on show, which is what makes them two rather than one
  // run of asking.
  await expect(column(page).locator(".assistant-line.is-user")).toHaveCount(1);
  await expect(column(page).locator(".assistant-line.is-user")).toContainText(
    second,
  );

  const held = await servedSessions();
  const older = held.find((session) => session.title === first);
  if (!older) throw new Error(`The first conversation is not in ${held}`);

  // Read the first again, then name it something a list can be picked from.
  await listing.selectOption(older.id);
  await expect(column(page).locator(".assistant-line.is-user")).toContainText(
    first,
  );
  await column(page).getByRole("button", { name: "Rename" }).click();
  await page.getByTestId("assistant-session-rename").fill("The brief, asked");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await servedSessions()).find((session) => session.id === older.id)
          ?.title,
      { timeout: 10_000 },
    )
    .toBe("The brief, asked");

  // Carried by the document, and found again by when something was last said in
  // it: the reopened panel reads the second conversation, not the one left picked.
  const newest = (await servedSessions()).find(
    (session) => session.title === second,
  );
  if (!newest) throw new Error("The second conversation did not stay kept");

  await page.reload();
  await openRecent(page, name);
  await page.getByRole("tab", { name: "Assistant" }).click();
  await expect
    .poll(() => listing.inputValue(), { timeout: 10_000 })
    .toBe(newest.id);
  await expect(column(page).locator(".assistant-line.is-user")).toContainText(
    second,
  );
  // Named by what was first asked, in the order they were last talked in, with
  // the one not written yet beside them.
  await expect(listing.locator("option")).toHaveText([
    `${second} · 2 lines`,
    "The brief, asked · 2 lines",
    "New conversation",
  ]);
});

test("a conversation asked for a picture puts one on the canvas and files it", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureWordsAndPictures();

  const name = "Asked For A Picture";
  const seed = "A lantern floats over a quiet lake at dusk.";
  await openWithWords(
    page,
    name,
    join(projectHome("assistant-picture"), "project"),
    seed,
  );

  await page.getByRole("tab", { name: "Assistant" }).click();
  await column(page)
    .getByRole("button", { name: "Image", exact: true })
    .click();
  await expect(page.getByTestId("assistant-about")).toHaveText("About 1 text");

  const asked = "A poster of it, at dawn.";
  await page.getByLabel("Ask about this canvas").fill(asked);
  await page.getByRole("button", { name: "Send: Image" }).click();

  await expect
    .poll(() => servedNodes().then((nodes) => nodes.map((node) => node.kind)), {
      timeout: 20_000,
    })
    .toEqual(["text", "image"]);
  await expect(
    column(page).locator(".assistant-line.is-assistant"),
  ).toContainText("Made 1 image", { timeout: 20_000 });

  const calls = await providerCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].model).toBe(PAINTER);
  expect(calls[0].prompt).toContain(asked);
  // A card is asked through a run, so the card it was about feeds it over a wire
  // rather than as words quoted into the asking.
  expect(await servedEdges()).toHaveLength(1);
  expect(calls[0].prompt).toContain(seed);

  // Filed once, as its own asset.
  const picture = (await servedNodes())[1];
  const images = await servedImages();
  expect(images).toHaveLength(1);
  expect(picture.data?.assetId).toBe(images[0].id);

  // Saved on the page's own schedule, so the conversation is waited for rather
  // than assumed — and the asset points back at it once it has arrived.
  await expect
    .poll(async () => (await servedSessions())[0]?.messages.length ?? 0, {
      timeout: 10_000,
    })
    .toBe(2);
  const kept = (await servedSessions())[0];
  expect(kept.messages.map((line) => line.role)).toEqual(["user", "assistant"]);
  expect(kept.messages[1].text).toBe("Made 1 image");
  expect(images[0].provenance?.assistantSessionId).toBe(kept.id);
  expect(images[0].provenance?.runId).toBeTruthy();

  // Both ways out of the line that made something: the card, and the shelf it
  // was put on.
  const answer = column(page).locator(".assistant-line.is-assistant");
  await expect(
    answer.getByRole("button", { name: "Show on canvas" }),
  ).toBeVisible();
  await expect(
    answer.getByRole("button", { name: "Show in assets" }),
  ).toBeVisible();
});

test("a card whose making came back empty is asked again without a second one", async ({
  page,
}) => {
  await fetch(`${PROVIDER_ORIGIN}/__reset`, { method: "POST" });
  await configureWordsAndPictures();

  const name = "Asked Again";
  await openWithWords(
    page,
    name,
    join(projectHome("assistant-retry"), "project"),
    "A lantern floats over a quiet lake at dusk.",
  );

  await page.getByRole("tab", { name: "Assistant" }).click();
  await column(page)
    .getByRole("button", { name: "Image", exact: true })
    .click();
  await page
    .getByLabel("Ask about this canvas")
    .fill("[refuse] A poster of it, at dawn.");
  await page.getByRole("button", { name: "Send: Image" }).click();

  const again = page.getByRole("button", { name: "Ask the card again" });
  await expect(again).toBeVisible({ timeout: 20_000 });

  const cards = await servedNodes();
  const picture = cards.find((node) => node.kind === "image");
  if (!picture)
    throw new Error("The asked-for card did not stay on the canvas");
  expect(
    (await servedImages()).filter((image) => image.provenance?.runId),
  ).toHaveLength(0);

  // The asking is what was wrong, so that is what gets changed before the card
  // is asked a second time. Written behind the page's back, so it waits for the
  // page to have saved what it was holding: a stale write of its own would take
  // the conversation away with it.
  await expect
    .poll(async () => (await servedSessions())[0]?.messages.length ?? 0, {
      timeout: 10_000,
    })
    .toBe(2);
  await reaskTheCard(picture.id, "A poster of it, at dawn.");
  await page.reload();
  await openRecent(page, name);
  await page.getByRole("tab", { name: "Assistant" }).click();
  await expect(again).toBeVisible({ timeout: 10_000 });

  await page.on("dialog", (dialog) => dialog.accept());
  await again.click();

  await expect(
    column(page).locator(".assistant-line.is-assistant"),
  ).toContainText("Made 1 image", { timeout: 20_000 });

  // Paid for twice, but placed once: the same card holds the picture the second
  // attempt made.
  const after = await servedNodes();
  expect(after.map((node) => node.kind)).toEqual(["text", "image"]);
  expect(after[1].id).toBe(picture.id);
  expect(
    (await servedImages()).filter((image) => image.provenance?.runId),
  ).toHaveLength(1);
  // Counted as what was asked rather than as what the transport attempted: a
  // refused ask is knocked at more than once before it is given up on.
  const calls = await providerCalls();
  expect(calls.some((call) => call.prompt.startsWith("[refuse]"))).toBe(true);
  expect(
    calls.filter((call) => call.prompt.startsWith("A poster of it")),
  ).toHaveLength(1);
});
