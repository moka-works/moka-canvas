#!/usr/bin/env node
// Clears the desktop window's webview cache.
//
// The window is served over a local origin that stays the same across builds
// (the server remembers its port so website data keeps its home), so a copy of
// index.html stored by the webview can keep running the previous build's
// chunks against a new binary. The server refuses to let the page be stored
// now, but copies already on disk survive reinstalls and updates: this removes
// them. Quit the app first; a running webview keeps its files open.

import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { identifier } = JSON.parse(
  await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);

// WebView2 keeps the profile and its caches in one user data folder; only
// disposable directories are removed. CacheStorage, cookies and origin storage
// belong to web clients and survive beside them.
const WINDOWS_CACHE_NAMES = new Set([
  "Cache",
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
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function cacheDirectoriesUnder(dir, depth = 0) {
  if (depth > 6 || !(await isDirectory(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (WINDOWS_CACHE_NAMES.has(entry.name)) found.push(path);
    else found.push(...(await cacheDirectoriesUnder(path, depth + 1)));
  }
  return found;
}

export async function targets(
  currentPlatform = platform(),
  home = homedir(),
  env = process.env,
) {
  switch (currentPlatform) {
    case "darwin":
      // Only the HTTP network cache is disposable. CacheStorage belongs to web
      // clients, and the rest of WebsiteData holds cookies and origin storage.
      return [
        join(home, "Library", "Caches", identifier, "NetworkCache"),
        join(
          home,
          "Library",
          "WebKit",
          identifier,
          "WebsiteData",
          "NetworkCache",
        ),
      ];
    case "win32": {
      const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return cacheDirectoriesUnder(join(localAppData, identifier));
    }
    case "linux": {
      const data = env.XDG_DATA_HOME ?? join(home, ".local", "share");
      const cache = env.XDG_CACHE_HOME ?? join(home, ".cache");
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

async function main() {
  const found = await targets();
  let removed = 0;
  for (const target of found) {
    try {
      if (!(await isDirectory(target))) continue;
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
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
