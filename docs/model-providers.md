# 模型接入覆盖

本页是「模型 API 图鉴」（`~/Work/affordable-model-apis`）所收录能力的接入对照表。转换器都放在 `src-tauri/converter-scripts/models/<能力>/<转换器>/`，新增一个目录即多一种协议；界面「设置 → 模型」里选协议、填**完整端点**、模型名与密钥即可。

| 站点能力   | 画布能力            | 目录                      |
| ---------- | ------------------- | ------------------------- |
| 文本与推理 | 文本                | `text/`                   |
| 多模态理解 | 文本                | `text/`（附件随请求发送） |
| 语音       | 语音合成 / 语音识别 | `speech/`、`asr/`         |
| 图像生成   | 图像                | `image/`                  |
| 视频生成   | 视频                | `video/`                  |

## 文本与推理

| 厂商          | 转换器                          | 默认端点                                                                            |
| ------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| OpenAI        | `openaiChat`、`openaiResponses` | `https://api.openai.com/v1/chat/completions`、`https://api.openai.com/v1/responses` |
| Anthropic     | `anthropicMessages`             | `https://api.anthropic.com/v1/messages`                                             |
| Google Gemini | `gemini`                        | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`   |
| DeepSeek      | `deepseekText`                  | `https://api.deepseek.com/chat/completions`                                         |
| 阿里云百炼    | `bailianText`                   | DashScope 文本生成端点                                                              |
| 月之暗面 Kimi | `moonshotText`                  | `https://api.moonshot.cn/v1/chat/completions`                                       |
| 智谱 GLM      | `zhipuText`                     | `https://open.bigmodel.cn/api/paas/v4/chat/completions`                             |
| MiniMax       | `minimaxText`                   | `https://api.minimaxi.com/v1/chat/completions`                                      |
| 火山方舟      | `volcengineText`                | Ark 对话端点                                                                        |

以上文本转换器均声明 `toolCalling`，助理与 Agent 会发送原生工具。

## 多模态理解

多模态不是独立能力：文本节点可以带图片、音频、视频端口，转换器按自己的协议把附件放进请求。

| 转换器                                         | 图片 | 音频 | 视频 | 文档                      |
| ---------------------------------------------- | ---- | ---- | ---- | ------------------------- |
| `gemini`                                       | ✓    | ✓    | ✓    | ✓（按 `inlineData` 发送） |
| `anthropicMessages`                            | ✓    | —    | —    | ✓（PDF）                  |
| `openaiChat`                                   | ✓    | —    | —    | —                         |
| `deepseekText`、`moonshotText`、`zhipuText`    | ✓    | —    | —    | —                         |
| `bailianText`、`volcengineText`、`minimaxText` | ✓    | —    | —    | —                         |

## 语音合成

| 厂商              | 转换器                                | 认证 / 要点                                            |
| ----------------- | ------------------------------------- | ------------------------------------------------------ |
| OpenAI 兼容       | `openaiSpeech`                        | `Authorization: Bearer`                                |
| ElevenLabs        | `elevenlabsSpeech`                    | `xi-api-key`；端点里的 `{voiceId}` 会换成所选音色      |
| Deepgram          | `deepgramSpeech`                      | `Authorization: Token`；音色即模型，写在查询的 `model` |
| Cartesia          | `cartesiaSpeech`                      | `Authorization: <key>`；自动带 `Cartesia-Version`      |
| 智谱 GLM          | `zhipuSpeech`                         | `Authorization: Bearer`；需填音色                      |
| 火山引擎 Seed TTS | `volcengineSpeech`                    | `X-Api-Key`；自动带 `X-Api-Resource-Id: seed-tts-2.0`  |
| 阿里云百炼        | `bailianSpeech`、`bailianCloneSpeech` | 声音复刻用参考音频                                     |
| MiniMax           | `minimaxSpeech`                       | 需填音色                                               |

## 语音识别

| 厂商              | 转换器          | 认证 / 要点                                    |
| ----------------- | --------------- | ---------------------------------------------- |
| OpenAI 兼容       | `openaiAsr`     | 表单上传；读 `verbose_json` 的分段              |
| ElevenLabs Scribe | `elevenlabsAsr` | `xi-api-key`；逐词时间与说话人                 |
| Deepgram          | `deepgramAsr`   | `Authorization: Token`；录音以原始字节发送     |
| Cartesia Ink      | `cartesiaAsr`   | `Authorization: <key>`；`Cartesia-Version`     |
| AssemblyAI        | `assemblyaiAsr` | `authorization: <key>`；先上传、再提交、后轮询 |
| 阿里云百炼        | `bailianAsr`    | 临时存储上传后异步转写                         |
| MiniMax           | `minimaxAsr`    | 表单上传，一次返回                             |

转换器只交回带时间的句子（`cues`：`start_ms`、`end_ms`、`text`），SRT 由宿主统一写成；带说话人模板时按模板加前缀，说话人从 1 开始编号。

实时语音（WebSocket / Realtime）不在画布的生成节点模型内：画布按一次请求、一份结果接入，因此各家的批处理接口是这里覆盖的范围。

## 图像生成

| 厂商              | 转换器                 | 认证 / 要点                                 |
| ----------------- | ---------------------- | ------------------------------------------- |
| OpenAI 兼容       | `openaiImages`         | 表单与遮罩编辑                              |
| Black Forest Labs | `blackForestLabsImage` | `x-key`；任务轮询，参考图作为 `input_image` |
| 智谱 GLM          | `zhipuImage`           | `Authorization: Bearer`；返回地址或 base64  |
| 阿里云百炼        | `bailianImage`         | DashScope 多模态端点                        |
| 火山方舟          | `volcengineImage`      | Ark 图像端点                                |
| MiniMax           | `minimaxImage`         | —                                           |

图像生成在画布里是同步调用；需要轮询的转换器用回复里的 `wait_ms` 让宿主在两次查询之间等待。

## 视频生成

| 厂商          | 转换器            | 认证 / 要点                                                                                 |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| OpenAI 兼容   | `openaiVideos`    | —                                                                                           |
| Google Gemini | `geminiVideo`     | 模型名在地址里                                                                              |
| Luma AI       | `lumaVideo`       | `Authorization: Bearer`；首尾帧走 `keyframes`                                               |
| Runway        | `runwayVideo`     | `Authorization: Bearer` + `X-Runway-Version`；`text_to_video` / `image_to_video` 由端点决定 |
| 可灵 Kling    | `klingVideo`      | `Authorization: Bearer`（新版 API Key）；`text2video` / `image2video` 由端点决定            |
| 智谱 GLM      | `zhipuVideo`      | `Authorization: Bearer`；结果在 `/async-result/{id}`                                        |
| 阿里云百炼    | `bailianVideo`    | —                                                                                           |
| 火山方舟      | `volcengineVideo` | —                                                                                           |
| MiniMax       | `minimaxVideo`    | —                                                                                           |

## 音乐

站点不单列音乐；画布保留 `bailianMusic` 与 `minimaxMusic` 两种协议。

## 端点与认证约定

- 配置里的 URL 是**完整端点**，不是 base URL。路径里带模型名的协议（Gemini）与带操作的协议（Runway、Kling）都由端点决定。
- 密钥只由宿主放进 `model.json` 声明的请求头，且只发给配置端点的同源地址；转换器脚本拿不到密钥。
- 语音合成若协议要有音色，`model.json` 会声明 `needsVoice`；未填音色时在发起请求前就会被拒绝并提示。
- 火山引擎 Seed TTS 使用新版控制台的 API Key；仍在使用 App ID + Access Token 的旧账号需要通过兼容网关接入。
