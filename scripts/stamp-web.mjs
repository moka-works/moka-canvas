#!/usr/bin/env node
// Stamps the frontend build with the commit it was made from.
//
// A package carries a copy of dist/ into the app's resources, and nothing in
// that copy says which source it came from. The stamp is what lets packaging
// tell today's frontend from one left behind by an earlier build: the package
// refuses a dist/ whose stamp does not name the commit it is being built
// from, and the installed app can be asked the same question.
//
// `npm run build` runs this through the postbuild hook, so every supported
// way of building the frontend — make web-build, tauri dev, tauri build —
// stamps what it wrote rather than only the ones somebody remembered.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

if (!existsSync(join(dist, "index.html"))) {
  console.error(
    "stamp-web: dist/index.html is missing — the frontend build did not finish",
  );
  process.exit(1);
}

/** One git command's answer, or nothing when git is unavailable. */
function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const commit = git("rev-parse", "--short", "HEAD") || "unknown";
// Untracked files are the checkout's own business; a tracked change means the
// built frontend carries code that is not in the commit the stamp names.
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
await writeFile(
  join(dist, "moka-build.json"),
  `${JSON.stringify(
    {
      commit,
      version: pkg.version,
      dirty,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `stamp-web: dist/ is frontend ${commit}${dirty ? " (working tree has changes)" : ""}`,
);
