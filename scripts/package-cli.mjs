#!/usr/bin/env node
// Packs the standalone CLI: the binary, the Agent Skill, and a short README.
// This is the package for machines that cannot take the app installer, and the
// way AppImage users get `moka` onto their PATH at all.

import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function hostTriple() {
  const release = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return release
    .split("\n")
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length)
    .trim();
}

const triple = argument("--target") ?? hostTriple();
const extension = triple.includes("windows") ? ".exe" : "";
const platformName = triple.includes("windows")
  ? "windows"
  : triple.includes("apple")
    ? "macos"
    : "linux";
const arch = triple.startsWith("aarch64") ? "aarch64" : "x64";
const stageName = `moka-cli-${pkg.version}-${platformName}-${arch}`;
const release = join(root, "release");
// Staged outside release/: every file under release/ becomes a release asset,
// so the unpacked tree would otherwise be uploaded next to the archive.
const staging = await mkdtemp(join(tmpdir(), "moka-cli-"));
const stage = join(staging, stageName);

await mkdir(release, { recursive: true });
await mkdir(stage, { recursive: true });
await copyFile(
  join(root, "src-tauri", "binaries", `moka-${triple}${extension}`),
  join(stage, `moka${extension}`),
);
await mkdir(join(stage, "skills", "moka-canvas"), { recursive: true });
await copyFile(
  join(root, "skills", "moka-canvas", "SKILL.md"),
  join(stage, "skills", "moka-canvas", "SKILL.md"),
);
await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
await writeFile(
  join(stage, "README.txt"),
  `Moka Canvas CLI ${pkg.version}

Put moka${extension} on your PATH, or run it from here.

  moka doctor                 find the running Moka Canvas server
  moka tools list             the tool catalog
  moka --project <path> tools call canvas.list
  moka skills install --dir <agent-skills-dir>

The CLI talks to a running Moka Canvas server; nothing is uploaded.
`,
);

if (platformName === "windows") {
  const archive = join(release, `${stageName}.zip`);
  await rm(archive, { force: true });
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${stage}' -DestinationPath '${archive}'`,
    ],
    { stdio: "inherit" },
  );
  console.log(`Created ${archive}`);
} else {
  const archive = join(release, `${stageName}.tar.gz`);
  await rm(archive, { force: true });
  execFileSync("tar", ["-czf", archive, "-C", staging, stageName], {
    stdio: "inherit",
  });
  console.log(`Created ${archive}`);
}
await rm(staging, { recursive: true, force: true });
