import { join } from "node:path";
import { expect, test } from "./fixtures";
import {
  createProject,
  forgetHome,
  forgetProjects,
  newTimeline,
  openClipRoom,
  projectHome,
} from "./helpers";

/**
 * The export dialog on a machine that cannot render.
 *
 * The e2e harness points MOKA_FFMPEG at a path that is never there, so this
 * is the same machine on every host: the entry opens the dialog, the dialog
 * says what is missing and where a renderer would be looked for, and the one
 * button that would ask for a render is refused with that reason. A real
 * render is not asserted here — it belongs to whatever ffmpeg a machine has —
 * but "no renderer" must never be silent.
 */

test("a machine without a renderer is told so, and the cut is left alone", async ({
  page,
}) => {
  const home = projectHome("clip-export");
  await forgetProjects();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await createProject(page, join(home, "project"), "Export Unavailable");
  await openClipRoom(page);
  await newTimeline(page, "Timeline 1");

  // The entry is a real one now: it opens rather than explaining itself away.
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export video…" }).click();

  const dialog = page.getByRole("dialog", { name: "Export video" });
  await expect(dialog).toBeVisible();
  // What the machine can do, said in words: nothing was found, and where a
  // renderer would have been looked for.
  const capability = page.getByTestId("clip-export-capability");
  await expect(capability).toContainText("ffmpeg was not found");
  await expect(capability).toContainText("MOKA_FFMPEG");

  // The one button that would ask for a render is refused with that reason —
  // and with it refused, nothing asks where a file would go: the path is a
  // question only a render that can happen is worth asking.
  const start = page.getByRole("button", { name: "Export video", exact: true });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAttribute("title", /ffmpeg was not found/);
  await expect(page.getByTestId("path-browser")).toHaveCount(0);

  // Closing leaves the room as it was: the refusal was about a machine, not
  // about the cut.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".clip-timeline")).toBeVisible();
  await expect(page.locator(".clip-timeline")).toHaveAttribute(
    "data-track-count",
    "3",
  );

  forgetHome(home);
});
