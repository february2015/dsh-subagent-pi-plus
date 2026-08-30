---
description: "Fork 自官方 @deepseek-ai/dsh-subagent-codex：让 Pi 在 DeepSeek Harness 里成为一等公民——真网关直连、排队/插入连续对话、中间过程实时透出、持久绑定重启自动恢复、图片透传。"
kind: "package-bundle"
---

# dsh-subagent-pi

[English](README.md) | 中文

**本插件基于官方 `@deepseek-ai/dsh-subagent-codex` 插件 fork 而来**（经由个人项目 `dsh-subagent-codex-plus`），把直连对象从 Codex 换成 Pi，让 **Pi 在 DeepSeek Harness（dsh）里成为一等公民**。

## 与 dsh-subagent-codex-plus 的关系

[`dsh-subagent-codex-plus`](https://github.com/february2015/dsh-subagent-codex-plus) 是本插件的**姊妹插件**：两者都是官方 `@deepseek-ai/dsh-subagent-codex` 的个人 fork，在其上叠加了同一套真网关层——直连、排队/插入连续对话、中间过程实时透出、持久绑定与图片透传。二者唯一的区别是直连对象——`dsh-subagent-codex-plus` 直连 **Codex**，本插件直连 **Pi**；架构完全相同，功能、命令与文档一一对应：

| | `dsh-subagent-codex-plus` | `dsh-subagent-pi`（本插件） |
|---|---|---|
| 直连对象 | Codex | Pi |
| 绑定命令 | `/codex-lock` | `/pi-lock` |
| 解绑命令 | `/codex-unlock` | `/pi-unlock` |
| 标题徽标 | `CDX-xxxx` | `PI-xxxx` |

两个项目同属一个 GitHub 账号，并行维护。可按需二选一，也可同时安装：各自绑定各自的会话，互不干扰。

## 功能

### 1. 真网关直连（核心功能）

一条本地指令把你的**当前 dsh 对话 1:1 绑定到一个持久的 Pi 会话**，此后你在 dsh 输入框里的一切输入输出都直达 Pi——**dsh 中间不跑任何模型，只做搬运**。

- `/pi-lock`：绑定当前会话到持久 Pi 会话（支持指定已有 Pi 会话恢复）。
- `/pi-unlock`：解除绑定，恢复普通 dsh 智能体回路；Pi 会话保留，可随时重新绑定。
- **绑定持久化**：关机/重启 dsh 后，重新进入该会话自动恢复直连，无需人工干预。
- 一个 Pi 会话只能被一个 dsh 会话绑定。

### 2. 连续对话：排队 + 直接插入

- Pi 忙时，新消息自动**排队**，当前轮结束后依次执行。
- 悬浮窗可以把某条消息**直接插入**（优先于排队消息立即执行）。
- 队列完全可控：查看、置顶、插入、编辑、删除。

### 3. 中间过程实时透出

Pi 的执行过程（消息增量、工具调用、状态事件）以近实时方式显示在 dsh 会话里，不只是最终答案。默认仅作日志展示，不进入 dsh 模型上下文。

### 4. 状态显示

绑定后，会话标题栏显示 `PI-xxxx` 徽标（彩色状态点 + 前四位会话 id），composer 下方显示"Pi 直连 · …"状态条；**未绑定的会话不显示**，保持界面干净。

### 5. 图片/附件透传

可直接粘贴/上传图片，原样交给 Pi 处理。图片理解兜底由 TeamAI skill `ocgw-vision` 处理（本插件不做视觉理解）。

### 6. 委派与网关并存

同一个 dsh 对话可以同时使用模型触发的 one-shot Pi 委派，以及用户主动直连的网关会话，互不干扰。

## 快速开始

### 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-subagent-pi
dsh --profile <name>
```

前提：本机已安装 `pi` 并配置好登录/模型。

### 使用

1. 打开任意 dsh 会话（工作目录为你的项目）。
2. 输入 `/pi-lock`：绑定成功后标题栏出现 `PI-xxxx` 徽标，此后输入直接进入 Pi。
3. Pi 忙时再发消息会自动排队；用悬浮窗可查看队列、置顶/插入/编辑/删除。
4. `/pi-unlock` 解除直连；之后可 `/pi-lock <piSessionId>` 重新绑定。

## 文档

- `IMPLEMENTATION.md` — 功能开发清单（实现细节）
- `REQUIREMENTS.md` — 需求定稿
- `TECH-VERIFICATION.md` — 技术验证报告（实现技术）
