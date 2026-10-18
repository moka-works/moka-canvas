import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const extension = platform() === "win32" ? ".exe" : "";
const binary = join(
  root,
  "src-tauri",
  "target",
  "release",
  `moka-server${extension}`,
);
const destination = join(
  root,
  "release",
  `moka-canvas-web-${pkg.version}-${platform()}-${process.arch}`,
);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(join(root, "dist"), join(destination, "dist"), { recursive: true });
await cp(binary, join(destination, basename(binary)));
// The package ships the example only. A server with no config/moka.yaml runs on
// built-in defaults, which is what a first run wants; the example is there to be
// copied into a deployment's own file, not to be read as one.
await mkdir(join(destination, "config"), { recursive: true });
await cp(
  join(root, "config", "moka.example.yaml"),
  join(destination, "config", "moka.example.yaml"),
);
await writeFile(
  join(destination, "README.txt"),
  `Moka Canvas ${pkg.version}\n\nRun ./moka-server${extension} --static-dir dist --port 8080, then open http://127.0.0.1:8080.\n\nTo change anything the server does — its address, what it waits for, what it refuses — copy config/moka.example.yaml to config/moka.yaml and edit that; with no such file every value stays at its default. The address alone can also be named here: --host 0.0.0.0 listens on every interface, and a server reachable from elsewhere has nothing checking who is calling.\n`,
);
console.log(`Created ${destination}`);
