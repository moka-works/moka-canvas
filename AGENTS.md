# AGENTS.md

本文件供在本仓库工作的编码代理参考；人类开发者请看 `README.md` 与 `BUILD.md`。与用户当次的明确指令冲突时，以用户当次指令为准。

## 项目概览

**摩卡画布（Moka Canvas）**——本地优先的 AI 创作画布：项目、素材与密钥都保存在用户自己的机器上，无账号、不上传。画布（节点加连线）之外还有故事室、剪辑室、素材架。项目就是一个普通文件夹，拷走即迁移；应用状态（模型配置、密钥、偏好、最近项目）在系统应用数据目录，密钥加密保存、只写不回显。

技术栈：**Rust（Axum）本地服务器 + React 19 + LeaferJS + Tauri 2 桌面壳**。Web 与桌面是同一产品的两张脸：桌面窗口加载内嵌服务器地址（`src-tauri/src/lib.rs` 的 `WebviewUrl::External`），全部业务走同源 HTTP `/api/v1/*`，业务代码不直接依赖 Tauri API。

版本号同步存在于 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.lock` 四处；只允许用 `make set-version <semver>` 修改。

## 常用命令

| 命令                                                                                                                       | 作用                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make install`                                                                                                             | `npm ci`                                                                                                                                                                               |
| `make check`                                                                                                               | **提交前硬门槛**：前端构建 + 边界检查 + prettier 检查 + eslint + tsc + vitest + cargo fmt/clippy（`-D warnings`）/ test                                                                |
| `make web-serve`                                                                                                           | 构建前端并由 `moka-server` 提供，http://127.0.0.1:8080                                                                                                                                 |
| `npm run dev`                                                                                                              | Vite 开发服务器（1420，`/api` 代理到 127.0.0.1:8080，需另行起服务器）                                                                                                                  |
| `make tauri-dev`                                                                                                           | 运行桌面壳                                                                                                                                                                             |
| `npm test` / `npm run test:e2e`                                                                                            | vitest 单测 / Playwright e2e（前置先 `make web-build`；端口 `MOKA_E2E_PORT`，默认 8971，可另起一套互不干扰的套件；替身提供方端口随其后（+1），可用 `MOKA_E2E_PROVIDER_PORT` 单独指定） |
| `make package-web` / `package-macos` / `package-macos-x86` / `package-windows` / `package-linux` / `cross-package-windows` | 打包（平台限定见 Makefile）                                                                                                                                                            |
| `make set-version X.Y.Z`                                                                                                   | 同步四处版本号，勿手改                                                                                                                                                                 |

前置：Node.js 22+、npm 10+、Rust stable（桌面打包另需各平台原生依赖，见 `BUILD.md`）。ffmpeg（≥5.0、带 libass）只有剪辑导出与自动字幕需要，可用 `MOKA_FFMPEG` 或配置 `clip.ffmpegPath` 指定；其余功能不依赖。

## 仓库地图

- `src/`——React 前端。`features/{editor,clip,story,assets,settings,assistant}` 按房间划分、`App.tsx` 懒加载；zustand store 在各 feature 的 `stores/`；HTTP 调用只经 `src/api/*`；`shared/i18n/`（i18next，en/zh）、`components/`、`styles/`。
- `src-tauri/`——Rust crate `moka-canvas`：`api/`（路由与结构化 problem 响应）、`project/` `metadata/` `assets/` `domain/` `imaging/`（存储与本地图片运算）、`generate/` `converter/` `workflow/` `story/` `clip/`（模型网关、Lua 转换器、生成与导出）、`prompts.rs`（minijinja 模板）。两个二进制：`moka-canvas`（桌面）与 `moka-server`（Web 服务器）。`tests/` 为集成测试，`resources/native-config.yaml` 是桌面默认配置。
- `e2e/`——Playwright 规格（按功能命名，如 `canvas-*`、`clip-*`、`story-*`、`assets-*`、`critical-path`）+ `helpers.ts`、`mock-provider.ts`。
- `fixtures/`——示例 `.moka` 文档与媒体文件；`scripts/`——`set-version`、`package-web`、`collect-release`、`build-favicon`、`e2e-server` 等；`config/moka.example.yaml`——配置样例；`docs/`——部署、安全、发布检查清单；`BUILD.md` / `BUILD_EN.md`——构建指南（中文 / 英文）。

## 强制边界（`make check-boundaries` 逐条 grep 拦截，违反即构建失败）

1. `src-tauri/src/{project,assets,workflow}` 不得引用 `MetadataStore`——项目内容不得触及元数据层。
2. 前端、Rust 侧、测试与配置中不得出现 `recent_registry_path` / `recentRegistryPath`——被取代的最近项目注册表必须保持删除。
3. 不得引入数据库依赖（`sqlx`、`sea-query`、`sea_orm`）——文件后端是当前唯一后端。
4. `src-tauri/src` 不得出现字面量 `json.tmp`——文档写入必须走唯一的原子写实现。
5. `config/moka.yaml` 必须保持未跟踪——它是单机部署读到的真实配置（地址与密钥），仓库里只提交 `config/moka.example.yaml`。

## 提交与文档规则

- **提交信息一律英文**（conventional 前缀风格）；不得包含日期、机器或环境信息（如 `2026-09-15, macOS arm64` 之类）。
- 收到提交类指令时，先 `git status` / `git diff` 审阅工作区——改动可能来自其他会话或工具；只暂存与任务相关的文件，用户的手改文件不得卷入。每完成一个部分做一次独立提交。
- **文档中文优先**；英文版本保留为 `*_EN` 文件（如 `BUILD.md` / `BUILD_EN.md`）。写文档前先看仓库现状——工作区里的手改即最新意图。
- **用户手改的工作区改动一律保留**：遇到未预期的未提交改动，先查明来源；是用户就地修改就保留并继续，绝不回退或覆盖。
- 密钥只写不回显：界面与服务端都只回掩码，留空保存即保持原值；真实密钥、真实配置不进提交。

## 代码约定

- 所有用户可见文案走 i18next（en/zh 双份），不得硬编码字符串；测试固定英文。
- `src/api/` 是前端访问服务器的唯一出口；错误经 `ApiError` 把服务端 problem code 映射到 i18n 文案，不要各页面自行解析响应。前端请求一律同源相对路径 `/api/v1/*`。
- 服务端错误用 `src-tauri/src/api/problem.rs` 的结构化 problem 体。
- 图标/美术成品须满幅、裁到内容边界（不留空边）；favicon 由 `npm run favicon` 从 `src-tauri/icons` 再生成，不要手改 `public/`。

## 产品准则（用户反复强调，实现与评审都按此把关）

- **Web 与桌面成对**：给桌面端接原生能力（保存/打开对话框等）时，同一需求必须想好 Web 的内置等价物，并与导入项目等既有同类流程保持一致；不要只在桌面端实现。
- **导出/保存必须让用户选目的地**：目录与文件名由用户定（桌面用系统对话框，Web 用内置对话框），不得静默写入固定位置。
- **失败必须露出真实原因**：错误提示带原始错误信息与标识，可用"概要 + 点击展开完整描述"，但不可只有概要；展示时间要足，长文案展开后常驻。不得只报"未返回/失败"。
- **修 bug 流程**：先查根因 → 修复 → 测试验证 → 提交，汇报时给出原因解释；并主动审计同类问题一并处理（用户常要求"同类一起修"），不满足于只修个案。
- **顺带发现的问题只报告，不混入本次提交**：说清发生在哪两处、为何不一致、用户会看到的后果、当前 UI 是否可达，给出修复选项等用户拍板。
- 疑似旧有故障（环境性失败、"flaky"）先用改前构建复现（临时 worktree、symlink `node_modules`、`--repeat-each 3`），拿确凿证据再报，不要以"可能是偶发"交差。
- 改文案或外观时，把同义的关联位置（对话框标题、注释等）一并同步修改；风格/文案类反馈直接动手改，不必反复确认，给选项时"推荐项在前 + 真实取舍"。

## 测试与验证

- 单元测试：vitest，与被测文件同目录（`src/**/*.test.ts[x]`），node 环境。
- e2e：Playwright，`workers: 1`、`fullyParallel: false`（服务器已支持同时打开多个项目、每个窗口各自具名请求，但启动器最近项目列表与应用设置仍全局共享，用例仍须串行）；前置先 `make web-build`；`scripts/e2e-server.mjs` 以临时配置启动真实 `moka-server`，`e2e/mock-provider.ts` 是替身模型提供方。
- Rust：`src-tauri/tests/*.rs` 集成测试（`tower::ServiceExt` + `tempfile`）。
- **UI/交互改动必须在真实界面验证**（`make web-serve` 或 e2e），类型检查与单测不算验证。
- 打包验证纪律：为检查而 `hdiutil attach` 的 DMG 必须**当轮 detach**，并清掉 `rw.*.dmg` 等中间文件——残留的僵尸卷会让用户下次 `make package-macos` 以笼统错误失败。
