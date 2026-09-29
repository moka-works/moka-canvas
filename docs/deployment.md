# Deployment

How to run `moka-server` outside the desktop app, and the constraints that come
with the file-backed metadata store.

## The short version

One server process, one metadata directory, on a local disk. There is no
horizontal scaling and no shared-state mode: the configuration store is a
directory of JSON documents guarded by a per-process advisory lock.

## Running the server

```sh
make package-web
cd release/moka-canvas-web-<version>-<platform>-<arch>
./moka-server --static-dir dist --port 8080
```

| Flag           | Default                            | Effect                                                 |
| -------------- | ---------------------------------- | ------------------------------------------------------ |
| `--config`     | `config/moka.yaml`, if it exists   | YAML configuration file                                |
| `--static-dir` | `server.staticDir` from the config | Built frontend to serve                                |
| `--port`       | `server.bind` from the config      | Overrides the port and pins the address to `127.0.0.1` |

The server starts from built-in defaults and reads nothing else, so a first run
needs no file at all. To tune it, copy the tracked example, which says what every
key means and otherwise agrees with those defaults one for one:

```sh
cp config/moka.example.yaml config/moka.yaml
```

`config/moka.yaml` is what one machine wants — an address, a set of ceilings —
and is ignored by git; `config/moka.example.yaml` is documentation and is
tracked. A path named with `--config` is a different matter: if it is not there,
startup fails rather than serving defaults nobody asked for, because a
deployment that meant to be read should not be quietly unread. Relative paths
inside a configuration file resolve against the working directory.

`--port` always binds loopback. Exposing the server on another interface means
editing `server.bind` in the configuration file, and means accepting that there
is no authentication layer: anyone who can reach the port can read and write
every project the process can open. Put it behind a reverse proxy that handles
identity if you need that at all.

## Metadata directory

Configuration, recent projects, model configurations, encrypted credentials, and
the prompt library live in one directory resolved at startup. The default is the
platform application-data directory (see [security.md](security.md)); override it
per deployment:

| Variable              | Overrides        | Notes                                                                                                                    |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MOKA_METADATA_DIR`   | `metadata.dir`   | Absolute path required                                                                                                   |
| `MOKA_METADATA_STORE` | `metadata.store` | Only `file` is accepted                                                                                                  |
| `MOKA_METADATA_KEY`   | —                | Base64 of 32 bytes; the server-mode master key. Optional — see [Credentials in server mode](#credentials-in-server-mode) |

Startup refuses the directory when it is relative, when it resolves inside the
executable's directory, the static asset directory, or the working directory, or
when it cannot be created and written. In each case the process exits with the
paths it tried rather than starting in a state where nothing is saved.

### It must be on a local disk

Not a network mount. Two parts of the write protocol degrade in ways that cannot
be detected reliably at runtime:

- `rename` is not atomic on some NFS and SMB configurations, so a reader can
  observe a half-written document;
- advisory lock semantics vary, so two hosts mounting the same share can both
  believe they hold the lock.

The first write probe runs at startup and a failure there is fatal, but a mount
that accepts writes and still breaks atomicity will not be caught. Keep the
directory on local storage.

### One process at a time

The directory holds a `.lock` file containing the owner's pid. A second process
that points at the same directory fails to start with `METADATA_UNAVAILABLE` and
names the pid holding it.

Consequences:

- **Multi-instance deployment is unsupported.** Several replicas sharing one
  directory will not work, and several replicas each with their own directory
  will silently diverge — there is no invalidation broadcast and no merge.
  Serving more than one user from a shared configuration requires a database
  backend, which does not exist yet.
- Running the desktop app and a hand-started `moka-server` against the same
  directory does not work either. The desktop app is already single-instance;
  the lock exists for exactly this combination.
- The lock is released when the process exits, including on `kill -9`, so a
  crash does not strand the directory.

## Containers

No image is published and the repository ships no Dockerfile; build one from
`make package-web` if you need it. Two things have to be true inside the
container:

- `MOKA_METADATA_DIR` points at a **mounted volume**. On a read-only root
  filesystem the process exits at startup without one.
- `MOKA_METADATA_KEY` is present if credentials are stored, or if they will be.
  Without it the first stored credential leaves a `master.key` inside the
  mounted volume — usable, but the weaker tier, and it only survives as long as
  the volume does.

```sh
docker run \
  -e MOKA_METADATA_DIR=/data/metadata \
  -e MOKA_METADATA_KEY="$MOKA_METADATA_KEY" \
  -v moka-metadata:/data \
  -p 127.0.0.1:8080:8080 \
  <your-image> --static-dir dist --port 8080
```

The volume must be local to the host, for the reasons given above — a network
volume reintroduces the atomicity problem.

## Logging

Both runtimes write one file per day under the `logs` subdirectory of the
platform application data directory — the same root the metadata directory
resolves from — and the two files never mix:

| Runtime       | File                     | Also on console                        |
| ------------- | ------------------------ | -------------------------------------- |
| `moka-server` | `moka-server.log.<date>` | yes — it is watched in a terminal      |
| desktop app   | `moka-app.log.<date>`    | no — a windowed program has no console |

On Windows that directory is `%APPDATA%\MokaCanvas\logs`, on
macOS `~/Library/Application Support/MokaCanvas/logs`, on
Linux `$XDG_DATA_HOME/mokacanvas/logs` — usually
`~/.local/share/mokacanvas/logs`. Files are kept, not rotated
away.

The filter defaults to `info`. `RUST_LOG` overrides it in both runtimes
(`RUST_LOG=debug moka-server …`). The desktop app, which is normally started by
a double-click and inherits no environment, can also be told from a file: write
one filter directive into `log.level` beside the `logs` directory —
`%APPDATA%\MokaCanvas\log.level` on Windows,
`~/.local/share/mokacanvas/log.level` on Linux — and restart:

```sh
# Windows
echo debug > "%APPDATA%\MokaCanvas\log.level"
# Linux
echo debug > ~/.local/share/mokacanvas/log.level
```

`RUST_LOG` wins over the file when both are there. A panicking app writes the
panic to the log file before the window closes, and a startup that fails before
the window is built is a line in the file rather than a program that seems
never to have run.

## Credentials in server mode

The desktop app takes its master key from the OS keychain. A server has no
desktop session, so it reads `MOKA_METADATA_KEY` or falls back to
`<metadata.dir>/master.key`.

If neither is there, the first credential stored creates
`<metadata.dir>/master.key` (`0600`) and the server logs a warning. Nothing is
refused, so a server started without the variable is still usable — but the key
then sits beside the ciphertext it protects and a backup of the directory
carries both. That is fine for a local, single-user server. Export a key for
anything else, and check `secretStorage` in `/api/health`: `file` means the
weaker tier.

If `secrets.json` already holds credentials and no master key is available,
startup fails with `CONFIG_METADATA_KEY_MISSING`. Supply the key that sealed
them rather than deleting the document — deleting it discards every stored
credential, and a key generated now opens none of them.

Generate one with either of:

```sh
openssl rand -base64 32
moka-server --generate-key
```

Treat it like any other production secret: inject it from the orchestrator's
secret store, not from a file in the image. Losing it makes the stored
credentials unrecoverable; there is no reset path that preserves them.

## Backup and restore

Backup is copying the directory:

```sh
cp -a "$MOKA_METADATA_DIR" /backups/moka-metadata-$(date +%F)
```

Copy the whole directory, including `master.key` if that is where the key lives.
Restoring is copying it back with the server stopped.

Note that a directory copied to another machine or another user account carries
the configuration but **not** the ability to decrypt credentials when the master
key sits in the OS keychain — the keychain entry does not travel with the files.
Server deployments that use `MOKA_METADATA_KEY` are portable as long as the key
value moves with the backup through whatever channel keeps it secret.

Project data is not in this directory. Projects live wherever the user put them
and are exported as `.moka` packages; see the release checklist.

## Upgrades and rollbacks

`meta.json` records a schema version. Only the version this build reads opens:
a directory stamped otherwise exits the process with
`METADATA_SCHEMA_UNSUPPORTED` and a message naming the version it found. Nothing
is migrated, downgraded, or overwritten in place — set the directory aside and
configure it anew.

Before rolling back the application version, back up the metadata directory
(whole-directory copy, as above). The rolled-back build refuses the directory
the newer one stamped, so it cannot start until the directory is restored from
that backup or set aside entirely.

Changing the bundle identifier changes the resolved directory. Point
`MOKA_METADATA_DIR` at the previous path to keep the existing configuration.

## Video export

Rendering a timeline to an MP4 runs on the machine the **server** runs on, through the ffmpeg that machine has. The program is found in three places, in order:

1. `clip.ffmpegPath` in the configuration file;
2. the `MOKA_FFMPEG` environment variable;
3. `ffmpeg` on the server process's `PATH`.

A level that names a path settles the question: if the file named there is not there, the search does not fall through to the next level, and the export reports itself unavailable rather than quietly using a different program than the one named. **On a server deployment, install ffmpeg on the server machine** — a client's ffmpeg is never used or looked for, and no request can name a program: the export body carries a timeline id and the destination path, and nothing else.

No ffmpeg is not a failure to start: the server, the editor, the preview, and every edit work as they are, and only the export dialog says what is missing and where it looked. The capability answer — version, path, encoder, whether text burn-in is possible (`ass`) — is probed once per process and cached.

One export runs at a time (`409 CONFLICT` for a second ask). Each render writes its filter graph and, when the timeline has text, a generated `subs.ass` into a temporary directory under the project's temp area (`export-<id>/`), which is removed on success, failure, cancellation, and timeout alike; a render outliving the request that started it is stopped by `DELETE /api/v1/clip/export/{id}`, and `clip.timeoutSeconds` (default 3600) stops one that runs too long. The finished render is copied to the destination the request named — the path the reader chose in a save dialog, which opens at the project's own `output` folder — and is not filed among the project's assets: the file the reader chose is the only copy the export makes.

Reference numbers to set expectations (1080p30, two layers, one crossfade, burn-in subtitles, `libx264 -preset medium -crf 18`): roughly 2–4× realtime on a current desktop, about 5–15 MB per minute of output. A machine with `h264_videotoolbox` or `h264_nvenc` is asked for those by name and renders at a fixed 12 Mbit/s instead of a quality target.

## The story room

The story room asks configured models for premises, chapters, elements, boards, and shots, and every ask is a batch: `POST /api/v1/projects/current/story/jobs` carries the kind and the pieces, `GET /api/v1/projects/current/story/jobs?storyId=` lists the project's batches, `GET /api/v1/projects/current/story/jobs/{id}` reads one, `POST /api/v1/projects/current/story/jobs/{id}/cancel` calls one off (a batch that already ended answers how it ended), and `POST /api/v1/projects/current/story/jobs/{id}/read` writes down that a settled batch's answer has been read into its story — an answer carrying that note is never read in again, whatever the reader has changed since, so a batch that answered days ago is not written over this afternoon's work. Results are filed into the project document by the client, one command per batch, so the document is the only thing that holds a story.

Batches are bounded twice over, and a deployment that expects several readers at once raises both:

| Key                             | Default | What it bounds                                                                                                                                                                                                                                                            |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `story.maxStoriesPerProject`    | 20      | How many stories one project may tell. The client enforces the same number, so a room that offers the button is never refused by a server that would not have taken it. The ceiling is also written into the document schema, so raising this key alone does not lift it. |
| `story.maxItemsPerJob`          | 40      | How many pieces one batch may carry. The client splits larger asks into waves and says which wave is out.                                                                                                                                                                 |
| `story.maxParallelItems`        | 2       | How many generations from _any_ batch are in flight at once. A batch of twenty waits its turn here rather than opening twenty calls.                                                                                                                                      |
| `story.maxActiveJobsPerProject` | 16      | How many batches one project may be driving at once; asking past it is refused with `409 STORY_JOB_BUSY`. Generous on purpose, since drawing a cast one card at a time is a batch per card — what is really in flight is bounded by `story.maxParallelItems`.             |
| `story.keepRecords`             | 100     | How many ended batch records the project keeps, besides the ones still running; older ones are pruned when the list is read.                                                                                                                                              |

Timeouts and retries are not story settings: a piece is a generation like any other and is carried with the ones under `generate:`, including which executors are enabled (a deployment with only `deterministic` runs no story jobs at all). A story's words are asked for as a stream, so `generate.textTimeoutSeconds` is how long one of them may stay silent rather than how long it may take — a thinking model that deliberates before its first word and a chapter's worth of json that arrives piece by piece are both waited out, and only a channel that has gone quiet is given up on.

Each batch is one file under `<project>/history/story-jobs/`, written by the process that drives it and pruned as above. A batch found still running when a project is opened is failed as interrupted and named to the client, which offers it as a retry — nothing is left waiting on a process that is gone.

The story room needs the same three capabilities as the rest of the product: **text** for premises, chapters, elements, boards, and shot lists; **image** for element art and key frames; **video** for the acts a telling is filmed in. **speech** and **music** are optional and asked for one act at a time: a speech model reads the lines aloud, and a music model plays the music and sound under an act. Each speaking part may name a speech model of its own — kept on the story, with the tone and the manner it is read in — and a batch still carries one model, so the client groups a press that reads a whole act by whoever speaks and sends one wave per model, one after another. Both land as ordinary assets — filed on the `voice` and `music` shelves, since which capability a piece was asked in is what files it — and the fifth step lays them on audio rows of their own under the film. A deployment with neither sound capability simply has no sound buttons to press. A story can be taken all the way to the board with text and image alone; the fifth step assembles only what has been filmed, and a machine without ffmpeg says so in the same words the cutting room does (see [Video export](#video-export)).

The two sound capabilities are configured apart: the `speech` default reads a telling's lines aloud, and the `music` default composes its scores. A score asked for with no music model configured is refused (`PROVIDER_NOT_CONFIGURED`) rather than answered by whatever speaks, so a deployment that wants both sets a default for each. Model Studio's music generation ships as the `bailianMusic` converter (a `music` model addressed at `.../api/v1/services/audio/music/generation`); it is deployed at startup like every other built-in converter, and a reader may copy or replace it under the models directory.

## Probes

| Endpoint          | Status     | Purpose                                                                                                                                                                                                                    |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health` | always 200 | Liveness plus metadata diagnostics: store kind, redacted root, schema version, secret-storage tier, and per-document size, revision, and corruption flags. `ok` is false when any document was reset from a damaged state. |
| `GET /api/ready`  | 200 or 503 | Readiness: the static asset directory exists, a full write probe against the metadata directory succeeded, and any open project directory still exists. The body lists each check.                                         |

Neither endpoint reports paths verbatim or any credential material.
