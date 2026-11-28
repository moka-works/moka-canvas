# `moka` CLI 与 MCP

`moka` 与界面里的助理使用同一套工具目录与 HTTP 路由。它不直接读写项目文件，只与一个正在运行的本地 Moka Canvas 服务器通信。

## 安装与发现

- 桌面安装包：Linux deb/rpm 安装到 `/usr/bin/moka`；Windows NSIS 把安装目录加入用户 PATH（卸载时恢复）；macOS 的合并 PKG 把应用内的 CLI 链接到 `/usr/local/bin/moka`。
- 独立 CLI 包：`moka-cli-<version>-<平台>-<架构>.tar.gz`（Windows 为 `.zip`），内含二进制、`skills/moka-canvas/`、`skills/moka-storyboard/` 与 LICENSE。
- Web 包：`bin/moka`。
- AppImage 不修改宿主 PATH；需要命令行的机器请用独立 CLI 包。

服务器地址按顺序解析：

1. `--server <URL>`
2. `MOKA_SERVER`
3. 元数据目录里的 `runtime.json`（服务器启动时写入 pid/port/mode/url）
4. `http://127.0.0.1:3000`

```sh
moka doctor
```

`doctor` 会打印找到的服务器、版本、当前项目与目录版本/工具数。找不到服务器时退出码为 3。

## 登录（服务器启用鉴权时）

Web 部署在 `config/moka.yaml` 里配置了 `server.auth` 后，未登录的 CLI 调用会收到 `403 AUTH_REQUIRED`。登录一次即可，会话保存在元数据目录的 `cli-sessions.json`（0600），其后的命令自动携带：

```sh
moka login --username moka                  # 密码从终端读取
MOKA_PASSWORD='…' moka login --username moka
moka login --username moka --password '…'   # 会进入 shell 历史，不推荐
moka doctor                                 # access: signed in as moka
moka logout                                 # 结束该服务器上的登录
```

- `MOKA_USERNAME` 可替代 `--username`；密码依次取 `--password`、`MOKA_PASSWORD`、终端输入。
- 登录哪台服务器由 `--server` 或 `MOKA_SERVER` 决定；不同服务器各存一份会话。
- 服务器未配置 `server.auth` 时，`moka login` 会说明无需登录。
- 服务端改密码后旧会话立即失效，再执行一次 `moka login` 即可。

## 选择项目

```sh
moka --project /path/to/project tools call canvas.list
moka --project 01a15f78-... tools call canvas.list
```

`--project` 是目录或 `.moka` 包时，CLI 先调用 `projects/open`；是 id 时直接作为 `x-moka-project` 头发送。省略时使用服务器当前项目。

## 常用命令

```sh
# 目录
moka tools list                      # 外部可见工具
moka tools list --pack clip
moka tools describe canvas.add_node

# 读
moka --project ./lake tools call canvas.list
moka --project ./lake tools call timeline.get --input '{"timelineId":"tl_1"}'

# 写（command 可撤销）
moka --project ./lake tools call clip.trim \
  --input '{"timelineId":"tl_1","edits":[{"clipId":"cl_1","durationMs":4000}]}'
moka --project ./lake tools call clip.update \
  --input '{"timelineId":"tl_1","clipId":"cl_1","patch":{"transform":{"scale":0.5,"x":0.2,"y":-0.1,"rotation":15}}}'
# 调色：亮度/对比/饱和，以及色温/色调（-1..1，0 为中性）
moka --project ./lake tools call clip.update \
  --input '{"timelineId":"tl_1","clipId":"cl_1","patch":{"adjust":{"brightness":0.1,"contrast":0.2,"saturation":0.15,"temperature":0.3,"tint":-0.1}}}'
# 文字：位置 0..1（覆盖九宫格）、旋转 -180..180、字距与淡入淡出
moka --project ./lake tools call clip.update \
  --input '{"timelineId":"tl_1","clipId":"cl_text","patch":{"text":{"content":"标题","style":{"fontFamily":"Inter","fontSize":48,"color":"#ffffff","bold":true,"italic":false,"align":"center","position":"center","background":null,"strokeWidth":0,"strokeColor":"#000000","x":0.5,"y":0.35,"rotation":-8,"letterSpacing":2,"fadeMs":300}}}}'
moka --project ./lake tools call clip.update \
  --input '{"timelineId":"tl_1","clipId":"cl_1","patch":{"adjust":null}}'
moka --project ./lake tools call clip.reverse --input '{"timelineId":"tl_1","clipIds":["cl_1"]}'
moka --project ./lake tools call clip.freeze --input '{"timelineId":"tl_1","clipId":"cl_1","atMs":12000,"durationMs":2000}'
moka --project ./lake tools call clip.slip --input '{"timelineId":"tl_1","edits":[{"clipId":"cl_1","byMs":500}]}'
moka --project ./lake tools call clip.slide --input '{"timelineId":"tl_1","moves":[{"clipId":"cl_2","byMs":200}]}'
moka --project ./lake tools call clip.roll --input '{"timelineId":"tl_1","afterClipId":"cl_1","byMs":200}'
# 在任意位置落片：fit 只接受空位；overwrite 裁/切底下；ripple 整体后移
moka --project ./lake tools call clip.add \
  --input '{"timelineId":"tl_1","kind":"video","assetId":"a_1","startMs":12000,"placement":"ripple","rippleScope":"all"}'
moka --project ./lake --yes tools call clip.ripple_delete \
  --input '{"timelineId":"tl_1","clipIds":["cl_1"],"confirm":"delete-clips","scope":"all"}'
moka --project ./lake tools call clip.close_gaps --input '{"timelineId":"tl_1","trackId":"tr_v1"}'
moka --project ./lake tools call clip.delete_gap \
  --input '{"timelineId":"tl_1","trackId":"tr_v1","atMs":8000,"scope":"track"}'
moka --project ./lake changes list
moka --project ./lake changes undo cs_...

# 先预演，不写文档
moka --project ./lake tools call canvas.add_node --dry-run \
  --input '{"canvasId":"cv_1","kind":"text","title":"Note"}'

# 花钱/删除/导出/整体替换配置需要 --yes（删除类还要求 input.confirm 非空）
moka --project ./lake --yes tools call canvas.run \
  --input '{"canvasId":"cv_1","nodeIds":["n_1"]}'
moka --project ./lake --yes tools call timeline.export --wait 300 \
  --input '{"timelineId":"tl_1","destination":"/home/me/lake.mp4"}'

# 任务
moka tasks get run <id>
moka tasks cancel run <id>

# 会话
moka --project ./lake sessions list --q crossfade
moka --project ./lake sessions show <id>
moka --project ./lake sessions rename <id> "湖边分镜"
moka --project ./lake sessions delete <id> --yes

# 审计（effect，不可撤销）
moka --project ./lake audit list
```

- `--input` 接受 JSON 字符串、`@file.json` 或 `-`（stdin）。
- `--json` 原样输出服务器 JSON；脚本应始终使用它。
- `--wait <秒>` 是 CLI 侧轮询 `task.get`，不是工具在服务端等待。
- `--dry-run` 只对 command 工具有效；effect 返回 `DRY_RUN_UNSUPPORTED`。

## 配置备份

设置里的「配置备份」（全部模型配置、各能力默认模型、生成偏好）也可以从命令行搬运：

```sh
# 导出；目的地必须由调用者给出
moka config export --destination ./moka-settings.json

# 连 API 密钥一起导出
moka config export --destination ~/moka-settings.json --keys

# 只预览文件内容，不写入
moka config import --file ./moka-settings.json --preview

# 合并导入；文件带密钥时默认一并导入
moka config import --file ./moka-settings.json

# 整体替换：文件未提到的本地模型及密钥会被删除，必须 --yes
moka config import --file ./moka-settings.json --mode replace --yes

# 只导入配置，跳过文件里的密钥
moka config import --file ./moka-settings.json --skip-keys
```

- `--destination` 不接受默认位置；相对路径按当前目录解析成绝对路径。导出由服务器写盘，所以路径属于服务器所在的机器；`--server` 指向远端时尤其要注意。导入文件由 CLI 自己读取后上传，与服务器不在同一台机器也可以。
- 只有加 `--keys`（别名 `--include-keys`）才携带密钥；机器上没有已保存的密钥时不会要求口令，文件也不含密钥。口令依次取 `--passphrase`、`MOKA_PASSPHRASE`，都没有且终端可交互时提示输入；非交互环境会直接报错，不会等待。`--passphrase` 会进入 shell 历史，优先用环境变量或终端输入。从终端输入口令时，导出会要求输入两遍，且至少 12 个字符（服务端策略）。口令不保存，丢失后文件里的密钥无法恢复。
- 密钥只以口令加密形式写入文件（PBKDF2-HMAC-SHA256 + AES-256-GCM），文件权限为 0600，任何输出与日志都不含明文密钥。
- 导入总是先向服务器预览，再带着预览得到的文件摘要与配置修订号（revision）应用；预览之后配置发生变化会被拒绝（`REVISION_CONFLICT`），重新执行即可。
- 文件里有加密密钥时默认导入密钥，需要提供口令；`--skip-keys` 只导入配置。若配置已写入但个别密钥未能保存，命令以退出码 1 结束，并在 stderr 给出服务端返回的真实原因。
- `--mode merge`（默认）保留文件未提到的本地模型；`--mode replace` 删除它们及其存储的密钥，缺少 `--yes` 时不写入任何内容，并以退出码 2 拒绝。
- `--json` 下：`--preview` 输出预览 JSON；实际导入只输出应用结果（含 `view` 与 `report`）。

## 退出码

| 码  | 含义                                                           |
| --- | -------------------------------------------------------------- |
| 0   | 成功                                                           |
| 1   | 服务器拒绝（problem code 与消息写在 stderr），或只完成了一部分 |
| 2   | 用法错误、本地输入不合法，或缺少 `--yes`                       |
| 3   | 找不到 / 连不上服务器，或登录信息无法写入本地                  |

## MCP

```sh
moka --project ./lake mcp serve
```

- stdio、一行一条 JSON-RPC；实现 `initialize`、`tools/list`、`tools/call`、`ping`。
- 只暴露 `both + external` 工具；工具名中的 `.` 换成 `_`。
- 默认只读。写操作加 `--allow-write`，付费加 `--allow-spend`，删除/替换加 `--allow-destructive`，导出加 `--allow-export`。
- 服务器启用鉴权时先执行 `moka login`；`mcp serve` 与每次工具调用一样携带保存的会话。
- `tools/call` 的返回是文本化的工具响应；失败时 `isError: true`，正文保留 problem code 与消息。

Claude Code / Cursor 一类客户端的配置示例（按实际路径调整）：

```json
{
  "mcpServers": {
    "moka-canvas": {
      "command": "moka",
      "args": ["--project", "/path/to/project", "mcp", "serve", "--allow-write"]
    }
  }
}
```

## Agent Skill

```sh
moka skills print                                  # moka-canvas
moka skills print --name moka-storyboard           # the chapter autopilot
moka skills install --dir ~/.claude/skills         # installs both
```

两份 `SKILL.md` 都在二进制内嵌，安装后无需源码树。`moka-canvas` 教第三方 Agent 先读后写、用 `--json`、不代替用户确认、目的地必须让用户选择，以及各类工具的基本流程。`moka-storyboard` 是单章批量制作流程：分镜、选角图、帧图、视频、配音与配乐，按批次停下来让用户在 UI 里审查；它依赖 `story.plan_job`、`story.board_report` 与 `story.dubbing_report`，并假定故事室保持打开，由应用把作业答案写回文档。
