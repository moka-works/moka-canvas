import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import {
  configureTextModel,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";

/** The project as the server has it written down, verbatim. */
async function projectText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    return await response.text();
  });
}

/**
 * A manuscript cut into chapters without changing a word of it.
 *
 * The room is asked only where the chapters begin; the text between those
 * places is the manuscript's own, and the document keeps a window into the
 * file rather than a second copy of the prose.
 */

test("a manuscript is cut at its own headings, and the words stay on the shelf", async ({
  page,
}) => {
  const home = projectHome("story-split");
  await configureTextModel("storyteller");
  await forgetProjects();
  await page.goto("/");
  await createProject(page, join(home, "project"), "Story Split");
  await openStoryRoom(page);
  await newStory(page, "Rain at Night");

  const manuscript = [
    "第一章 站台",
    "末班列车停在一个不该停的站台，车门开了，没有人上车。",
    "",
    "第二章 车厢",
    "车厢比站台更暗，两个人隔着一条过道坐着。",
    "",
  ].join("\n");

  try {
    await page.getByTestId("story-idea-tab-upload").click();
    await page.getByTestId("story-file").setInputFiles({
      name: "rain.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(manuscript, "utf8"),
    });
    await expect(page.getByTestId("story-source")).toBeVisible({
      timeout: 15_000,
    });

    // The words are copied into the project before any offsets are taken:
    // the manuscript the chapters point into is the project's own file, not
    // the one the reader picked, which an editor could change underneath it.
    const filedSource = async (): Promise<string> => {
      const filed = JSON.parse(await projectText(page)) as {
        moka?: {
          stories?: Array<{ brief?: { sourceAssetId?: string } }>;
          resources?: { texts?: Array<{ id: string; path: string }> };
        };
      };
      const sourceId = (filed.moka?.stories ?? [])[0]?.brief?.sourceAssetId;
      return (
        (filed.moka?.resources?.texts ?? []).find(
          (entry) => entry.id === sourceId,
        )?.path ?? ""
      );
    };
    await expect.poll(filedSource).toMatch(/^assets\/texts\//);
    expect(existsSync(join(home, "project", await filedSource()))).toBe(true);

    await page.getByTestId("story-confirm-idea").click();

    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-mode-split").click();

    // The manuscript writes its own chapters, and the step counts them.
    await expect(page.getByTestId("story-outline-chapters-hint")).toContainText(
      "2",
    );
    await page.getByTestId("story-outline-start").click();

    // The boundaries are found, and the chapters carry the manuscript's own
    // words under its own headings.
    await expect(page.getByTestId("story-chapter-0")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("story-chapter-1")).toBeVisible();
    await expect(page.getByTestId("story-chapter-title-0")).toHaveValue(
      "第一章 站台",
    );
    await expect(page.getByTestId("story-chapter-source-0")).toHaveValue(
      "末班列车停在一个不该停的站台，车门开了，没有人上车。",
    );
    await expect(page.getByTestId("story-chapter-source-1")).toHaveValue(
      "车厢比站台更暗，两个人隔着一条过道坐着。",
    );

    // The document keeps where the words are, not the words: a novel cut into
    // chapters does not double the project's save. The room saves in the
    // background, so the check waits for the story to have been written.
    await expect
      .poll(async () => {
        const body = JSON.parse(await projectText(page)) as {
          moka?: {
            stories?: Array<{
              chapters?: Array<{ source?: unknown }>;
              brief?: { sourceSplit?: boolean };
            }>;
          };
        };
        const story = (body.moka?.stories ?? [])[0];
        return [
          story?.chapters?.length ?? 0,
          story?.chapters?.every((chapter) => chapter.source !== undefined) ??
            false,
          story?.brief?.sourceSplit ?? false,
        ];
      })
      .toEqual([2, true, true]);

    const written = await projectText(page);
    expect(written).not.toContain("末班列车停在一个不该停的站台");
  } finally {
    forgetHome(home);
  }
});
