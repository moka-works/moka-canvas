# 构建指南

在各类主机上构建与打包摩卡画布的必备条件与命令。

## 通用前置条件

| 工具        | 版本   | 说明                                  |
| ----------- | ------ | ------------------------------------- |
| Node.js     | 22+    | 推荐 LTS                              |
| npm         | 10+    | 随 Node.js 附带                       |
| Rust 工具链 | stable | 包含 `cargo` 与 `rustup`              |
| Tauri CLI   | 2.x    | 作为开发依赖安装（`@tauri-apps/cli`） |

[Tauri 前置条件](https://tauri.app/start/prerequisites/) 是打包工具链的上游参考；本项目中各主机具体需要什么见下文。

## 平台前置条件

### macOS

| 要求             | 安装方式                                                          |
| ---------------- | ----------------------------------------------------------------- |
| Xcode 命令行工具 | `xcode-select --install` —— clang、SDK 与 `codesign`              |
| Rust 工具链      | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js 22+      | `brew install node`，或来自 nodejs.org 的安装器                   |

窗口由系统自带的 WebKit 渲染，因此桌面应用不需要安装其他任何东西即可运行。`make package-macos` 也不需要更多工具。

### Windows

| 要求              | 安装方式                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSVC C++ 生成工具 | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` —— 即「使用 C++ 的桌面开发」工作负载 |
| Rust 工具链       | `winget install Rustlang.Rustup`，然后 `rustup default stable-msvc`（MSVC 宿主目标，不是 GNU）                                                                                                |
| Node.js 22+       | `winget install OpenJS.NodeJS.LTS`                                                                                                                                                            |
| WebView2 运行时   | Windows 11 与当前 Windows 10 预装；没有的机器请从 [WebView2 页面](https://developer.microsoft.com/microsoft-edge/webview2/) 安装 Evergreen Bootstrapper                                       |

应用的窗口由 WebView2——Edge 的渲染引擎——绘制，因此无论是运行 `make tauri-dev` 还是使用安装后的应用都需要它：没有它就没有窗口可画。NSIS 安装包在缺少它的机器上会下载微软的引导程序来安装，所以那次安装需要联网。WiX 与 NSIS 本身只在构建安装器时才需要，`make package-windows` 按 Tauri 前置条件覆盖了这些。

### Linux

窗口由 WebKitGTK 渲染，开发包在构建与运行时都要有——缺了它 `cargo` 会在 `webkit2gtk-sys` 处停下。Debian、Ubuntu 及其衍生版一条命令装齐（即 Tauri 前置条件里的那一行）：

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

rpm 系发行版把 `-dev` 换成对应的 `-devel`（`webkit2gtk4.1-devel`、`gtk3-devel`、`libsoup3-devel`、`librsvg2-devel`）；具体包名以 [Tauri 前置条件](https://tauri.app/start/prerequisites/) 为准。Rust 与 Node.js 的装法同 macOS。

## 片段导出（ffmpeg）

时间线导出由 ffmpeg 完成，它不随程序打包。没有它程序照常运行——导出会自报不可用，其对话框列出每一条出路——要导出的机器需要一份带 **libass**（烧录字幕的 `ass` 滤镜）与 `xfade`（转场）的构建。`brew install ffmpeg` 的普通 formula 编译时不含 libass：没有台词的剪辑可以导出，带台词的剪辑会被点名拒绝，而不是悄悄把台词丢掉。

渲染器按以下顺序在三个地方查找：配置文件中的 `clip.ffmpegPath`（`config/moka.example.yaml` 里的 `clip` 一节）、`MOKA_FFMPEG` 环境变量，然后是平台搜索路径。指名而不存在的路径视为不可用，而不会改用另一个 ffmpeg 运行——这正是让一台机器上的渲染器保持确定的原因。

macOS：

```sh
brew install ffmpeg-full
```

`ffmpeg-full` 是 keg-only —— 链接它会遮蔽精简的 `ffmpeg` —— 所以之后要让程序指向它：Apple Silicon 上是 `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`，Intel 上是 `/usr/local/opt/ffmpeg-full/bin/ffmpeg`。

```sh
MOKA_FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg make tauri-dev
```

或者写进配置文件作为 `clip.ffmpegPath`，让每次运行都能找到。Rust 测试套件以同样方式查找渲染器；ffmpeg 缺 libass 的机器会在两个烧录字幕的片段测试上失败，因此在 macOS 上完整跑一遍是 `MOKA_FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg make check`。

Windows：安装一份全功能构建——gyan.dev 的 ["full"](https://www.gyan.dev/ffmpeg/builds/)，或 [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases) 的发布版——同样指名它，`clip.ffmpegPath: 'C:\path\to\ffmpeg.exe'` 或 `MOKA_FFMPEG`，或把它的 `bin` 目录放进 `PATH`。

Linux：发行版自己的 `ffmpeg` 包通常就是带 libass 的完整构建——Debian 与 Ubuntu 的官方构建即是如此——`sudo apt install ffmpeg` 之后用下面那条命令确认即可。

任何构建都可以被问它有什么：`ffmpeg -h filter=ass` 在滤镜存在时会描述它，不存在时会说 `Unknown filter 'ass'.`。

## 安装依赖

```sh
make install   # npm ci
```

## 验证工具链

```sh
make check
```

先运行前端构建、Prettier/ESLint/TypeScript 检查与 Vitest 套件，然后对 Rust 服务器运行 `cargo fmt --check`、`cargo clippy -D warnings` 与 `cargo test`。`make test` 只跑两个测试套件（Vitest 与 `cargo test`）。

## 本地运行

```sh
make web-serve   # 构建前端，在 http://127.0.0.1:8080 提供 dist/ + API
make tauri-dev   # 构建前端，运行 Tauri 桌面应用
```

## 版本号

```sh
make set-version 1.2.3
```

一处设定所有构建产物的版本：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`，以及 `src-tauri/Cargo.lock` 中的 `moka-canvas` 条目。Windows 安装器元数据与 DMG/setup 文件名都由这些派生，因此发布打包前先运行它。

## 界面语言

界面同时携带英文与简体中文。语言包位于 `src/shared/i18n/locales/en/` 与 `.../zh/`，按区域每个文件一份（`editor`、`clip`、`settings`、`assistant`、`story`、`app`、`common`、`domain`、`errors`、`problems`）；代码用键命名它的词语，语言包持有这些词。界面跟随机器的语言，读者也可以在 设置 → 偏好设置 → 语言 中钉住英文或中文，在该机器上记住。自动化测试套件钉住英文，因此它们的断言逐字读英文语言包。

打包后的应用名有自己的规则，见下文 Windows 安装器与 macOS DMG 两节。

## 转换器协议

本程序说出的每个协议都是一个转换器，而转换器是模型目录下的一个目录——Rust 或 TypeScript 里没有协议表。桌面安装上，该目录是元数据目录旁边的 `models/`（macOS 为 `~/Library/Application Support/MokaCanvas/models`，Windows 为 `%APPDATA%\MokaCanvas\models`）；服务器上，它是配置的 `metadata.dir` 旁边的 `models/`。

```
<模型根目录>/<capability>/<id>/
  model.json      协议声明了什么
  <script>.lua    它做什么
```

`<capability>` 是 `text`、`image`、`speech`、`music`、`video`、`asr` 之一。`<id>` 是目录自身的名字：模型配置存储的线上名字，因此一旦有模型使用它就不能更改。`.lua` 文件名是自由的——由 `model.json` 指名。没有任何东西读取的能力目录——比如声音拆分为语音与音乐之前的 `audio/`——留在原处：内置部署写在它旁边而不是覆盖它，移除它是读者自己的整理。

`model.json` 就是全部声明：

| 字段          | 含义                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName` | 没有匹配标签时它使用的名字，也是服务器自身消息使用的名字。必填。                                                                                                                                                                   |
| `labels`      | 各语言的名字，例如 `{"zh": "…"}`。没有条目的语言回退到 `displayName`，再回退到 id。                                                                                                                                                |
| `urlExample`  | 展示给读者、作为可复制形状的地址。必填。                                                                                                                                                                                           |
| `script`      | 本文档旁边的 Lua 文件。必填。                                                                                                                                                                                                      |
| `order`       | 它在自己的能力内所处的位置，升序，同名按名称排（默认 1000）。                                                                                                                                                                      |
| `auth`        | 凭据搭载在哪里：除非另有说明，是 `{"header": "Authorization", "scheme": "Bearer"}`；没有 scheme 的密钥用 `{"header": "x-goog-api-key", "scheme": ""}`；不接受凭据的端点用 `{"header": ""}`。只有配置端点同源之内的地址才会拿到它。 |
| `features`    | 界面读取的自由形式标志，例如 `{"mask": true}` 表示某个图像协议有自己的蒙版字段。                                                                                                                                                   |
| `version`     | 内置部署据此决定是否接管一个目录（见下）。手写的转换器省略此项。                                                                                                                                                                   |

Lua 侧是一组钩子，全部可选，脚本导出了哪些钩子就是宿主认为自己能做什么：

| 钩子                                         | 用途                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_request(call, req, inputs)`           | 描述一次调用：`{method, url, headers = {name = value}, body = …}`；当应答需要自己的函数来读取时用 `{request = …, handler = …}`；在发出任何东西之前就拒绝用 `{error = …}`。 |
| `parse_response(status, headers, body)`      | 把该应答读成 `{text, items, usage, error}`。                                                                                                                               |
| `build_stream_request(call, req, inputs)`    | 同上，用于以事件作答的端点；导出它就表示该转换器是流式的。每个事件由 `parse_event(event)` 读取。                                                                           |
| `build_task_request` / `parse_task_response` | 启动一个比单次请求更长寿的任务；应答用 `{reference = …}` 点名服务商的句柄。                                                                                                |
| `build_poll_request` / `parse_poll_response` | 看一眼那个任务：`{status = "pending"}`、`{status = "succeeded", result = {items = …}}`、`{status = "failed", error = …}` 或 `{status = "expired"}`。                       |

脚本内部，`call` 是 `{url, model}`（完整配置的端点与服务商的模型名），`req` 是 `{prompt, system, capability, params}`，每个输入是 `{role, filename, mime, data_url}`，字节以 base64 编码在 data URL 中。条目可以以 `{url = …}` 报告其字节（宿主去抓取，凭据遵循同样的同源规则）、`{data_url = …}`、`{base64 = …}`，或用 `{raw = true}` 表示应答自身的 body。宿主 API 是 `json`、`base64`、`log` 与 `util`；凭据从不交给脚本。

内置转换器随程序发布：`src-tauri/build.rs` 在编译时嵌入 `src-tauri/converter-scripts/models/` 下的每个目录（畸形的目录会使构建失败），启动时把每一个写入模型根目录，除非那里已部署的版本至少同样新——因此读者编辑过的转换器会保留，直到更高版本的内置版本超过它。本构建不认识的目录永远不会被读取、写入或移除。

所以添加一个协议就是那个目录本身，别无其他：没有 Rust、没有 TypeScript、没有 i18n 文件。放进去、重启，名字就会出现在设置里与内置协议并列。`src-tauri/tests/converter_extensibility.rs` 是这一主张的可执行形式。

## 打包目标

### Web（任何主机）

```sh
make package-web
```

构建前端、编译 `moka-server` 发布二进制，并在 `release/moka-canvas-web-<version>-<platform>-<arch>/` 下暂存一份自包含发行版，包含 `dist/`、原生服务器二进制与一份 `README.txt`。运行暂存的服务器：

```sh
./moka-server --static-dir dist --port 8080
```

### macOS DMG（仅 macOS）

```sh
make package-macos
```

生成 `Moka Canvas_<version>_<arch>.dmg`（Apple Silicon 上 `aarch64`，Intel 上 `x64`），复制进 `release/`（tauri-bundler 的输出保留在 `src-tauri/target/release/bundle/dmg/` 下），带品牌背景与 app/Applications 投放槽，通过 `src-tauri/tauri.conf.json` 的 `bundle.macOS.dmg` 配置。`.app` 包为 ad-hoc 签名（`bundle.macOS.signingIdentity` = `"-"`）；DMG 自身不签名，这是 Tauri 对自签名身份的刻意做法。首次启动时 Gatekeeper 仍会警告，因为 ad-hoc 签名未公证——右键选择「打开」。

包保留英文名——`.app` 文件夹、可执行文件与 DMG 文件名。在中文系统上，访达、程序坞与菜单栏显示的是摩卡画布：`bundle.macOS.files` 随附 `Contents/Resources/zh-Hans.lproj/InfoPlist.strings`（以及旁边的 `zh-Hant`），macOS 从那里读取本地化的 `CFBundleDisplayName`/`CFBundleName`；其他语言回退到包自身的名字。这些文件在包签名之前复制，因此 ad-hoc 签名仍然可验证。

> 重新构建会删除上一个 DMG，所以在再次运行 `make package-macos` 之前先弹出任何已挂载的副本——否则 DMG 会作为残留卷保持挂载，Finder 样式化步骤会以通用的 `error running bundle_dmg.sh` 失败。

### Windows 安装器（Windows 主机）

```sh
make package-windows
```

在 `src-tauri/target/release/bundle/` 下生成 MSI 与 NSIS 安装器，并复制进 `release/`。需要 Microsoft C++ Build Tools、WebView2，以及按 Tauri 的 Windows 前置条件所需的 WiX/NSIS 工具链。

NSIS 安装器由自定义模板构建（`src-tauri/installer/installer.nsi`，从 Tauri 默认模板派生），提供品牌欢迎页与完成页，以及来自 `src-tauri/installer/` 的头部位图；通过 `src-tauri/tauri.conf.json` 的 `bundle.windows.nsis.template` 选用。因为模板是派生的，它不会自动获得上游 Tauri 的修复——每次升级 Tauri CLI 时都要重新与[上游模板](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)做 diff。

安装器是双语的。`bundle.windows.nsis.languages` 列出 `English` 与 `SimpChinese`，交互式安装以标准 MUI 语言选择页作为第一步；`/P` 与 `/UPDATE` 运行则复用上一次安装存储的语言，因此磁盘上已有的名字保持不变。模板添加的文本是靠近文件底部的 NSIS `LangString`（文件必须保持无 BOM 的 UTF-8），且必须为该列表中的每种语言定义——缺失只会是编译期警告（6040），并渲染为空字符串。应用的可见名跟随所选语言：桌面与开始菜单快捷方式、程序列表条目、`.moka` 关联文本在中文下显示摩卡画布，否则显示 "Moka Canvas"。编译期的 `${PRODUCTNAME}`（"Moka Canvas"）仍是背后一切的身份——安装文件夹、注册表键、`uninstall.exe` 与安装文件名——因此升级与卸载始终匹配，另一种语言下的安装会替换旧名快捷方式，而不是把它们留在新的旁边。

### Windows 安装器交叉编译（macOS 主机）

```sh
make cross-package-windows
```

用 `x86_64-pc-windows-gnu` Rust 目标与 mingw-w64 在 macOS 上交叉编译 NSIS 安装器（`Moka Canvas_<version>_x64-setup.exe`），然后复制进 `release/`。

主机前置条件：

```sh
brew install mingw-w64 makensis
```

Makefile 强制这些检查，并在缺失时自动安装 Rust 目标。构建设置 `LC_ALL=en_US.UTF-8`，因为 makensis 在非 UTF-8 locale 下会以 `std::bad_alloc` 中止（[NSIS bug 1165](https://sourceforge.net/p/nsis/bugs/1165/)）。

注意事项：

- 打包的 exe 未签名；Windows SmartScreen 可能会警告。
- 交叉构建的安装器尚未在物理 Windows 机器上冒烟测试；分发前先安装一次验证。
- 绝不要把 `cross-package-windows` 与另一个打包任务（`package-macos`、`package-web`、`web-build`）并发运行。它们都会重建 `dist/`，而 vite 在重建开始时清空 `dist/`。如果 bundler 在 `dist/` 为空时解析资源，Tauri 的资源遍历器会静默跳过该目录，产出没有 `web/` 的安装器——安装后的应用启动即退出（内嵌 HTTP 服务器需要 `web/` 资源目录）。如果安装好的 Windows 构建双击「没反应」，检查安装器确实包含 `web/`（`7zz l <setup.exe>`）并重建。

### Linux 安装包（仅 Linux）

```sh
make package-linux
```

在 `src-tauri/target/release/bundle/` 下生成三种包，并由 `scripts/collect-release.mjs` 一并复制进 `release/`：

| 包       | 文件名                                 | 面向                      |
| -------- | -------------------------------------- | ------------------------- |
| deb      | `Moka Canvas_<version>_amd64.deb`      | Debian、Ubuntu 及其衍生版 |
| rpm      | `Moka Canvas-<version>-1.x86_64.rpm`   | Fedora、RHEL、openSUSE    |
| AppImage | `Moka Canvas_<version>_amd64.AppImage` | 任何发行版，免安装        |

deb 与 rpm 交给系统包管理器安装，它们的运行期依赖由 Tauri 从构建机上实际链接到的库推出（本构建得到的是 `libwebkit2gtk-4.1-0` 与 `libgtk-3-0`）。AppImage 自带全部内容，`chmod +x` 之后直接运行。

AppImage 由 linuxdeploy 生成：Tauri 从 GitHub 取 linuxdeploy、AppRun 与 gtk 插件，放在 `~/.cache/tauri/` 下，所以打包 AppImage 需要联网。那份缓存不在 `make clean` 的范围内——它是跨项目共用的工具，不是本仓库的产物。

每种包各起一次 `npm run tauri build -- --bundles <kind>`，而不是把三种写进同一次运行：`@tauri-apps/cli` 2.11.4 内置的 tauri-bundler 2.9.4 进程被打包两种以上时，会在打完最后一种之后空转——CPU 满载、不再输出、也不落任何文件——而只要一种就总能收尾。两次运行的差别仅在这个分组，产物完全一致。

### 更新应用图标

Windows 通过两条独立路径使用图标，都源自 `src-tauri/icons/`：

- exe 的 `.rsrc` 段（资源管理器/快捷方式图标），由 tauri-build 写入。
- 一个在编译时由 `generate_context!()` 宏嵌入的 RGBA 副本（运行时窗口/任务栏图标）。

`tauri-build` 不会为 `icons/icon.ico` 发出 `rerun-if-changed`，因此替换图标后，陈旧的构建缓存可能仍保留旧的运行时图标，即使源文件是新的。打包前强制重建 lib crate：

```sh
touch src-tauri/src/lib.rs
```

或运行一次 `make clean`。之后 Windows 可能仍从其 shell 图标缓存显示旧图标——在 Windows 机器上刷新它：从任务栏取消固定应用、重新安装、重新固定，然后运行 `ie4uinit.exe -show`（或重启 explorer.exe）以刷新图标缓存。

Linux 与其他 Unix 的运行时窗口图标同样取自编译期嵌入的这份 RGBA 副本，且固定取 `bundle.icon` 里的**第一个 `.png`**——本仓库因此把 `icons/256x256.png` 排在首位，窗口图标不再是被拉大的 32×32。这个文件没有沿用上游模板的 `128x128@2x.png` 命名：tauri-bundler 会把名字以 `@2x` 结尾的 PNG 装进 `hicolor/256x256@2/`，那是 freedesktop 主题不识别的非标准目录；命名为 `256x256.png` 后落在标准的 `hicolor/256x256/`。用 `tauri icon` 之类工具重新生成图标集时请保持这两点，并同步更新 README 徽标里引用的文件名。

### `.moka` 文件关联

`*.moka` 文档注册为用本应用打开，并使用自己的文档图标（上一版应用图标设计），构建为 `src-tauri/icons/moka-file.icns` / `moka-file.ico`，并通过 `src-tauri/tauri.conf.json` 的 `bundle.resources` 随附：

- **macOS**：`src-tauri/Info.plist`（由 Tauri 自动合并进包的 Info.plist）声明 `app.canvas.moka` UTI 与文档类型，`CFBundleTypeIconFile` = `moka-file`。
- **Windows（NSIS）**：派生的 `installer/installer.nsi` 为 `.moka` 硬编码 `APP_ASSOCIATE`/`APP_UNASSOCIATE`，`DefaultIcon` = `$INSTDIR\moka-file.ico`。这替换了上游的 `{{#each file_associations}}` 循环，后者无法使用单独的文档图标——与上游模板重新 diff 时重新应用这处分歧。
- MSI 包（在 Windows 主机上由 `package-windows` 构建）**不**注册该关联，其文本保持英文；两者的分发都请用 NSIS setup exe。

## 清理

```sh
make clean
```

移除 `dist/`、`release/`、`src-tauri/target/` 与 TypeScript 构建缓存（`node_modules/.tmp`）。

## 签名与公证

### macOS ad-hoc 签名（默认）

`src-tauri/tauri.conf.json` 中 `bundle.macOS.signingIdentity` 设为 `"-"`，因此 bundler 由内而外 ad-hoc 签名 `.app`——先外部二进制如 `moka-server` 与任何框架，再包本身。没有它，包完全不带 `_CodeSignature/CodeResources`，只有每个 Mach-O 上链接器生成的 ad-hoc 签名，`codesign --verify` 会以 `code has no resources but signature indicates they must be present` 失败。用以下命令验证构建：

```sh
codesign --verify --verbose=3 "Moka Canvas.app"
codesign -dv --verbose=2 "Moka Canvas.app"   # 期待 Sealed Resources version=2
```

Ad-hoc 签名证明包的内容完整、彼此一致。它**不**满足 Gatekeeper：ad-hoc 签名无法公证，因此下载的 DMG 仍会提示，`spctl` 持续拒绝它。这是没有任何 Apple 凭据的构建能诚实宣称的，仅此而已。

### Developer ID 签名与公证（发布）

发布签名（Windows 的 Authenticode，macOS 的 Developer ID + 公证）需要组织特定的凭据，超出此基线范围。有凭据时 macOS 无需改配置：CLI 读取 `APPLE_SIGNING_IDENTITY` 并让它胜过 `signingIdentity`，因此真实身份按构建提供，无需编辑受跟踪的配置。

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: <org> (<team id>)" make package-macos
```

当 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`（或 `APPLE_API_KEY*` 等价物）存在时会自动尝试公证，不存在时跳过并给出警告。注意身份为 `"-"` 时 DMG 保持未签名——Tauri 有意跳过自签名 DMG——因此给 DMG 本身签名同样需要真实身份。
