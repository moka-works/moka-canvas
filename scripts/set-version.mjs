import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    "Usage: make set-version <semver>  (e.g. make set-version 1.2.3)",
  );
  process.exit(1);
}

function fail(relativePath) {
  console.error(`Failed to find the version in ${relativePath}`);
  process.exit(1);
}

// Line-level replacements keep each file's existing layout; parsing and
// re-serializing JSON would expand arrays such as tauri.conf.json's languages.
async function replaceVersion(relativePath, pattern, replacement) {
  const path = join(root, relativePath);
  const text = await readFile(path, "utf8");
  if (!pattern.test(text)) {
    fail(relativePath);
  }
  await writeFile(path, text.replace(pattern, replacement));
}

await replaceVersion(
  "package.json",
  /^  "version": "[^"]*"/m,
  `  "version": "${version}"`,
);
await replaceVersion(
  "src-tauri/tauri.conf.json",
  /^  "version": "[^"]*"/m,
  `  "version": "${version}"`,
);

const packageLockPath = join(root, "package-lock.json");
const packageLock = await readFile(packageLockPath, "utf8");
const lines = packageLock.split("\n");
const packages = lines.findIndex((line) => line === '  "packages": {');
const rootPackage = lines.findIndex(
  (line, index) => index > packages && line === '    "": {',
);
const rootVersion = lines.findIndex(
  (line, index) => index > rootPackage && /^      "version": "/.test(line),
);
const topVersion = lines.findIndex((line) => /^  "version": "/.test(line));
if (
  packages === -1 ||
  rootPackage === -1 ||
  rootVersion === -1 ||
  topVersion === -1
) {
  fail("package-lock.json");
}
lines[rootVersion] = lines[rootVersion].replace(
  /("version": ")[^"]*"/,
  `$1${version}"`,
);
lines[topVersion] = lines[topVersion].replace(
  /("version": ")[^"]*"/,
  `$1${version}"`,
);
await writeFile(packageLockPath, lines.join("\n"));

await replaceVersion(
  "src-tauri/Cargo.toml",
  /^version = "[^"]*"$/m,
  `version = "${version}"`,
);
await replaceVersion(
  "src-tauri/Cargo.lock",
  /(name = "moka-canvas"\nversion = ")[^"]*"/,
  `$1${version}"`,
);

console.log(`Version set to ${version} in:`);
console.log("  package.json");
console.log("  package-lock.json");
console.log("  src-tauri/tauri.conf.json");
console.log("  src-tauri/Cargo.toml");
console.log("  src-tauri/Cargo.lock");
