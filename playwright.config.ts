import { defineConfig } from "@playwright/test";

const port = Number(process.env.MOKA_E2E_PORT ?? 8971);
const baseURL = `http://127.0.0.1:${port}`;
// Playwright wipes its output directory as a run starts, so two runs sharing
// one directory wipe the artifacts out from under each other. The directory
// follows the port a run listens on; the default run keeps the familiar name.
const outputDir = port === 8971 ? "test-results" : `test-results-${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir,
  // A model is configured against the stand-in provider's address, so it has
  // to be listening before the first page opens, and is stopped after the last.
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 30_000,
  // Projects are no longer why the suite serializes: each window names the
  // project it speaks for, and one server holds several (multi-project.spec.ts
  // proves two windows side by side). What still serializes it is the rest of
  // the shared home — the launcher's list of projects and the app's settings,
  // which specs clear or rewrite as their own setup.
  workers: 1,
  fullyParallel: false,
  // The interface follows the browser's language; the assertions are English,
  // so the browser is asked for English.
  use: { baseURL, locale: "en-US" },
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `${baseURL}/api/health`,
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
