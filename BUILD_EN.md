# Build Guide

Prerequisites and commands for building and packaging Moka Canvas on each host.

## Common prerequisites

| Tool           | Version | Notes                                             |
| -------------- | ------- | ------------------------------------------------- |
| Node.js        | 22+     | LTS recommended                                   |
| npm            | 10+     | Ships with Node.js                                |
| Rust toolchain | stable  | Includes `cargo` and `rustup`                     |
| Tauri CLI      | 2.x     | Installed as a dev dependency (`@tauri-apps/cli`) |

[Tauri prerequisites](https://tauri.app/start/prerequisites/) is the upstream reference for the bundling toolchains; what each host needs for this project is below.

## Platform prerequisites

### macOS

| Requirement     | Install                                                           |
| --------------- | ----------------------------------------------------------------- |
| Xcode CLI tools | `xcode-select --install` — clang, the SDK and `codesign`          |
| Rust toolchain  | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js 22+     | `brew install node`, or the installer from nodejs.org             |

The window renders in the system's own WebKit, so the desktop app runs with nothing else installed. `make package-macos` needs no further tools either.

### Windows

| Requirement          | Install                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MSVC C++ build tools | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` — the "Desktop development with C++" workload |
| Rust toolchain       | `winget install Rustlang.Rustup`, then `rustup default stable-msvc` (the MSVC host target, not GNU)                                                                                                    |
| Node.js 22+          | `winget install OpenJS.NodeJS.LTS`                                                                                                                                                                     |
| WebView2 Runtime     | preinstalled on Windows 11 and current Windows 10; on a machine without one, install the Evergreen Bootstrapper from the [WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)     |

The app's window is drawn by WebView2 — Edge's rendering engine — so it is needed to run `make tauri-dev` as much as the installed app: without it there is no window to draw in. The NSIS setup installs it on machines that lack it, by downloading Microsoft's bootstrapper, so that install needs network. WiX and NSIS themselves are only needed to build installers, which `make package-windows` covers per the Tauri prerequisites.

### Linux

The window is drawn by WebKitGTK, and its development package is needed to build as much as to run — without it `cargo` stops at `webkit2gtk-sys`. On Debian, Ubuntu, and their derivatives one command installs the lot (the line from the Tauri prerequisites):

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

On rpm-based distributions the `-dev` packages become the matching `-devel` ones (`webkit2gtk4.1-devel`, `gtk3-devel`, `libsoup3-devel`, `librsvg2-devel`); the [Tauri prerequisites](https://tauri.app/start/prerequisites/) have the exact names. Rust and Node.js install the same way as on macOS.

## Clip export (ffmpeg)

Timeline export is done by ffmpeg, which is not bundled. The program runs without it — export reports itself unavailable and its dialog names every way out — and a machine that is meant to export needs a build with **libass** (the `ass` filter that burns captions in) and `xfade` (the transitions). The plain `brew install ffmpeg` formula is built without libass: a cut with no words exports, and one with words is refused by name rather than quietly losing them.

The renderer is looked for in three places, in this order: `clip.ffmpegPath` in the configuration file (`clip` in `config/moka.example.yaml`), the `MOKA_FFMPEG` environment variable, then the platform search path. A named path that is not there is unavailable rather than a different ffmpeg being run instead, which is what makes a machine's renderer deterministic.

macOS:

```sh
brew install ffmpeg-full
```

`ffmpeg-full` is keg-only — linking it would shadow the slim `ffmpeg` — so point the program at it afterwards: `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` on Apple Silicon, `/usr/local/opt/ffmpeg-full/bin/ffmpeg` on Intel.

```sh
MOKA_FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg make tauri-dev
```

or write it into the configuration file as `clip.ffmpegPath` so every run finds it. The Rust suites look for their renderer the same way, and a machine whose ffmpeg lacks libass fails the two clip tests that burn a caption in, so a full run on macOS is `MOKA_FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg make check`.

Windows: install a full-featured build — gyan.dev's ["full"](https://www.gyan.dev/ffmpeg/builds/), or a [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases) release — and name it the same way, `clip.ffmpegPath: 'C:\path\to\ffmpeg.exe'` or `MOKA_FFMPEG`, or put its `bin` directory on `PATH`.

Linux: the distribution's own `ffmpeg` package is normally a full build with libass — Debian's and Ubuntu's are — so `sudo apt install ffmpeg` is all it takes; confirm with the command below.

Any build can be asked what it has: `ffmpeg -h filter=ass` describes the filter when it is there, and says `Unknown filter 'ass'.` when it is not.

## Setup

```sh
make install   # npm ci
```

## Verify the toolchain

```sh
make check
```

Runs the frontend build, Prettier/ESLint/TypeScript checks and the Vitest suite, then `cargo fmt --check`, `cargo clippy -D warnings`, and `cargo test` for the Rust server. `make test` runs only the two test suites (Vitest and `cargo test`).

## Local run

```sh
make web-serve   # Build frontend, serve dist/ + API at http://127.0.0.1:8080
make tauri-dev   # Build frontend, run the Tauri desktop app
```

## Versioning

```sh
make set-version 1.2.3
```

Sets the version of all build outputs in one place: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `moka-canvas` entry in `src-tauri/Cargo.lock`. Windows installer metadata and the DMG/setup filenames derive from these, so run this before packaging a release.

## Localization

The interface carries English and Simplified Chinese side by side. The catalogues live under `src/shared/i18n/locales/en/` and `.../zh/`, one file per area (`editor`, `clip`, `settings`, `assistant`, `story`, `app`, `common`, `domain`, `errors`, `problems`); the code names its words by key and the catalogues hold them. The interface follows the machine's language, and a reader can pin English or Chinese in Settings → Preferences → Language, remembered on that machine. The automated suites pin English, so their assertions read the English catalogue word for word.

The packaged app names each have their own rule, described in the Windows installer and macOS DMG sections below.

## Converter protocols

Every protocol this program speaks is a converter, and a converter is a directory under the models tree — there is no protocol table in Rust or TypeScript. On a desktop install that tree is `models/` beside the metadata directory (`~/Library/Application Support/MokaCanvas/models` on macOS, `%APPDATA%\MokaCanvas\models` on Windows); on a server it is `models/` beside the configured `metadata.dir`.

```
<models root>/<capability>/<id>/
  model.json      what the protocol declares
  <script>.lua    what it does
```

`<capability>` is one of `text`, `image`, `speech`, `music`, `video`, `asr`. `<id>` is the directory's own name: the wire name a model configuration stores, so it must not change once a model speaks it. The `.lua` file name is free — `model.json` names it. A directory under a capability nothing reads — an `audio/` from before sound was split into speech and music — is left where it is: the built-in deploy writes beside it rather than over it, and removing it is a reader's own tidying.

`model.json` is the whole declaration:

| Field         | Meaning                                                                                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName` | The name it goes by where no label matches, and the name the server's own messages use. Required.                                                                                                                                                                                                          |
| `labels`      | Names per locale, e.g. `{"zh": "…"}`. A language with no entry falls back to `displayName`, then to the id.                                                                                                                                                                                                |
| `urlExample`  | An address shown to the reader as a shape to copy. Required.                                                                                                                                                                                                                                               |
| `script`      | The Lua file beside this document. Required.                                                                                                                                                                                                                                                               |
| `order`       | Where it sits within its capability, ascending, ties by name (default 1000).                                                                                                                                                                                                                               |
| `auth`        | Where the credential rides: `{"header": "Authorization", "scheme": "Bearer"}` unless it says otherwise; `{"header": "x-goog-api-key", "scheme": ""}` for a key with no scheme; `{"header": ""}` for an endpoint that takes none. Only addresses inside the configured endpoint's origin are ever given it. |
| `features`    | Free-form flags the interface reads, e.g. `{"mask": true}` for an image protocol with a mask field of its own.                                                                                                                                                                                             |
| `version`     | How the built-in deploy decides whether to take over a directory (see below). Omit for a hand-written converter.                                                                                                                                                                                           |

The Lua side is a set of hooks, all optional, and which ones a script exports is what the host believes it can do:

| Hook                                         | Purpose                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_request(call, req, inputs)`           | Describes one call: `{method, url, headers = {name = value}, body = …}`, or `{request = …, handler = …}` when the answer needs a function of its own to read it, or `{error = …}` to refuse before anything is sent. |
| `parse_response(status, headers, body)`      | Reads that answer into `{text, items, usage, error}`.                                                                                                                                                                |
| `build_stream_request(call, req, inputs)`    | The same, for an endpoint that answers in events; exporting it is what says the converter streams. Each event is read by `parse_event(event)`.                                                                       |
| `build_task_request` / `parse_task_response` | Starts a job that outlives one request; the reply names the provider's handle with `{reference = …}`.                                                                                                                |
| `build_poll_request` / `parse_poll_response` | One look at that job: `{status = "pending"}`, `{status = "succeeded", result = {items = …}}`, `{status = "failed", error = …}`, or `{status = "expired"}`.                                                           |

Inside a script, `call` is `{url, model}` (the complete configured endpoint and the provider's model name), `req` is `{prompt, system, capability, params}`, and each input is `{role, filename, mime, data_url}` with its bytes base64-encoded in the data URL. An item may report its bytes as `{url = …}` (the host fetches it, with the credential following the same origin rule), `{data_url = …}`, `{base64 = …}`, or `{raw = true}` for the answer's own body. The host API is `json`, `base64`, `log` and `util`; the credential is never handed to a script.

Built-in converters ship with the program: `src-tauri/build.rs` embeds every directory under `src-tauri/converter-scripts/models/` at compile time (a malformed directory fails the build), and startup writes each one into the models root unless the version already deployed there is at least as new — so a converter a reader edited survives until a later built-in version overtakes it. Directories this build does not know are never read, written, or removed.

Adding a protocol is therefore that directory and nothing else: no Rust, no TypeScript, no i18n file. Drop it in, restart, and the name is offered in Settings beside the built-ins. `src-tauri/tests/converter_extensibility.rs` is the executable form of that claim.

## Package targets

### Web (any host)

```sh
make package-web
```

Builds the frontend, compiles the `moka-server` release binary, and stages a self-contained distribution under `release/moka-canvas-web-<version>-<platform>-<arch>/` containing `dist/`, the native server binary, and a `README.txt`. Run the staged server with:

```sh
./moka-server --static-dir dist --port 8080
```

### macOS DMG (macOS only)

```sh
make package-macos
```

Produces `Moka Canvas_<version>_<arch>.dmg` (`aarch64` on Apple Silicon, `x64` on Intel), copied into `release/` (the tauri-bundler output remains under `src-tauri/target/release/bundle/dmg/`), with the branded background and app/Applications drop slots configured via `bundle.macOS.dmg` in `src-tauri/tauri.conf.json`. The `.app` bundle is ad-hoc signed (`bundle.macOS.signingIdentity` = `"-"`); the DMG itself is left unsigned, which Tauri does deliberately for self-signed identities. Gatekeeper still warns on first launch because ad-hoc signatures are not notarized — right-click and choose Open.

The bundle keeps its English name — the `.app` folder, the executable, and the DMG file name. On a Chinese system Finder, the Dock, and the menu bar show 摩卡画布 instead: `bundle.macOS.files` ships `Contents/Resources/zh-Hans.lproj/InfoPlist.strings` (and `zh-Hant` beside it), and macOS reads the localized `CFBundleDisplayName`/`CFBundleName` from there; every other language falls back to the bundle's own name. The files are copied before the bundle is signed, so the ad-hoc signature still verifies.

> Rebuilding deletes the previous DMG, so eject any mounted copy before running `make package-macos` again — otherwise the DMG stays mounted as a leftover volume and the Finder styling step fails with a generic `error running bundle_dmg.sh`.

### Windows installers (Windows host)

```sh
make package-windows
```

Produces MSI and NSIS installers under `src-tauri/target/release/bundle/` and copies them into `release/`. Requires Microsoft C++ Build Tools, WebView2, and WiX/NSIS tooling per Tauri's Windows prerequisites.

The NSIS installer is built from a custom template (`src-tauri/installer/installer.nsi`, forked from the Tauri default) that provides branded welcome and finish pages plus header bitmaps from `src-tauri/installer/`; it is selected via `bundle.windows.nsis.template` in `src-tauri/tauri.conf.json`. Because the template is forked, it does not automatically pick up upstream Tauri fixes — re-diff it against the [upstream template](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) whenever the Tauri CLI is upgraded.

The installer is bilingual. `bundle.windows.nsis.languages` lists `English` and `SimpChinese`, and an interactive install opens on the standard MUI language picker as its first step; `/P` and `/UPDATE` runs instead reuse the language the previous install stored, so what is already on disk keeps its name. The texts the template adds are NSIS `LangString`s near its bottom (the file must stay UTF-8 without BOM) and must be defined for every language in that list — a missing one is only a compile-time warning (6040) and renders as an empty string. The app's visible name follows the chosen language: the desktop and start-menu shortcuts, the entry in the programs list, and the `.moka` association texts read 摩卡画布 on Chinese and "Moka Canvas" otherwise. The compile-time `${PRODUCTNAME}` ("Moka Canvas") stays the identity behind it all — install folder, registry keys, `uninstall.exe`, and the setup file name — so upgrades and uninstalls keep matching, and a run in the other language replaces the old-named shortcuts rather than leaving them beside the new ones.

### Windows installer cross-compile (macOS host)

```sh
make cross-package-windows
```

Cross-compiles the NSIS installer (`Moka Canvas_<version>_x64-setup.exe`) from macOS using the `x86_64-pc-windows-gnu` Rust target and mingw-w64, then copies it into `release/`.

Host prerequisites:

```sh
brew install mingw-w64 makensis
```

The Makefile enforces these checks and installs the missing Rust target automatically. The build sets `LC_ALL=en_US.UTF-8` because makensis aborts with `std::bad_alloc` under non-UTF-8 locales ([NSIS bug 1165](https://sourceforge.net/p/nsis/bugs/1165/)).

Caveats:

- The bundled exe is unsigned; Windows SmartScreen may warn.
- The cross-built installer has not been smoke-tested on a physical Windows machine; verify by installing once before distribution.
- Never run `cross-package-windows` concurrently with another package task (`package-macos`, `package-web`, `web-build`). All of them rebuild `dist/`, and vite empties `dist/` at the start of a rebuild. If the bundler resolves resources while `dist/` is empty, Tauri's resource walker silently skips the directory, producing an installer without `web/` — the installed app then exits immediately on launch (the embedded HTTP server requires the `web/` resource directory). If an installed Windows build "does nothing" on double-click, check that the installer actually contains `web/` (`7zz l <setup.exe>`) and rebuild.

### Linux packages (Linux only)

```sh
make package-linux
```

Produces three packages under `src-tauri/target/release/bundle/`, and `scripts/collect-release.mjs` copies them all into `release/`:

| Package  | File name                              | For                            |
| -------- | -------------------------------------- | ------------------------------ |
| deb      | `Moka Canvas_<version>_amd64.deb`      | Debian, Ubuntu and derivatives |
| rpm      | `Moka Canvas-<version>-1.x86_64.rpm`   | Fedora, RHEL, openSUSE         |
| AppImage | `Moka Canvas_<version>_amd64.AppImage` | any distribution, no install   |

The deb and the rpm are installed by the system package manager, and their runtime dependencies are derived by Tauri from the libraries actually linked on the build machine (this build yields `libwebkit2gtk-4.1-0` and `libgtk-3-0`). The AppImage carries everything itself — `chmod +x` and run it.

The AppImage is produced by linuxdeploy: Tauri fetches linuxdeploy, AppRun, and the gtk plugin from GitHub and keeps them in `~/.cache/tauri/`, so packaging an AppImage needs network. That cache is outside `make clean` — it is tooling shared across projects, not an artifact of this repository.

Each kind gets its own `npm run tauri build -- --bundles <kind>` rather than sharing one run: a single tauri-bundler 2.9.4 process (the version `@tauri-apps/cli` 2.11.4 vendors) asked for two or more kinds stalls after its last bundle — CPU pegged, no further output, no files written — while a process asked for exactly one always finishes. The grouping is the only difference; the artifacts are identical.

### Updating app icons

Windows uses the icon through two independent paths, both sourced from `src-tauri/icons/`:

- The `.rsrc` section of the exe (explorer/shortcut icons), written by tauri-build.
- An RGBA copy embedded at compile time by the `generate_context!()` macro (runtime window/taskbar icon).

`tauri-build` does not emit `rerun-if-changed` for `icons/icon.ico`, so after replacing icons, a stale build cache can keep the old runtime icon even though the source files are new. Force the lib crate to rebuild before packaging:

```sh
touch src-tauri/src/lib.rs
```

or run `make clean` once. Afterwards, Windows may still show the old icon from its shell icon cache — refresh it on the Windows machine by unpinning the app from the taskbar, reinstalling, re-pinning, then running `ie4uinit.exe -show` (or restarting explorer.exe) to flush the icon cache.

### `.moka` file association

`*.moka` documents are registered to open with the app and use their own document icon (the previous app icon design), built as `src-tauri/icons/moka-file.icns` / `moka-file.ico` and shipped via `bundle.resources` in `src-tauri/tauri.conf.json`:

- **macOS**: `src-tauri/Info.plist` (auto-merged into the bundle's Info.plist by Tauri) declares the `app.canvas.moka` UTI and document type with `CFBundleTypeIconFile` = `moka-file`.
- **Windows (NSIS)**: the forked `installer/installer.nsi` hardcodes `APP_ASSOCIATE`/`APP_UNASSOCIATE` for `.moka` with `DefaultIcon` = `$INSTDIR\moka-file.ico`. This replaces the upstream `{{#each file_associations}}` loop, which cannot use a separate document icon — re-apply the divergence when re-diffing against the upstream template.
- The MSI bundle (built by `package-windows` on a Windows host) does **not** register the association, and its texts stay English; distribute the NSIS setup exe for both.

## Clean

```sh
make clean
```

Removes `dist/`, `release/`, `src-tauri/target/`, and TypeScript build caches (`node_modules/.tmp`).

## Signing and notarization

### macOS ad-hoc signing (default)

`bundle.macOS.signingIdentity` is set to `"-"` in `src-tauri/tauri.conf.json`, so the bundler ad-hoc signs the `.app` inside out — external binaries such as `moka-server` and any frameworks first, then the bundle itself. Without this the bundle ships with no `_CodeSignature/CodeResources` at all, only the linker-generated ad-hoc signature on each Mach-O, and `codesign --verify` fails with `code has no resources but signature indicates they must be present`. Verify a build with:

```sh
codesign --verify --verbose=3 "Moka Canvas.app"
codesign -dv --verbose=2 "Moka Canvas.app"   # expect Sealed Resources version=2
```

Ad-hoc signing proves the bundle's contents are intact and consistent with each other. It does **not** satisfy Gatekeeper: ad-hoc signatures cannot be notarized, so a downloaded DMG still prompts, and `spctl` keeps rejecting it. It is what a build with no Apple credentials available can honestly claim, and nothing more.

### Developer ID signing and notarization (release)

Release signing (Authenticode for Windows, Developer ID + notarization for macOS) requires organization-specific credentials and is out of scope for this baseline. When they are available, macOS needs no config change: the CLI reads `APPLE_SIGNING_IDENTITY` and lets it win over `signingIdentity`, so a real identity is supplied per-build without editing the tracked config.

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: <org> (<team id>)" make package-macos
```

Notarization is then attempted automatically when `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` (or the `APPLE_API_KEY*` equivalents) are present, and skipped with a warning when they are not. Note that the DMG stays unsigned whenever the identity is `"-"` — Tauri skips self-signed DMGs on purpose — so signing the DMG itself also requires a real identity.
