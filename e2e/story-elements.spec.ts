import { join } from "node:path";
import { expect, test, type Locator, type Page } from "./fixtures";
import {
  backToLauncher,
  configureWordsAndPictures,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openRecent,
  openStoryRoom,
  projectHome,
} from "./helpers";

/**
 * The third step: who and what the telling is made of.
 *
 * The chapters are read once for the cast they hold; each of them is described
 * and drawn, and the step's own press — the only agreement the step has — is
 * what opens the board behind it, once every one of them has a picture.
 */

/** The elements the server has written into the first story. */
async function persistedElements(
  page: Page,
): Promise<Array<{ name: string; described: boolean; drawn: boolean }>> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          elements?: {
            name?: string;
            description?: string;
            main?: { takes?: unknown[] };
          }[];
        }[];
      };
    };
    return (body.moka?.stories?.[0]?.elements ?? []).map((element) => ({
      name: element.name ?? "",
      described: (element.description ?? "") !== "",
      drawn: (element.main?.takes ?? []).length > 0,
    }));
  });
}

/** The card of one element, which is where its own pictures live. */
function card(page: Page, kind: string, name: string): Locator {
  return page.getByTestId(`story-element-${kind}-${name}`);
}

/**
 * Keeper's main drawing as the server holds it, and the shelf beside it: the
 * files the place keeps, oldest first, and every file the project still has.
 */
async function keeperMainAndShelf(
  page: Page,
): Promise<{ takes: string[]; images: string[] }> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        resources?: { images?: { id?: string }[] };
        stories?: {
          elements?: {
            name?: string;
            main?: { takes?: { assetIds?: string[] }[] };
          }[];
        }[];
      };
    };
    const element = (body.moka?.stories?.[0]?.elements ?? []).find(
      (each) => each.name === "Keeper",
    );
    return {
      takes: (element?.main?.takes ?? []).map(
        (take) => take.assetIds?.[0] ?? "",
      ),
      images: (body.moka?.resources?.images ?? []).map(
        (entry) => entry.id ?? "",
      ),
    };
  });
}

test("the chapters are read for their cast, drawn, and the step confirmed", async ({
  page,
}) => {
  const home = projectHome("story-elements");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Elements");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");

    // A premise, and the chapters it is told in.
    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.getByTestId("story-confirm-outline").click();

    // Step three: the cast is read out of the chapters, by the model the room
    // is set to — the deployment's default until a reader picks another.
    await page.getByTestId("story-step-elements").click();
    await expect(page.getByTestId("story-step-body-elements")).toBeVisible();
    await expect(page.getByTestId("story-elements-empty")).toBeVisible();
    await expect(page.getByTestId("story-model-text")).toBeVisible();
    await expect(
      page.getByTestId("story-model-text").getByRole("combobox"),
    ).toHaveValue("");
    // The pictures this step draws are asked of a model of their own, and the
    // batch they are asked in runs at a count the reader sets here.
    await expect(page.getByTestId("story-model-image")).toBeVisible();
    await expect(page.getByTestId("story-parallel")).toHaveValue("3");
    await page.getByTestId("story-parallel").selectOption("4");
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/v1/ui-prefs");
          const body = (await response.json()) as { storyParallel?: number };
          return body.storyParallel;
        }),
      )
      .toBe(4);
    await page.getByTestId("story-elements-recognise").click();

    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-description-Keeper",
      ),
    ).toHaveValue(/grey coat/);
    // Nobody has a picture yet, so the step's press says what it is missing
    // rather than opening the board: there is no agreement per element to give.
    await expect(page.getByTestId("story-elements-draw-all")).toHaveText(
      "Draw every missing picture (4)",
    );
    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-confirm-gaps-elements")).toContainText(
      "4 elements have no picture",
    );
    await expect(page.getByTestId("story-step-storyboard")).toBeDisabled();

    // Drawing them all is four asks of the painter, said out loud.
    await page.getByTestId("story-elements-draw-all").click();
    await expect(card(page, "character", "Keeper").locator("img")).toBeVisible({
      timeout: 60_000,
    });

    // A character is drawn with the four views as well, and only the two
    // characters need them.
    await expect(page.getByTestId("story-elements-views-all")).toHaveText(
      "Four views for every character (2)",
    );
    await page.getByTestId("story-elements-views-all").click();
    await expect(
      card(page, "character", "Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });

    // Every element described and drawn: the press settles the step and takes
    // the reader on to the board, which is now a door.
    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-step-body-storyboard")).toBeVisible();
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled();

    await expect
      .poll(async () => persistedElements(page))
      .toEqual([
        { name: "Keeper", described: true, drawn: true },
        { name: "Traveller", described: true, drawn: true },
        { name: "Last carriage", described: true, drawn: true },
        { name: "Old ticket", described: true, drawn: true },
      ]);
  } finally {
    forgetHome(home);
  }
});

test("the cast a reading left, and what the reader said since, outlast the room", async ({
  page,
}) => {
  const home = projectHome("story-elements-again");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Elements Again");
    await openStoryRoom(page);
    await newStory(page, "Rain at Night");
    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-idea-duration-3").click();
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();
    await page.getByTestId("story-outline-start").click();
    await expect(page.locator(".story-chapter")).toHaveCount(3, {
      timeout: 30_000,
    });
    await page.getByTestId("story-confirm-outline").click();

    // The cast, and a picture drawn for one of them.
    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-empty-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await card(page, "character", "Keeper")
      .getByTestId("story-slot-main-generate")
      .click();
    await expect(card(page, "character", "Keeper").locator("img")).toBeVisible({
      timeout: 60_000,
    });

    // Drawn again, which appends rather than replaces — and the older drawing
    // is thrown away from the list: out of the story, and off the shelf with
    // it. The drawing in use is not one to throw away, so it carries no ✕.
    await card(page, "character", "Keeper")
      .getByTestId("story-slot-main-again")
      .click();
    await expect(
      card(page, "character", "Keeper").getByTestId("story-slot-main-pick"),
    ).toBeVisible({ timeout: 60_000 });
    await card(page, "character", "Keeper")
      .getByTestId("story-slot-main-pick")
      .click();
    // The place holds both drawings, oldest first; the newest is the one it is
    // keeping, and the older one is the reader's to throw away.
    const drawn = await keeperMainAndShelf(page);
    const [unwanted, kept] = drawn.takes as [string, string];
    expect(unwanted).not.toBe(kept);
    await page.getByTestId(`story-pick-remove-${unwanted}`).click();
    await page.getByTestId("story-pick-remove-confirm").click();
    await expect(page.getByTestId(`story-pick-${unwanted}`)).toHaveCount(0);
    await expect(page.getByTestId(`story-pick-remove-${kept}`)).toHaveCount(0);

    await expect
      .poll(async () => (await keeperMainAndShelf(page)).takes)
      .toEqual([kept]);
    await expect
      .poll(async () =>
        (await keeperMainAndShelf(page)).images.includes(unwanted),
      )
      .toBe(false);

    // The ask stands until the file has been answered for, and only then is
    // there a list to walk out of.
    await expect(page.getByTestId("story-pick-ask")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("story-picks")).toHaveCount(0);

    // What the reader says to the cast by hand: one added, one taken out, and
    // a description of their own over the words the reading brought.
    await page.getByTestId("story-elements-add").click();
    await page.getByTestId("add-element-kind").selectOption("scene");
    await page.getByTestId("add-element-name").fill("Waiting room");
    await page
      .getByTestId("add-element-description")
      .fill("Nobody on the benches.");
    await page.getByTestId("add-element-confirm").click();
    await card(page, "prop", "Old ticket")
      .getByTestId("story-element-remove-Old ticket")
      .click();
    await page.getByTestId("remove-element-confirm").click();
    await card(page, "character", "Keeper")
      .getByTestId("story-element-description-Keeper")
      .fill("A woman in a long grey coat, slow to speak.");
    // The click that leaves the field is the write, and there is nothing else
    // for the reader to say about it: no element is agreed to one at a time.
    await page.getByTestId("story-elements-group-all").click();
    await expect
      .poll(async () => (await persistedElements(page))[0])
      .toEqual({ name: "Keeper", described: true, drawn: true });

    // Home and back in, which reads the same batches into the story a second
    // time: every one of them says its answer is already in, so none of it is
    // written over what the reader has said since.
    await backToLauncher(page);
    await openRecent(page, "Story Elements Again");
    await openStoryRoom(page);
    await page.getByTestId("story-step-elements").click();
    await expect(page.getByTestId("story-step-body-elements")).toBeVisible();

    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });
    await expect(
      card(page, "scene", "Waiting room").getByTestId(
        "story-element-description-Waiting room",
      ),
    ).toHaveValue("Nobody on the benches.");
    await expect(card(page, "prop", "Old ticket")).toHaveCount(0);
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-description-Keeper",
      ),
    ).toHaveValue("A woman in a long grey coat, slow to speak.");
    await expect(
      card(page, "character", "Keeper").locator("img"),
    ).toBeVisible();

    // And the server holds the same cast: the pictures that were drawn are
    // still the element's, and the one that was taken out is gone.
    await expect
      .poll(async () => persistedElements(page))
      .toEqual([
        { name: "Keeper", described: true, drawn: true },
        { name: "Traveller", described: true, drawn: false },
        { name: "Last carriage", described: true, drawn: false },
        { name: "Waiting room", described: true, drawn: false },
      ]);
  } finally {
    forgetHome(home);
  }
});
