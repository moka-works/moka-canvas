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
const tag = option("--tag") ?? `v${version}`;
const repo = option("--repo") ?? "moka-works/moka-canvas";
const notesFile = option("--notes-file");

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version "${version}" must look like x.y.z.`);
  process.exit(1);
}
if (tag !== `v${version}`) {
  console.error(`Tag ${tag} must name the release of version ${version}.`);
  process.exit(1);
}
if (requireAll && notesFile === undefined) {
  console.error("A complete release needs --notes-file for the update notes.");
  process.exit(1);
}

/** Release notes are read as words, not as a document the update UI renders. */
function plainNotes(markdown) {
  return (
    markdown
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^#{1,6}\s+/, "")
          .replace(/^>\s?/, "")
          .replace(/^\s*[-*+]\s+/, "• ")
          .replace(/\*\*(.*?)\*\*/g, "$1")
          .replace(/`([^`]*)`/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"),
      )
      .join("\n")
      // The version heading only repeats what the update row already says.
      .replace(/^\s*v\d+\.\d+\.\d+(?:\s*[-–]\s*\d{4}-\d{2}-\d{2})?\s*$/m, "")
      .trim()
      .slice(0, 1_000)
      .trim()
  );
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
const versionPattern = new RegExp(
  `(?:^|[^0-9])${version.replace(/\./g, "\\.")}(?![0-9])`,
);
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
  // The macOS updater archive is named after the app bundle and carries no
  // version; its artifact directory is what says which build it belongs to.
  const updaterArchive =
    group.startsWith("bundle-macos") &&
    /\.app\.tar\.gz(\.sig)?$/.test(filename);
  if (!updaterArchive && !versionPattern.test(filename)) {
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
  `moka-canvas-${version}-macos-aarch64.app.tar.gz`,
  `moka-canvas-${version}-macos-aarch64.app.tar.gz.sig`,
  `moka-canvas-${version}-macos-x64.dmg`,
  `moka-canvas-${version}-macos-x64.pkg`,
  `moka-canvas-${version}-macos-x64.app.tar.gz`,
  `moka-canvas-${version}-macos-x64.app.tar.gz.sig`,
  `moka-cli-${version}-macos-aarch64.tar.gz`,
  `moka-cli-${version}-macos-x64.tar.gz`,
  `moka-cli-${version}-windows-x64.zip`,
  `moka-cli-${version}-linux-x64.tar.gz`,
  `moka-canvas-${version}-windows-x64-setup.exe`,
  `moka-canvas-${version}-windows-x64-setup.exe.sig`,
  `moka-canvas-${version}-windows-x64.msi`,
  `moka-canvas-${version}-linux-x64.deb`,
  `moka-canvas-${version}-linux-x64.rpm`,
  `moka-canvas-${version}-linux-x64.AppImage`,
  `moka-canvas-${version}-linux-x64.AppImage.sig`,
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

let notes = `Moka Canvas ${version}`;
if (notesFile !== undefined) {
  const path = isAbsolute(notesFile) ? notesFile : join(root, notesFile);
  notes = plainNotes(await readFile(path, "utf8"));
  if (notes === "") {
    console.error(`Release notes ${notesFile} are empty.`);
    process.exit(1);
  }
}

const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {},
};

async function signatureOf(name) {
  const signature = (await readFile(join(destRoot, name), "utf8")).trim();
  if (signature === "") {
    console.error(`Signature is empty: ${name}`);
    process.exit(1);
  }
  return signature;
}

async function addUpdater(key, artifact) {
  const signatureName = `${artifact}.sig`;
  if (!assets.has(artifact) || !assets.has(signatureName)) return false;
  manifest.platforms[key] = {
    signature: await signatureOf(signatureName),
    url: `${baseUrl}/${artifact}`,
  };
  return true;
}

const macArm = `moka-canvas-${version}-macos-aarch64.app.tar.gz`;
const macX64 = `moka-canvas-${version}-macos-x64.app.tar.gz`;
const windows = `moka-canvas-${version}-windows-x64-setup.exe`;
const linux = `moka-canvas-${version}-linux-x64.AppImage`;

// Both the bundle key and the bare platform key are written: the updater asks
// for the bundle it was installed as first and falls back to the platform.
await addUpdater("darwin-aarch64", macArm);
await addUpdater("darwin-aarch64-app", macArm);
await addUpdater("darwin-x86_64", macX64);
await addUpdater("darwin-x86_64-app", macX64);
await addUpdater("windows-x86_64", windows);
await addUpdater("windows-x86_64-nsis", windows);
// Linux writes the bundle key only: a deb/rpm install falling back to the bare
// key would download an AppImage it cannot install.
await addUpdater("linux-x86_64-appimage", linux);

if (requireAll) {
  const expected = [
    "darwin-aarch64",
    "darwin-aarch64-app",
    "darwin-x86_64",
    "darwin-x86_64-app",
    "windows-x86_64",
    "windows-x86_64-nsis",
    "linux-x86_64-appimage",
  ];
  const absent = expected.filter((key) => !(key in manifest.platforms));
  if (absent.length > 0) {
    console.error(
      `The update manifest is missing platforms: ${absent.join(", ")}`,
    );
    process.exit(1);
  }
}

await writeFile(
  join(destRoot, "asset-map.json"),
  `${JSON.stringify({ version, assets: assetMap }, null, 2)}\n`,
);
await writeFile(
  join(destRoot, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const checksumLines = [];
for (const name of [...published, "latest.json"]) {
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

console.log(`Prepared ${published.length} assets in ${dest}/.`);
console.log(
  `Update manifest lists: ${Object.keys(manifest.platforms).join(", ")}`,
);
if (requireAll) {
  console.log("All required release assets are present.");
}
