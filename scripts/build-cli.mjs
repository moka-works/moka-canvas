#!/usr/bin/env node
// Builds the `moka` CLI for one target and lays it where Tauri's externalBin
// and the Linux package file map expect it.
//
// The bundle looks for `binaries/moka-<target-triple>` (Tauri appends the
// triple itself) and the deb/rpm file map copies `binaries/moka` to
// /usr/bin/moka, so both names are written here.

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cargoTargetDir } from "./checkout.mjs";

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

const triple =
  argument("--target") ?? process.env.CARGO_BUILD_TARGET ?? hostTriple();
if (!triple) {
  console.error("Could not determine the target triple; pass --target.");
  process.exit(1);
}
const extension = triple.includes("windows") ? ".exe" : "";
const targetDir = process.env.CARGO_TARGET_DIR ?? cargoTargetDir(root);

console.log(`Building moka for ${triple}`);
execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--manifest-path",
    join(root, "src-tauri", "Cargo.toml"),
    "--bin",
    "moka",
    "--target",
    triple,
  ],
  { stdio: "inherit", cwd: root },
);

const built = join(targetDir, triple, "release", `moka${extension}`);
const version = execFileSync(built, ["--version"], { encoding: "utf8" }).trim();
if (!version.endsWith(pkg.version)) {
  console.error(
    `The CLI reports ${version}, but package.json is ${pkg.version}. Run make set-version first.`,
  );
  process.exit(1);
}

const binaries = join(root, "src-tauri", "binaries");
await mkdir(binaries, { recursive: true });
const suffixed = join(binaries, `moka-${triple}${extension}`);
const plain = join(binaries, `moka${extension}`);
await copyFile(built, suffixed);
await copyFile(built, plain);
if (process.platform !== "win32") {
  await chmod(suffixed, 0o755);
  await chmod(plain, 0o755);
}
console.log(`CLI ${version} -> ${suffixed}`);
