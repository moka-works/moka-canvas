import { test as base, expect } from "@playwright/test";
import { APP } from "./helpers";

export type { Locator, Page } from "@playwright/test";

async function resetPreferences(): Promise<void> {
  const response = await fetch(`${APP}/api/v1/ui-prefs`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(
      `the interface preferences could not be reset: ${response.status}`,
    );
  }
}

/**
 * The suite's own `test`, which starts each case with fresh interface
 * preferences.
 *
 * Those choices now live in the server's metadata directory rather than in a
 * browser's storage, so they are shared by every case in a run. A panel left
 * folded by one spec would otherwise be folded for the next; the reset puts
 * every case back on the defaults a fresh machine has.
 *
 * The page is closed and the reset repeated on the way out: closing it flushes
 * whatever the case changed on its way out, and that flush must not land on
 * top of the next case's fresh start.
 */
export const test = base.extend({
  page: async ({ page }, run) => {
    await resetPreferences();
    await run(page);
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await resetPreferences();
  },
});

export { expect };
