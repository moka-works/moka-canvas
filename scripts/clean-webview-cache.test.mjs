import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { targets } from "./clean-webview-cache.mjs";

test("macOS removes only network caches, not the WebsiteData directory", async () => {
  const home = join("/", "Users", "tester");
  assert.deepEqual(await targets("darwin", home, {}), [
    join(home, "Library", "Caches", "app.mokacanvas", "NetworkCache"),
    join(
      home,
      "Library",
      "WebKit",
      "app.mokacanvas",
      "WebsiteData",
      "NetworkCache",
    ),
  ]);
});

test("Windows preserves CacheStorage and origin storage", async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), "moka-cache-targets-"));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const profile = join(localAppData, "app.mokacanvas", "EBWebView");
  for (const name of ["Cache", "CacheStorage", "Code Cache", "LocalStorage"]) {
    await mkdir(join(profile, name), { recursive: true });
  }

  const found = await targets("win32", join("/", "home", "tester"), {
    LOCALAPPDATA: localAppData,
  });
  assert.deepEqual(
    found.sort(),
    [join(profile, "Cache"), join(profile, "Code Cache")].sort(),
  );
});

test("an unknown platform has no implicit deletion target", async () => {
  assert.deepEqual(await targets("plan9", join("/", "home", "tester"), {}), []);
});
