import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const source = option("--source") ?? "artifacts";
const dest = option("--dest") ?? "dist";
const requireAll = process.argv.includes("--require-all");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = option("--version") ?? pkg.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version "${version}" must look like x.y.z.`);
  process.exit(1);
}

const sourceRoot = isAbsolute(source) ? source : join(root, source);
const destRoot = isAbsolute(dest) ? dest : join(root, dest);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function artifactGroup(path) {
  const parts = relative(sourceRoot, path).split(sep);
  return parts.find((part) => part.startsWith("bundle-"));
}

function targetName(group, filename) {
  const lower = filename.toLowerCase();

  if (group === "bundle-macos-arm64") {
    if (lower.endsWith(".app.tar.gz.sig")) {
      return `moka-canvas-${version}-macos-aarch64.app.tar.gz.sig`;
    }
    if (lower.endsWith(".app.tar.gz")) {
      return `moka-canvas-${version}-macos-aarch64.app.tar.gz`;
    }
    if (lower.endsWith(".dmg")) {
      return `moka-canvas-${version}-macos-aarch64.dmg`;
    }
    if (lower.endsWith(".pkg")) {
      return `moka-canvas-${version}-macos-aarch64.pkg`;
    }
  }

  if (group === "bundle-macos-x64") {
    if (lower.endsWith(".app.tar.gz.sig")) {
      return `moka-canvas-${version}-macos-x64.app.tar.gz.sig`;
    }
    if (lower.endsWith(".app.tar.gz")) {
      return `moka-canvas-${version}-macos-x64.app.tar.gz`;
    }
    if (lower.endsWith(".dmg")) {
      return `moka-canvas-${version}-macos-x64.dmg`;
    }
    if (lower.endsWith(".pkg")) {
      return `moka-canvas-${version}-macos-x64.pkg`;
    }
  }

  if (group === "bundle-windows-x64") {
    if (lower.endsWith(".exe.sig")) {
      return `moka-canvas-${version}-windows-x64-setup.exe.sig`;
    }
    if (lower.endsWith(".exe")) {
      return `moka-canvas-${version}-windows-x64-setup.exe`;
    }
    if (lower.endsWith(".msi")) {
      return `moka-canvas-${version}-windows-x64.msi`;
    }
  }

  if (group === "bundle-linux-x64") {
    if (lower.endsWith(".appimage.sig")) {
      return `moka-canvas-${version}-linux-x64.AppImage.sig`;
    }
    if (lower.endsWith(".appimage")) {
      return `moka-canvas-${version}-linux-x64.AppImage`;
    }
    if (lower.endsWith(".deb")) {
      return `moka-canvas-${version}-linux-x64.deb`;
    }
    if (lower.endsWith(".rpm")) {
      return `moka-canvas-${version}-linux-x64.rpm`;
    }
  }

  if (
    lower.startsWith("moka-cli-") &&
    (lower.endsWith(".tar.gz") || lower.endsWith(".zip"))
  ) {
    return filename;
  }

  if (group === "bundle-web-linux-x64" && lower.endsWith(".tgz")) {
    return `moka-canvas-web-${version}-linux-x64.tgz`;
  }

  return undefined;
}

let files;
try {
  files = await walk(sourceRoot);
} catch (error) {
  console.error(`Cannot read artifact directory ${source}: ${error.message}`);
  process.exit(1);
}

const assets = new Map();
const versionTags = [`_${version}_`, `-${version}-`];
for (const file of files) {
  const group = artifactGroup(file);
  if (!group) {
    continue;
  }
  const filename = file.split(sep).pop();
  const name = targetName(group, filename);
  if (!name) {
    continue;
  }
  if (!versionTags.some((tag) => filename.includes(tag))) {
    console.error(`Artifact does not carry version ${version}: ${file}`);
    process.exit(1);
  }
  if (assets.has(name)) {
    console.error(
      `Two artifacts would become ${name}:\n  ${assets.get(name).source}\n  ${file}`,
    );
    process.exit(1);
  }
  if ((await stat(file)).size === 0) {
    console.error(`Artifact is empty: ${file}`);
    process.exit(1);
  }
  assets.set(name, {
    source: file,
    sourceName: relative(sourceRoot, file).split(sep).join("/"),
  });
}

const required = [
  `moka-canvas-${version}-macos-aarch64.dmg`,
  `moka-canvas-${version}-macos-aarch64.pkg`,
  `moka-canvas-${version}-macos-x64.dmg`,
  `moka-canvas-${version}-macos-x64.pkg`,
  `moka-cli-${version}-macos-aarch64.tar.gz`,
  `moka-cli-${version}-macos-x64.tar.gz`,
  `moka-cli-${version}-windows-x64.zip`,
  `moka-cli-${version}-linux-x64.tar.gz`,
  `moka-canvas-${version}-windows-x64-setup.exe`,
  `moka-canvas-${version}-windows-x64.msi`,
  `moka-canvas-${version}-linux-x64.deb`,
  `moka-canvas-${version}-linux-x64.rpm`,
  `moka-canvas-${version}-linux-x64.AppImage`,
  `moka-canvas-web-${version}-linux-x64.tgz`,
];

if (requireAll) {
  const missing = required.filter((name) => !assets.has(name));
  if (missing.length > 0) {
    console.error("Missing required release assets:");
    for (const name of missing) {
      console.error(`  ${name}`);
    }
    process.exit(1);
  }
}

if (assets.size === 0) {
  console.error(`No recognized release assets found under ${source}.`);
  process.exit(1);
}

await rm(destRoot, { recursive: true, force: true });
await mkdir(destRoot, { recursive: true });

const assetMap = {};
for (const [name, asset] of assets) {
  await cp(asset.source, join(destRoot, name));
  assetMap[asset.sourceName] = name;
  console.log(`${asset.sourceName} -> ${name}`);
}

const published = [...assets.keys()].sort();
const checksumLines = [];
for (const name of published) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(destRoot, name))) {
    hash.update(chunk);
  }
  checksumLines.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(
  join(destRoot, "SHA256SUMS.txt"),
  `${checksumLines.join("\n")}\n`,
);
await writeFile(
  join(destRoot, "asset-map.json"),
  `${JSON.stringify({ version, assets: assetMap }, null, 2)}\n`,
);

console.log(`Prepared ${published.length} assets in ${dest}/.`);
if (requireAll) {
  console.log("All required release assets are present.");
}
