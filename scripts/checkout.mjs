// One rule for what a checkout builds with and where it keeps what it builds.
// The main checkout and every worktree compile into src-tauri/target: sccache's
// Rust keys are built from paths relative to the checkout, so a differently
// named directory would forfeit the shared cache. qoder worktrees symlink that
// path into the main checkout, which makes parallel builds queue on one cargo
// lock and overwrite one target/debug/<binary>; the symlink is replaced with a
// directory of the worktree's own. A worktree also keeps its metadata beside
// it rather than inside it — the server rejects a metadata directory under the
// working directory — because the default one is locked by whichever server
// holds it, so two worktrees could not run one server each.
import {
  accessSync,
  constants,
  lstatSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkoutRoot() {
  return resolve(new URL("..", import.meta.url).pathname);
}

function isLinkedWorktree(root) {
  return (
    statSync(join(root, ".git"), { throwIfNoEntry: false })?.isFile() ?? false
  );
}

export function cargoTargetDir(root) {
  return join(root, "src-tauri", "target");
}

export function worktreeMetadataDir(root) {
  if (!isLinkedWorktree(root)) {
    return "";
  }
  return join(dirname(root), `.${basename(root)}.metadata`);
}

export function ensurePrivateTarget(root) {
  if (!isLinkedWorktree(root)) {
    return false;
  }
  const target = cargoTargetDir(root);
  if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return false;
  }
  // Only the link goes; whatever it pointed at belongs to another checkout.
  unlinkSync(target);
  process.stderr.write(
    `moka: ${target} pointed at another checkout; this worktree now builds there itself\n`,
  );
  return true;
}

export function sccacheOnPath() {
  const name = process.platform === "win32" ? "sccache.exe" : "sccache";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this directory.
    }
  }
  return false;
}

// The environment every cargo invocation of this checkout should carry, with an
// explicit variable winning as it does in the Makefile. With sccache the
// compiled crates of one checkout answer for the next: one base per checkout
// makes rustc's paths relative, so the main checkout and every worktree share
// entries. sccache does not cache incremental compilations, so those are off.
export function cargoEnv(root) {
  const env = {
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? cargoTargetDir(root),
  };
  const wrapper =
    process.env.RUSTC_WRAPPER ?? (sccacheOnPath() ? "sccache" : "");
  if (wrapper) {
    env.RUSTC_WRAPPER = wrapper;
    if (wrapper === "sccache") {
      if (!process.env.SCCACHE_BASEDIR) {
        env.SCCACHE_BASEDIR = resolve(root);
      }
      if (!process.env.CARGO_INCREMENTAL) {
        env.CARGO_INCREMENTAL = "0";
      }
    }
  }
  return env;
}

// `node scripts/checkout.mjs` prepares this checkout and prints its target
// directory; `--metadata-dir` prints the metadata directory a worktree keeps
// (nothing for the main checkout, which uses the platform default).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = checkoutRoot();
  ensurePrivateTarget(root);
  process.stdout.write(
    process.argv.includes("--metadata-dir")
      ? worktreeMetadataDir(root)
      : cargoTargetDir(root),
  );
}
