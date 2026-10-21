# Security

What the application does to protect credentials and configuration, and — just
as importantly — what it does not.

## Metadata directory

Application-level configuration lives in a single directory outside the program
tree, resolved at startup:

| Runtime | macOS                                                 | Windows                           | Linux                                  |
| ------- | ----------------------------------------------------- | --------------------------------- | -------------------------------------- |
| Desktop | `~/Library/Application Support/<identifier>/metadata` | `%APPDATA%\<identifier>\metadata` | `~/.local/share/<identifier>/metadata` |
| Server  | same                                                  | same                              | same                                   |

`<identifier>` is the bundle identifier from `src-tauri/tauri.conf.json`. Both
runtimes derive it from one constant so that the desktop app and a hand-started
`moka-server` on the same machine see the same configuration.

Placing the directory inside the executable's directory, the static asset
directory, or the working directory is rejected at startup with
`CONFIG_METADATA_DIR_INVALID` rather than warned about. Project content never
goes through this layer: canvases, assets, and run history stay inside the
project directory.

Override the location with `MOKA_METADATA_DIR` (see
[deployment.md](deployment.md)).

## API keys

A provider API key is written to disk only as ciphertext:

```
base64( nonce(12 bytes) ‖ AES-256-GCM(master key, plaintext, aad = model config id) )
```

The model configuration id is bound as additional authenticated data, so
copying one model's ciphertext under another model's entry fails to decrypt
rather than silently leaking a key to the wrong provider.

`models.json` carries no key field of any kind — not an empty one, not a
placeholder. Credentials live in `secrets.json`, which is written `0600` inside a
`0700` directory on Unix.

### Master key

| Runtime | Sources, in order                                                          |
| ------- | -------------------------------------------------------------------------- |
| Desktop | OS keychain, then `<metadata.dir>/master.key` (`0600`)                     |
| Server  | `MOKA_METADATA_KEY` (base64 of 32 bytes), then `<metadata.dir>/master.key` |

Neither source has to exist beforehand. When the first credential is stored and
no key can be found, one is generated: into the keychain on a desktop, into
`<metadata.dir>/master.key` (`0600`) on a server. A server started without an
exported key therefore still accepts an API key instead of failing the moment
someone types one — at the cost of landing on the weakest tier, where the key
sits beside the ciphertext it protects and a copy of the directory carries
both. Export `MOKA_METADATA_KEY` for anything beyond a local, single-user
deployment; `moka-server --generate-key` prints a value.

`/api/health` and every `/api/v1/providers` response report which tier is in
use as `secretStorage` (`keyring`, `env`, `file`, or `unset` while nothing has
been stored), and the settings page repeats it next to the API key field, so
the current level is visible without exposing the key.

If credentials are already on disk and no master key can be found, server
startup fails with `CONFIG_METADATA_KEY_MISSING` rather than generating a key
that would open none of them. Starting anyway would produce the confusing state
where configuration looks complete but every generation request is rejected by
the provider.

### What encryption does and does not buy

The honest positioning, and the one the UI must not overstate:

- **It does** keep plaintext keys out of the metadata directory, out of logs,
  out of HTTP responses, and out of exported project packages. With the key in
  the keychain or exported through the environment it also keeps them out of
  backups of that directory; with a file-held key the backup carries the key
  alongside the ciphertext, so that part of the guarantee is only as strong as
  the tier in use. A misconfigured sync client that uploads the directory does
  not upload usable keys unless it also uploads a file-held master key with
  them.
- **It does not** defend against malware running as the same user. Such a
  process can read the keychain entry or `master.key` and can call the running
  application's own API. This is encryption at rest against accidental exposure,
  not a sandbox.

Never describe stored keys as "secure" or "encrypted, safe" in product copy.
Describe where they are and what they are protected from.

### Redaction

Only two derived forms of a key may leave this layer:

- `fingerprint` — the first 8 hex characters of `sha256(key)`, for matching a
  key across sessions without revealing it;
- `masked` — the first 3 and last 4 characters, for confirming in the UI which
  key is stored.

Both come from one module (`src-tauri/src/metadata/redact.rs`); telemetry and the
HTTP layer reuse it rather than formatting keys themselves. Plaintext keys are
never logged, never serialised into a response body, and never included in an
error message.

Rotation replaces the entry for a model configuration and updates `rotatedAt`. Previous
ciphertext is not retained, so an old copy of `secrets.json` cannot be used to
recover a superseded key.

### Where a key is allowed to travel

A key leaves this process only towards the host it belongs to, and the rules
around that are deliberately narrow:

- It goes out on a generation request. Nothing else carries one.
- The plaintext is decrypted at send time and lives only inside that one
  in-flight request. Configuration holds ciphertext, the gateway decrypts once
  per call, and the task registry holds no credential at all — polling a video
  job resolves and decrypts afresh rather than reusing the key that started it.
- It is sent only to the model's own host. That includes an address a provider
  hands back for a finished file: it is fetched with the credential only when it
  resolves to the same origin, and without one otherwise, because an image left
  on a third-party CDN is public by nature and a key following it would not be.
- The model's protocol decides which header carries it. It is never a query
  parameter, so it cannot survive in a proxy log or a browser history.
- A provider's failure is reduced to its message: the envelope around it is
  dropped, a credential the message echoes back is replaced with the masked
  form, and what remains is truncated. Some providers repeat parts of a request
  in a failure, and a response must not become a way of reading a key out.

## Recording provider calls

Every rule above says the same thing about prompts and keys: they are not written
down. Telemetry carries counts, durations and outcomes, and deliberately nothing
else — `src-tauri/src/telemetry.rs` builds its one log line out of names and
numbers so that keeping a prompt out of it is not something every caller has to
remember. The log lines go to a daily file under the `logs` subdirectory of the
platform application data directory — and, for the server binary that somebody
watches in a terminal, to the console beside it; the desktop app writes to the
file alone. What protects them is the shape of the line, not the place it lands.

There is one exception, and it is explicit rather than implied:
`generate.debug.enabled`. Switched on, every call that reaches a provider is
written to a directory as the request and the answer that came back — address,
headers, prompt, reference media and body, whole and untruncated. It exists
because an answer that arrived and was the wrong thing cannot be diagnosed from a
line saying the call took nine seconds: the only evidence of what was asked and
what came back was in the two bodies, and both were dropped the moment the call
returned.

It is off by default and it is not a setting to leave on. What it writes:

- **Prompts.** Everything a reader typed, and everything a card on their canvas
  said, in full. A recording directory is a copy of the work that went through
  it.
- **Credentials, masked.** Masking is not a setting and cannot be turned off:
  the header that carries a key is masked with the same `masked` form every
  other diagnostic surface uses, a key in a query parameter is masked, and any
  echo of the key inside a body is replaced. What remains says which key was
  used, which is the half of it a diagnosis needs, and never the key itself.
- **Media.** A body that is not text — a picture, a sound, a video — is written
  beside the record as a `.bin` file of its own and pointed at from it, rather
  than encoded into a document nobody can read.

The protections that apply:

- The directory is the `records` subdirectory of the platform application data
  directory — the same root the metadata directory and the logs are resolved
  from, so the application already owns it — created `0700` with every file
  `0600`. It is not a setting; nothing can point recordings somewhere else.
- Nothing is uploaded anywhere. Recordings are local files and stay local files,
  and an exported project package never contains them: they live in the
  application data directory, which is structurally outside every project
  directory (see "Exported packages").
- Recording cannot fail a generation. Files are written by a task of their own
  after the answer is already in hand, and a disk that will not take one is
  complained about in the log rather than handed back to whoever asked.

`/api/health` reports whether recording is on and where it is writing, so that
somebody who did not switch it on can find out that it is. Turn it off by
removing the setting, and delete the directory: nothing cleans it up, and a long
run with large media in the answers can write gigabytes.

Enable it three ways, in descending order of precedence: `moka-server
--llm-debug`, the environment (`MOKA_LLM_DEBUG=1`), and the configuration file
(`generate.debug.enabled`). All three say whether to record; none of them says
where.

## Directory listings

A browser has no file dialog to ask which folder is meant, so the web runtime
serves one listing at a time instead: `GET /api/v1/filesystem?path=<dir>`
answers with the names in a directory and where each leads, which is what the
launcher's own **Browse…** dialog draws itself from.

What narrows it:

- **Names, never contents.** No route reads a file's bytes here; the answer is a
  name, an absolute path, and whether it is a folder. Opening a project still
  goes through `POST /api/v1/projects/open`, which reads only what a project
  document is.
- **Web runtime only.** In the desktop runtime the route answers 404: the
  operating system's dialog is there, and a loopback server answering a question
  nothing on it asks would be a wider surface for the same price.
- **Folders, and only the files asked for.** A listing with no `extensions` is a
  listing of folders alone. Entries whose name begins with a dot are left out, so
  the dot-directories a home holds are not offered and a listing is not a way of
  reading what configuration a machine has. A listing stops at 1000 entries and
  says it stopped.
- **A path is resolved, not trusted.** Symlinks are followed to answer what a
  row is, one that points at nothing is left out, a relative path is refused
  rather than resolved against the server's working directory, and a directory
  that will not open answers 404 rather than saying whether it exists.

What it does cost is worth stating plainly, because it is the one part of this
API that describes the machine rather than the work: a caller who can reach the
port can enumerate directory names across the filesystem the process can read.
That is the same trust the rest of the API already asks for — there is no
authentication layer, and whoever reaches the port can open any project the
process can open (see [deployment.md](deployment.md)) — but it is a wider answer
than any other route gives, which is why it is the one route the desktop runtime
refuses. Keep the server on loopback, or put identity in front of it.

## Writing files

The other half of the same question: `PUT /api/v1/filesystem/file?path=<file>`
writes the request body where a save dialog said, and
`POST /api/v1/filesystem/reveal` hands a file to the platform's file manager.
Unlike the listing above, both are served in **both** runtimes: the window
holding the bytes is not the one holding the disk, on the desktop as much as in
a browser, so a write that only the browser could make would be a feature the
desktop does not have.

What narrows them:

- **Only where a dialog already pointed.** The path must be absolute, its parent
  directory must already exist, and the path must not be a directory. No route
  creates a directory, so a write cannot scatter files somewhere nobody asked
  for; and the desktop's own save dialog is what produces the path there.
- **Whole or not at all.** The body goes to `<path>.tmp` first and is renamed
  over the target, so a write that fails leaves the directory as it was rather
  than half a file. A file already at the path is replaced — the dialog that
  produced the path is what asked about that.
- **Bounded.** A write body is capped at 256 MiB, well under the 2 GiB a media
  upload may carry.
- **Reveal reads nothing.** It takes an absolute path to an existing file and
  opens the platform's file manager on it.

Anyone who can reach the port can therefore write files the process can write.
That is the same trust the rest of the API asks for, but it is a wider answer
than the work routes give — keep the server on loopback, or put identity in
front of it.

## Exported packages

A project package (`.moka`, a ZIP) can never contain application metadata:

- credential names — `secrets.json`, `master.key`, and any `*.corrupt.*`
  quarantine copy — are excluded at **any** depth in the tree;
- the other metadata documents (`meta.json`, `recent-projects.json`,
  `models.json`, the legacy `providers.json`, `prompts/sources.json`) are excluded at
  the **project root**
  only, so a project that legitimately contains its own `assets/meta.json` still
  ships it;
- the project's own `output` folder — where the save dialogs open, and where an
  export is likely to land — is excluded at the **project root**, so an earlier
  package is not swept into the next one.

Because the metadata directory is structurally outside every project directory,
these guards are a second line of defence rather than the only one. The
exclusion rules appear in the package manifest, so an importer can see what was
left out.

What the two kinds of package differ in is whose machine they describe, and that
is personal data rather than a credential. The package of the work — what an
export makes unless asked otherwise — takes the record of the run that made each
generated asset out of the document, so the asset still says what it was asked
for and with which parameters, but not which run answered on which machine. A
full backup keeps those records, which means it carries every prompt this
machine asked and the name of every model that answered, a display name
somebody chose included. That is a choice the export dialog puts to the user, off by
default and saying what it keeps; it is not a leak, but it is a reason to think
about where a full backup is sent.

## Video export

A timeline render hands the project's own file paths to the machine's ffmpeg as a filter graph, written into a temporary directory under the project's temp area (`export-<id>/`, relative file names only) and deleted on success, failure, cancellation, and timeout alike; nothing is uploaded anywhere and no new credential is involved. The program itself is named only by `clip.ffmpegPath`, `MOKA_FFMPEG`, or the server process's search path — never by a request body. The director desk's blocking transcode likewise feeds an uploaded video to that same program, writes the MP4 into the project's staged asset area, and never accepts a program path from the request. The finished render is copied to the destination the request named — the path a save dialog produced — through the same staged write as any other save (see [Writing files](#writing-files)), and nowhere else: it is not filed among the project's assets, so what a reader keeps is the file they chose.

## Damaged documents

A document that fails to parse is renamed `<name>.corrupt.<timestamp>.json` and
the layer starts from an empty one. Nothing is silently zeroed:

- `/api/health` reports the affected documents with `corrupt: true` and sets
  `ok: false`, which names what was lost and lets the UI distinguish "reset
  because it was damaged" from "empty because it is new";
- a damaged `models.json` or `secrets.json` never causes `open_project` to
  fail. Project work continues; the models have to be entered again.

The quarantine copy is preserved so the user can inspect what was lost. It is
excluded from exports under the credential rule above.

## Known limitations

- On Windows the atomic write protocol fsyncs the file but not the parent
  directory; `std` exposes no equivalent API. A power loss immediately after a
  successful write can therefore leave the rename uncommitted.
- The directory lock is advisory and per process. Two processes must not share
  one metadata directory — see [deployment.md](deployment.md).
- Changing the bundle identifier changes the metadata directory. Existing
  configuration is not migrated automatically; set `MOKA_METADATA_DIR` to the old
  path to keep using it.

## The agent, its tools, and what it may reach

The in-app assistant and the `moka` CLI / MCP server run the same tools. Their
boundaries:

- **No credential tool.** Model configurations and API keys are read-only to
  the agent: it can list models by capability and label, never read a key,
  endpoint, or metadata path, and cannot write one.
- **Document writes are commands.** A command tool plans and the server
  submits with revision CAS; an effect tool deletes or starts work and leaves
  an audit record instead of a false undo.
- **Path tools are loopback-only.** `asset.import_path`, `project.create`,
  `project.open`, and `project.import` read or write paths on the server's
  disk. They are refused unless `server.bind` is a loopback address, so a
  server exposed on a network interface cannot be used to read its files.
  The interface's own dialogs and project launcher are unchanged.
- **Project lifecycle is external-only.** `project.create/open/import/
list_recent/remove_recent` never enter an in-app model's tool set; only
  CLI/MCP/HTTP callers see them.
- **Conversations are project data.** `agent/sessions/`, `history/agent/
changes`, `audit`, and `idempotency` live inside the project directory, are
  never uploaded, and are carried only by a backup package — a work package
  leaves them behind. They contain prompts and tool inputs; treat a project
  folder with the same care as its generated assets.
- **Approval is enforced server-side for risk.** Spend, destroy, and export
  calls without `acknowledgeRisk` are refused before anything happens. The
  interface asks first and then sends the acknowledgement; the CLI needs
  `--yes`; MCP needs the matching `--allow-*` flag.
- **Destinations are chosen, not inferred.** Export tools require a
  destination; the interface opens a save dialog, and the CLI/MCP must pass a
  path. No tool writes to a fixed output folder on its own.
