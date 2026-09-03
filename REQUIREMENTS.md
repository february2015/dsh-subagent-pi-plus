# dsh-subagent-pi-plus 需求文档

> 状态：v1.0 定稿（R0-R4 + Q1-Q5 + C3 全部确认；**R3 真网关 = V1 首发核心**）
> 项目：`/Users/robin/myProject/dsh-subagent-pi`
> 基底：fork `dsh-subagent-codex-plus`（协议层 Codex stdio JSON-RPC → **Pi RPC**）

## 总目标

在 DeepSeek Harness（dsh）的统一界面里，把 Pi 变成一等公民：
既能委派式调用（one-shot），也能连续对话（排队/插入），还能**真网关直连**
（用户输入输出与 Pi 直接互通，dsh 不经过任何大模型，只做搬运）。

## 运行环境决策

- dsh：`0.1.1-rc.2`（全局 CLI + profile 运行时同步）。
- Pi：本机 `pi` 可执行（`pi --mode rpc` 原生 RPC 模式），Pi 鉴权/模型/工具/沙箱由 Pi 进程自身处理。
- 已验证：`npm run typecheck` + `npm run build` 全绿；`/api/pi-plus/state` 正常响应。

## V1 交付范围

- **R3 真网关是 V1 首发核心**；one-shot 委派（R0）作为同包既有子功能保留。
- V1 一次性包含：R0（one-shot）+ R1-A1（中间事件级透出）+ R2（排队/插入 + 官方槽位 + 悬浮窗）+ R3（真网关 + 持久绑定）+ Q3（图片透传）+ C3（重启自动恢复）。
- 实现顺序：先打通真网关最小闭环（attach → 直连 → 排队/steer → 解除），再叠加 R1 透出与 UI；one-shot 天然在包内。
- A1-b（字节级流式渲染）仍为后续任务，不阻塞 V1。

## R0 基线

- 保留 one-shot 行为：一次委派 = 一个 Pi 子进程（`pi --mode rpc`）跑完返回最终答案，作为可回退基线。
- 包名 `dsh-subagent-pi-plus` / 插件名 `subagent-pi-plus` / provider 名 `pi-plus`。

## R1 中间过程全量透出

**需求**：Pi 执行过程中的输出实时、原样呈现在 dsh 里，不只是最终答案。

- A1：第一版用**事件块级注入**（无需改 dsh，近实时）：`message_update(text_delta)`、`toolcall_*`、`turn_start/turn_end`、`agent_end/agent_settled` → dsh 会话日志投影。
- A1-b（未来任务，已记录）：字节级流式渲染，需给 dsh 打补丁 + 实测 Web UI 流式渲染。
- A2：中间过程**默认不进 dsh 模型上下文**（省 token、不干扰模型）。
- A3：跨重启 turn 编号延续（会话日志持久化，启动时续接最大 turn 编号），避免前端装配器崩溃。

## R2 同会话连续对话 + 排队 + 直接插入

**需求**：一个 dsh 对话对应一个 Pi 会话（持久、可跨重启恢复）；Pi 忙时新消息可排队，也可直接插入。

- B1：按 dsh 语义：
  - 排队 = dsh `followup`（FIFO inbox），当前轮结束后依次执行；
  - 直接插入 = dsh `interrupt` 语义（消息作为下一轮立即执行，优先于排队）。
- B2：默认排队 + 显式插入（悬浮窗 steer 输入触发 Pi `steer` 命令）。
- B3（用户定稿）：**选择/控制类 → 悬浮窗口；状态显示类 → 官方槽位**。
  - 控制类（队列查看/置顶/插入/编辑/删除、steer）→ 悬浮窗（dsh-pet 模式，`shell.overlay`）。
  - 状态类（直连徽标、状态条、排队计数）→ 官方槽位：`conversation.session.header`、`conversation.composer.dock`、`conversation.input.dock`。
- B4（实现约束）：Pi 内部 `queue_update` 队列为纯文本数组、无 id，**排队由 dsh 本地维护**（本地消息 id），`agent_settled` 时释放下一条。

## R3 真网关直连（V1 核心）

**需求**：用一条本地指令直接绑定一个 Pi 会话；绑定后 dsh 界面上所有输入输出直接转给 Pi，dsh 只做搬运、不过任何大模型。

- C1：真网关——`/pi-lock` 把当前 dsh 会话绑定到 Pi 会话（新建或指定 `piSessionId` 恢复），此后输入输出直连 Pi，dsh 不调用任何 LLM。
- C2：`/pi-unlock` 解除绑定，恢复普通 dsh 智能体回路；Pi 会话保留，可重新绑定。
- C3：**持久化 1:1 绑定**——`$DSH_HOME/pi-plus-gateway.json`（`sessionId ↔ piSessionId`）；关机/重启后重新进入该会话，自动直连同一 Pi 会话（auto-reattach）。UI 在合适槽位显示"直连 Pi"状态。
- Q4：双向唯一——一个 Pi 会话只能被一个 dsh 会话绑定；重复绑定拒绝。
- Q1：解除绑定后会话恢复普通模式，不留残留网关。

## Q3 图片/附件透传

- Composer 附件以 base64 / local path 透传给 Pi（image 输入）。
- **本插件不做视觉理解**；视觉兜底归 TeamAI skill `ocgw-vision`（my-agent-hub）：纯文本模型遇图 → 提示用户图片落盘 → skill 脚本调 ocgo 网关 `glm-5.3-flash` 视觉模型描述。

## Q5 委派与网关并存

- 一个 dsh 会话可同时持有多个 one-shot Pi 委派（模型触发）与至多一个用户 `/pi-lock` 真网关直连；互不干扰。

## 非目标（V1 明确不做）

- 不做 HTTP API / MCP 通道（协议为本地子进程 + stdin/stdout JSONL）。
- 不做插件内视觉模型（归 ocgw-vision skill）。
- 不做字节级流式渲染（A1-b，后续任务）。
