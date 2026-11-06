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
 * A manuscript cut into chapters, with each chapter's text kept in the story.
 *
 * The room is asked only where the chapters begin; the text between those
 * places becomes each chapter's own words, the uploaded file is released, and
 * the table is the reader's to edit, insert into, and prune.
 */

test("a manuscript is cut at its own headings, and its words move into the chapters", async ({
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

    // The upload is filed inside the project first: that copy is what the cut
    // is read from, and it is released once the chapters hold its words.
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
    const sourcePath = await filedSource();
    expect(existsSync(join(home, "project", sourcePath))).toBe(true);

    await page.getByTestId("story-confirm-idea").click();

    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-mode-split").click();

    // The manuscript's own divisions decide the count, so the step asks for a
    // cut rather than a number of chapters.
    await expect(page.getByTestId("story-outline-chapters")).toHaveCount(0);
    await expect(page.getByTestId("story-outline-will-ask")).toHaveText(
      "Cuts at the manuscript's own chapters",
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

    // The chapters keep the words themselves rather than offsets into the
    // manuscript, and the brief lets the file go. The room saves in the
    // background, so the check waits for the story to have been written.
    await expect
      .poll(async () => {
        const body = JSON.parse(await projectText(page)) as {
          moka?: {
            stories?: Array<{
              chapters?: Array<{ synopsis?: string }>;
              brief?: { sourceSplit?: boolean; sourceAssetId?: string };
            }>;
            resources?: { texts?: Array<{ path: string }> };
          };
        };
        const story = (body.moka?.stories ?? [])[0];
        return {
          chapters: story?.chapters?.length ?? 0,
          bodies: (story?.chapters ?? []).map((chapter) => chapter.synopsis),
          split: story?.brief?.sourceSplit ?? false,
          source: story?.brief?.sourceAssetId ?? null,
          filed: (body.moka?.resources?.texts ?? []).some(
            (entry) => entry.path === sourcePath,
          ),
        };
      })
      .toEqual({
        chapters: 2,
        bodies: [
          "末班列车停在一个不该停的站台，车门开了，没有人上车。",
          "车厢比站台更暗，两个人隔着一条过道坐着。",
        ],
        split: true,
        source: null,
        filed: false,
      });
    expect(existsSync(join(home, "project", sourcePath))).toBe(false);
    expect(await projectText(page)).toContain("末班列车停在一个不该停的站台");

    // A cut chapter is the reader's to rewrite: the edit lands on the chapter
    // itself rather than back in a manuscript window.
    await page.getByTestId("story-chapter-source-0").fill("改过的第一章。");
    await page.getByTestId("story-chapter-title-0").click();
    await expect
      .poll(async () => {
        const body = JSON.parse(await projectText(page)) as {
          moka?: {
            stories?: Array<{ chapters?: Array<{ synopsis?: string }> }>;
          };
        };
        return (body.moka?.stories ?? [])[0]?.chapters?.[0]?.synopsis ?? "";
      })
      .toBe("改过的第一章。");

    // A chapter can be put between two others and filled in like any other.
    await page.getByTestId("story-chapter-insert-0").click();
    await expect(page.getByTestId("story-chapter-2")).toBeVisible();
    await page.getByTestId("story-chapter-title-1").fill("插入章");
    await page.getByTestId("story-chapter-source-1").fill("插入的正文。");
    await page.getByTestId("story-chapter-title-0").click();

    // And one can be taken out after the question says what goes with it.
    await page.getByTestId("story-chapter-delete-2").click();
    await expect(page.getByTestId("delete-chapter")).toBeVisible();
    await page.getByTestId("delete-chapter-confirm").click();
    await expect(page.getByTestId("story-chapter-2")).toHaveCount(0);
    await expect
      .poll(async () => {
        const body = JSON.parse(await projectText(page)) as {
          moka?: {
            stories?: Array<{
              chapters?: Array<{ title?: string; synopsis?: string }>;
            }>;
          };
        };
        return ((body.moka?.stories ?? [])[0]?.chapters ?? []).map(
          (chapter) => [chapter.title, chapter.synopsis],
        );
      })
      .toEqual([
        ["第一章 站台", "改过的第一章。"],
        ["插入章", "插入的正文。"],
      ]);
  } finally {
    forgetHome(home);
  }
});
