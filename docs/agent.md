# 助理与 Agent 工具

摩卡画布的助理不再只是画布上的一条对话栏。它在画布、剪辑、素材三个房间的右栏（与检查器并排的标签），以及故事每一步的末尾都能使用；同一套工具也通过 HTTP、`moka` CLI 和 MCP 提供给第三方 Agent。

## 结构

```
AgentDock（前端四房间）
  └─ ReAct 循环（src/features/assistant/agent/loop.ts）
       ├─ POST /api/v1/agent/chat      一轮模型步：提示词、现场摘要、工具调用
       └─ POST /api/v1/agent/tools/... 执行一个工具
              ├─ command：规划 DocumentCommand → CAS 提交 → change set（可撤销）
              └─ effect：只执行一次 → audit（不可撤销）
```

- **工具实现在 Rust 服务端**，所以 CLI、MCP、脚本和界面用的是同一套校验与副作用边界。
- **循环在界面前端**，因为它需要当前选择、播放头、故事步骤与本地撤销栈；关闭窗口即停止。
- **模型选择**：助理右栏可选用任一已启用的文本模型；选择保存在会话的 `model` 上，继续该会话时沿用，未选时用部署默认。
- **会话独立存放**：`<项目>/agent/sessions/<id>.json`，不进入 `canvas.moka`，不改变文档 revision，不升 schema，也不迁移旧的 `canvas[].sessions`。
- **模型协议**：转换器在 `model.json` 的 `features.toolCalling` 里声明是否支持原生工具；内置的 `openaiChat` 与 `openaiResponses` 已实现，其余协议回退到 JSON ReAct（`agent/protocol.rs`）。回退步骤的协议 JSON 不会流式显示，支持一步内多个工具调用。

## 工具契约

每个工具在目录里声明：

| 字段      | 含义                                                                |
| --------- | ------------------------------------------------------------------- |
| `name`    | `<领域>.<动词>_<对象>`，发布后不改名                                |
| `kind`    | `command`（可重试、可撤销）或 `effect`（只执行一次）                |
| `surface` | `both` / `app`（只在界面循环里跑）/ `external`（只给 CLI/MCP/HTTP） |
| `risk`    | `read` / `write` / `spend` / `destroy` / `export`                   |
| `input`   | JSON Schema；时间一律整数毫秒                                       |
| `version` | 单工具契约版本；目录整体用 `catalogHash`                            |

`GET /api/v1/agent/tools` 返回目录与 `catalogHash`。`POST /api/v1/agent/chat` 必须带上客户端使用的 `catalogHash`；不一致返回 `TOOLS_VERSION_MISMATCH`，客户端刷新目录后重发本步，不重跑已完成的工具。

### command 与 effect

- **command**：只读文档、只规划命令。写入由 `FsProjectStore::apply_agent_commands` 以 revision CAS 提交，冲突时重新读取并重新规划（最多 5 次）。成功后把正向与逆向命令写入 `history/agent/changes/<id>.json`。`POST /api/v1/agent/changes/{id}/undo` 在文档仍与 `digestAfter` 一致时应用逆向命令。
- **effect**：删除文件、上传/复制、启动 run/故事 job/转写/导出、项目生命周期。执行器不自动重试；幂等键默认 24 小时。只写 `history/agent/audit/<id>.json`，没有撤销按钮。项目创建/打开/导入发生在一个项目的历史存在之前，因此这一小类没有本地 audit；调用方拿到的是工具响应本身。
- 一个工具不能既做外部副作用又返回需要提交的命令；需要两件事时拆成两个工具（例如 `asset.detach_references` + `asset.delete`）。

### 风险与确认

| 风险                     | 界面                                 | 外部调用                                     |
| ------------------------ | ------------------------------------ | -------------------------------------------- |
| read / write             | 直接执行                             | 需要相应开关（MCP 写操作需 `--allow-write`） |
| spend / destroy / export | 每次确认；`destroy` 的确认卡显示输入 | 需要 `--yes` / `acknowledgeRisk`             |
| export                   | 先弹保存对话框选目的地               | 必须给 `destination`                         |

`story.replace_chapters / replace_acts / replace_keyframes / replace_elements` 是 `destroy`：只在用户明确要求重写时使用，输入必须带 `confirm`，可先 `dryRun` 得到删除数量。

### 任务

`canvas.run`、`story.start_job`、`clip.transcribe`、`timeline.export` 只启动任务并返回 `task {kind,id}`，工具内部不等待。运行时轮询 `task.get`（1s→5s，默认 90 秒）；超时返回 `pending`，不当作失败。run 完成后由既有 run 管线写回并 `reload()`；故事/ASR 文本由模型再调用写工具落回。

## 会话

| 方法   | 路径                                               | 作用                        |
| ------ | -------------------------------------------------- | --------------------------- |
| GET    | `/api/v1/agent/sessions?q=&limit=&cursor=`         | 列表/搜索（标题与消息正文） |
| POST   | `/api/v1/agent/sessions`                           | 新建                        |
| GET    | `/api/v1/agent/sessions/{id}`                      | 读取消息（分页）            |
| PATCH  | `/api/v1/agent/sessions/{id}`                      | 改名、模型、最近现场        |
| DELETE | `/api/v1/agent/sessions/{id}`                      | 删除                        |
| POST   | `/api/v1/agent/sessions/delete`                    | 批量删除                    |
| POST   | `/api/v1/agent/sessions/{id}/messages`             | 追加消息（按 id 幂等）      |
| PUT    | `/api/v1/agent/sessions/{id}/messages/{messageId}` | 回填一步的工具结果          |

- 一步一条 assistant 消息，工具调用与结果都在同一条消息的 `toolCalls[]` 里。
- 每会话上限 200 条 / 2MB；超出先保留首条用户消息与最近 40 条，仍超出则拒绝 `SESSION_TOO_LARGE`。项目不设会话总数上限，界面提供搜索、改名、删除、批量删除。
- 原子写；损坏文件改名为 `.corrupt.<时间戳>.json` 并在列表里给出 warning，不阻止项目打开。
- `agent/**` 与 `history/agent/**` 属于个人历史：工作包不携带，备份包携带。

## 安全边界

- 会话、审计与幂等文件不进入工作包；密钥、元数据路径、绝对文件路径不写入会话或审计。
- `asset.import_path` 只在服务端本机可用，外部 Agent 才看得到；界面导入走文件选择器。
- 项目生命周期工具（`project.create/open/import/list_recent/remove_recent`）只给外部面，内置模型永远看不到。
- 模型配置与密钥不开放给 Agent（v1）：只能读可用模型列表，不能写入凭据。

## 相关文档

- CLI 与 MCP：[cli.md](cli.md)
- 安全边界：[security.md](security.md)
- 打包与 PATH：[BUILD.md](../BUILD.md) 的「CLI 与 Agent Skill」一节
