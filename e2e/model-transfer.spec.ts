import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "./fixtures";

import {
  APP,
  CHANNEL_KEY,
  configureModels,
  forgetHome,
  projectHome,
} from "./helpers";

/**
 * A configuration export carries every model and its key, sealed; the import
 * reads the same file back through the settings dialog and stores the model
 * and credential again.
 *
 * What a unit test cannot show is that the file a real save dialog produced is
 * the file the real server reads back: the export is written where the web
 * file browser said, the model is deleted from the metadata store, and the
 * import restores it with the credential still sealed.
 */
test("a configuration export and import round-trip every model and its key", async ({
  page,
}) => {
  // The passphrase KDF is deliberately slow, and this suite runs a debug
  // build; two derivations are part of the round trip.
  test.setTimeout(60_000);
  const home = projectHome("model-transfer");
  try {
    await configureModels([
      {
        id: "transferable",
        capability: "text",
        alias: "Transferable",
      },
    ]);

    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.locator("#settings-toptab-system").click();

    // Export: the passphrase is what seals the key bundle.
    await dialog.getByTestId("settings-export").click();
    await dialog
      .getByTestId("settings-export-passphrase")
      .fill("transfer-passphrase-1");
    await dialog
      .getByTestId("settings-export-confirm")
      .fill("transfer-passphrase-1");
    await dialog.getByTestId("settings-export-run").click();

    const browser = page.getByTestId("path-browser");
    await expect(browser).toBeVisible();
    await browser.getByTestId("path-browser-typed").fill(home);
    await browser.getByTestId("path-browser-typed").press("Enter");
    await expect(browser.getByTestId("path-browser-list")).toBeVisible();
    await browser.getByTestId("path-browser-name").fill("backup.json");
    await browser.getByRole("button", { name: "Save" }).click();

    await expect(
      page.getByText(/Exported \d+ model configurations/),
    ).toBeVisible({ timeout: 30_000 });

    const destination = join(home, "backup.json");
    expect(existsSync(destination)).toBe(true);
    const raw = readFileSync(destination, "utf8");
    expect(raw).not.toContain(CHANNEL_KEY);
    const document = JSON.parse(raw) as {
      format: string;
      models: { id: string }[];
      credentials?: { count: number };
    };
    expect(document.format).toBe("moka-canvas.settings");
    expect(document.models.some((model) => model.id === "transferable")).toBe(
      true,
    );
    expect(document.credentials?.count ?? 0).toBeGreaterThan(0);

    // Throw the model away, key and all, then read the file back.
    const removed = await fetch(`${APP}/api/v1/models/transferable`, {
      method: "DELETE",
    });
    expect(removed.ok).toBe(true);

    await dialog.getByTestId("settings-import").click();
    await page.getByTestId("settings-import-file").setInputFiles(destination);
    const preview = page.getByTestId("settings-import-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("model configurations");
    await expect(preview).toContainText("encrypted API keys");

    await page
      .getByTestId("settings-import-passphrase")
      .fill("transfer-passphrase-1");
    await page.getByTestId("settings-import-run").click();

    await expect(
      page.getByText(/Imported \d+ model configurations/),
    ).toBeVisible({ timeout: 30_000 });
    const restored = await fetch(`${APP}/api/v1/models`).then(
      (response) =>
        response.json() as Promise<{
          models: {
            id: string;
            apiKey: { set: boolean; masked: string | null };
          }[];
        }>,
    );
    const model = restored.models.find((entry) => entry.id === "transferable");
    expect(model).toBeDefined();
    expect(model!.apiKey.set).toBe(true);
    expect(model!.apiKey.masked?.endsWith(CHANNEL_KEY.slice(-4))).toBe(true);
  } finally {
    await fetch(`${APP}/api/v1/models/transferable`, {
      method: "DELETE",
    }).catch(() => undefined);
    forgetHome(home);
  }
});
