# `moka` CLI 与 MCP

`moka` 与界面里的助理使用同一套工具目录与 HTTP 路由。它不直接读写项目文件，只与一个正在运行的本地 Moka Canvas 服务器通信。

## 安装与发现

- 桌面安装包：Linux deb/rpm 安装到 `/usr/bin/moka`；Windows NSIS 把安装目录加入用户 PATH（卸载时恢复）；macOS 的合并 PKG 把应用内的 CLI 链接到 `/usr/local/bin/moka`。
- 独立 CLI 包：`moka-cli-<version>-<平台>-<架构>.tar.gz`（Windows 为 `.zip`），内含二进制、`skills/moka-canvas/SKILL.md` 与 LICENSE。
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
moka --project ./lake changes list
moka --project ./lake changes undo cs_...

# 先预演，不写文档
moka --project ./lake tools call canvas.add_node --dry-run \
  --input '{"canvasId":"cv_1","kind":"text","title":"Note"}'

# 花钱/删除/导出需要 --yes（删除类还要求 input.confirm 非空）
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

## 退出码

| 码  | 含义                                         |
| --- | -------------------------------------------- |
| 0   | 成功                                         |
| 1   | 服务器拒绝（problem code 与消息写在 stderr） |
| 2   | 用法错误或本地输入不合法                     |
| 3   | 找不到 / 连不上服务器                        |

## MCP

```sh
moka --project ./lake mcp serve
```

- stdio、一行一条 JSON-RPC；实现 `initialize`、`tools/list`、`tools/call`、`ping`。
- 只暴露 `both + external` 工具；工具名中的 `.` 换成 `_`。
- 默认只读。写操作加 `--allow-write`，付费加 `--allow-spend`，删除/替换加 `--allow-destructive`，导出加 `--allow-export`。
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
moka skills print
moka skills install --dir ~/.claude/skills
```

`SKILL.md` 已在二进制内嵌，安装后无需源码树。它教第三方 Agent 先读后写、用 `--json`、不代替用户确认、目的地必须让用户选择，以及各类工具的基本流程。
