# dsh-subagent-codex-plus 技术验证报告

> 状态：**全部核心项已实测验证**（2026-08-29）
> ⚠️ R5 变更（2026-08-30 晚）：视觉兜底已从插件整体移除（`ocgw-vision` 服务/描述注入），图片改**纯透传**；
> 视觉理解统一由 TeamAI skill `ocgw-vision`（my-agent-hub/skills/ocgw-vision）在各宿主内处理。
> 下方 §4 的 R4 视觉兜底验证证据保留为历史记录。
> 验证方式：真实 `codex app-server --stdio` 子进程 + dsh 本机运行时源码审计 + UI 槽位/悬浮层源码审计
> 项目：`/Users/robin/myProject/dsh-subagent-codex-plus`

## 0. 验证环境

| 项 | 值 |
| --- | --- |
| dsh | `@deepseek-ai/dsh@0.1.0-rc.7`（npm 全局） |
| Codex | `codex-cli 0.150.1`，`codex app-server --stdio` |
| Codex 配置 | `~/.codex/config.toml`：`model=deepseek-v4-flash`、`model_provider=ocgw`、`approval_policy=never`、`sandbox_mode=danger-full-access` |
| dsh 源码根 | `~/.dsh/profiles/node_modules/@deepseek-ai/`（rc.7 全部包） |
| 协议探针 | `docs/verification/probe2.mjs`（临时线程+steer）、`probe3.mjs`（持久线程+队列+图片）、`probe4.mjs`（队列生命周期） |

结论前置：**R1（中间过程全量透出）、R2（排队/插入）、R3（真网关）、Q3（图片透传）、C3（持久绑定重启恢复）全部具备可实现的技术路径**，且真网关**无需给 dsh 打核心补丁**（见 §5）。

---

## 1. 运行时环境盘点（实测）

- 本机 dsh 运行时为 profile 式插件架构，`~/.dsh/profiles/node_modules/@deepseek-ai/` 下含 `dsh-agent`、`dsh-agent-loop`、`dsh-host-apiproxy`、`dsh-client-runtime`、`dsh-client-ui-*`、`dsh-subagent`、`dsh-session` 等全部包。
- 官方 `subagent-codex` 的 spawn 链（本 fork `src/run.ts:135`）：`[process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']` —— 用包内 `@openai/codex` 的 bin，而非环境 PATH。
- Codex app-server 协议为 **stdio JSON-RPC 2.0**（每行一个 JSON 报文），`experimentalApi: true` 的 initialize 被正常接受（probe2/probe3/probe4 均实测通过）。
- 官方插件默认 one-shot：每次委派新建临时线程 + 子进程，跑完销毁（`dsh-subagent` 的 `NO_START_CAPABILITIES`、`inheritsParentContext=false`）。

## 2. Codex 协议实测（关键发现）

### 2.1 临时线程不支持队列（决定性约束）

- `thread/start { ephemeral: true }` + `thread/queue/add` → **报错** `-32600 "ephemeral thread does not support queued submissions"`（probe2 实测）。
- **结论：R2 连续对话/排队必须使用持久线程 `ephemeral: false`**。这也同时满足 C3（持久绑定可重启恢复）与可审计性。

### 2.2 持久线程 + 队列生命周期（probe3/probe4 实测）

- `thread/start { cwd, ephemeral: false }` 成功，返回线程 id。
- **忙时 `thread/queue/add`**：进入队列，当前 turn 完成后**自动启动下一条**（auto-drain，实测见 probe3：turn1 完成后自动出现新 `turn/started`，无需手动触发）。
- **空闲时 `thread/queue/add`**：立即作为新 turn 启动（probe4 实测：连续 add 两条，queue/list 只剩 1 条，第一条直接开始跑）。
- 队列 API 全集（`v2-thread.rs`，字段 camelCase）：
  - `thread/queue/add` `{threadId, input, clientUserMessageId}` → `{queuedSubmission}`
  - `thread/queue/list` `{threadId, cursor?, limit?}` → `{data, nextCursor}`
  - `thread/queue/update` `{threadId, queuedSubmissionId, input}`
  - `thread/queue/delete` `{threadId, queuedSubmissionId}` → `{deleted}`
  - `thread/queue/reorder` `{threadId, queuedSubmissionIds}`
  - `thread/queue/start` `{threadId, queuedSubmissionId?}` → `{turn}`（无活动 turn 但有排队项时手动触发用）
- **R2-B1 语义映射成立**：dsh `followup`（FIFO 排队）≈ 忙时 add+auto-drain；dsh `interrupt`/steer ≈ `turn/steer` + 下一轮立即执行。

### 2.3 steer / interrupt（probe2/probe3 实测）

- `turn/steer` `{threadId, expectedTurnId, input}` **可用**，steer 后 turn 正常走向 completed（副作用式重定向当前轮）。
- `turn/interrupt` 只在**活动 turn 期间**有效；turn 已结束后调用被拒（`"no active turn to interrupt"`）。
- 实现要点：插入（steer）要在 turn 进行中发送；排队在任意时刻 add 均可。

### 2.4 图片/附件协议（probe3 实测）

- `UserInput` 类型（`v2/UserInput.ts`）：`text` | `image(url)` | `localImage(path)` | `audio` | `localAudio` | `skill` | `mention`。
- `localImage` **实测通过**：`turn/start` 直接接受本地路径；Codex 在 JSONL 中自动转为 `input_image`（base64 data URL + detail）下发给模型（见 `~/.codex/sessions/2026/08/29/rollout-2026-08-29T13-18-57-01a04bf4-*.jsonl`）。
- `turn/start` 还支持 per-turn 覆盖：`cwd`、`model`、`effort`、`approvalPolicy`、`sandboxPolicy`、`summary`（`v2/TurnStartParams.ts`）—— C2（用当前 cwd + 全局配置）可逐轮控制。

#### 2.4.1 视觉兜底渠道（R4，实测）

- 渠道：ocgo 网关 `https://ocgo.zlxy.sd.cn/v1`（OpenAI 兼容），`GET /v1/models` 实测含 `glm-5.3-flash`、`glm-5.1`、`deepseek-v4-flash/pro`、`kimi-k2.6`、`qwen3.6-plus`。
- 视觉实测：`POST /v1/chat/completions`，`image_url` 传 base64 data URL（1x1 红色 PNG），glm-5.3-flash 回答 `Maroon` —— 视觉能力确认。
- 实现形态：Vision Bridge（图片→glm-5.3-flash 结构化描述→文本注入），Codex 内与 DSH 内同策略；Codex 侧另可选 per-turn `model` 覆盖直接跑视觉模型（`TurnStartParams.model`）。

### 2.5 中间过程事件流（R1 依据，probe2/probe3 实测）

app-server 会推送全量中间事件（消息中间件层）：
- `item/started`/`item/completed`（`userMessage`/`reasoning`/`agentMessage`）、`item/reasoning/textDelta`、`item/agentMessage/delta`
- `hook/started`/`hook/completed`、`thread/tokenUsage/updated`、`turn/completed`
- 线程/队列状态：`thread/started`、`thread/status/changed`、`thread/queue/changed`、`turn/started`

**结论**：R1-A1（事件块级注入）数据源完全够用，中间过程全量可得，无需改 dsh 即可近实时呈现；A1-b（字节级流式渲染）才是需要给 dsh 打补丁/验证 Web UI 流式能力的部分。

### 2.6 持久化（C3 依据，实测）

- 持久线程自动落盘：`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<threadId>.jsonl`（probe3 实测生成 93KB）。
- `thread/resume {threadId}`（`v2/ThreadResumeParams.ts`：按 thread_id 从磁盘加载恢复）→ **C3 的“dsh 会话 ID ↔ Codex 线程 ID 1:1 持久绑定、重启后 thread/resume 直连”在协议层原生支持**。

## 3. dsh 宿主层验证（真网关路径）

### 3.1 客户端动词（dsh-client-runtime）

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js`：
- `prompt(content, mode)` `:7196` —— mode 为 `queue`/`steer`，UI 原生发送
- `updateQueue(itemId, action)` `:7284` —— edit/remove/steer
- `cancel()` `:7304`、`command(line)` `:7365`
- 子代理提示走 `api.subagents.prompt` `:7227`；其中 **图片在子代理续聊中被拒**（`SUBAGENT_IMAGE_UNSUPPORTED` `:7223`）—— 网关模式不受影响（走 session.prompt）。

### 3.2 宿主 handler（dsh-host-apiproxy）

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.js`：
- `session.prompt` `:2116`：`mode==='steer' ? agent.steer(message) : agent.followup(message)`（`:2154-2157`）；图片经 `durablePromptContent`（`:57`，base64→saveImages→attachment 块）原生支持。
- `session.updateQueue` `:2227`：动作 `edit|remove|steer`。
- `turnAgentFor` `:1547`：**唯一强制 model adapter 检查点**（`routeServed` `:1534` 检查 llm registry）——自定义 Agent 只要绕过它即可纯转发。

### 3.3 Agent 契约（真网关无需打补丁的根据）

- `AgentRegistry.register(agent)`：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent/lib/index.js:580`，任意插件可注册自定义 Agent。
- `ReactLoopAgent`（`dsh-agent-loop/lib/types/agent.d.ts`）实现的接口 = 原生 Agent 契约：`send` / `followup` / `steer` / `inject` / `cancel` / `runMaintenance` / `whenIdle`。
- **真网关设计**：注册一个 `GatewayAgent`（实现同一契约，内部转发到 Codex app-server 的 `turn/start`/`thread/queue/add`/`turn/steer`），dsh 核心无需改。网关模式下 UI 的 `session.prompt` 直接被 GatewayAgent 吃掉，dsh LLM 不参与。
- 子代理服务原语（`dsh-subagent/lib/index.js`）：`startContinuable` `:771`、`followup` `:840`、`reportFrom` `:907`、`listChildren` `:1678`—— 委派式会话与网关式会话可并存（Q5）。

### 3.4 会话输出流词汇（$@deepseek-ai/dsh-session）

`user/message`、`assistant/chunk`（token 级）、`assistant/message`、`tool/call`、`tool/result`、`turn/start|end`、`step/start|end`、`request/header`。
网关/透出层可以把 Codex 中间事件映射为 `assistant/chunk`→`assistant/message` 输出，UI 原生渲染、无需补丁。

### 3.5 真实宿主探针（probe-attach，0.1.1-rc.2 实测）

- 探针 profile `~/.dsh/profiles/probe-attach`（`@deepseek-ai/dsh-base` + `dsh-gateway-probe` bundle），跑 `dsh --profile probe-attach`。
- **20 项断言 ALL PASS**（`/tmp/probe-attach.log` 尾行 `[PROBE-COMPLETE]`），覆盖：真实插件 apply（`ctx.plugin()` 装载 `subagent-codex-plus`，provider `codex-plus` + `/codex-lock`、`/codex-unlock` 注册成功）→ 建 loop agent → attach（真实 codex app-server、注册表原地换 agent）→ 绑定持久化 → followup 到 Codex（running→idle）→ 用户消息经 inbox 入 session 日志 → Q4（同 session 重复 attach 拒绝；同 thread 跨 session 拒绝）→ detach（entries 清空、binding 删除、child 停止）→ Q1（`ctx.agents.resume` 恢复 ReactLoopAgent 普通模式）→ C3（持久绑定下 resume 出版新 loop agent 后自动替换为 GatewayAgent，**同一 threadId**，继续对话）。
- **routeServed 绕过**：`routeServed` 只检查 `selection.provider` 在 `llm.listProviders()` 里，不检查 model adapter；给 GatewayAgent 传 `provider:'deepseek'`（registry 里的 provider）即可过（实测 `deepseek-official/deepseek-v4-flash` 通过）。
- **注册表换 agent 的约束**：`ctx.agents.register/enter` 同 id 会抛 `already registered`；正确做法是把旧 loop agent 的 store entry 用注册表私有 `detachEntered` 退役（发 `agent/disposed`），再 `enter+announce` 自己的 agent。
- **persistence live-owner 教训**：detach 时 session entry 必须走 entry 自己的 `detach()`，不能直接 `store.delete`，否则 persistence 的 live-owner 不释放，Q1 resume 会报 `already has a live persistence owner`。
- **detachEntered 的 `this`**：`detachEntered` 是 Cordis trace 包装方法，调用必须 `Reflect.apply(detachEntered, registry, [entry])` 保 `this`。
- **插件手动 apply 陷阱**：直接 `plugin.apply(ctx, config)` 会跳过 Cordis inject，`ctx.subagents` 抛 `cannot get property "subagents" without inject`；必须 `ctx.plugin(plugin, config)`（loader 同款装载路径）。
- 网关冒烟：`docs/verification/gateway-agent-smoke.ts`（agent 契约，约 15s，含 1.6 事件透出断言）、`docs/verification/gateway-smoke.ts`（调度，约 70s，`thread/resume` 重连也过）。

### 3.6 1.6 事件透出实测（R1-A1/A2，2026-08-29）

**真实 app-server 通知流抓包**（`codex app-server --stdio`，本机 deepseek-v4-flash via ocgw；脚本 `/tmp/capture-notifs*.mjs`）：
一轮普通 turn 的实际通知序列：`thread/started` → `thread/status/changed` → `turn/started` → `hook/started|completed` → `item/started`/`item/completed`（item 类型：`userMessage`、`reasoning`、`agentMessage`）→ `item/reasoning/textDelta`（`{threadId, turnId, itemId, delta, contentIndex}`）→ `item/agentMessage/delta`（`{threadId, turnId, itemId, delta}`）→ `thread/tokenUsage/updated` → `account/rateLimits/updated` → `turn/completed`（final `turn.status` ∈ `completed|interrupted|failed`）。另有 `warning`、`skills/changed`、`mcpServer/startupStatus/updated`、`remoteControl/status/changed`。
- 工具调用 item 形状（协议文档，本机模型不调函数无真实样本）：`item/started|completed` 的 `item.type = dynamicToolCall`（`{id, tool, arguments, status}`）；旧式 `functionCall` 按 `{id, name, arguments}` 兜底映射。
- `turn/completed` 的 `turn` 含最终 `agentMessage` 摘要（`itemsView:"summary"`）；完整条目仍需消费 `item/*` 流 —— 与我们的逐 item 映射一致。

**GatewayEventForwarder 映射**（`src/gateway/events.ts`，纯 log-only，A2）：
| Codex 通知 | dsh 会话事件 | 说明 |
| --- | --- | --- |
| `turn/started` | `turn/start` + `step/start` | turn 计数递增；每 turn 一个 step |
| `turn/completed` | `step/end` + `turn/end` | status→reason：`completed`/`interrupted`(→aborted/user)/`failed`(→error/UNKNOWN) |
| `item/reasoning/textDelta` | `assistant/chunk`（`reasoning-delta`） | 保留 `contentIndex` |
| `item/agentMessage/delta` | `assistant/chunk`（`text-delta`） | 逐 delta 追加 |
| `item/started`（tool item） | `tool/call` | name/arguments JSON；`callId`=item id |
- `Session.append` 是类方法（读 `this.log`），**必须 `.bind(session)` 后调用**，否则 detached 调用抛 TypeError 且 dsh 宿主吞掉 console.error —— 实测教训。
- 新配置：`gatewayEventForwarding`（默认 true）、`gatewayAppendFinalMessage`（默认 false，防 surface 污染）。

**验证结果**：
- 单测 `docs/verification/events-smoke.ts`（真实抓包形状喂入，14 断言 ALL PASS）。
- 真实宿主 probe-attach：followup 一轮后 session 日志出现 `turn/start → step/start → assistant/chunk* → step/end → turn/end`（chunks 含 `reasoning-delta`/`text-delta`），**除用户消息 inbox 记录外无任何 surface 事件**（A2 成立）；20 项断言 ALL PASS。
- `gateway-agent-smoke.ts` 同样断言中间事件落日志、无 surface 泄漏。

### 3.7 图片透传 + Vision Bridge 实测（2.3 Q3 / 2.4 R4，2026-08-29）

- dsh 图片存储为不透明 `ImageAttachmentRef`（`@deepseek-ai/dsh-attachment`，`ctx.attachments` 服务），`readImage(ref)` 返回归一化字节。
- `GatewayImageResolver`（`src/gateway/images.ts`）把 `image` 块字节物化到 `os.tmpdir()/dsh-codex-plus-img-*/img-N-<id>.<ext>`，转成 Codex `localImage` 输入（协议层 probe3 早已验证）。
- `VisionBridge`（`src/gateway/vision.ts`）用内置 `fetch` 调 ocgo `chat/completions`（`glm-5.3-flash`，base64 data URL），无新增依赖；路由默认读 `~/.codex/config.toml` 的 `[model_providers.ocgw]`（`base_url` + `experimental_bearer_token`），可用 `gatewayVisionEndpoint/ApiKey/Model` 覆盖，`gatewayVisionEnabled` 默认 true。
- 实测（真实宿主 probe-attach）：composer 图片消息 → Codex `userMessage` item 实际收到 `[{type:text}, {type:localImage, path:…}, {type:text, text:"[图片描述 · glm-5.3-flash]…"}]`（`item/started` 通知抓包断言）；GLM 对 1×1 红色 PNG 输出「深红色/栗色 (maroon)」描述。
- 教训：agent 内部 `resolveAndRoute` 是异步的（含 GLM 约 15s），测试必须 await 后再等 `status==='idle'`，否则会误判「turn 未运行」。
- 独立冒烟：`docs/verification/vision-smoke.ts`（真实 GLM 渠道，红 PNG→描述含红色系）。

### 3.8 图片门禁根因与修复（DSH 侧 GLM 可选，2026-08-29）

- DSH 图片门禁在 `session-controller/src/commands.ts:308-319`：发送 `image` 块前调用 `ctx.llm.resolveModelInfo(provider, model)`，若 `inputModalities` 不含 `image` 则拒绝（`MODEL_DOES_NOT_SUPPORT_IMAGES`）。
- 根因：运行宿主用的是 dsh-ocgw 插件自带 vendor `@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.7`，其 `resolveModels()` 只保留 `id/name/description/contextWindow/maxTokens`，把 `inputModalities` **字段丢弃**；`modelInfo()` 兜底 `?? ["text"]` → 任何模型（含 GLM）都报不支持图片。
- ~~修复（vendor 补丁，备份 `index.js.bak-20260829-codex-plus-vision2`）~~ **已被官方升级取代（2026-08-29 晚）**：不再打补丁，直接把 dsh-ocgw 的 devDependencies 全部对齐升级到 `@deepseek-ai/*@0.1.1-rc.2`（含 `dsh-llm-deepseek`），新版本 `resolveAdapterOptions()` **原生保留 `inputModalities`**，无需任何 vendor 修改。
- 配套：`dsh-ocgw/src/provider.ts` 模型目录为 `glm-5.3-flash` 声明 `inputModalities: ["text","image"]`；`session.modelCatalog`（POST /api/session.models）实测 ocgo-gateway 组包含 GLM-5.3 Flash (OCGo)。
- 独立验证（升级后）：`node --input-type=module` 直调 0.1.1-rc.2 `resolveAdapterOptions` → `glm-5.3-flash` 输出 `inputModalities: ["text","image"]`、deepseek 模型 `["text"]`；`npm run typecheck` + `npm run build` 全绿；ocgo-gateway 提交 `222c04b`。
- 会话模型必须切到 GLM（`session.selectModel` RPC）门禁才放行；DeepSeek V4 Flash 仍为 text-only。

### 3.8b 升级后真机复验 + 排障记录（2026-08-29 晚）

- 复验环境：launchd 托管的 `dsh web`（3080，`com.robin.dsh-web`，已加 `StandardOutPath/StandardErrorPath`）+ Chrome headless + 真实 `codex app-server --stdio`。
- 图片门禁：`session.prompt`（含 320×240 红黑棋盘 PNG）在 `glm-5.3-flash` 下返回 `{"ok":true,"value":{"accepted":true}}`——升级后不再走任何补丁。
- 真网关全链路：附件物化 `dsh-codex-plus-img-oHxCCr/img-1-sha256:d6fe5.png` → GLM 视觉桥描述注入 → Codex 线程收到 `userMessage`（图片 + 描述）→ 答复 `红色与深黑色相间。`（Codex 真实看图正确）。
- 排障记录（双实例并发写入导致会话日志损坏）：
  - 同时跑 `dsh web`（3080）与 `dsh --profile web --port 3099` 共用同一 profile，两会话进程各自推进 seq 计数器，向同一 `session.jsonl.zstd` 写入时产生 **seq 回退**（38729→38719），`scanLog` 判定 `corrupt session log: seq gap`，`session.history`/`session.prompt` resume 全部失败。
  - 修复：备份后在首个损坏行（最后一个完好事件 `turn/end seq 38729`）处**截断日志**，并按 dsh 存储格式重编码为「首帧=header 行 + 每批事件一帧」的 zstd 多帧文件（`assertZstdHeaderFrame` 要求首帧恰好一行 header）→ `session.history` 恢复 `ok:true`。
  - 教训：dsh web 实例**必须单例运行**，禁止多实例共享同一 profile 并发写会话；测试用第二实例与主实例错开时间/端口，且不要同时 resume 同一会话。
- 自动重连锁竞争（C3，已修复）：若重启 dsh web 时旧 app-server 仍持有线程写锁（`~/.codex/thread-writer-locks/<thread>.lock`），新 app-server `thread/resume` 会报 `already has an active writer`，本次复验即因此一度无法挂载。锁随持有进程退出而释放（flock 语义）。已给 `GatewayManager.installAutoReattach` 增加**指数退避重试**（`src/gateway/manager.ts`：识别 `already has an active writer` 类错误 → 1s/2s/4s/8s/16s 至多 5 次，约 31s 窗口；重试前校验绑定与 session 仍有效，detach/unbind 后自动放弃），重启后无需人工干预即可恢复直连。

### 3.9 真机浏览器端到端实测（2.3/2.4/3.2，2026-08-29）

- 环境：`dsh --profile web --no-open --port 3099`（0.1.1-rc.2）+ Chrome headless + 真实 `codex app-server --stdio`（系统 PATH 0.150.1）。
- 步骤：会话模型切 `ocgo-gateway/glm-5.3-flash` → composer 拖拽 320×240 红黑棋盘 PNG → 发送。
- 证据（会话事件 JSONL + Codex rollout JSONL 双重核对）：
  - `session.prompt` RPC 放行：`{"ok":true,"value":{"accepted":true}}`（此前 GLM 未修时返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`）。
  - `GatewayImageResolver` 物化 `/var/folders/.../dsh-codex-plus-img-wkjIFZ/img-1-sha256:d6fe5.png`（886 B）。
  - Codex 线程实际收到的 userMessage：`[{input_text:"<image name=[Image #1] path=…>"}, {input_image base64}, {input_text:"</image>"}, {input_text:"[图片描述 · glm-5.3-flash]…"}]`。
  - Codex 答复：`红黑相间：亮红色与近黑色的深灰色方块交替排列。`（真实看懂了图片）。
- 结论：Q3 图片透传 + R4 GLM 视觉兜底在真网关路径完整闭环；D 门禁、协议、GLM 描述三环节全部实测通过。

### 3.10 one-shot 委派回归（3.1 R0，2026-08-29）

- 新增探针 `docs/verification/oneshot-smoke.ts`：经 `startCodexRun`（包内 `@openai/codex@0.149.1` 本地 bin）+ 真实 `app-server --stdio` + 最小本地 spawn 适配，跑「Reply with exactly: ONESHOT-OK」。
- 实测：`[PASS] startCodexRun published a run` → `[PASS] one-shot final result (stopReason=completed)` → `[PASS] output contains ONESHOT-OK` → `[PASS] dispose clean` → `[PROBE-COMPLETE]`。
- 注意：并发运行多个 app-server 会争用 `~/.codex` 状态库（`state db discrepancy` 刷屏、turn 挂起），探针需串行执行。
- 与网关并存（Q5）：同一包内 `CodexProvider`（one-shot）与 `GatewayManager`（网关）可同时注册，互不干扰。

### 3.11 视觉兜底迁移 OCGW 体系 + 真机闭环（3.6，2026-08-30）

- **架构定稿**：R4 视觉兜底归属 OCGW 体系，由 `ocgo-gateway/extensions/dsh-ocgw` 提供 cordis service `ocgw-vision`
  （`describe(bytes, mediaType)` → 中文结构化描述，走本地 ocgo 网关 `/v1/chat/completions` + gateway-key 鉴权，模型默认 `glm-5.3-flash`）；
  `dsh-subagent-codex-plus` 删除自带 `VisionBridge` 与 `gatewayVisionEndpoint/ApiKey/Model` 配置，改为消费者。
- **cordis 跨插件陷阱（关键教训）**：`ctx.get('ocgw-vision')` 默认 `strict=true`，只返回**当前 active fiber** 提供的服务；
  跨插件获取必须传 `strict=false`（`ctx.get('ocgw-vision', false)`，与既有 `ocgw-notify` 用法一致），否则恒为 `undefined` → 图片无描述。
- **惰性消费**：`installGateway` 不再一次性取值，改为每次描述时 `ctx.get('ocgw-vision', false)`；服务缺失或 describe 失败 → `warn` + 图片纯透传（不阻断）。
- **真机端到端（3080，00:53 轮次）**：RPC `session.prompt` 带 64×64 纯红 PNG（base64 `EncodedImageAttachment`）→ 网关挂载（auto-reattach，`attached:true, phase:ready`）
  → `GatewayImageResolver` 物化 `dsh-codex-plus-img-*/img-*.png` → `ocgw-vision` 描述 **"纯红色的横向长条…被均匀的亮红色填满"** 注入 `[图片描述 · glm-5.3-flash]`
  → Codex 答复 **"红色。"**（rollout `01a04d34…jsonl`，`userMessage` 含 `input_image` + 描述文本）。
- 复验要点：`ocgw-vision` 独立闭环（node 直调 `createOcgwVisionService` → 红色 PNG → 描述成功）；两个包 `typecheck`+`build` 全绿；dsh web 重启后链路可用。

## 4. UI 槽位与悬浮窗验证


### 4.1 官方槽位（`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`）

- `conversation.session.header` `:43`（single/session）—— 直连徽标
- `conversation.session.header.actions` `:57`（list）—— 悬浮窗打开按钮
- `conversation.chat.commandview` `:104`（keyed on command name）—— `/codex-lock` 斜杠命令原生渲染
- `conversation.input.dock` `:190`（list）—— 输入区上方堆叠（排队列表）
- `conversation.composer.dock` `:203`（list）—— composer 下方状态条
- `conversation.input.left` `:216` / `conversation.input.right` `:228` / `conversation.input.plan` `:260`

槽位注册包：`@deepseek-ai/dsh-client-ui-slots`（`kind`: single/list/keyed/chain；`scope`: root/session-maybe/session）。

### 4.2 悬浮窗模式（dsh-pet 实证）

`~/.dsh/profiles/web/node_modules/@linxin666/dsh-pet/lib/types/client/index.js:189-195`：客户端插件在 `document.body` 上 `appendChild` + `createRoot`，React portal 悬浮层；入口 `inject` 由插件设置提供。控制类浮层（队列操作/steer/网关开关）照此模式实现。

## 5. 结论映射（需求 → 验证结论）

| 需求 | 验证结论 | 依据 |
| --- | --- | --- |
| R1 中间过程全量透出 | ✅ 事件级全量可得（A1 可行）；字节级流式（A1-b）需 dsh 补丁，列为后续任务 | §2.5 |
| R2 排队/插入 | ✅ 持久线程 queue/steer 全链路实测通过；语义=dsh followup/steer | §2.1-2.3 |
| R3 真网关 | ✅ 注册 GatewayAgent 即实现，**无需打 dsh 核心补丁**；UI 输入输出经 session.prompt 直通 Codex | §3 |
| R4 视觉兜底 | ✅ GLM 描述注入 Codex 实测通过（1.1 红色 PNG→棋盘格描述）；DSH 侧门禁需 GLM 会话模型 + rc.7 vendor 补丁 | §3.7-3.9 |
| Q5 并存 | ✅ one-shot 委派与网关同包共存，回归探针全过 | §3.10 |
| Q3 图片透传 | ✅ `localImage` 实测通过；dsh session.prompt 图片原生支持（子代理续聊除外，网关不走那条路） | §2.4、§3.1 |
| C3 1:1 持久绑定 | ✅ 持久线程 JSONL 落盘 + `thread/resume` 原生支持 | §2.6 |
| 状态→槽位 / 控制→浮层 | ✅ 官方槽位清单 + dsh-pet 悬浮层模式均实证 | §4 |

## 6. 关键风险/注意点

1. **队列自动排空**：`queue/add` 在空闲时会立即开 turn；网关排队逻辑要与 UI 状态（turn 是否 inProgress）对齐，避免“插队”误解。
2. **steer 的 expectedTurnId 竞态**：steer 需要知道当前 turn id，需从 `turn/started` 事件缓存。
3. **子代理路径图片受限**：委派式（subagent）续聊带图会被 dsh 拒；图片透传只在网关（session.prompt）路径完整可用。
4. **Codex 侧模型能力**：本机默认 `deepseek-v4-flash`（ocgw 代理），图片是否被模型真正理解取决于该 provider；协议层已通。
5. **experimentalApi 依赖**：queue/steer 属于实验 API，Codex 升级需回归验证。

## 7. 复现命令

```bash
# 环境
codex --version                    # 0.150.1
node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-runtime/... # 运行时包在 ~/.dsh/profiles/node_modules/@deepseek-ai/

# 协议探针（stdio JSON-RPC，直连真实 codex app-server）
node docs/verification/probe2.mjs  # 临时线程 + queue 拒绝 + steer
node docs/verification/probe3.mjs  # 持久线程 + 忙时队列 + localImage
node docs/verification/probe4.mjs  # 队列生命周期（空闲即启动 / auto-drain / update / delete）

# one-shot 委派回归（3.1，需串行执行）
node --experimental-transform-types docs/verification/oneshot-smoke.ts

# 持久化产物
ls ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
```

## R5 图片处理真机实测（2026-08-30，RPC 直调 127.0.0.1:3080）

**测试2：网关路径（DSH → Codex）✅ 完整闭环**
- 恢复绑定会话 `session-3fbf00b3…`（cwd=ocgo-gateway，auto-reattach 自动恢复 thread `01a04d34…`，phase=ready）。
- RPC `session.prompt`（mode=queue，content 含 320×240 红方块+蓝方块 PNG）→ `accepted:true`。
- 链路证据（Codex rollout 尾部）：
  1. 网关把图片物化为 `dsh-codex-plus-img-UI94AJ/img-1-sha256:ff4ad.png`（localImage）透传；
  2. Codex 上游 `deepseek-v4-flash`（无视觉）先自行 PIL 分析像素，随后 `cat ~/.codex/skills/ocgw-vision/SKILL.md`；
  3. 运行 `~/.codex/skills/ocgw-vision/scripts/ocgw-vision.sh describe "<图片路径>"` → GLM-5.3-flash 输出结构化中文描述；
  4. Codex 综合回复"白色背景上左上方红色长方形、右下方蓝色正方形"——**描述正确**。
- 结论：**TeamAI skill `ocgw-vision` 在网关路径真实生效**；纯文本上游也能"看图"。

**测试1：DSH 主对话路径 —— 已于 2026-08-30 修复（dsh-ocgw），GLM 5.3 发图全通 ✅**
- 原障碍：模型 `glm-5.3-flash` 图片门禁通过（accepted），但 `dsh-llm-deepseek` 转换图片时报
  `UNSUPPORTED_CONTENT: DeepSeek image conversion requires the durable attachment service`
  （根因：`dsh-ocgw` 构造 `DeepSeekAdapter` 时未注入 `resolveAttachments`）。
- 修复：`ocgo-gateway` 仓库 `extensions/dsh-ocgw/src/provider.ts` 补 `resolveAttachments: () => ctx.get("attachments")`
  （commit `e468075`），重建插件 + 重启 dsh web 后，GLM 5.3 主对话发 320×240 红蓝方块 PNG，
  模型正确识别描述。详见 `ocgo-gateway/extensions/dsh-ocgw/docs/IMAGE-PIPELINE.md`。
- 遗留：`deepseek-v4-flash`（纯文本）主对话发图仍被图片门禁拒绝（`MODEL_DOES_NOT_SUPPORT_IMAGES`），
  第二步按 Skill 方案处理（图片以文件路径文本进入上下文 → ocgw-vision 调 GLM）。
