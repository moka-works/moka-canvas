import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";
import {
  configureTheWholeStudio,
  createProject,
  forgetHome,
  forgetProjects,
  newStory,
  openStoryRoom,
  projectHome,
} from "./helpers";

// The whole telling is walked in one test — five steps, every ask through a
// stand-in — which needs longer than the suite's own budget for one case.
test.describe.configure({ timeout: 60_000 });

/**
 * The fourth step: one episode's board, its frames and its clip.
 *
 * A whole telling is taken as far as the board the last step needs: the premise
 * becomes chapters, the chapters become a cast, the cast is drawn and the step
 * confirmed, and then one episode is boarded, framed, and filmed.
 */

/** What the server holds of the first story's first act. */
async function persistedBoard(page: Page): Promise<{
  acts: number;
  titles: string[];
  frames: number;
  contents: string[];
  drawn: number;
  clips: number;
  bridges: Array<{
    prompt?: string;
    durationMs?: number;
    frameSource?: string;
  }>;
}> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        stories?: {
          chapters?: {
            acts?: {
              title?: string;
              transition?: {
                prompt?: string;
                durationMs?: number;
                frameSource?: string;
              };
              keyframes?: { content?: string; art?: { takes?: unknown[] } }[];
              video?: { takes?: unknown[] };
            }[];
          }[];
        }[];
      };
    };
    const acts = (body.moka?.stories?.[0]?.chapters ?? []).flatMap(
      (chapter) => chapter.acts ?? [],
    );
    return {
      acts: acts.length,
      titles: acts.map((act) => act.title ?? ""),
      frames: acts.flatMap((act) => act.keyframes ?? []).length,
      contents: acts.flatMap((act) =>
        (act.keyframes ?? []).map((keyframe) => keyframe.content ?? ""),
      ),
      drawn: acts
        .flatMap((act) => act.keyframes ?? [])
        .filter((keyframe) => (keyframe.art?.takes ?? []).length > 0).length,
      clips: acts.filter((act) => (act.video?.takes ?? []).length > 0).length,
      bridges: acts
        .filter((act) => act.transition !== undefined)
        .map((act) => act.transition ?? {}),
    };
  });
}

/**
 * The telling walked as far as its first episode's board: the premise, the
 * chapters it is told in, the cast drawn and the step confirmed, and then the
 * board written.
 */
async function toTheBoard(
  page: Page,
  home: string,
  name: string,
): Promise<void> {
  await page.goto("/");
  await createProject(page, join(home, "project"), name);
  await openStoryRoom(page);
  await newStory(page, "Rain at Night");

  {
    // A premise, the chapters it is told in, and the cast they hold.
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
    await page.getByTestId("story-elements-recognise").click();
    await expect(page.locator(".story-element")).toHaveCount(4, {
      timeout: 30_000,
    });

    // A character takes a second form: the card's picker manages the forms,
    // and a new form starts out made from the element's default form.
    const keeper = page.getByTestId("story-element-character-Keeper");
    await keeper
      .getByTestId("story-element-form-Keeper")
      .selectOption("__manage__");
    await page.getByTestId("story-element-form-name").fill("老年");
    await page.getByTestId("story-element-form-add").click();
    await page.getByTestId("story-element-forms-close").click();
    await expect(
      keeper.getByTestId("story-element-form-Keeper").locator("option:checked"),
    ).toHaveText("老年");
    await expect(
      keeper.getByTestId("story-element-reference-Keeper"),
    ).toContainText("Keeper");
    await expect(page.getByTestId("story-elements-counts")).toContainText(
      "3 characters",
    );

    await page.getByTestId("story-elements-draw-all").click();
    await expect(page.getByTestId("story-elements-views-all")).toBeEnabled({
      timeout: 60_000,
    });
    await page.getByTestId("story-elements-views-all").click();
    // The four views have to be back before the step settles: an element drawn
    // only halfway is an element whose views are not part of the answer, and
    // the press reads the document rather than the spinners.
    await expect(
      page
        .getByTestId("story-element-character-Keeper")
        .getByTestId("story-slot-turnaround")
        .locator("img"),
    ).toBeVisible({ timeout: 60_000 });

    // A form's main drawing may be made from another element's picture, or
    // from a file on the shelf; the one named is what the row says.
    await keeper.getByTestId("story-element-reference-pick-Keeper").click();
    await page
      .getByTestId("story-reference-picker")
      .locator(".story-pick")
      .filter({ hasText: "Last carriage" })
      .click();
    await expect(
      keeper.getByTestId("story-element-reference-Keeper"),
    ).toContainText("Last carriage");
    await keeper.getByTestId("story-element-reference-pick-Keeper").click();
    await page
      .getByTestId("story-reference-picker")
      .locator('[data-testid^="story-reference-asset-"]')
      .first()
      .click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/v1/projects/current");
          const body = (await response.json()) as {
            moka?: {
              stories?: {
                elements?: {
                  name?: string;
                  variants?: {
                    name?: string;
                    reference?: { kind?: string };
                  }[];
                }[];
              }[];
            };
          };
          const hero = (body.moka?.stories?.[0]?.elements ?? []).find(
            (element) => element.name === "Keeper",
          );
          return (
            hero?.variants?.find((variant) => variant.name === "老年")
              ?.reference?.kind ?? ""
          );
        }),
      )
      .toBe("asset");

    await page.getByTestId("story-confirm-elements").click();
    await expect(page.getByTestId("story-step-storyboard")).toBeEnabled({
      timeout: 30_000,
    });

    // Step four: the episode the room opens on is boarded.
    await page.getByTestId("story-step-storyboard").click();
    await expect(page.getByTestId("story-step-body-storyboard")).toBeVisible();
    await expect(page.getByTestId("story-board-empty")).toBeVisible();
    await page.getByTestId("story-board-generate").click();
  }
}

test("an episode is boarded, framed, and filmed", async ({ page }) => {
  const home = projectHome("story-storyboard");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    await toTheBoard(page, home, "Story Board");

    // Every act of the board stands on the page at once, and a row's name is
    // its place within its own act — so each card is looked at on its own.
    const firstAct = page.getByTestId("story-act-0");
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("story-act-1")).toBeVisible();
    await expect(firstAct.getByTestId("story-kf-0")).toBeVisible();

    // The pictures a shot stands on are the board's to look at: an element's
    // reference opens over the board, and the kept picture can be changed
    // rather than only drawn again.
    await expect(firstAct.getByTestId("story-kf-extras-0")).toBeVisible();
    await firstAct.getByTestId("story-ref-view-Keeper").click();
    await expect(page.getByTestId("story-picture-inspector")).toBeVisible();
    await page.getByTestId("story-inspector-edit").click();
    await expect(page.getByTestId("story-edit-dialog")).toBeVisible();
    // The dialog's words come from the catalogue rather than standing as raw
    // keys: the picture-edit copy is a section of its own.
    const editDialog = page.getByTestId("story-edit-dialog");
    await expect(editDialog.getByRole("heading")).toHaveText("Edit Keeper");
    await expect(editDialog.getByText("What to change")).toBeVisible();
    await page
      .getByTestId("story-edit-dialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await page.getByTestId("story-inspector-close").click();

    // A shot's reference can be switched to another form of the element; the
    // choice is written on the shot, so the next frame is drawn with it.
    await firstAct.getByTestId("story-kf-ref-0-0").click();
    await expect(page.getByTestId("story-inspector-form")).toBeVisible();
    await page
      .getByTestId("story-inspector-form")
      .selectOption({ label: "老年" });
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/v1/projects/current");
          const body = (await response.json()) as {
            moka?: {
              stories?: {
                elements?: {
                  name?: string;
                  id?: string;
                  variants?: { id?: string; name?: string }[];
                }[];
                chapters?: {
                  acts?: {
                    keyframes?: {
                      variantChoices?: Record<string, string>;
                    }[];
                  }[];
                }[];
              }[];
            };
          };
          const story = body.moka?.stories?.[0];
          const hero = story?.elements?.find(
            (element) => element.name === "Keeper",
          );
          const frame = story?.chapters?.[0]?.acts?.[0]?.keyframes?.[0];
          const chosen =
            hero?.id === undefined
              ? undefined
              : frame?.variantChoices?.[hero.id];
          return (
            hero?.variants?.find((variant) => variant.id === chosen)?.name ?? ""
          );
        }),
      )
      .toBe("老年");
    await page.getByTestId("story-inspector-close").click();

    // A picture beside the cast, which the shot's own words do not name, is
    // taken from the shelf and kept on the shot it was added to.
    await firstAct.getByTestId("story-kf-extra-add-0").click();
    await firstAct.getByTestId("story-kf-extra-library-0").click();
    const shelf = page.getByTestId("story-library");
    await page.getByTestId("story-library-search").fill("no-such-picture");
    await expect(shelf.locator(".story-pick")).toHaveCount(0);
    await expect(shelf.getByText(/No asset matches/)).toBeVisible();
    await page.getByTestId("story-library-search").fill("");
    await shelf.locator(".story-pick").first().click();
    await expect(firstAct.getByTestId("story-kf-extra-0-0")).toBeVisible();

    // A picture beside the cast may also come from the story's own elements,
    // and the words may name it from an @ the same way they name the cast.
    await firstAct.getByTestId("story-kf-extra-add-0").click();
    await firstAct.getByTestId("story-kf-extra-element-0").click();
    const picker = page.getByTestId("story-element-picker");
    await page.getByTestId("story-element-search").fill("Last");
    await expect(picker.locator(".story-pick")).toHaveCount(1);
    await picker
      .locator(".story-pick")
      .filter({ hasText: "Last carriage" })
      .click();
    await expect(firstAct.getByTestId("story-kf-extra-0-1")).toBeVisible();

    const words = firstAct.getByTestId("story-kf-content-0");
    await words.click();
    await words.press("End");
    await words.pressSequentially(" @Last");
    await expect(page.getByTestId("story-kf-content-0-offer")).toBeVisible();
    await page
      .getByTestId("story-kf-content-0-offer")
      .getByRole("option", { name: "Last carriage" })
      .click();
    await expect(words.locator("[data-mention-name]").last()).toHaveText(
      "Last carriage",
    );
    await words.blur();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const response = await fetch("/api/v1/projects/current");
          const body = (await response.json()) as {
            moka?: {
              stories?: {
                chapters?: {
                  acts?: { keyframes?: { content?: string }[] }[];
                }[];
              }[];
            };
          };
          return (
            body.moka?.stories?.[0]?.chapters?.[0]?.acts?.[0]?.keyframes?.[0]
              ?.content ?? ""
          );
        }),
      )
      .toContain("`Last carriage`");

    // The cell shows the ask as it will be sent: the name the words mention
    // stands as a chip, and the picture it calls in stands under them.
    await expect(
      firstAct
        .getByTestId("story-kf-content-0")
        .locator("[data-mention-name]")
        .first(),
    ).toHaveText("Keeper");
    await expect(firstAct.getByTestId("story-kf-ref-0-0")).toBeVisible();

    // Nothing about a board is sealed: the table is editable from the moment
    // it is written, and a picture is one press away — there is no agreement
    // on the table to give first.
    await expect(firstAct.getByTestId("story-kf-size-0")).toBeEnabled();
    await expect(firstAct.getByTestId("story-kf-move-0")).toBeEnabled();
    await expect(firstAct.getByTestId("story-act-draw-0")).toBeEnabled();

    /** How wide a cell of the framing row stands, in whole pixels. */
    const widthOf = async (testId: string) => {
      const box = await firstAct.getByTestId(testId).boundingBox();
      return Math.round(box?.width ?? -1);
    };

    // One frame of the act, drawn from the cast step three settled on, while
    // its own ask is the only thing that waits on it.
    await firstAct.getByTestId("story-kf-slot-0-generate").click();
    await expect(
      firstAct.getByTestId("story-kf-slot-0").locator("img"),
    ).toBeVisible({ timeout: 60_000 });

    // The frame is shown whole inside its cell rather than cropped to the
    // telling's shape: a picture is drawn at the nearest size the model offers,
    // and a preview holding only part of it sends the reader to the lightbox to
    // see what was drawn.
    await expect(
      firstAct.getByTestId("story-kf-slot-0").locator("img"),
    ).toHaveCSS("object-fit", "contain");

    // A drawn frame's own size must not push the attribute column aside: with
    // the picture in place the selects still hold their words whole, and the
    // frame itself stays a peek rather than widening the row.
    expect(await widthOf("story-kf-size-0")).toBeGreaterThan(80);
    expect(await widthOf("story-kf-move-0")).toBeGreaterThan(80);
    expect(await widthOf("story-kf-angle-0")).toBeGreaterThan(80);
    expect(await widthOf("story-kf-slot-0")).toBeLessThanOrEqual(160);
    await expect(
      firstAct.getByTestId("story-kf-slot-1-generate"),
    ).toBeEnabled();

    // The rest of the act at once: with every frame drawn, the act's clip is
    // one press away — the pictures are what the clip waits on, not their
    // agreements, and there is nothing per frame to agree to.
    await firstAct.getByTestId("story-act-draw-0").click();
    await expect(
      firstAct.getByTestId("story-kf-slot-1").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await expect(firstAct.getByTestId("story-act-video-go-0")).toBeEnabled();

    // And the clip itself, which the stand-in's job hands back at once.
    await firstAct.getByTestId("story-act-video-go-0").click();
    await expect(firstAct.getByTestId("story-act-video-0")).toBeVisible({
      timeout: 60_000,
    });

    // A clip is not the last word: the ask that made it stands beside the
    // take, and asking again plays a fresh one in its place.
    const played = firstAct.getByTestId("story-act-video-0").locator("video");
    // The preview has a width of its own rather than only a ceiling: WebKit
    // gives a video that has not opened a picture no width, and a flex row
    // squeezes it to a sliver — the clip was there and played on click while
    // its preview drew nothing.
    await expect(played).toHaveCSS("width", "160px");
    const wasPlaying = await played.getAttribute("src");
    await expect(firstAct.getByTestId("story-act-video-again-0")).toHaveText(
      "Ask for another",
    );
    await firstAct.getByTestId("story-act-video-again-0").click();
    await expect.poll(() => played.getAttribute("src")).not.toBe(wasPlaying);
    await expect(firstAct.getByTestId("story-act-video-again-0")).toBeEnabled();

    // One act can be filmed its own way: the choice stands on its own card,
    // and switching over clips already made is a question scoped to this act.
    await firstAct.getByTestId("story-act-granularity-keyframe-0").click();
    const scoped = page.getByTestId("change-act-granularity-0");
    await expect(scoped).toBeVisible();
    await expect(scoped).toContainText("by shot");
    await page.getByTestId("change-act-granularity-0-confirm").click();
    await expect(firstAct.getByTestId("story-kf-video-0")).toBeVisible();
    // The telling's default has not moved with the act beside it.
    await expect(page.getByTestId("story-granularity-act")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // And back, from the same card, with the clip that was kept.
    await firstAct.getByTestId("story-act-granularity-act-0").click();
    await page.getByTestId("change-act-granularity-0-confirm").click();
    await expect(firstAct.getByTestId("story-act-video-again-0")).toBeVisible();

    // The fifth step's door waits on the board being finished — every act
    // framed and filmed — and the step's own press is what says what is left
    // and, once there is nothing left, what opens it.
    const secondAct = page.getByTestId("story-act-1");
    await page.getByTestId("story-confirm-storyboard").click();
    await expect(
      page.getByTestId("story-confirm-gaps-storyboard"),
    ).toContainText("1 acts have no clip yet");
    await expect(page.getByTestId("story-step-edit")).toBeDisabled();

    await secondAct.getByTestId("story-act-draw-1").click();
    await expect(
      secondAct.getByTestId("story-kf-slot-0").locator("img"),
    ).toBeVisible({ timeout: 60_000 });
    await secondAct.getByTestId("story-act-video-go-1").click();
    await expect(secondAct.getByTestId("story-act-video-1")).toBeVisible({
      timeout: 60_000,
    });

    await page.getByTestId("story-confirm-storyboard").click();
    await expect(page.getByTestId("story-step-body-edit")).toBeVisible();
    await expect(page.getByTestId("story-step-edit")).toBeEnabled();

    // The document is read back off the server, which is a flush behind the
    // window: what is asserted is what the server ends up holding.
    await expect.poll(async () => (await persistedBoard(page)).clips).toBe(2);
    const board = await persistedBoard(page);
    expect(board.acts).toBe(2);
    expect(board.frames).toBe(3);
    expect(board.drawn).toBe(3);
  } finally {
    forgetHome(home);
  }
});

test("an episode's board is rearranged by hand", async ({ page }) => {
  const home = projectHome("story-board-edit");
  await forgetProjects();
  await configureTheWholeStudio();
  try {
    await toTheBoard(page, home, "Story Board Edit");

    // An act goes in at the seam the reader pointed at — above "The last
    // carriage", the act that stood second — and the room names it by the
    // place it took, with the act it pushed down keeping its own name.
    await expect(page.getByTestId("story-act-1")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByTestId("story-act-1").getByTestId("story-act-title-1"),
    ).toHaveValue("The last carriage");
    await page.getByTestId("story-act-insert-1").click();
    await expect(page.getByTestId("story-act-2")).toBeVisible();
    await expect(
      page.getByTestId("story-act-1").getByTestId("story-act-title-1"),
    ).toHaveValue("Act 2");
    await expect(
      page.getByTestId("story-act-2").getByTestId("story-act-title-2"),
    ).toHaveValue("The last carriage");
    await expect.poll(async () => (await persistedBoard(page)).acts).toBe(3);

    // Moved up, the new act stands first, and the acts it passed are whole
    // where they were rather than read again.
    await page.getByTestId("story-act-up-1").click();
    await expect(
      page.getByTestId("story-act-0").getByTestId("story-act-title-0"),
    ).toHaveValue("Act 2");
    await expect(
      page.getByTestId("story-act-1").getByTestId("story-act-title-1"),
    ).toHaveValue("The platform");

    // Taken out again, once the reader has answered the question: what leaves
    // is the act, and the acts around it close up.
    await page.getByTestId("story-act-remove-0").click();
    const asked = page.getByTestId("remove-act");
    await expect(asked).toContainText("Act 2");
    await page.getByTestId("remove-act-confirm").click();
    await expect(page.getByTestId("story-act-1")).toBeVisible();
    await expect(page.getByTestId("story-act-2")).toHaveCount(0);

    // A shot is inserted above the row it belongs above and then moved: the
    // board is the reader's to order, not only to fill in.
    const firstAct = page.getByTestId("story-act-0");
    await firstAct.getByTestId("story-kf-insert-0").click();
    await expect.poll(async () => (await persistedBoard(page)).frames).toBe(4);
    // The shot nobody has written into yet is the one that moved: the shot it
    // was inserted above is the act's first again, and its words are its own.
    await firstAct.getByTestId("story-kf-down-0").click();
    await expect
      .poll(async () => (await persistedBoard(page)).contents)
      .toEqual([
        "Rain over the platform, `Keeper` under the lamp.",
        "",
        "`Traveller` turns.",
        "The `Old ticket` is held up to the light.",
      ]);

    // What the server ends up holding: two acts, four shots, none of them
    // drawn — nobody asked for a picture in any of this.
    const board = await persistedBoard(page);
    expect(board.acts).toBe(2);
    expect(board.titles).toEqual(["The platform", "The last carriage"]);
    expect(board.frames).toBe(4);
    expect(board.drawn).toBe(0);

    // A long act is cut in two at the seam between two of its shots: the
    // shots keep the acts they were written into, and the second half says
    // what it is.
    await firstAct.getByTestId("story-kf-split-1").click();
    await expect(page.getByTestId("story-act-2")).toBeVisible();
    await expect.poll(async () => (await persistedBoard(page)).acts).toBe(3);
    await expect(
      page.getByTestId("story-act-1").getByTestId("story-act-title-1"),
    ).toHaveValue("The platform (cont.)");

    // The two halves are joined back at the same seam, one act again.
    await page.getByTestId("story-act-merge-1").click();
    await expect(page.getByTestId("story-act-2")).toHaveCount(0);
    await expect.poll(async () => (await persistedBoard(page)).acts).toBe(2);
    await expect(
      page.getByTestId("story-act-0").getByTestId("story-act-title-0"),
    ).toHaveValue("The platform");

    // A bridge stands between the two acts, waiting for the ends it is filmed
    // between: neither act has been drawn in this telling.
    await page.getByTestId("story-act-transition-1").click();
    const transition = page.getByTestId("story-transition-1");
    await expect(transition).toBeVisible();
    await expect
      .poll(async () => (await persistedBoard(page)).bridges)
      .toEqual([{ prompt: "", durationMs: 3_000 }]);
    await expect(
      transition.getByTestId("story-transition-video-go-1"),
    ).toBeDisabled();
    await expect(
      transition.getByTestId("story-transition-missing-1"),
    ).toContainText("ending frame");

    // The ends may come from the neighbouring clips instead, and this telling
    // has filmed none: the card says which end it is short of rather than
    // offering a bridge it cannot take.
    await transition.getByTestId("story-transition-source-video-1").click();
    await expect(
      transition.getByTestId("story-transition-missing-1"),
    ).toContainText("no clip");
    await expect(
      transition.getByTestId("story-transition-video-go-1"),
    ).toBeDisabled();
    await transition.getByTestId("story-transition-source-keyframes-1").click();

    await transition
      .getByTestId("story-transition-prompt-1")
      .fill("Fade through the dark");
    await transition.getByTestId("story-transition-prompt-1").press("Tab");
    await transition.getByTestId("story-transition-seconds-1").fill("4");
    await transition.getByTestId("story-transition-seconds-1").press("Tab");
    await expect
      .poll(async () => (await persistedBoard(page)).bridges)
      .toEqual([
        {
          prompt: "Fade through the dark",
          durationMs: 4_000,
          frameSource: "keyframes",
        },
      ]);

    // Taken away again, the two acts close up.
    await transition.getByTestId("story-transition-remove-1").click();
    await expect(page.getByTestId("story-transition-1")).toHaveCount(0);
    await expect.poll(async () => (await persistedBoard(page)).acts).toBe(2);
  } finally {
    forgetHome(home);
  }
});
