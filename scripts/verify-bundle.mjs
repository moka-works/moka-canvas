#!/usr/bin/env node
// Checks that a packaged app carries the frontend this checkout just built.
//
// The app's window is served from the web/ directory beside its resources, a
// copy of dist/ made while bundling. A package can carry a binary from this
// commit beside a web/ from an older one — a resource copy left from a
// previous build, a DMG collected under the same version, a dist/ emptied by
// a concurrent build — and the installed app then shows an interface nobody
// built. Comparing the packaged index.html and build stamp with dist/ turns
// that into a failed package instead of a mystery after install.
//
// Without an argument the newest artifact under the target's bundle
// directories is checked; the argument may also be an installed .app, which
// is how somebody asks an installed copy which frontend it carries.
//
// A .dmg is mounted read-only on a private mount point and detached again on
// the way out, however the check ends.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "./checkout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const target = process.env.CARGO_TARGET_DIR ?? cargoTargetDir(root);
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

// One problem, carried up to the entry point rather than ending the process
// where it is found: a DMG is detached on the way out even when its contents
// are wrong, and a leftover mounted volume breaks the next package run.
class VerifyError extends Error {}

function fail(message) {
  throw new VerifyError(message);
}

async function text(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function modified(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return -1;
  }
}

/** Every place tauri-bundler may have written a bundle for this checkout. */
async function bundleRoots() {
  const roots = [join(target, "release", "bundle")];
  let entries = [];
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    // No target directory: nothing is there to check.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      roots.push(join(target, entry.name, "release", "bundle"));
    }
  }
  return roots;
}

/** The newest bundle of one kind, if the last run left one. */
async function newestBundle(kind) {
  const dirName = kind === "app" ? "macos" : "dmg";
  const suffix = kind === "app" ? ".app" : ".dmg";
  const found = [];
  for (const bundle of await bundleRoots()) {
    const dir = join(bundle, dirName);
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(suffix)) continue;
      if (kind === "app" ? !entry.isDirectory() : !entry.isFile()) continue;
      // A package built for another version is not this run's business.
      if (kind === "dmg" && !entry.name.includes(pkg.version)) continue;
      const path = join(dir, entry.name);
      found.push({ path, at: await modified(path) });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.path;
}

/** The frontend one app bundle carries, checked against this checkout. */
async function checkApp(app, label) {
  const web = join(app, "Contents", "Resources", "web");
  const bundledIndex = await text(join(web, "index.html"));
  if (bundledIndex === null) {
    fail(`${label}: carries no Contents/Resources/web/index.html`);
  }
  const builtIndex = await text(join(dist, "index.html"));
  if (builtIndex === null) {
    fail(
      "dist/index.html is missing — build the frontend (make web-build) first",
    );
  }
  if (bundledIndex !== builtIndex) {
    fail(
      `${label}: its web/index.html is not the one in dist/ — the package carries a frontend from another build; rebuild and package again`,
    );
  }

  const bundledStamp = await text(join(web, "moka-build.json"));
  if (bundledStamp === null) {
    fail(
      `${label}: carries no web/moka-build.json — its frontend predates build stamping; rebuild and package again`,
    );
  }
  const builtStamp = await text(join(dist, "moka-build.json"));
  if (builtStamp === null) {
    fail(
      "dist/moka-build.json is missing — build the frontend with npm run build",
    );
  }
  const held = JSON.parse(bundledStamp);
  const source = JSON.parse(builtStamp);
  if (held.commit !== source.commit || held.version !== source.version) {
    fail(
      `${label}: its frontend is ${held.version} at ${held.commit}, dist/ is ${source.version} at ${source.commit}; rebuild and package again`,
    );
  }

  // The page's own files are what the window will ask for; an index naming a
  // chunk the package does not hold is a half-copied frontend.
  for (const [, ref] of bundledIndex.matchAll(/(?:src|href)="\/([^"]+)"/g)) {
    if (!existsSync(join(web, ref))) {
      fail(`${label}: its web/ is missing ${ref}, which its index.html loads`);
    }
  }

  console.log(
    `verify-bundle: ${label} carries frontend ${held.commit} (${held.builtAt})`,
  );
}

/** Checks the app inside a DMG, mounting it only for the check. */
async function checkDmg(dmg, label) {
  if (process.platform !== "darwin") {
    fail(`${label}: a DMG can only be mounted on macOS`);
  }
  const mount = await mkdtemp(join(tmpdir(), "moka-verify-"));
  let attached = false;
  try {
    try {
      execFileSync(
        "hdiutil",
        [
          "attach",
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-mountpoint",
          mount,
          dmg,
        ],
        { stdio: "ignore" },
      );
    } catch {
      fail(`${label}: could not mount the image to check it`);
    }
    attached = true;
    const apps = (await readdir(mount, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
    );
    if (apps.length !== 1) {
      fail(
        `${label}: expected one .app inside the image, found ${apps.length}`,
      );
    }
    await checkApp(join(mount, apps[0].name), label);
  } finally {
    if (attached) {
      try {
        execFileSync("hdiutil", ["detach", "-force", mount], {
          stdio: "ignore",
        });
      } catch {
        console.error(`verify-bundle: could not detach ${mount}`);
      }
    }
    await rm(mount, { recursive: true, force: true }).catch(() => {});
  }
}

try {
  const requested = process.argv[2];
  if (requested !== undefined) {
    if (requested.endsWith(".app")) {
      await checkApp(requested, basename(requested));
    } else if (requested.endsWith(".dmg")) {
      await checkDmg(requested, basename(requested));
    } else {
      fail("expected a .app directory or a .dmg file");
    }
  } else {
    // A package that just rebuilt its .app (the combined PKG) is the newer
    // artifact; a DMG-only build has no .app left and is checked by its image.
    const app = await newestBundle("app");
    if (app !== undefined) {
      await checkApp(app, app.slice(root.length + 1));
    } else {
      const dmg = await newestBundle("dmg");
      if (dmg === undefined) {
        fail(
          "no .app or .dmg for this version under the target's bundle directories",
        );
      }
      await checkDmg(dmg, dmg.slice(root.length + 1));
    }
  }
} catch (error) {
  console.error(
    `verify-bundle: ${error instanceof VerifyError ? error.message : String(error)}`,
  );
  process.exit(1);
}
