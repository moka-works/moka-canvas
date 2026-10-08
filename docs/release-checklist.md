# Release Checklist

Manual, per-platform verification before publishing a build. Record the
date, build version, and results for each run; a release needs every
critical item passing on every target platform.

Automated coverage (run these first, they gate the release):

```sh
make check        # build + format + lint + typecheck + vitest + cargo tests
npm run test:e2e  # Playwright: critical path, provider settings, a
                  # generation asked from the panel under a node and
                  # driven against a stand-in provider, and a picture
                  # cropped from the row of tools over its card
```

## Web (`make package-web`)

1. Run the staged server: `./moka-server --static-dir dist --port 8080`.
2. `GET /api/health` and `GET /api/ready` return 200 with check details.
3. Create a project, add nodes of every kind across two canvases, connect
   them, save, close, reopen — the order the tree reads, the cameras, and
   the content all persist.
   - Arrange the project's canvases in the tree on the **Project** face of
     the column beside the canvas: make a folder, a folder inside it, and
     a board in each; rename both; drag a board into a folder and back out
     to the top level, and a folder into another, letting go above, below,
     and inside a row to check that the mark under the pointer is where it
     lands. Save, close, reopen, and confirm the tree reads the same. Undo
     each of those and confirm it gives back what it took, a move included.
     Try to drop a folder into itself and into one it holds and confirm
     neither is offered. Delete a folder holding a board and confirm the
     question says how many boards move up, and that they do — nothing on a
     board is lost by tidying the tree. The automated equivalents are
     `npm test` (`ProjectTree`, `folders`, `canvasTree`) and
     `cargo test --test tree`.
   - Open a board from the tree and confirm a tab appears for it on the
     strip across the top; open a second, close one, and confirm the board
     beside it is looked at rather than nothing. Close the project and
     reopen it: the boards left open come back open, and the project opens
     onto the one last looked at. That remembering is this machine's, so
     confirm a package imported elsewhere opens onto its first board.
     Delete a board that has a tab up and confirm its tab goes with it. The
     automated equivalents are `npm test` (`openCanvases`, `app`).
   - Open a board in the tree and confirm it unfolds into **Text**,
     **Image**, **Audio**, and **Video** whether or not it uses all four;
     that what is under each is what that board's cards point at rather
     than what the project holds; and that right-clicking a file there
     offers **Show in assets**, which turns the column over to the shelf,
     on the kind that file is filed under, with that one row marked and in
     view.
4. Import small and large image/audio/video fixtures; preview each, then
   remove them safely (referencing nodes are flagged, never silently
   deleted).
   - A video card shows the film's own first frame with a play button
     over it. Pressing the button plays it in the card itself, controls
     and all; the rest of the frame still drags, selects, and wires the
     node while nothing is playing, and pausing or ending brings the
     button back. The automated equivalent is
     `npx playwright test canvas-video`.
   - The **Assets** face of the same column is the shelf, cut into the four
     kinds a board can be given. Confirm that **Import…** files what is
     chosen; that each kind tab lists only what belongs to it and counts
     what it holds whether or not a filter is narrowing it; and that audio
     offers the choice between music and a voice, being two shelves, while
     no other kind asks a question with one answer. Give a file words and a
     note on its row, mark it a keeper, and confirm the shelf narrows by a
     word, by shelf, by origin, by keepers, and by every word chosen at
     once — a second word narrows the list rather than emptying it — and
     that the search reaches a file by its name, its words, its note, and
     its summary. Drag a file from the shelf onto the canvas and confirm it
     becomes a card where it was let go. The automated equivalents are
     `npm test` (`AssetsPanel`, `shelfFilter`).
   - Save a text node's words as material from the inspector and from
     the node's menu: a row appears on the shelf under `texts/` holding
     exactly what the node holds, and filing the unchanged node again
     says it is already there rather than writing a second file. Save an
     image node the same way and confirm the entry it already had is
     marked as one to hand, with the node's ask as its summary where it
     had none, rather than a second copy appearing. The automated
     equivalents are `cargo test --test api
a_text_node_is_filed_once_and_its_words_come_back` and `npm test`
     (`media`).
   - Take the shelf the other way with **From assets…** — from the
     quick-add menu, from a node's reference bar, and from beside the
     assistant's about line. The dialog says what the choice will come
     to before anything is taken. Choose two files from the menu and
     confirm two cards arrive where the menu was opened, all of them
     selected, with one undo taking both back; choose two from a node's
     reference bar and confirm they are added to that node — wired in
     beside it where the wiring is what the ask reads, listed by it
     where a list kept by hand is.
     The automated equivalent is `npm test` (`AssetPickerModal`).
5. Run a valid workflow and an invalid one (validation errors surface on
   the run card); cancel a running workflow; retry a failed one; reopen
   the project and confirm `history/runs/` records are intact.
6. Export a package, import it into a fresh directory, and delete an
   asset file externally before reopening: the self-check dialog offers
   locate-replacement, open-with-missing, and cancel; export without
   restoring offers the incomplete-manifest route.
   - The export dialog asks two questions and both start off. With
     neither ticked, unpack the `.mokapkg.zip` and confirm it holds
     `canvas.moka`, `assets/**`, and `moka-package.json` only — no
     `history/` — and that the manifest has `personalHistory: false`
     with every rule that skipped a file listed beside its count and
     the bytes it freed.
   - Confirm the canvas tree travelled: a folder made before the export is
     there after the import, holding what it held, since the tree is
     document state and goes where the work goes. Confirm which boards were
     open did **not** travel, and that the imported project opens onto its
     first board — that is this machine's business, like the theme, and a
     package carries none of it. The automated equivalents are
     `cargo test --test contract` (`tree_binary_decodes_to_tree_json_model`,
     `tree_re_encode_is_byte_canonical`) and `npm test` (`codec`).
   - Tick the run-history choice and confirm `history/runs/**` arrives
     and the manifest says `personalHistory: true`. Unticked, the
     pointer from each generated asset back to the run that made it is
     gone from the document while the prompt and parameters it was
     asked with stay, the inspector says the record did not come with
     the project, and **Run again** starts a new run rather than
     retrying one that is not there. The conversations had over each
     canvas travel on the same choice: unticked, `canvas.moka` holds
     neither a `sessions` list nor an `assistantSessionId`, and the
     imported project opens onto an empty assistant rather than onto
     somebody else's asking.
   - Tick the referenced-assets-only choice on a project holding an
     asset no node points at. The question counts that asset and its
     size before the choice is made, and after the import the
     self-check reports nothing — the registry entry and its file went
     out together, which is the part most easily got wrong.
   - Search the unpacked bytes of both kinds for `sk-`, `apiKey`,
     `cipher`, `secrets.json`, `master.key`, and the metadata directory
     path: none appear in either. The automated equivalent is
     `cargo test --test package export_never_contains_personal_or_secret_data`.
   - Import a package written by the previous build (manifest
     `formatVersion: 1`) and confirm it is accepted and cleaned to what
     this build keeps, and that a manifest naming a later version is
     refused with the range this build reads in the message.
7. Check the server log: one structured line per API request with request
   id, method, path, status, duration, and error code; no payloads, no
   filesystem internals beyond project paths, no secrets.
8. Open the settings dialog from the launcher and from the editor: it
   opens on one tab per model category — **Text**, **Image**, **Audio**,
   **Video** — plus **Preferences**. On a category tab add a model
   through **New … model** and confirm the form offers only the
   protocols that category speaks (a video model is not offered a chat
   endpoint), that picking a protocol starts the URL field from that
   protocol's own complete endpoint address, and that the address is the
   whole endpoint rather than a base URL. Confirm the credential is
   written once and comes back only masked, that leaving the key field
   blank on an edit keeps the stored key, and that clearing it is its own
   explicit action. Duplicate a model and confirm the copy carries the
   fields and the key and opens ready to be changed. Choose the category's
   default with the radio on its cards, and adjust generation preferences;
   save, reload, and confirm everything persisted. Editing the same configuration in two windows at
   once surfaces a conflict notice in the loser instead of silently
   overwriting.
9. Generate against a model you really configured. The text route
   `POST /api/v1/generate/text` returns text; `/image`, `/speech` and
   `/music` return the media base64-encoded beside a mime type, kind, and
   dimensions, and nothing appears in the project directory as a result.
   Repeat the text call with `params.stream: true` and confirm
   `text/event-stream`, several `delta` frames, and one closing `done`
   frame. `POST /api/v1/generate/video` returns a handle instead: poll
   `GET /api/v1/generate/tasks/{id}` until it ends, then poll a handle
   you invented and confirm it is reported missing rather than
   unfinished. Finally remove the category's default model and confirm
   the answer is one problem document — code in the body and in
   `x-error-code`, the provider's message rather than its raw body, and
   no credential anywhere in it. The automated equivalent is
   `cargo test --test generate_api`.
10. Generate from a node rather than from the API, which is the path a
    canvas takes. Write a spec on an image node in the panel under it
    (item 11) and run it: the answer appears on the node, in the
    assets panel behind a badge naming the
    node that made it, and under `assets/images/` with provenance
    carrying the run, the node, the inputs that travelled, and the
    parameters it was asked with. Search the project directory and an
    exported package for the model's key and find nothing, the
    snapshot included. Ask for several at once and confirm the node
    keeps the first while the rest become cards of their own. Run a
    node that is already showing an answer and confirm it goes on
    showing that one while the new answer becomes a card to its right
    with an edge between them; run it once more and confirm the card is
    written into rather than doubled. Revoke the key and run again: the
    step fails with a reason and the node still says what it said
    before. Finally import a package whose run records
    did not travel with it and click **Run again** on one of its assets —
    a new run starts under the snapshot's parameters rather than a retry
    of a run this project has never heard of. The automated equivalents
    are `cargo test --test provider_runs` and `npm run test:e2e`.
11. Ask a node from the editor's own interface, which is how a canvas is
    driven. Select an empty image node and confirm a panel comes up
    under it; reach the same panel through **Generate…** on the node's
    menu and through `Enter`, and confirm `Enter` on a text node that
    already has words edits them instead. Turn the **Prompt** toggle in
    the footer off and confirm selecting a node no longer raises it.
    Type a prompt and confirm nothing is written until focus leaves the
    field — one undo step, not one per keystroke — then open
    **Parameters** and confirm only the parameters that capability has
    are offered, that each says what the global default is on the choice
    that leaves it out, and that choosing a shape reshapes a node that
    is still empty while leaving one that holds something alone. Empty
    the prompt with nothing connected to it, remove the model
    for that capability, and boot a deployment without the provider
    executor: each says why on the button instead of failing on the
    click. Ask for three images, stop a run part way, and ask a failed
    run again from both the panel and the node's menu. While a run is
    going confirm the card shows how far it has got, or a band that says
    only that it is going, and that a text node shows the words as they
    arrive; after one that failed confirm the mark and the reason where
    the card is pointed at, with what it held before still in place, and
    after one that brought several answers confirm the count on the
    card. In the inspector confirm every ask the node has had is listed
    rather than only the newest, that the result the node shows is named
    as such, and that making another of them the one shown — from there
    or from the menu of a card holding one answer of a batch — is one
    undo step. Finally leave the project and switch canvas with a run
    still going: both say how many are going, neither stops one, and
    what it makes is in the project when it is opened again.
12. Give a node something to work from, which is the half of an ask that
    decides what a provider is handed. Wire a text node into an image
    node and open **Preview**: the words arrive as a run will send them,
    with the upstream text folded in under a `[Text 1]` heading of its
    own, and each reference is listed with its mime type, dimensions,
    size and the card it came from. Run it and confirm that is what the
    provider was handed — the automated equivalent is
    `cargo test --test provider_runs what_the_panel_shows`, with the
    panel, the bar and the mention field covered by `npm test`. Point at
    two nodes by hand and drag one above the other, and confirm the
    preview lists them in the new order rather than in the order the
    wires were drawn — and that the prompt's own words take over from
    the list as soon as they name a card, there being no mode to choose
    on the panel. Type `@`, and confirm what is offered is the nodes
    this one could mean, that a picture is offered by its thumbnail and
    a text by its first words, that what is chosen is written as
    `@[node:<id>]` and drawn in the field as the card's name between
    ticks, that hovering the name summons what it points at, and that
    backspace takes it out whole. Confirm the strip under the field
    lists what the prompt names, in the order it names them, wearing the
    mark of its kind where the card has no picture — a text and an audio
    — and that hovering an entry shows the whole of it: the words, the
    sound playing, the picture large. Delete the node a mention names
    and confirm the name is drawn as one that is gone, that the field
    says so, and that the button refuses rather than sending an ask that
    quietly means something else. Drop an asset from the assets panel
    onto the bar and confirm it is wired in beside the node when the
    wiring is what the ask reads, and listed by it when a list kept by
    hand is; confirm the bar takes nothing while the prompt names its own
    cards, since nothing dropped there would be read. Move a wired-in
    reference onto the mask or the first frame of the node taking it and
    confirm the preview lists it under that role. Fill an upstream text
    past the prompt limit and confirm the preview says by how much it was
    cut; remove an asset's file from under the project and confirm its
    reference is listed as one that will not travel rather than dropped
    from the list. Copy a node whose prompt mentions another and paste
    it: the copy's mention names the copy. Choose **Image from these
    words** on a text node and confirm a node appears to its right,
    wired to it, with its panel open and nothing asked for yet. Finally
    link an asset the project already holds to an empty image node from
    the inspector and confirm the node stops waiting without a run.
13. Work on a picture the project already holds, which is the half of a
    canvas that asks nobody for anything. Select one image node and
    confirm a row of tools comes up over its card, and that it goes while
    the card is being moved so the press that ends the move cannot land
    on a tool. Hide two entries under **Settings** → **Preferences** →
    _Picture tools on a node_, reload, and confirm the row is as it was
    left while the document says nothing about it — the choice is kept on
    this machine and travels in no package. Crop by a proportion and by a
    region given in the picture's own pixels, divide into a grid,
    resample to a named size and to one typed in, and tilt: each files a
    new asset named after the picture it came from rather than rewriting
    it, puts it on a card to the right wired back to what it was made
    from, and leaves the subject's own bytes as they were. In the
    inspector confirm the result says which tool made it and which
    picture it was made from, with no run offered as an explanation, and
    that a picture a run did make still names the run. Confirm a
    division's pieces arrive in one undo step and all of them selected,
    and that letting go takes the cards and the wires while leaving every
    file filed. Refuse one: a region wider than the picture, a division
    past its ceiling, a proportion nobody can read — each says so before
    anything is written, and the dialog stays open with nothing spent.
    Take an asset's file out of the project and confirm the bar says why
    instead of offering a tool that would fail in a moment reading as the
    tool breaking. Finally paint a region for **Repaint** and confirm the
    marking is filed as an asset of its own, wired into the picture's
    mask port, with the words written into that picture's ask and nothing
    spent from the dialog; and ask **Describe** against a model you
    really configured, confirming the reading is shown as it arrives,
    becomes a text node wired into the picture's prompt, and can be let
    go of half way through. The automated equivalents are
    `cargo test imaging`, `npm test`, and
    `npx playwright test picture-tools`.
14. Hold a conversation over a canvas, which is the other half of asking.
    Open the **Assistant** tab beside the inspector and confirm the head of
    the panel says what the conversation is about in counts — the selected
    cards and whatever feeds them — and that naming one more with `@` adds
    it to that. Ask a question against a model you really configured and
    confirm the answer arrives as it is written, then becomes a kept line;
    reload and confirm the same conversation is still there, that the list
    at the head offers every conversation this canvas has had, that a new
    one starts empty, and that renaming or removing one is reflected after
    another reload. Select a text card and choose **Rewrite**, then
    **Replace selection**: the card's words change in one undo step and the
    line it came from stays. From other lines confirm **Insert on canvas**
    makes a card of its own, **Copy text** and **Download** do what they
    say, and **Ask again** puts the question back in the field without
    sending it twice. Choose **Image**: a card lands beside the cards it was
    about, wired to them, the file is filed once under `assets/images/`
    with provenance naming the run and the conversation that asked, and
    both **Show on canvas** and **Show in assets** go where they promise.
    Make one fail — remove the model, or point it at a provider
    that gives up — and confirm the trouble is a line in the conversation
    carrying the reason rather than a notice that fades, that **Ask the card
    again** offered from it re-runs the card that is there rather than
    adding a second one, and that the card still says nothing it never got.
    For a words ask, choose how many earlier lines travel with the question
    and confirm the panel counts the characters that go and the provider was
    handed those lines; a media ask offers no such choice, since the cards
    feed it over wires. A conversation longer than the column steps back in
    increments, and a card a kept line was about that has since been deleted
    says so rather than offering to find it. Finally remove the model for a
    kind and confirm the panel names the kind that is missing and offers the
    settings instead of answering the ask badly. The automated equivalents
    are `npm test` and `npx playwright test assistant`.
15. Switch the interface's language: Settings → Preferences → Language,
    pick 中文 — the screens, the messages, and the browser tab's title all
    change with it — then pick English and confirm they change back; leave
    it on Follow system and confirm the choice survives a reload. The
    automated equivalent is `npx playwright test e2e/i18n.spec.ts`.

## macOS (`make package-macos`, Intel: `make package-macos-x86`)

1. Build the DMG; eject any previously mounted copy first (a leftover
   mount makes the bundler fail with a generic `bundle_dmg.sh` error).
2. Mount the DMG read-only, verify the app icon, background, and
   Applications symlink, then eject and clean up the mount the same
   session.
3. Install and launch: Gatekeeper may warn on the unsigned build (first
   launch via right-click → Open).
4. Repeat the web checklist items 3–6 inside the desktop app, including
   native directory pickers (Browse… buttons) and reveal-in-Finder.
5. Double-click a `.moka` file in Finder: it opens in a running instance
   (single-instance) or launches the app with the project open.
6. Audio/video previews play; media blob URLs are allowed by the app CSP.
7. Check the embedded config is used: no `config/` file next to the app
   changes its behavior.
8. Locale name: on a Chinese-language system, Finder, the Dock, and the
   menu bar show the app as 摩卡画布; on any other system they read
   Moka Canvas. The bundle folder itself keeps its English name
   ("Moka Canvas.app") in both cases, and
   `codesign --verify --strict` still passes.
9. Intel bundle (`make package-macos-x86`): `lipo -archs` on the mounted
   app's `Contents/MacOS/moka-canvas` prints `x86_64`, and the app
   launches — under Rosetta 2 when the host is Apple Silicon.

## Windows (`make package-windows` on Windows, or

`make cross-package-windows` on macOS)

1. Verify the installer actually contains the `web/` resource directory
   (`7zz l <setup.exe>`) — an installer built while `dist/` was empty
   silently ships without it and the app exits on launch.
2. Install and launch; SmartScreen may warn on the unsigned build.
3. Repeat the web checklist items 3–6 inside the desktop app.
4. Double-click a `.moka` file in Explorer: the NSIS-registered
   association opens it with the document icon (not the app icon).
5. `.moka` uninstall removes the association (NSIS `APP_UNASSOCIATE`).
6. The installer's first step is the language picker (English /
   中文(简体)), and the welcome page, finish page, and progress text
   follow the choice.
7. Install in Chinese: the desktop and start-menu shortcuts read
   摩卡画布, Settings → Apps lists the app as 摩卡画布, and the `.moka`
   association says it opens with 摩卡画布. Run the installer again in
   English (upgrade/repair): the names become English, and no 摩卡画布
   shortcut is left behind.
8. Uninstall in either language: the programs-list entry and both name
   variants of the shortcuts are removed, none left as a dead link.

## Linux (`make package-linux`)

1. Build from the checkout; the `.deb`, `.rpm`, and `.AppImage` land in
   `release/`. Packaging the AppImage needs network on a first run — Tauri
   fetches linuxdeploy into `~/.cache/tauri/` (see `BUILD.md` ›
   Linux 安装包).
2. Install the `.deb` (`sudo apt install ./release/Moka*.deb`): the
   applications menu lists Moka Canvas under **Graphics**, with its icon
   and comment, and `desktop-file-validate` passes on
   `/usr/share/applications/Moka Canvas.desktop` — in particular
   `Categories=` is filled rather than empty.
3. Check the installed paths (`dpkg -L moka-canvas`): the icons sit under
   `hicolor/{32x32,128x128,256x256}/apps/`. A `256x256@2` directory means
   the retina-named icon found its way back into the set.
4. Launch from the menu: the app's icon — window, alt-tab, taskbar — is
   sharp at large sizes. The runtime icon is the first `.png` in
   `bundle.icon` (256×256); a blurry upscaled 32×32 means the list order
   changed.
5. Repeat the web checklist items 3–6 inside the desktop app, including
   native directory pickers (Browse…).
6. Run the AppImage directly (`chmod +x`, then launch): it starts, and
   `--appimage-extract` shows the desktop entry with the same populated
   `Categories=` and the icons under `hicolor/256x256/apps/`.
7. Where an rpm-based distribution is at hand, install the `.rpm`
   (`sudo dnf install ./release/Moka*.rpm`) and confirm the same menu
   entry; otherwise `rpm -qpl` shows the same icon paths inside the
   package.

## Metadata store (all platforms)

Configuration, recent projects, model configurations, and encrypted credentials
live in the platform application-data directory, never in the program tree. See
[security.md](security.md) and [deployment.md](deployment.md).

1. Record the path from `GET /api/health` (`metadata.root`). It is
   reported with the home directory replaced by a literal `$HOME`;
   expand it and confirm it is the OS application-data location for
   that platform, not the install directory.
2. Confirm no metadata file landed in the program tree: nothing named
   `meta.json`, `recent-projects.json`, `models.json`,
   `secrets.json`, or `master.key` under the repository `data/`,
   the served `dist/`, or the executable's own directory.
3. Store a real API key through the settings dialog (Channels → Edit →
   API key), then search for it three ways and find nothing —
   `grep -r "sk-"` over the metadata directory, `strings` over every
   file in it, and the captured HTTP responses and server log for
   that session. Only a fingerprint and a masked form may appear.
   The dialog must not echo it either: reopen the model and
   confirm the key field is empty with the masked form as its
   placeholder. The automated equivalent is
   `cargo test --test metadata_file`.
4. Confirm `secrets.json` is mode `0600` and the metadata directory
   `0700` (macOS and Linux).
5. Confirm `/api/health` reports `secretStorage` and that the value
   fits the runtime: `keyring` for a desktop build with a usable
   keychain, `file` when the master key came from
   `<metadata.dir>/master.key` — including one the server created
   itself because `MOKA_METADATA_KEY` was not exported — `env` for a
   server started with `MOKA_METADATA_KEY`, and `unset` while no
   credential has ever been stored. The settings dialog repeats the
   tier next to the API key field, so confirm the two agree.
6. Hard-kill the process (`kill -9`, or Force Quit / Task Manager),
   then relaunch: `tmp/` is empty, no document is reported
   `corrupt`, model configurations and the recent-project list are intact, and
   the directory lock was released (no "in use by another process"
   error).
7. Copy the whole metadata directory to another user account or
   another machine and start the app there: models, defaults,
   preferences, and the prompt library are all present. Stored API
   keys are **not** expected to work unless the master key travelled
   with them — that is the documented behaviour, not a defect.
8. Before installing an **older** build over a newer one, back up the
   metadata directory by copying it whole. A directory stamped with a
   schema version other than the one a build reads refuses to open;
   nothing is migrated or downgraded in place, so the backup is the
   only way back. Record that the backup was taken.
9. Project documents follow the same rule, so copy any open project
   directory too before rolling back. A `.moka` stamped with a canvas
   schema other than the running build's is reported as an unsupported
   version and is never rewritten. Optional fields the build does not
   know — per-node generation settings, for instance — are ignored on
   read instead of rejecting the document.

## Performance smoke (reference machine)

1. Open the 200-node/300-edge stress project; pan, zoom, and drag stay
   responsive; frame times stay within the recorded tolerance.
2. A long undo/redo session (30+ operations) neither leaks memory nor
   degrades responsiveness.
3. Autosave never blocks pointer input while a save is in flight.

## Cutting room

The manual script for the cutting room (timeline editing, transitions, text
and subtitles, and a **real** video export) is package 13's §4 in
`note/plan/13-quality-gates-and-acceptance.md`: it needs a browser with
H.264 and an ffmpeg ≥ 5.0 with libass, which the automated suites do not
assume. Run it on the reference machine before a release, together with:

1. `make check && npm run test:e2e` — the full gate, including the eleven
   cutting-room e2e specs beside every editor spec.
2. A packaged-build smoke: install the DMG, open a project, drop one of
   `fixtures/tiny.mp4`'s kind on a timeline, and export it — then
   **detach the disk image in the same run and clear any leftover mount
   points**, so no zombie volume is left behind.
3. The acceptance record from that run (`note/acceptance-<date>.md`,
   local) with its conclusion line quoted in the release commit.

## Known limitations

Intended behaviour, recorded here so a tester does not file it as a defect.

1. **Importing one package twice keeps one project id.** An import does not
   give the arriving document a new id, so two directories unpacked from the
   same package describe the same project. The recent-project list is keyed
   by that id and holds one entry for it: opening the second copy replaces
   the first in the list rather than sitting beside it, though both
   directories remain on disk and each still opens. Keeping several
   independent copies of one package means giving the document a new id,
   which this build does not do on your behalf.
2. **A picture asked for in a conversation is two steps of undo.** The card
   and the line that asked for it are separate entries deliberately: taking
   back what was said should not quietly delete a picture that was paid
   for.
3. **A web deployment holds one set of models and keys.** The metadata
   store — model configurations, credentials, defaults, preferences — is a
   single-user, file-backed store: the deployment's operator owns it and
   every visitor asks through the same models and spends the same keys.
   Per-project or per-user keys are not part of this build; per-user
   metadata directories wait for a database-backed store. Serve a web
   build only where the operator means everyone to share what they
   configured.

## Sign-off

| Platform | Build | Date | Result | Notes |
| -------- | ----- | ---- | ------ | ----- |
| Web      |       |      |        |       |
| macOS    |       |      |        |       |
| Windows  |       |      |        |       |
| Linux    |       |      |        |       |
