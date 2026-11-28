import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "./fixtures";
import {
  backToLauncher,
  chooseSavePath,
  configureWordsAndPictures,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openSeededStory,
  projectHome,
} from "./helpers";

/**
 * Taking a cast to another project.
 *
 * The package is made from a telling that was drawn once: its cards' pictures
 * and recordings travel with the words, and the chapters the cards stood in do
 * not — those ids name chapters of the telling they came from, and an element
 * arriving in another telling stands in every chapter until its reader says
 * otherwise.
 */

interface Manifest {
  format: string;
  version: number;
  elements: Array<{ name: string; chapterIds?: unknown }>;
  assets: Array<{ id: string; name: string; file: string; mime?: string }>;
}

/** What the open telling holds, and every file the project has on its shelf. */
async function landedCast(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        resources?: Record<string, Array<{ id?: string; name?: string }>>;
        stories?: Array<{
          elements?: Array<{
            name?: string;
            chapterIds?: string[];
            main?: { takes?: Array<{ assetIds?: string[] }> };
            turnaround?: { takes?: Array<{ assetIds?: string[] }> };
            variants?: Array<{
              main?: { takes?: Array<{ assetIds?: string[] }> };
              turnaround?: { takes?: Array<{ assetIds?: string[] }> };
            }>;
            voice?: { referenceAssetId?: string };
            reference?: { kind?: string; assetId?: string };
          }>;
        }>;
      };
    };
    const elements = body.moka?.stories?.[0]?.elements ?? [];
    const resources = Object.values(body.moka?.resources ?? {}).flat();
    const held = new Set(resources.map((entry) => entry.id ?? ""));
    const ids: string[] = [];
    for (const element of elements) {
      const slots = [
        element.main,
        element.turnaround,
        ...(element.variants ?? []).flatMap((form) => [
          form.main,
          form.turnaround,
        ]),
      ];
      for (const slot of slots) {
        for (const take of slot?.takes ?? []) {
          ids.push(...(take.assetIds ?? []));
        }
      }
      if (element.voice?.referenceAssetId !== undefined) {
        ids.push(element.voice.referenceAssetId);
      }
      if (element.reference?.kind === "asset") {
        ids.push(element.reference.assetId ?? "");
      }
    }
    return {
      names: elements.map((element) => element.name ?? ""),
      chapters: elements.map((element) => element.chapterIds ?? ["?"]),
      assetIds: ids,
      missing: ids.filter((id) => !held.has(id)),
      shelfNames: resources.map((entry) => entry.name ?? ""),
    };
  });
}

test("a cast is exported as a zip and imported with its pictures", async ({
  page,
}) => {
  const home = projectHome("story-elements-transfer");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    // A telling whose cast was drawn once: its pictures are real files.
    await openSeededStory(page, home, true);
    await page.getByTestId("story-step-elements").click();
    await expect(page.getByTestId("story-step-body-elements")).toBeVisible();
    const exportLink = page.getByTestId("story-elements-export");
    await expect(exportLink).toBeEnabled({ timeout: 10_000 });
    await exportLink.click();
    const archive = await chooseSavePath(page, { name: "cast.zip" });
    await expect
      .poll(() => existsSync(archive), { timeout: 30_000 })
      .toBe(true);

    const zipped = unzipSync(new Uint8Array(readFileSync(archive)));
    const manifest = JSON.parse(
      strFromU8(zipped["moka-elements.json"] ?? new Uint8Array()),
    ) as Manifest;
    expect(manifest.format).toBe("moka.story.elements");
    expect(manifest.elements.length).toBeGreaterThan(0);
    expect(manifest.assets.length).toBeGreaterThan(0);
    for (const element of manifest.elements) {
      expect(element).not.toHaveProperty("chapterIds");
    }
    for (const asset of manifest.assets) {
      expect(zipped[asset.file]).toBeDefined();
    }

    // A project of its own, whose telling knows nothing of the first one.
    await backToLauncher(page);
    await createProject(page, join(home, "target"), "Element Import", "Story");
    await newStory(page, "Borrowed Cast");
    await page
      .getByTestId("story-idea-input")
      .fill("A borrowed cast stands on a borrowed platform.");
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.getByTestId("story-confirm-outline").click();
    await page.getByTestId("story-step-elements").click();
    await expect(page.getByTestId("story-step-body-elements")).toBeVisible();

    await page.getByTestId("story-elements-import-file").setInputFiles(archive);
    await expect
      .poll(async () => (await landedCast(page)).names.length, {
        timeout: 30_000,
      })
      .toBe(manifest.elements.length);

    const landed = await landedCast(page);
    expect(landed.names).toEqual(
      manifest.elements.map((element) => element.name),
    );
    for (const chapters of landed.chapters) expect(chapters).toEqual([]);
    expect(landed.missing).toEqual([]);
    for (const asset of manifest.assets) {
      expect(landed.shelfNames).toContain(asset.name);
    }
  } finally {
    forgetHome(home);
  }
});
