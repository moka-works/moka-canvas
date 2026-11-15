#!/usr/bin/env node
// Clears the bundle outputs of earlier runs before a package target builds.
//
// tauri-bundler writes fixed paths under target/*/release/bundle, and the
// release collector copies every matching artifact it finds there. A DMG or
// installer left by an earlier build of the same version is indistinguishable
// by name, so the only safe starting point is none: a package that fails to
// produce its own artifact then fails loudly instead of releasing the one
// from yesterday.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDir } from "./checkout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = process.env.CARGO_TARGET_DIR ?? cargoTargetDir(root);

async function removeBundle(dir) {
  try {
    if (!(await stat(dir)).isDirectory()) return;
  } catch {
    return;
  }
  await rm(dir, { recursive: true, force: true });
  console.log(`clean-bundles: removed ${dir}`);
}

await removeBundle(join(target, "release", "bundle"));
let entries = [];
try {
  entries = await readdir(target, { withFileTypes: true });
} catch {
  // Nothing has been built under this target yet.
}
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  // Cross-compiled packages (an Intel macOS or Windows target) keep their
  // bundles under a directory named after the triple.
  await removeBundle(join(target, entry.name, "release", "bundle"));
}
