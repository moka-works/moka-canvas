import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  APP,
  configureTextModel,
  createProject,
  forgetHome,
  newStory,
  openAssetsRoom,
  openClipRoom,
  projectHome,
} from "./helpers";
import { STORYTELLER } from "./mock-provider";

/**
 * The agent dock, driven by the stand-in's scripted tool turns.
 *
 * The marker in the question tells the stand-in to list the canvases and then
 * add a card — a real read and a real write through the same tool routes the
 * interface calls.
 */
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await configureTextModel(STORYTELLER);
});

interface ServedNode {
  title?: string;
  data?: { content?: string };
}

async function servedNodes(): Promise<ServedNode[]> {
  const response = await fetch(`${APP}/api/v1/projects/current`);
  const body = (await response.json()) as {
    moka?: { canvas?: { nodes?: ServedNode[] }[] };
  };
  return body.moka?.canvas?.[0]?.nodes ?? [];
}

test("the canvas assistant runs tool turns, adopts the change, and keeps the conversation", async ({
  page,
}) => {
  const home = projectHome("agent-canvas");
  await page.goto("/");
  await createProject(page, join(home, "project"), "Agent canvas");

  await page.getByTestId("right-tab-assistant").click();
  const dock = page.getByTestId("agent-dock");
  await expect(dock).toBeVisible();

  // The conversation can choose among the configured text models rather than
  // being pinned to the deployment's default.
  const model = dock.getByLabel("Model");
  await expect(model.locator('option[value="storyteller"]')).toHaveCount(1);
  await model.selectOption("storyteller");

  await dock.getByLabel("Ask the assistant…").fill("[agent] add a note");
  await dock.getByRole("button", { name: "Send" }).click();

  // Two tool calls, read then write, each recorded as its own card.
  await expect(dock.locator(".agent-tool-name")).toHaveCount(2, {
    timeout: 20_000,
  });
  await expect(dock.locator(".agent-tool-name").last()).toHaveText(
    "canvas.add_node",
  );
  await expect(dock.locator(".agent-line.is-assistant").last()).toContainText(
    "Added the note through the canvas tool.",
  );
  await expect(dock.getByText("Can be undone with Ctrl+Z")).toBeVisible();

  const nodes = await servedNodes();
  expect(nodes).toHaveLength(1);
  expect(nodes[0].title).toBe("From the agent");
  expect(nodes[0].data?.content).toBe("Written through a tool call.");

  const sessions = (await (
    await fetch(`${APP}/api/v1/agent/sessions`)
  ).json()) as { sessions: { id: string; messageCount: number }[] };
  expect(sessions.sessions).toHaveLength(1);
  expect(sessions.sessions[0].messageCount).toBeGreaterThanOrEqual(3);

  // A new conversation clears the dock; the old one is still in the list and
  // opens with its lines intact.
  await dock.getByRole("button", { name: "New conversation" }).click();
  await expect(dock.locator(".agent-line")).toHaveCount(0);
  await dock.getByRole("button", { name: "Conversations" }).click();
  await expect(dock.getByTestId("agent-sessions")).toBeVisible();
  await dock.locator(".agent-session-open").first().click();
  await expect(dock.locator(".agent-line.is-user")).toContainText(
    "[agent] add a note",
  );

  await dock.getByRole("button", { name: "Conversations" }).click();
  await dock.getByRole("button", { name: "Delete" }).first().click();
  await dock.getByRole("button", { name: "Delete?" }).click();
  await expect(dock.getByText("No conversations yet")).toBeVisible();

  forgetHome(home);
});

test("the cutting room and the shelf carry the assistant in their right column", async ({
  page,
}) => {
  const home = projectHome("agent-rooms");
  await page.goto("/");
  await createProject(page, join(home, "project"), "Agent rooms");

  await openClipRoom(page);
  const clipTabs = page.locator(".side-panel-tabs");
  await expect(clipTabs).toBeVisible();
  await clipTabs.getByRole("tab", { name: "Assistant" }).click();
  await expect(page.getByTestId("agent-dock")).toHaveAttribute(
    "data-room",
    "clip",
  );

  await openAssetsRoom(page);
  const assetTabs = page.locator(".side-panel-tabs");
  await expect(assetTabs).toBeVisible();
  await assetTabs.getByRole("tab", { name: "Assistant" }).click();
  await expect(page.getByTestId("agent-dock")).toHaveAttribute(
    "data-room",
    "assets",
  );

  forgetHome(home);
});

test("every story step ends with the assistant", async ({ page }) => {
  const home = projectHome("agent-story");
  await page.goto("/");
  await createProject(page, join(home, "project"), "Agent story", "Story");
  await newStory(page, "The lake");
  await page.locator(".story-row-name").filter({ hasText: "The lake" }).click();

  const dock = page.getByTestId("agent-dock");
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute("data-room", "story");

  // The dock is the last thing in the step body, below the confirm area; the
  // same mount follows every step the tab strip turns to.
  await expect(
    page.locator(".story-step-body [data-testid='agent-dock']"),
  ).toBeVisible();

  forgetHome(home);
});
