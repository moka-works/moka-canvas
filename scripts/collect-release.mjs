import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const targetDir = join(root, "src-tauri", "target");
const releaseDir = join(root, "release");
const extensions = new Set([
  ".dmg",
  ".msi",
  ".exe",
  ".deb",
  ".rpm",
  ".AppImage",
]);
// deb and AppImage separate the version with underscores, rpm with dashes.
const versionTags = [`_${pkg.version}_`, `-${pkg.version}-`];

const bundleRoots = [join(targetDir, "release", "bundle")];
for (const entry of await readdir(targetDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    bundleRoots.push(join(targetDir, entry.name, "release", "bundle"));
  }
}

const artifacts = [];
for (const bundleRoot of bundleRoots) {
  for (const bundleType of ["dmg", "msi", "nsis", "deb", "rpm", "appimage"]) {
    const dir = join(bundleRoot, bundleType);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !versionTags.some((tag) => entry.name.includes(tag))
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
  const destination = join(releaseDir, artifact.split("/").pop());
  await cp(artifact, destination);
  console.log(`Copied ${artifact} -> ${destination}`);
}
