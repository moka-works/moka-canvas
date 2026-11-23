import { join } from "node:path";
import { expect, test, type Locator, type Page } from "./fixtures";
import {
  backToLauncher,
  configureModels,
  configureWordsAndPictures,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openRecent,
  openStoryRoom,
  projectHome,
} from "./helpers";
import { SENTENCE, STORYTELLER, providerCalls } from "./mock-provider";

/**
 * The third step: who and what the telling is made of.
 *
 * The chapters are read once for the cast they hold; each of them is described
 * and drawn, and the step's own press — the only agreement the step has — is
 * what opens the board behind it. Pictures are not owed by the press: a cast
 * settled on its words opens the board with placeholders standing in for the
 * drawings still to come.
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
      .fill("The keeper changes into a blue coat in the second chapter.");
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
    await expect(page.getByTestId("story-model-text-toggle")).toContainText(
      "Settings default",
    );
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
    // The cast is narrowed by name, and a search that finds nothing says so.
    const search = page.getByTestId("story-elements-search");
    await search.fill("Old");
    await expect(page.locator(".story-element")).toHaveCount(1);
    await expect(card(page, "prop", "Old ticket")).toBeVisible();
    await search.fill("nothing here");
    await expect(page.getByTestId("story-elements-search-empty")).toBeVisible();
    await search.fill("");
    await expect(page.locator(".story-element")).toHaveCount(4);
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-description-Keeper",
      ),
    ).toHaveValue(/grey coat/);
    const keeperForm = card(page, "character", "Keeper").getByTestId(
      "story-element-form-Keeper",
    );
    await keeperForm.selectOption({ label: "Blue coat" });
    await expect(
      card(page, "character", "Keeper").getByTestId(
        "story-element-description-Keeper",
      ),
    ).toHaveValue(/blue coat, black trousers and black shoes/);
    await keeperForm.selectOption("");
    // A prop's quick press asks for the props alone, and four views belong to
    // characters, so the group of things offers no such press.
    await page.getByTestId("story-elements-group-prop").click();
    await expect(page.getByTestId("story-elements-draw-all")).toHaveText(
      "Draw every missing picture (1)",
    );
    await expect(page.getByTestId("story-elements-views-all")).toHaveCount(0);
    await page.getByTestId("story-elements-select-all").click();
    await expect(page.getByTestId("story-bulk")).toContainText("1 chosen");
    await page.getByTestId("story-bulk-clear").click();
    await page.getByTestId("story-elements-group-all").click();

    // A thing may be drawn in a frame of its own; the chosen cards may be
    // given one picture model together.
    await card(page, "prop", "Old ticket")
      .getByTestId("story-element-ratio-Old ticket")
      .selectOption("9:16");
    await card(page, "prop", "Old ticket")
      .getByTestId("story-element-select-Old ticket")
      .check();
    await card(page, "character", "Keeper")
      .getByTestId("story-element-select-Keeper")
      .check();
    await expect(page.getByTestId("story-bulk")).toContainText("2 chosen");
    await page.getByTestId("story-bulk-action").selectOption("model");
    await page
      .getByTestId("story-bulk-model")
      .selectOption({ label: "Painter" });
    await expect(page.getByTestId("story-bulk")).toHaveCount(0);
    await expect(
      card(page, "character", "Keeper")
        .getByTestId("story-element-model-Keeper")
        .getByRole("combobox"),
    ).not.toHaveValue("");

    // The second coat is a form of Keeper, so five forms need pictures while
    // the cast still holds four elements.
    await expect(page.getByTestId("story-elements-draw-all")).toHaveText(
      "Draw every missing picture (5)",
    );

    // A picture is not what the step owes: with every element described the
    // press settles the step at once, and the board behind it opens.
    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-step-body-storyboard")).toBeVisible();
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled();

    // The board is written with no picture drawn yet, and each reference it
    // carries stands in with its own kind's placeholder: a character in a
    // shot's row, a place in the act's cast.
    await page.getByTestId("story-board-generate").click();
    await expect(page.getByTestId("story-act-0")).toBeVisible({
      timeout: 60_000,
    });
    const characterStandIn = page
      .locator('.story-ref-thumb img[src="/story/element-character.svg"]')
      .first();
    await expect(characterStandIn).toBeVisible();
    // The picture is really served, not merely named.
    await expect
      .poll(() =>
        characterStandIn.evaluate(
          (picture) => (picture as HTMLImageElement).naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
    await expect(
      page.locator('.story-ref-avatar[src="/story/element-scene.svg"]').first(),
    ).toBeVisible();

    // Back on the cast, the pictures can still be drawn — and drawn now, they
    // are what the step shows the next time it is read.
    await page.getByTestId("story-step-elements").click();
    await expect(page.getByTestId("story-step-body-elements")).toBeVisible();

    // Drawing them all includes the second coat as a separate generation.
    await page.getByTestId("story-elements-draw-all").click();
    await expect(card(page, "character", "Keeper").locator("img")).toBeVisible({
      timeout: 60_000,
    });

    // Each character form gets its own four-view sheet, including the blue coat.
    await expect(page.getByTestId("story-elements-views-all")).toHaveText(
      "Four views for every character (3)",
    );
    await page.getByTestId("story-elements-views-all").click();
    await expect(
      card(page, "character", "Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    const calls = await providerCalls();
    expect(
      calls.some(
        (call) =>
          call.prompt.includes("approximately 16:9 horizontal landscape") &&
          call.prompt.includes("left approximately 2/5 (40%)") &&
          call.prompt.includes("right approximately 3/5 (60%)"),
      ),
    ).toBe(true);

    // Every element described and drawn: the press reads the finished cast and
    // takes the reader on to the board again.
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

    // A picture may come from the project's own shelf rather than a model...
    const ticket = card(page, "prop", "Old ticket");
    await ticket.getByTestId("story-slot-main-library").click();
    const library = page.getByTestId("story-library");
    await expect(library).toBeVisible();
    // The tiles are the pictures on the shelf: the dialog's own search box and
    // its notices share the shelf's name, so the tile is named rather than the
    // first thing under it.
    await library.locator(".story-pick").first().click();
    await expect(
      ticket.getByTestId("story-slot-main").locator("img"),
    ).toBeVisible();

    // ...or from a file on this computer, which is filed on the shelf first.
    await ticket.getByTestId("story-slot-main-upload-input").setInputFiles({
      name: "ticket.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(ticket.getByTestId("story-slot-main-pick")).toBeVisible({
      timeout: 60_000,
    });

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

/**
 * An element's picture, rewritten for the model's contract before it is drawn.
 *
 * The card's own picture dialog shows the whole ask, the text model may be
 * asked to rewrite it, and the reader's press draws with the words shown.
 */
test("an element's picture prompt is rewritten before it is drawn", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const home = projectHome("story-element-prompt-rewrite");
  await forgetProjects();
  await configureWordsAndPictures();
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Element Prompt");
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
    await page.getByTestId("story-step-elements").click();
    await page.getByTestId("story-elements-empty-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });

    const keeper = card(page, "character", "Keeper");
    await keeper.getByTestId("story-slot-image-prompt-main").click();
    const dialog = page.getByTestId("story-image-prompt-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("story-image-prompt-rewrite").click();
    await expect(dialog.getByTestId("story-image-prompt-text")).toHaveValue(
      SENTENCE,
      { timeout: 30_000 },
    );

    await dialog.getByTestId("story-image-prompt-draw").click();
    await expect
      .poll(
        async () =>
          (await providerCalls())
            .filter((call) => call.path.startsWith("/v1/images/"))
            .at(-1)?.prompt,
        { timeout: 60_000 },
      )
      .toBe(SENTENCE);
  } finally {
    forgetHome(home);
  }
});

/**
 * A place that is asked of several models.
 *
 * A step's picker keeps a list rather than one value, in the order the asks
 * take turns; the machine keeps that list so the next window opens with the
 * same rotation.
 */
test("a step's models are ticked into a rotation", async ({ page }) => {
  const home = projectHome("story-model-rotation");
  await forgetProjects();
  await configureModels([
    { id: STORYTELLER, capability: "text", alias: "Storyteller" },
    { id: "storyteller-two", capability: "text", alias: "Storyteller Two" },
  ]);
  try {
    await page.goto("/");
    await createProject(page, join(home, "project"), "Story Model Turns");
    await openStoryRoom(page);
    await newStory(page, "Turns");
    await page
      .getByTestId("story-idea-input")
      .fill("Eleven at night, and the last train stops where it should not.");
    await page.getByTestId("story-confirm-idea").click();
    await expect(page.getByTestId("story-step-body-outline")).toBeVisible();

    await page.getByTestId("story-model-text-toggle").click();
    await page.getByTestId("story-model-text-option-storyteller").check();
    await page.getByTestId("story-model-text-option-storyteller-two").check();
    await expect(page.getByTestId("story-model-text-toggle")).toContainText(
      "Storyteller / Storyteller Two",
    );
    await expect(page.getByTestId("story-model-text-count")).toHaveText(
      "2 in rotation",
    );
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/v1/ui-prefs");
          const body = (await response.json()) as {
            storyModels?: Record<string, string[]>;
          };
          return body.storyModels?.text;
        }),
      )
      .toEqual(["storyteller", "storyteller-two"]);
  } finally {
    forgetHome(home);
  }
});
