import { expect, test } from "./fixtures";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { addNode, createProject, projectHome } from "./helpers";

/** The viewport of the first canvas as persisted server-side. */
async function persistedViewport(
  page: Page,
): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/projects/current");
    const body = (await response.json()) as {
      moka?: {
        canvas?: { viewport?: { x: number; y: number; zoom: number } }[];
      };
    };
    return body.moka?.canvas?.[0]?.viewport ?? { x: 0, y: 0, zoom: 1 };
  });
}

/**
 * Three fingers down on the glass, a drag with all of them, and one lifting.
 *
 * Sent as the pointer events a trackpad or a screen makes of three fingers —
 * the first of them primary and the others not — which is what the canvas
 * counts when it decides the second action is being asked for.
 */
async function threeFingerDrag(
  surface: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await surface.evaluate(
    (el, points) => {
      // Taken off the element's own window rather than named: what a page
      // makes its events with is the page's own, and this file is typed away
      // from the DOM.
      const host = el as unknown as {
        ownerDocument: { defaultView: unknown };
        dispatchEvent: (event: Event) => void;
      };
      const view = host.ownerDocument.defaultView as Record<
        string,
        new (type: string, init?: Record<string, unknown>) => Event
      >;
      const fire = (
        type: string,
        id: number,
        x: number,
        y: number,
        primary: boolean,
      ) => {
        host.dispatchEvent(
          new view.PointerEvent(type, {
            pointerId: id,
            pointerType: "touch",
            isPrimary: primary,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
            buttons: 1,
          }),
        );
      };
      const dx = (points.to.x - points.from.x) / 4;
      const dy = (points.to.y - points.from.y) / 4;
      fire("pointerdown", 1, points.from.x, points.from.y, true);
      fire("pointerdown", 2, points.from.x + 10, points.from.y + 10, false);
      fire("pointerdown", 3, points.from.x + 20, points.from.y, false);
      for (let step = 1; step <= 4; step++) {
        fire(
          "pointermove",
          1,
          points.from.x + dx * step,
          points.from.y + dy * step,
          true,
        );
        fire(
          "pointermove",
          2,
          points.from.x + 10 + dx * step,
          points.from.y + 10 + dy * step,
          false,
        );
        fire(
          "pointermove",
          3,
          points.from.x + 20 + dx * step,
          points.from.y + dy * step,
          false,
        );
      }
      fire("pointerup", 1, points.to.x, points.to.y, true);
      fire("pointerup", 2, points.to.x + 10, points.to.y + 10, false);
      fire("pointerup", 3, points.to.x + 20, points.to.y, false);
    },
    { from, to },
  );
}

test("the middle button drags the canvas while the select tool chooses", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("second-action"), "pan"),
    "Second Action Pan",
  );

  const surface = page.getByTestId("canvas-surface");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const middle = {
    x: box!.x + box!.width * 0.4,
    y: box!.y + box!.height * 0.4,
  };

  const before = await persistedViewport(page);

  // The select tool is the one the editor opens with: the primary drag draws
  // a selection, and the middle button takes the canvas instead.
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(middle.x + 120, middle.y + 80, { steps: 8 });
  await page.mouse.up({ button: "middle" });

  // The camera that settles is the camera the document keeps, so what the
  // drag did is read back from the project itself.
  await expect
    .poll(
      async () => Math.round(before.x - (await persistedViewport(page)).x),
      {
        timeout: 10_000,
      },
    )
    .toBe(120);
  await expect
    .poll(
      async () => Math.round(before.y - (await persistedViewport(page)).y),
      {
        timeout: 10_000,
      },
    )
    .toBe(80);
});

test("the middle button chooses while the pan tool drags the canvas", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("second-action"), "choose"),
    "Second Action Choose",
  );
  await addNode(page, "Text");
  // The node arrives selected and its panel comes up with it: one Escape
  // sends the panel away and a second lets go of the node.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Nothing is chosen yet, so the fit-the-selection control has nothing to fit.
  await expect(page.getByTestId("zoom-selection")).toBeDisabled();

  await page.getByTestId("tool-pan").click();

  const surface = page.getByTestId("canvas-surface");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();

  // The node arrived at the middle of the surface; a box dragged across the
  // middle with the middle button takes it in.
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height * 0.8, {
    steps: 8,
  });
  await page.mouse.up({ button: "middle" });

  await expect(page.getByTestId("zoom-selection")).toBeEnabled();

  // And the canvas did not move: choosing was what the drag did, and the
  // same button under the same tool does the same thing twice.
  const before = await persistedViewport(page);
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.2);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(
    box!.x + box!.width * 0.2 + 90,
    box!.y + box!.height * 0.2 + 60,
    {
      steps: 8,
    },
  );
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(500);
  const after = await persistedViewport(page);
  expect(Math.round(after.x)).toBe(Math.round(before.x));
  expect(Math.round(after.y)).toBe(Math.round(before.y));
});

test("three fingers drag the canvas while the select tool chooses", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("second-action"), "glass-pan"),
    "Three Finger Pan",
  );

  const surface = page.getByTestId("canvas-surface");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();

  const before = await persistedViewport(page);
  await threeFingerDrag(
    surface,
    { x: box!.x + box!.width * 0.3, y: box!.y + box!.height * 0.3 },
    { x: box!.x + box!.width * 0.3 + 120, y: box!.y + box!.height * 0.3 + 80 },
  );

  await expect
    .poll(
      async () => Math.round(before.x - (await persistedViewport(page)).x),
      { timeout: 10_000 },
    )
    .toBe(120);
});

test("three fingers choose while the pan tool drags the canvas", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("second-action"), "glass-choose"),
    "Three Finger Choose",
  );
  await addNode(page, "Text");
  // One Escape for the panel that came up with the selection, and a second
  // for the selection itself.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("zoom-selection")).toBeDisabled();

  await page.getByTestId("tool-pan").click();

  const surface = page.getByTestId("canvas-surface");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  await threeFingerDrag(
    surface,
    { x: box!.x + box!.width * 0.3, y: box!.y + box!.height * 0.3 },
    { x: box!.x + box!.width * 0.8, y: box!.y + box!.height * 0.8 },
  );

  await expect(page.getByTestId("zoom-selection")).toBeEnabled();
});
