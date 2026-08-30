# dsh-subagent-codex-plus 需求文档

> 状态：v1.1 定稿（R0-R4 全部确认；**R3 真网关 = V1 首发核心**，2026-08-29 用户定稿）
> 项目：`/Users/robin/myProject/dsh-subagent-codex-plus`
> 基底：fork 官方 `@deepseek-ai/dsh-subagent-codex`（master TS 源码 0.1.2-alpha.1，包/插件/provider 已改名）

## 总目标

在 DeepSeek Harness（dsh，本机 0.1.0-rc.7）的统一界面里，把 Codex 变成一等公民：
既能委派式调用（保留官方 one-shot），也能连续对话（排队/插入），还能**真网关直连**
（用户输入输出与 Codex 直接互通，dsh 不经过任何大模型，只做搬运）。

## 运行环境决策（2026-08-29 用户定稿：**DSH 直接升级**）

- 本机 dsh 从 `0.1.0-rc.7` 直接升级到 **`0.1.1-rc.2`**（全局 CLI + profile 运行时同步），与官方 `dsh-subagent-codex` bundle 同代，fork 的 master API（`NO_START_CAPABILITIES`、`settleRunResult`、`JsonRpcLineTransport` 等）全部可用。
- 已验证：`dsh --version` = 0.1.1-rc.2；`dsh --profile web --dump-config` 组合正常；`npx tsc -p tsconfig.json` 全量类型检查通过。
- 配套改动：`tsconfig.json` 改为独立配置（原 monorepo extends/references 已移除）；`package.json` 依赖范围修正为 npm 可解析版本（`cordis@^4.0.1`、`cordis-plugin-loader@^1.0.2`、`dsh-app-boot@^0.1.0-rc.6`、补 `typescript`/`@types/node`）；`src/run.ts` 对已发布 `RunResultSettlement` 类型做了 master 兼容处理。
- 注意：`npm install` 因上游 dsh 包 peer 依赖（cordis 4.x vs 0.0.x 混标）需 `--legacy-peer-deps`，属上游打包问题，非本仓库问题。

## V1 交付范围（2026-08-29 用户定稿：**真网关第一次就要上**）

- **R3 真网关是 V1 首发核心，不后置、不做二期**；one-shot 委派（R0）作为同一包内的既有子功能保留（官方插件逻辑），但 V1 的交付主线是网关直连。
- V1 一次性包含：R0（one-shot 委派基线）+ R1-A1（中间过程事件级透出）+ R2（连续对话/排队/插入 + 官方槽位 + 悬浮窗）+ R3（真网关 + 持久绑定）+ R4（视觉兜底）+ Q3（图片/附件透传）。
- 实现顺序随之调整：**先打通真网关最小闭环（attach → 直连 → 排队/steer → 解除）**，再叠加 R1 透出与 R4 视觉兜底；one-shot 委派天然在包内，随时可启用。
- A1-b（字节级流式渲染）仍为后续任务，不阻塞 V1。

## R0 基线（已确定）

- 保留官方 one-shot 行为：一次委派 = 一个 Codex 子进程（`codex app-server --stdio`）跑完返回最终答案，作为可回退基线。
- 包名 `dsh-subagent-codex-plus` / 插件名 `subagent-codex-plus` / provider 名 `codex-plus`。

## R1 中间过程全量透出

**需求**：Codex 执行过程中的输出实时、原样呈现在 dsh 里，不只是最终答案。

透出范围：推理摘要、agent 消息增量、工具调用（工具名+参数）、命令输出、文件修改、turn/hook/token 状态。
实时可见、可回放（本地 JSONL）。

**已定决策**
- A1：第一版用**事件块级注入**（无需改 dsh，近实时）。
- A1-b（**未来任务，已记录**）：字节级流式渲染，需要给 dsh 打补丁 + 实测 Web UI 流式渲染能力。后续可能要做，列为待办。
- A2：中间过程**默认不进 dsh 模型上下文**（省 token、不干扰模型），仅在网关/调试模式可选项开启。
- A3：推理接受**摘要级**为上限（Codex 侧全文默认加密，不为此改 Codex 配置）。

## R2 同会话连续对话 + 排队 + 直接插入

**需求**：一个 dsh 对话对应一个 Codex 线程（持久、可跨重启恢复）；Codex 忙时新消息可排队，
也可直接插入（打断当前轮）。

**已定决策**
- B1：**按 dsh 语义**：
  - 排队 = dsh `followup`（FIFO inbox），当前轮结束后依次执行；
  - 直接插入 = dsh `interrupt` 语义（中断当前轮，消息成为下一轮立即执行）。
- B2：**默认排队 + 显式插入**（如 `/steer` 或 `codex_steer` 工具触发）。
- B3（用户定稿）：**选择/控制类 → 悬浮窗口；状态显示类 → 官方槽位**。
  - 控制类（队列查看/取消/改序、steer/插入、网关开关）→ 悬浮窗口（`dsh-pet` 模式：
    `document.body` 全局 React root，经 `dsh.client.inject` 客户端插件注入）。
  - 状态类（直连 Codex 徽标、排队状态条）→ 官方槽位：
    - `conversation.session.header`（single/session）：会话头部直连徽标；
    - `conversation.composer.dock`（list/session）：composer 下方状态条（直连状态、排队计数）；
    - `conversation.input.dock`（list/session）：输入区上方堆叠条（排队列表实时展示）；
    - `conversation.session.header.actions`（list/session）：挂悬浮窗的打开按钮；
    - 悬浮窗入口另可挂 `conversation.input.right`（输入卡右侧工具行）。
  - 本地指令：`/codex-lock` 走官方命令体系，`conversation.chat.commandview`
    （keyed on `command/run.name`）原生支持斜杠命令渲染，零注册即可显示。

## R3 真网关（直连模式）

**需求**：一条本地指令（如 `/codex-lock`）把当前 dsh 对话绑定到一个**新的** Codex 会话；
绑定后，dsh 界面上的所有输入输出与 Codex 直接互通，**dsh 不经过任何大模型，只做搬运**。

**已定决策**
- C1：**真网关**（传输级直通，非模型转发壳）。**已验证无需打 dsh 核心补丁**：注册自定义 `GatewayAgent`（实现 `send/followup/steer/inject/cancel`，内部转发 Codex app-server），`session.prompt` 的输入输出被它直通消费，dsh 模型不参与；UI 端以 `assistant/chunk`→`assistant/message` 事件流透出（详见 TECH-VERIFICATION.md §3）。
- C2：新 Codex 会话参数 = dsh 当前会话 cwd + Codex 全局配置（模型/权限等）。
- C3：**1:1 持久绑定**：dsh 会话 ID ↔ Codex 线程 ID 一一对应，绑定关系持久化，
  关机/重启后重新进入该 dsh 会话即自动直连同一个 Codex 会话。
- 新增（用户补充，已定稿）：**直连状态显示**——状态显示类用官方槽位：
  会话头部 `conversation.session.header` 徽标 + `conversation.composer.dock` 状态条；
  选择/控制类用悬浮窗口（队列操作、网关开关）。
- 新增（Q3=B 定稿）：**图片/附件透传**——网关模式 v1 即支持把 dsh 输入框的图片/附件原样转给 Codex。

## R4 视觉兜底路由（Vision Bridge，2026-08-29 新增定稿；**2026-08-30 架构归属定稿：归 OCGW 体系**）

**需求**：主模型（Codex 内 / DSH 内）不支持视觉时，遇到图片一律交给视觉模型 `glm-5.3-flash` 处理（理解/描述/OCR），
结果作为文本继续走原流程。该策略**不止在 Codex 里生效，在 DSH 里同样生效**。

**R5 变更（2026-08-30 晚，用户定稿）**：视觉兜底不再由插件承担——`dsh-ocgw` 的 `ocgw-vision` 服务
与本插件的描述注入均已移除，图片在网关式路径里**纯透传**；视觉理解统一改为 TeamAI 共享 skill **`ocgw-vision`**
（`my-agent-hub/skills/ocgw-vision`，DSH/PI/OMP/Codex 各宿主安装）：模型无图像能力时，按 skill 指引请用户把图片
保存为文件，运行 `ocgw-vision.sh describe <路径>` 由 ocgo 网关 `glm-5.3-flash` 生成中文描述后继续任务。
下方 R4 决策保留作为历史记录。

**架构归属（2026-08-30 用户定稿）**
- **视觉兜底不属 dsh-subagent-codex-plus**，而是 **OCGW Gateway 体系**的能力：由 `ocgo-gateway/extensions/dsh-ocgw` 插件提供，
  注册 cordis service **`ocgw-vision`**（`describe(bytes, mediaType) → 文本描述`，走本地 ocgo 网关 + gateway-key 鉴权，模型默认 `glm-5.3-flash`）。
- `dsh-subagent-codex-plus` 只做**消费者**：`ctx.get('ocgw-vision', false)` 惰性获取（跨插件须 `strict=false`，cordis fiber 非 ACTIVE 陷阱），
  服务缺失或描述失败时**优雅降级为纯透传**（图片原样交给 Codex）。
- 同体系其它宿主（pi-ocgw 等）未来可复用同一能力；网关本体转发管线**不做**图片改写。

**已实测（2026-08-29 / 2026-08-30）**
- 渠道：ocgo 网关 `/v1`（OpenAI 兼容 chat/completions），gateway-key 鉴权；模型清单含 `glm-5.3-flash`（视觉）。
- 视觉实测：`image_url` 传 base64 data URL（PNG）→ `glm-5.3-flash` 结构化描述成功。
- 端到端（2026-08-30）：dsh 传 64×64 纯红 PNG → `ocgw-vision` 描述"纯红色长条"注入 → Codex 答复"红色。"（rollout 00:53 轮次，含 `[图片描述 · glm-5.3-flash]`）。

**已定决策**
- V1：图片输入统一走视觉兜底预处理：检测输入含 `image/localImage` → 经 `ocgw-vision` 调 `glm-5.3-flash` 生成结构化描述 → 文本注入原消息，
  再交给 Codex（`turn/start`/queue 的 text 输入）或 DSH 主对话（不依赖模型本身视觉能力）。
- V2（备选，不阻塞）：Codex 侧也可用 per-turn `model` 覆盖（`TurnStartParams.model` 已验证）直接指定视觉模型跑那一轮，
  保留给"看图执行型"任务（如读截图改代码）选用；V1 为默认，节省 token 且对无视觉模型最通用。
- 适用层级：
  - **网关式（dsh-subagent-codex-plus）**：消费 `ocgw-vision` 服务（v1 已实现，真机验证通过）。
  - **DSH 主对话（非网关路径）**：dsh 核心模型路由不在插件控制内；实现方式二选一——
    (a) 用户在 dsh 侧把主模型配置为视觉模型；(b) 若 dsh 提供附件/输入预处理钩子则同样走 `ocgw-vision` 兜底（**待验证**，列入技术验证清单）。
- 状态显示：视觉兜底命中时，在 `conversation.composer.dock` 状态条显示"图片已转 glm-5.3-flash 理解"，可追溯。

## 已确认决策（Q1-Q5，2026-08-29 定稿）

- Q1：**保留解除绑定**。断开直连后 dsh 恢复普通模式；Codex 线程保留，可随时重新 attach 回同一会话。
- Q2：**网关模式下 R2 全部生效**。忙时新消息排队、悬浮窗可插入/打断/看队列；悬浮窗与队列逻辑在委派式/网关式两种模式下共用同一套组件。
- Q3：**v1 即支持图片/附件透传**（非文本先行）。实现要点：
  - dsh composer 的附件 → Codex `turn/start`/queue 的 image UserInput（本地路径/URL）转换；
  - 图片大小/格式校验、失败提示；附件类型（图片先行，文件类后续评估）；
  - **视觉兜底按 R4**：图片不依赖目标模型视觉能力，统一走 `glm-5.3-flash` Vision Bridge（Codex 内与 DSH 内同策略）。
- Q4：**双向唯一**。一个 Codex 线程只允许被一个 dsh 会话绑定，重复绑定拒绝；
  同一 dsh 会话多标签页共享同一绑定（天然串行，不算冲突）。
- Q5：**委派式与网关式并存**。一个 dsh 对话可挂多个委派式 Codex 子会话（模型触发），
  同时至多一个用户直连网关会话；网关模式下 dsh 模型不参与，两者按需切换。

## 技术验证（已完成，2026-08-29）

> 全部验证记录见 **[TECH-VERIFICATION.md](./TECH-VERIFICATION.md)**，探针脚本在 `docs/verification/`。

- ✅ dsh 核心消息路由位置：`session.prompt`（api-proxy.js:2116）→ `agent.steer/followup`；唯一 model 检查点在 `turnAgentFor`（:1547）。
- ✅ 真网关无需打 dsh 补丁：`AgentRegistry.register`（dsh-agent/lib/index.js:580）可注册自定义 `GatewayAgent`（实现 send/followup/steer/inject/cancel），UI 输入输出经 `session.prompt` 直通。
- ✅ 斜杠命令：`conversation.chat.commandview` 按命令名 keyed，原生可渲染 `/codex-lock`。
- ✅ 槽位：官方清单实证（`conversation.session.header` / `conversation.input.dock` / `conversation.composer.dock` / `conversation.session.header.actions` / `conversation.input.left/right`）。
- ✅ 悬浮层：dsh-pet 实证（document.body React root + client.inject）。
- ✅ 队列/steer 协议实测：临时线程拒绝队列（`-32600`）；持久线程 queue/add+auto-drain、queue/list/update/delete/reorder/start、`turn/steer` 全部通过。
- ✅ 图片透传实测：`localImage` 被 app-server 接受并转为 `input_image` base64；dsh `session.prompt` 图片原生支持（子代理续聊被拒 `SUBAGENT_IMAGE_UNSUPPORTED`，网关不走该路径）。
- ✅ C3 持久绑定实测：持久线程 JSONL 落盘 `~/.codex/sessions/...`，`thread/resume {threadId}` 原生支持重启恢复。
- ✅ R4 视觉兜底实测：ocgo 网关含 `glm-5.3-flash`，`image_url` base64 传图实测识别成功（红色 PNG → Maroon）。
