import { expect, test } from "./fixtures";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { createProject, projectHome } from "./helpers";

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

/** The tool the switch says is in hand, which is the tool a pointer meets. */
function heldTool(page: Page) {
  return page.locator(".tool-switch-thumb").getAttribute("data-tool");
}

test("a held Ctrl borrows the other tool, whichever is in hand", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("temporary-tool"), "borrow"),
    "Borrowed Tool",
  );

  // The select tool is in hand, and Ctrl borrows the pan tool for as long as
  // the key is down.
  await expect(page.getByTestId("tool-select")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await heldTool(page)).toBe("select");
  await page.keyboard.down("Control");
  expect(await heldTool(page)).toBe("pan");
  await page.keyboard.up("Control");
  expect(await heldTool(page)).toBe("select");

  // And the other way round: the pan tool in hand borrows the select tool.
  await page.getByTestId("tool-pan").click();
  expect(await heldTool(page)).toBe("pan");
  await page.keyboard.down("Control");
  expect(await heldTool(page)).toBe("select");
  await page.keyboard.up("Control");
  expect(await heldTool(page)).toBe("pan");
});

test("a Ctrl-held click moves the canvas and does not ask for the menu", async ({
  page,
}) => {
  await page.goto("/");
  await createProject(
    page,
    join(projectHome("temporary-tool"), "pan"),
    "Ctrl Pan",
  );

  const surface = page.getByTestId("canvas-surface");
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const middle = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  };

  const before = await persistedViewport(page);

  // Ctrl down borrows the pan tool, and the click that follows is a hand on
  // the canvas rather than a question for it: no menu comes up, and the drag
  // moves the canvas.
  await page.keyboard.down("Control");
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 100, middle.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole("menu", { name: "Context menu" })).toBeHidden();
  await page.keyboard.up("Control");

  await expect
    .poll(
      async () => Math.round(before.x - (await persistedViewport(page)).x),
      { timeout: 10_000 },
    )
    .toBe(100);

  // A real right button still asks for the menu, Ctrl or no Ctrl.
  await page.mouse.click(middle.x, middle.y, { button: "right" });
  await expect(page.getByRole("menu", { name: "Context menu" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Context menu" })).toBeHidden();
});
