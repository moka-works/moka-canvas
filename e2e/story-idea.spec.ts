import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  contrastOf,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";

/**
 * The first step of a telling: the premise it is told from, and the four
 * settings every step after it is written with.
 *
 * What is written here is the document's — a premise typed and looked away
 * from, a frame and a running time clicked — and the step that comes next is
 * opened by the same press that writes the last of it. A manuscript can be
 * handed in instead, and what the document keeps of it is where it lies rather
 * than the prose itself.
 */

interface StorySnapshot {
  brief?: {
    idea?: string;
    totalDurationMs?: number;
    aspect?: string;
    sourceName?: string;
    sourceAssetId?: string;
  };
}

/** The project as the server has it written down, verbatim. */
async function projectJson(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    return await response.text();
  });
}

/** The first story of the open project, as the server has it written down. */
async function persistedStory(page: Page): Promise<StorySnapshot> {
  const body = JSON.parse(await projectJson(page)) as {
    moka?: { stories?: StorySnapshot[] };
  };
  return (body.moka?.stories ?? [])[0] ?? {};
}

/** A project open on a story standing at its first step. */
async function storyAtItsFirstStep(page: Page, name: string): Promise<string> {
  const home = projectHome("story-idea");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openStoryRoom(page);
  await newStory(page, "Rain at Night");
  return home;
}

test("a premise, a running time and a frame are written down, and the outline follows", async ({
  page,
}) => {
  const home = await storyAtItsFirstStep(page, "Story Idea");
  try {
    // Nothing to go on yet: the press says what it is waiting for rather than
    // walking on into an outline written from nothing.
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-confirm-gaps-idea")).toContainText(
      "The premise is not written yet",
    );
    await expect(page.getByTestId("story-step-outline")).toBeDisabled();

    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");

    // Looking away is what writes it: the box is a draft until then, and what
    // the document holds is what the server is sent.
    await page.getByTestId("story-idea-tab-upload").click();
    await page.getByTestId("story-idea-tab-write").click();
    await expect
      .poll(async () => (await persistedStory(page)).brief?.idea)
      .toBe("Eleven at night, and the last train stops where it should not.");

    // Both ways in are read as tabs, and the one that is open is read at all:
    // its words stand clear of the ground they are on, and which of the two is
    // open is said by the strip's underline rather than by filling that ground
    // in — a near-white fill under near-white words is a tab nobody can read.
    for (const tab of ["story-idea-tab-write", "story-idea-tab-upload"]) {
      await page.getByTestId(tab).click();
      await expect(page.getByTestId(tab)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(await contrastOf(page.getByTestId(tab))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
    await page.getByTestId("story-idea-tab-write").click();

    // Three minutes, and a frame that is told upright.
    await page.getByTestId("story-idea-duration-3").click();
    await expect(page.getByTestId("story-idea-duration")).toHaveValue("3");
    await expect(page.getByTestId("story-idea-duration-hint")).toHaveText(
      "About 3 chapters of a minute each; the film runs 03:00",
    );
    await page.getByTestId("story-idea-aspect-9:16").click();
    await expect(page.getByTestId("story-idea-aspect-hint")).toHaveText(
      "The finished film is 1080×1920",
    );

    // The head of the room carries the same two settings, which are what every
    // step after this one is written from.
    const chips = page.locator(".story-head-chips .story-chip");
    await expect(chips.nth(0)).toHaveText("03:00");
    await expect(chips.nth(1)).toHaveText("9:16 vertical");

    await page.getByTestId("story-confirm-idea").click();

    // The second step is standing, and the first is no longer shut: a story
    // with a premise has earned its outline.
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await expect(page.getByTestId("story-step-outline")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("story-step-outline")).toBeEnabled();

    await expect
      .poll(async () => {
        const brief = (await persistedStory(page)).brief;
        return [brief?.totalDurationMs, brief?.aspect];
      })
      .toEqual([180_000, "9:16"]);
  } finally {
    forgetHome(home);
  }
});

test("a manuscript is handed in, and the document keeps where it lies", async ({
  page,
}) => {
  const home = await storyAtItsFirstStep(page, "Story Manuscript");
  const manuscript = [
    "夜里十一点，末班列车停在一个不该停的站台。",
    "车门开了，没有人上车，也没有人下车。",
    "站台上的灯一盏一盏亮起来，照着一把没有人撑的伞。",
  ].join("\n");
  try {
    await page.getByTestId("story-idea-tab-upload").click();
    await page.getByTestId("story-file").setInputFiles({
      name: "rain.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(manuscript, "utf8"),
    });

    // The file is filed in the project's shelf, and the step says what it now
    // holds: the name it came under, and how much prose is in it.
    const source = page.getByTestId("story-source");
    await expect(source).toBeVisible({ timeout: 15_000 });
    await expect(source).toContainText("rain.txt");
    await expect(source).toContainText(`${manuscript.length} characters`);
    await page.getByTestId("story-source-peek-toggle").click();
    await expect(page.getByTestId("story-source-peek")).toHaveText(manuscript);

    // The document points at the manuscript rather than carrying it: a novel
    // written into the document would weigh on every save of the project.
    await expect
      .poll(async () => {
        const brief = (await persistedStory(page)).brief;
        return [brief?.sourceName, brief?.sourceAssetId !== ""];
      })
      .toEqual(["rain.txt", true]);
    expect(await projectJson(page)).not.toContain(
      "末班列车停在一个不该停的站台。",
    );
  } finally {
    forgetHome(home);
  }
});
