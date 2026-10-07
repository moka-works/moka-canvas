<p align="center">
  <img src="src-tauri/icons/256x256.png" alt="Moka Canvas" width="140" />
</p>

<h1 align="center">Moka Canvas</h1>

<p align="center">Local-first AI creation canvas · <a href="README.md">简体中文</a></p>

> **This project is under heavy development.** How features are used, how the interface looks, the APIs it exposes, and the model protocols may all change — and some of those changes are incompatible: a project saved by a newer version, for instance, may not open in an older one. Take a look at the repository's latest notes before upgrading.

## Introduction

Moka Canvas is a local-first AI creation tool: projects, assets, and keys all stay on your own machine — no account, nothing uploaded. It places the work on a canvas that stretches without end: text, images, audio, and video are cards, connections between them express what is passed from one to another, and a piece of work is that chain laid out and run.

Moka Canvas brings no AI of its own. You connect the model services you already use — writing down the endpoint, the model name, and the key — and generation on the canvas is handed to them. Which provider's models you use, and how many at once, is entirely yours to decide; a model that is not in the list can be brought in through a "converter".

What is generated stays in the project: images, sound, and video are filed into the asset shelf by themselves, ready to be referenced from the canvas again, or to be cut into a film in the Clip module; the Story module, in turn, takes "telling a story" apart into five steps that walk from a premise all the way to a film ready to export.

View detail document: [https://moka-canvas.art](https://moka-canvas.art)

**If Moka Canvas is helpful to you, a Star :star: on the repository is a welcome way to support it; if you run into a problem while using it, please open an [Issue](https://github.com/moka-works/moka-canvas/issues/new) to tell us**

## Main features

- **Infinite canvas**: double-click empty space to add a node, drag a connection from a card's edge to make a reference; grouping, aligning, and distributing are there, the wheel zooms from 5% to 500%, and the minimap in the bottom-left corner handles navigation.
- **Predictable generation**: selecting a node brings up the generation panel — write the prompt, pick the model, set the parameters; press **Preview** before running to see what will actually be handed to the model; a run that fails never overwrites the result already on the card.
- **Assistant**: talk with the AI beside the canvas and change things as you go — the conversation is about the cards you have selected, and an answer can become a new card, be written into the selected text, or generate an image, a video, or a piece of audio outright.
- **Image tools**: Crop, Split, Resample, and Tilt are local operations — they cost nothing and lean on no model; Repaint (painting a mask) and Describe (reading a picture back into a prompt) do call the models, and whatever they make remembers where it came from.
- **Asset shelf**: every file in the project laid out by kind — text, image, audio, video — searchable, with notes and a keep-to-hand mark; any file can show what uses it: which canvases, clips, and stories refer to it.
- **Clip module**: multi-track timelines, seven transitions, subtitle editing with SRT import and export, and auto subtitles; MP4 export is rendered precisely by the machine's own ffmpeg.
- **Story module**: premise → outline → elements → storyboard → compose — each step a batch of AI questions you can read, edit, and confirm, and at the end a film is put together and handed to the Clip module for fine cutting.
- **Projects travel with you**: a project is an ordinary folder — copy it and it has moved; it can also be exported as a `.mokapkg.zip` package and imported on another machine.

## Quick start

### 1. Choose how it runs

- **Desktop app** (macOS, Windows, Linux): install it and go — made for personal work, with keys held by the system keychain;
- **Self-hosted**: run the program on a machine of your own and reach it through a browser — for machines with no desktop, or for putting it on an intranet;
- **From source**: the developer route, needing Node.js 22+ and a Rust toolchain; the details are in the [build guide](BUILD_EN.md).

### 2. Create a project

When it starts, press **New project** in the launcher: fill in a project name and choose a folder, and that is all it takes. A project is an ordinary folder — the canvas documents and the assets live inside it. A new project opens straight into the **Story module**; to begin from the canvas instead, switch to it with the projects menu in the top-left corner. The **Recent projects** list in the launcher also leads straight into any of the four modules.

### 3. Connect a model

Open **Settings → Model**, pick the capability tab first (Text, Image, Speech, Music, Video, Speech recognition), then press New and fill in the model's display name and the other details. Once it is saved, pick the corresponding model on that kind of card and it is in use.

Keys are written, never read back: the interface only ever shows a mask, and leaving the field blank on save keeps the value that was there.

### 4. Generate a first image

1. Double-click empty canvas space and add a **Text** node; double-click the card and write a description, say, "dusk settles in, a lantern drifts across a silent lake";
2. Right-click the text card and choose **Image from these words** — an image node drops onto the canvas, wired up for you;
3. Confirm the prompt and the model, then press **Run**;
4. When it is done, the result lands right on the card and is filed as a project asset, ready to be used again.

### 5. Meet the four modules

- **Canvas**: nodes, connections, and generation — where the work happens;
- **Story**: a telling in five steps, from premise to film;
- **Clip**: timelines, transitions, and subtitles — cut material into a film;
- **Assets**: every file the project holds — read in one place, kept in one place.

The projects menu in the top-left corner switches between the four modules at any time. The interface comes in English and Simplified Chinese, follows the system by default, and can be pinned in **Settings → System → Language**.

## Where the data lives

- **Project content** (canvas documents, assets, stories, and run records) lives in the project folder you chose: copy the whole folder and the project travels complete;
- **Application state** (model configurations, API keys, preferences, the recent-projects list) lives in the system's application-data directory — `~/Library/Application Support/MokaCanvas/` on macOS, `%APPDATA%\MokaCanvas\` on Windows — and does not travel with a project; keys are stored encrypted, written but never read back;
- No account, no cloud sync, and no telemetry: the only network requests are the ones to the model endpoints you configured.

Video export and auto subtitles need ffmpeg 5.0 or newer on the machine (an open-source video tool; you need a full build with libass support, and how to install one is in the [build guide](BUILD_EN.md)). Without it everything else carries on as usual — only those two places report themselves unavailable.

## Building and packaging

Building from source needs Node.js 22+, npm, and a Rust toolchain (desktop packaging also needs each platform's native dependencies). The everyday commands:

```sh
make install
make web-serve   # Build and start the local server; open http://127.0.0.1:8080 in a browser
make tauri-dev   # Run the desktop shell
```

The full build, packaging, and signing instructions are in the [build guide](BUILD_EN.md) (in Chinese: [BUILD.md](BUILD.md)). Stack: a Rust local server (Axum) · a React 19 + LeaferJS frontend · a Tauri 2 desktop shell.

## Docs and help

- [BUILD_EN.md](BUILD_EN.md): building, packaging, and releasing;
- [docs/deployment.md](docs/deployment.md): running a self-hosted server, the address it binds, and how to upgrade and roll back;
- [docs/security.md](docs/security.md): the reach and the limits of key protection;
- [docs/release-checklist.md](docs/release-checklist.md): read this before upgrading or rolling back a version;
- Questions and feedback go through the repository's Issues.

## License

This project is released under the [Apache License 2.0](LICENSE): you are free to use, modify, and distribute it, including commercially, with the patent license granted by its contributors. When you distribute it, keep the copyright and attribution notices (see [NOTICE](NOTICE)), and mark the files you changed. The software is provided "as is", without warranty of any kind. The full terms are in the [LICENSE](LICENSE) file at the repository root.
