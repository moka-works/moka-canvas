import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cargoTargetDir } from "./checkout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const targetDir = process.env.CARGO_TARGET_DIR ?? cargoTargetDir(root);
const releaseDir = join(root, "release");
const extensions = new Set([
  ".dmg",
  ".pkg",
  ".msi",
  ".exe",
  ".deb",
  ".rpm",
  ".AppImage",
  // The updater archive and the signatures over every updater artifact.
  ".gz",
  ".sig",
]);
// Installers separate the version with underscores, dashes, or a dot before
// the extension, so the number stands on its own rather than in a fixed pair
// of separators.
const versionPattern = new RegExp(
  `(?:^|[^0-9])${pkg.version.replace(/\./g, "\\.")}(?![0-9])`,
);

const bundleRoots = [join(targetDir, "release", "bundle")];
for (const entry of await readdir(targetDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    bundleRoots.push(join(targetDir, entry.name, "release", "bundle"));
  }
}

const artifacts = [];
for (const bundleRoot of bundleRoots) {
  for (const bundleType of [
    "dmg",
    "macos",
    "msi",
    "nsis",
    "deb",
    "rpm",
    "appimage",
  ]) {
    const dir = join(bundleRoot, bundleType);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // The macOS updater archive is named after the app bundle and carries no
      // version of its own; the directory it sits in says which build it is.
      const updaterArchive =
        bundleType === "macos" && /\.app\.tar\.gz(\.sig)?$/.test(entry.name);
      if (
        !entry.isFile() ||
        (!updaterArchive && !versionPattern.test(entry.name))
      ) {
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf("."));
      if (extensions.has(extension)) {
        artifacts.push(join(dir, entry.name));
      }
    }
  }
}

if (artifacts.length === 0) {
  console.error(
    `No bundle artifacts matching version ${pkg.version} found under src-tauri/target.`,
  );
  process.exit(1);
}

await mkdir(releaseDir, { recursive: true });
for (const artifact of artifacts) {
  const destination = join(releaseDir, basename(artifact));
  await cp(artifact, destination);
  console.log(`Copied ${artifact} -> ${destination}`);
}
