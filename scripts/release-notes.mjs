import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const version = option("--version");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    "Usage: node scripts/release-notes.mjs --version <x.y.z> [--out release-notes.md]",
  );
  process.exit(1);
}

const out = option("--out") ?? "release-notes.md";
const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
const lines = changelog.split(/\r?\n/);
const escapedVersion = version.replaceAll(".", "\\.");
const heading = new RegExp(`^## v${escapedVersion}(?:\\s|$)`);

const start = lines.findIndex((line) => heading.test(line));
if (start === -1) {
  const available = lines
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3));
  console.error(`CHANGELOG.md has no section for v${version}.`);
  if (available.length > 0) {
    console.error(`Sections present: ${available.join(", ")}`);
  }
  process.exit(1);
}

let end = lines.findIndex(
  (line, index) => index > start && line.startsWith("## "),
);
if (end === -1) {
  end = lines.length;
}

const notes = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (!notes) {
  console.error(`CHANGELOG.md section v${version} is empty.`);
  process.exit(1);
}

await writeFile(isAbsolute(out) ? out : join(root, out), `${notes}\n`);
console.log(`Wrote ${out} from CHANGELOG.md v${version}.`);
