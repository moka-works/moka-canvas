#!/usr/bin/env node
// Downloads the faces the burn-in is written in when this checkout does not
// have them. They are 11 MB together and change only when the renderer's
// contract does, so they live in moka-works/assets rather than in this
// history; the bytes are pinned here so a build gets exactly the faces the
// code was written against, not whatever that repository carries today.
//
// `make fonts` runs this before anything that compiles the Rust crate, and the
// scripts that compile on their own (build-cli, e2e-server) call ensureFonts
// first. Each face already present and matching its hash is left alone, so a
// warm checkout never touches the network.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(root, "src-tauri", "assets", "fonts");
const source = "https://github.com/moka-works/assets/raw/refs/heads/main/fonts";

export const FACES = [
  {
    name: "Inter-Regular.ttf",
    sha256: "eaf024c4e0f2077b3fa7478b81f346b964be5758652126757d29143e97bd912c",
  },
  {
    name: "NotoSansSC-Regular.ttf",
    sha256: "1af592b14ce725a8bfe88ca6b0aaff08223765a99e4c673403bd40e2a525353a",
  },
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function localHash(path) {
  try {
    return digest(await readFile(path));
  } catch {
    return null;
  }
}

async function download(face, path) {
  const url = `${source}/${face.name}`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  } catch (error) {
    throw new Error(
      `could not reach ${url}: ${error.cause?.message ?? error.message}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${url} answered HTTP ${response.status} ${response.statusText}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = digest(bytes);
  if (actual !== face.sha256) {
    throw new Error(
      `${face.name} from ${url} has SHA-256 ${actual}, not the pinned ${face.sha256}`,
    );
  }
  // The temp name sits beside the target so the rename stays on one filesystem.
  const staged = `${path}.download`;
  try {
    await writeFile(staged, bytes);
    await rename(staged, path);
  } catch (error) {
    await rm(staged, { force: true });
    throw new Error(`could not write ${path}: ${error.message}`);
  }
  return bytes.length;
}

// Fetches whatever is missing or no longer matches its pinned hash. Returns the
// names it downloaded; an empty list means the checkout was already complete.
export async function ensureFonts({ log = console.log } = {}) {
  await mkdir(directory, { recursive: true });
  const fetched = [];
  for (const face of FACES) {
    const path = join(directory, face.name);
    if ((await localHash(path)) === face.sha256) continue;
    const size = await download(face, path);
    log(`moka: fetched ${face.name} (${size} bytes) into ${directory}`);
    fetched.push(face.name);
  }
  return fetched;
}

async function main() {
  try {
    const fetched = await ensureFonts();
    if (fetched.length === 0) {
      console.log(`moka: the burn-in faces are already in ${directory}`);
    }
  } catch (error) {
    console.error(`moka: ${error.message}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
