// Boots the local server for Playwright against a throwaway config:
// a temp metadata directory and the built dist/ site. The server's
// log is written to a file so test output stays readable; its path is
// printed here and the tail is dumped on unexpected exit.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const port = process.env.MOKA_E2E_PORT ?? "8971";
const dist = join(repoRoot, "dist");

if (!existsSync(join(dist, "index.html"))) {
  console.error(
    "dist/index.html is missing — run `make web-build` before the browser suite.",
  );
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "moka-e2e-"));
const configPath = join(home, "config.yaml");
writeFileSync(
  configPath,
  `version: 1
server:
  bind: "127.0.0.1:${port}"
  staticDir: ${JSON.stringify(dist)}
  maxUploadBytes: 2147483648
projects:
  maxMokaFileBytes: 33554432
metadata:
  store: "file"
  dir: ${JSON.stringify(join(home, "metadata"))}
  maxDocumentBytes: 33554432
workflow:
  enabledExecutors: ["deterministic", "provider"]
public:
  productName: "Moka Canvas"
  maxUploadBytes: 2147483648
  allowedMediaTypes: ["image", "audio", "video", "text"]
limits:
  maxNodesPerCanvas: 5000
  maxEdgesPerCanvas: 10000
  maxCanvasesPerProject: 64
`,
);

const serverLog = join(home, "server.log");
const log = (line) => process.stdout.write(`[e2e-server] ${line}\n`);
log(`home: ${home}`);
log(`server log: ${serverLog}`);

// A converter the suite can read a reference recording off the wire with: the
// registry is files under the models tree, so dropping one in the throwaway
// home's is enough for the server to find it, and the directory's name is the
// protocol id the specs configure their models with.
const modelsRoot = join(home, "models", "speech", "e2eCloneSpeech");
mkdirSync(modelsRoot, { recursive: true });
for (const name of ["model.json", "clone-speech.lua"]) {
  copyFileSync(
    join(repoRoot, "e2e", "fixtures", "cloneSpeech", name),
    join(modelsRoot, name),
  );
}
log(`fixture converter: e2eCloneSpeech deployed under ${modelsRoot}`);

// Server mode will not invent a master key, so without one a channel could
// hold no credential and nothing could reach a provider. Generated per boot
// and never printed: it protects a directory that is thrown away anyway.
const metadataKey = randomBytes(32).toString("base64");
log("metadata key: generated for this boot");

// The renderer is pointed at a path that is never there, so the export's
// "no ffmpeg" path is the same on every machine: the suite asserts the
// unavailable dialog, and a developer whose PATH happens to carry ffmpeg
// does not get a different test than CI does.
const ffmpegPath = process.env.MOKA_FFMPEG ?? "/nonexistent/ffmpeg";
log(`ffmpeg: pointed at ${ffmpegPath}`);

const child = spawn(
  "cargo",
  [
    "run",
    "--manifest-path",
    join(repoRoot, "src-tauri", "Cargo.toml"),
    "--bin",
    "moka-server",
    "--",
    "--config",
    configPath,
  ],
  {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MOKA_METADATA_KEY: metadataKey,
      MOKA_FFMPEG: ffmpegPath,
    },
  },
);
const logStream = createWriteStream(serverLog);
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

function tail(path, lines) {
  try {
    return readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "(no log)";
  }
}

child.on("exit", (code, signal) => {
  if (!stopping) {
    log(
      `server exited unexpectedly (code=${code} signal=${signal}); log tail:`,
    );
    console.error(tail(serverLog, 40));
  }
  process.exit(stopping ? 0 : 1);
});
