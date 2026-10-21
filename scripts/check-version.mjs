import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const tag = option("--tag");

const sources = [];

async function addJson(relativePath, read) {
  const data = JSON.parse(await readFile(join(root, relativePath), "utf8"));
  sources.push({ path: relativePath, version: read(data) });
}

await addJson("package.json", (data) => data.version);
await addJson("package-lock.json", (data) => data.packages?.[""]?.version);
await addJson("src-tauri/tauri.conf.json", (data) => data.version);

const cargoToml = await readFile(join(root, "src-tauri", "Cargo.toml"), "utf8");
const cargoTomlVersion = /^version = "([^"]*)"/m.exec(cargoToml)?.[1];
if (!cargoTomlVersion) {
  console.error(
    "Could not read the package version from src-tauri/Cargo.toml.",
  );
  process.exit(1);
}
sources.push({ path: "src-tauri/Cargo.toml", version: cargoTomlVersion });

const cargoLock = await readFile(join(root, "src-tauri", "Cargo.lock"), "utf8");
const cargoLockVersion = /name = "moka-canvas"\nversion = "([^"]*)"/.exec(
  cargoLock,
)?.[1];
if (!cargoLockVersion) {
  console.error(
    "Could not read the moka-canvas entry from src-tauri/Cargo.lock.",
  );
  process.exit(1);
}
sources.push({ path: "src-tauri/Cargo.lock", version: cargoLockVersion });

const missing = sources.filter((source) => !source.version);
if (missing.length > 0) {
  for (const source of missing) {
    console.error(`${source.path}: no version found`);
  }
  process.exit(1);
}

const version = sources[0].version;
const mismatched = sources.filter((source) => source.version !== version);
if (mismatched.length > 0) {
  console.error(`Version mismatch; expected ${version} everywhere:`);
  for (const source of sources) {
    console.error(`  ${source.path}: ${source.version}`);
  }
  console.error(
    "Run `make set-version <version>` instead of editing files by hand.",
  );
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Version "${version}" is not a valid semantic version.`);
  process.exit(1);
}

if (tag !== undefined) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error(`Tag "${tag}" must look like vX.Y.Z (stable releases only).`);
    process.exit(1);
  }
  if (tag.slice(1) !== version) {
    console.error(
      `Tag ${tag} does not match the checked-in version ${version}.`,
    );
    process.exit(1);
  }
}

console.log(`Version check passed: ${version}`);
for (const source of sources) {
  console.log(`  ${source.path}`);
}
if (tag !== undefined) {
  console.log(`  tag ${tag}`);
}
