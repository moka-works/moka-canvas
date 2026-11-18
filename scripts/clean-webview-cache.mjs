#!/usr/bin/env node
// Clears the desktop window's webview cache.
//
// The window is served over a local origin that stays the same across builds
// (the server remembers its port so localStorage keeps its home), so a copy of
// index.html stored by the webview can keep running the previous build's
// chunks against a new binary. The server refuses to let the page be stored
// now, but copies already on disk survive reinstalls and updates: this removes
// them. Quit the app first; a running webview keeps its files open.

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { identifier } = JSON.parse(
  await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);

// WebView2 keeps the profile and its caches in one user data folder; only the
// directories named like caches are removed, so cookies and local storage that
// live beside them survive.
const WINDOWS_CACHE_NAMES = new Set([
  "Cache",
  "CacheStorage",
  "Code Cache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
]);

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function cacheDirectoriesUnder(dir, depth = 0) {
  if (depth > 6 || !(await isDirectory(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (WINDOWS_CACHE_NAMES.has(entry.name)) found.push(path);
    else found.push(...(await cacheDirectoriesUnder(path, depth + 1)));
  }
  return found;
}

async function targets() {
  switch (platform) {
    case "darwin":
      // WKWebView's network cache; its website data (local storage included)
      // lives under ~/Library/WebKit and is left alone.
      return [join(homedir(), "Library", "Caches", identifier)];
    case "win32": {
      const localAppData =
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
      return cacheDirectoriesUnder(join(localAppData, identifier));
    }
    case "linux": {
      const data =
        process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
      const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
      // WebKitGTK is pointed at the data directory for both its data and its
      // cache; the cache is the part this removes.
      return [
        join(cache, identifier),
        join(data, identifier, "webkitgtk", "cache"),
      ];
    }
    default:
      return [];
  }
}

const found = await targets();
let removed = 0;
for (const target of found) {
  if (!(await isDirectory(target))) continue;
  try {
    await rm(target, { recursive: true, force: true });
    console.log(`clean-webview-cache: removed ${target}`);
    removed += 1;
  } catch (error) {
    console.error(
      `clean-webview-cache: cannot remove ${target}: ${error.message}\n` +
        "quit Moka Canvas and run this again",
    );
    process.exitCode = 1;
  }
}
if (removed === 0 && process.exitCode !== 1) {
  console.log("clean-webview-cache: nothing to remove");
}
