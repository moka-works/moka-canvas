// Runs the browser suite in shards, each an isolated suite of its own.
//
// The suite serializes because its server holds a machine's home — the
// launcher's recent projects and the application settings — and every case
// resets that shared ground. Sharding is therefore done here rather than in
// one process: each shard gets its own server, stand-in provider, metadata
// directory and Playwright output directory, so the shards never meet. What
// is shared is only the repository, the built site and the cargo target.
//
// Ports are derived from the suite's own two, ten apart per shard; the count
// is `MOKA_E2E_SHARDS` (default 2) and arguments after `--` are passed to
// every shard, so a narrowed run stays sharded the same way.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** A positive whole number out of the environment, or what stands when unset. */
function count(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number, not "${raw}"`);
  }
  return value;
}

/** How far apart two shards' ports stand. */
const PORT_STEP = 10;
/** A ceiling rather than a promise: more shards than cores do not go faster. */
const MAX_SHARDS = 16;

const shards = count("MOKA_E2E_SHARDS", 2);
if (shards > MAX_SHARDS) {
  throw new Error(`MOKA_E2E_SHARDS may be at most ${MAX_SHARDS}`);
}
const serverBase = count("MOKA_E2E_PORT", 8971);
const providerBase = count("MOKA_E2E_PROVIDER_PORT", 8972);

const addresses = [];
for (let index = 0; index < shards; index += 1) {
  const server = serverBase + index * PORT_STEP;
  const provider = providerBase + index * PORT_STEP;
  for (const port of [server, provider]) {
    if (port > 65535) {
      throw new Error(
        `port ${port} runs past the end; use fewer shards or lower bases`,
      );
    }
    if (addresses.includes(port)) {
      throw new Error(
        `port ${port} would be spoken to by two shards; space the bases apart`,
      );
    }
    addresses.push(port);
  }
}

const cli = resolve(root, "node_modules", "playwright", "cli.js");
const forwarded = process.argv.slice(2);
const running = [];

/** Writes a child's output under the shard it came from, line by line. */
function relay(stream, tag) {
  readline.createInterface({ input: stream }).on("line", (line) => {
    process.stdout.write(`${tag}${line}\n`);
  });
}

for (let index = 0; index < shards; index += 1) {
  const server = serverBase + index * PORT_STEP;
  const provider = providerBase + index * PORT_STEP;
  const child = spawn(
    process.execPath,
    [
      cli,
      "test",
      `--shard=${index + 1}/${shards}`,
      // A narrowed run may leave a shard with nothing to do; that shard has
      // not failed, and the others still say what the suite did.
      "--pass-with-no-tests",
      ...forwarded,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MOKA_E2E_PORT: String(server),
        MOKA_E2E_PROVIDER_PORT: String(provider),
      },
      // stdin is left alone: nothing in the suite reads it, and sharing one
      // terminal between several reporters would only make the output worse.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  relay(child.stdout, `[e2e ${index + 1}/${shards}] `);
  relay(child.stderr, `[e2e ${index + 1}/${shards}] `);
  running.push(child);
}

// A shard is left to finish its own work when another fails, so the report
// says what every part of the suite did rather than only where it stopped.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of running) child.kill(signal);
  });
}

const results = await Promise.all(
  running.map(
    (child) =>
      new Promise((done) => {
        child.on("close", (code, signal) => done(code ?? (signal ? 1 : 0)));
      }),
  ),
);
const failures = results.filter((code) => code !== 0).length;
if (failures > 0) {
  console.error(`[e2e] ${failures} of ${shards} shards failed`);
}
process.exitCode = failures === 0 ? 0 : 1;
