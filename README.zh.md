---
description: "Fork 自 dsh-subagent-codex-plus：把协议层从 Codex stdio JSON-RPC 换成 Pi RPC（pi --mode rpc），保留真网关直连、排队/插入连续对话、中间过程实时透出、持久绑定重启自动恢复、图片透传。"
kind: "package-bundle"
---

# dsh-subagent-pi

[English](README.md) | 中文

`dsh-subagent-pi` 是 **`dsh-subagent-codex-plus` 的 fork**（后者本身 fork 自官方 `@deepseek-ai/dsh-subagent-codex`）。它把通信协议层从 Codex 的 stdio JSON-RPC 整体换成 **Pi 的原生 RPC 协议**（`pi --mode rpc`），其余架构与 UI 能力全部复用，让 **Pi 在 DeepSeek Harness（dsh）里成为一等公民**：连续对话、中间过程实时可见、"真网关"直连模式——dsh 只在你和 Pi 会话之间搬运数据，不经过任何大模型。

## 基于哪个插件

| | |
|---|---|
| 直接来源 | [`dsh-subagent-codex-plus`](https://github.com/robinwlive/dsh-subagent-codex-plus)（robinwlive，个人 fork） |
| 上游官方 | [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) |
| 本 fork 改名 | 包 `dsh-subagent-pi` · 插件 `subagent-pi` · provider `pi` |

**协议层差异（本 fork 的核心改动）**：codex-plus 通过 `codex app-server --stdio` 的 stdio JSON-RPC 与 Codex 通信；本插件改为 spawn `pi --mode rpc --session-dir <dir> --session-id <id>`，通过 stdin/stdout 的 **JSONL 命令/事件**与 Pi 通信（`prompt` / `follow_up` / `steer` / `abort` / `get_state` 命令；`response → turn_start → message_start/end → message_update(text_delta/toolcall_*) → turn_end → agent_end → agent_settled` 事件序列）。**不是 HTTP API，也不是 MCP**。

Pi 的鉴权、模型、工具、沙箱全部由 Pi 自身进程处理（读取用户本机的 Pi 配置），dsh 不接管。

## 核心能力

### 1. 真网关直连（核心功能）

一条本地指令把你的**当前 dsh 对话 1:1 绑定到一个持久的 Pi 会话**，此后你在 dsh 输入框里的一切输入都直达 Pi——**dsh 中间不跑任何模型，只做搬运**。

- `/pi-lock`：绑定当前会话到持久 Pi 会话（spawn `pi --mode rpc`；无 sessionId 则新建）。
- `/pi-unlock`：解除绑定，恢复普通 dsh 智能体回路；Pi 会话保留，可随时重新绑定。
- 绑定持久化在 `$DSH_HOME/pi-plus-gateway.json`（`sessionId ↔ piSessionId` 1:1）。
- **重启自动恢复（C3）**：dsh 重启后，重新打开绑定会话会自动重连同一个 Pi 会话（`agent/created` → 自动替换为网关 agent → `pi --mode rpc` 以原 sessionId 恢复），无需人工干预。
- 双向唯一（Q4）：一个 Pi 会话只能被一个 dsh 会话绑定，重复绑定会被拒绝。

### 2. 连续对话：排队 + 直接插入

- Pi 忙时，新消息**排队**（dsh 本地 FIFO 队列，当前轮结束后自动依次执行）。
- 悬浮控制窗的 steer 输入**立即插入**：向 Pi 发 `steer` 命令，插入的消息优先于排队消息执行。
- 队列完全可控：查看、置顶、插入、编辑、删除。

> 实现说明：Pi 内部事件 `queue_update {steering:[], followUp:[]}` 是纯文本数组、无 per-item id，无法在 Pi 侧做改序/编辑，因此**排队由 dsh 本地维护**（本地生成消息 id），`agent_settled` 时释放下一条。

### 3. 中间过程实时透出（R1）

Pi 的执行过程以近实时方式转发进 dsh 会话流：agent 消息增量（`message_update` 的 `text_delta`）、工具调用（`toolcall_*`）、状态事件（`turn_start` / `turn_end` / `agent_end` / `agent_settled`）。默认**仅作日志**——不进 dsh 模型上下文（省 token，不干扰模型）。

**跨重启 turn 编号延续**：会话日志持久化，事件转发器启动时读取已记录的最大 `turn` 编号再继续递增，保证 dsh 前端对话装配器不会因重复 `turn/start` 崩溃或隐藏对话。

### 4. 官方槽位状态 + 悬浮窗控制

- **状态显示**用官方槽位：`conversation.session.header` 直连徽标（`PI-xxxx`，彩色绑定状态点 + 前四位 session id）、`conversation.composer.dock` 状态条、`conversation.input.dock` 排队列表。徽标**仅在会话存在绑定后显示**（未绑定不占标题栏空间）。
- **选择/控制**放在悬浮窗（dsh-pet 模式，`shell.overlay`）：队列操作、steer/插入、解绑信息。

### 5. 图片/附件透传（Q3）

Composer 附件以 base64/local path 透传给 Pi（`image` 输入）。**本插件不做视觉理解**——图片理解兜底统一由 TeamAI skill `ocgw-vision`（my-agent-hub）处理：纯文本模型遇到图片时调用 ocgo 网关的 `glm-5.3-flash` 视觉模型描述图片。

### 6. 委派与网关并存

一个 dsh 会话可以同时持有多个 one-shot Pi 委派（模型触发的 `subagent_delegate` provider `pi`）和至多一个用户主动 `/pi-lock` 的真网关直连；互不干扰。

## 快速开始

### 安装到 dsh profile

```sh
# 本仓库本地 link 安装（或发布后的 npm 包名）
dsh plugin --profile <name> add /path/to/dsh-subagent-pi
dsh --profile <name>
```

前提：本机已安装并能运行 `pi`（`pi --version` 正常），Pi 已登录/配置好模型。

### 使用

1. 在 dsh 里打开任意会话（cwd 为工作项目）。
2. 输入 `/pi-lock`：绑定成功后会话头部出现 `PI-xxxx` 徽标 + "Pi 直连 · …" 状态条（未绑定的会话不显示徽标），此后输入直接进入 Pi。
3. Pi 忙时再发消息会自动排队；用悬浮窗可查看队列、置顶/插入/编辑/删除。
4. `/pi-unlock` 解除直连，Pi 会话保留，之后可 `/pi-lock <piSessionId>` 重新绑定。

## 架构链路

```text
DeepSeek Harness 会话（dsh）
    ↓ /pi-lock 或 subagent_delegate(provider=pi)
dsh-subagent-pi 插件
    ↓ spawn 子进程
pi --mode rpc --session-dir ~/.dsh/pi-sessions --session-id <id>
    ↓ stdin/stdout JSONL 命令/事件
Pi 完整 Agent 循环（工具调用、文件读写、模型推理）
    ↓ 中间事件（message_update/toolcall_*/turn_*）→ dsh 会话日志投影
    ↓ 最终结果回传 dsh 会话
```

## 调试

诊断日志默认关闭。需要时设置环境变量后重启 dsh：

```sh
export DSH_SUBAGENT_PI_DEBUG=1          # 开启诊断日志
export DSH_SUBAGENT_PI_DEBUG_LOG=/tmp/pi-gateway-debug.log   # 可选，默认 $TMPDIR/pi-gateway-debug.log
```

## 文档

- `IMPLEMENTATION.md` — 功能开发清单（全部完成）
- `REQUIREMENTS.md` — 需求定稿（R0-R4 + Q1-Q5 + C3）
- `TECH-VERIFICATION.md` — 技术验证报告（Pi RPC 协议实测 + 真机端到端 + 重启恢复）
