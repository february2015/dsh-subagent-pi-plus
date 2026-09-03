# dsh-subagent-pi-plus 功能开发清单

> 用法：按顺序执行，每完成一步把 `[ ]` 改成 `[x]` 并提交。
> 依据：`REQUIREMENTS.md`、`TECH-VERIFICATION.md`（已验证事实）。
> 项目：`/Users/robin/myProject/dsh-subagent-pi`（fork 自 `dsh-subagent-codex-plus`，协议层换 Pi RPC）

## 阶段 0：基线（已完成）

- [x] 0.1 fork + 改名：包 `dsh-subagent-pi-plus` / 插件 `subagent-pi-plus` / provider `pi`（含 git 基线提交）
- [x] 0.2 技术验证 + 记录：`TECH-VERIFICATION.md`（Pi RPC 协议探针）
- [x] 0.3 需求定稿：`REQUIREMENTS.md`（R0-R4 + Q1-Q5 + C3；真网关 = V1 首发核心）
- [x] 0.4 运行环境：dsh 0.1.1-rc.2 profile 运行时；独立 tsconfig；`npm run typecheck` + `npm run build` 全绿

## 阶段 1：协议层（Pi RPC）

- [x] 1.1 `PiRpcWire`（`src/gateway/pi-wire.ts`）：`pi --mode rpc` 子进程 stdin/stdout JSONL 命令/事件；命令 `prompt{streamingBehavior}` / `follow_up` / `steer` / `abort` / `get_state`；事件解析 `response / turn_start / message_start / message_update(text_delta|toolcall_*) / message_end / turn_end / agent_end / agent_settled / queue_update / interrupted` —— 冒烟全过
- [x] 1.2 进程生命周期：spawn、优雅 dispose、exit/error 诊断；会话文件落 `$DSH_HOME/pi-sessions`
- [x] 1.3 本地队列语义：Pi 内部 `queue_update` 纯文本无 id → 排队由 dsh 本地维护（本地消息 id + FIFO），`agent_settled` 释放下一条

## 阶段 2：网关核心（真网关最小闭环）

- [x] 2.1 `PiGateway`（`src/gateway/gateway.ts`）：忙时 `prompt` 进入队列、空闲直发；`steer` 立即插入；`abort` 中断
- [x] 2.2 `GatewayAgent` 契约（`src/gateway/agent.ts`）：实现 dsh `Agent` 接口（send/followup/steer/inject/cancel/whenIdle），内部转发 PiGateway
- [x] 2.3 绑定持久化：dsh sessionId ↔ piSessionId 1:1 本地 JSON（`$DSH_HOME/pi-plus-gateway.json`）+ 重启恢复（C3）
- [x] 2.4 `/pi-lock`、`/pi-unlock` 命令 + Q4 重复绑定拒绝 + 解除后恢复普通模式（Q1）
- [x] 2.5 auto-reattach（C3）：`agent/created` → 检测绑定 → 替换为网关 agent → 以原 piSessionId 恢复 `pi --mode rpc`；诊断日志可配置（`DSH_SUBAGENT_PI_DEBUG`）

## 阶段 3：界面与视觉

- [x] 3.1 状态槽位：`conversation.session.header` 直连徽标（`PI-xxxx` + 彩色状态点 + 前四位 session id）+ `conversation.composer.dock` 状态条（"Pi 直连 · …"）+ `conversation.input.dock` 排队列表
- [x] 3.2 悬浮控制窗（dsh-pet 模式，`shell.overlay`）：队列查看/置顶/插入/编辑/删除、steer、解绑信息；暗色主题适配
- [x] 3.3 图片透传（Q3）：composer 附件 → Pi image 输入（base64 / local path）；**不做视觉理解**（视觉兜底归 TeamAI skill `ocgw-vision`）

## 阶段 4：委派式 one-shot（保留）

- [x] 4.1 `pi-run.ts`：一次性 provider（`subagent_delegate` provider `pi`），每次调用新建 Pi 子进程跑自包含任务，返回最终答案
- [x] 4.2 与网关并存（Q5）：委派式 one-shot 与 `/pi-lock` 真网关互不干扰

## 阶段 5：真机端到端验证（全部通过）

- [x] 5.1 attach：`/pi-lock` 绑定成功，绑定写入 `~/.dsh/pi-plus-gateway.json`，Pi 会话文件落 `~/.dsh/pi-sessions/`
- [x] 5.2 直连消息往返：dsh 会话日志完整投影（`user/message` → `text-chunks` 流式 → `assistant/message` → `turn/end`）
- [x] 5.3 排队：长任务（sleep 12）期间发排队消息 → 本地队列 `queue:[{id,text}]` 正确显示
- [x] 5.4 插入（steer）：回复顺序"插好 → 2 → done"（插入优先于排队）
- [x] 5.5 C3 重启恢复：dsh 重启 → 绑定保持 → 打开绑定会话 → auto-reattach → `attached:true phase:ready`，Pi 会话恢复
- [x] 5.6 UI：`PI-xxxx` 徽标 + "Pi 直连 · 8031522b-7… · 空闲" 状态行正常

## 阶段 6：收尾

- [x] 6.1 清理探针：`/tmp/pi-probe*.mjs`、`/tmp/dsh-pi-*.mjs` 已删除
- [x] 6.2 诊断日志可配置：`src/gateway/debug.ts`（`DSH_SUBAGENT_PI_DEBUG=1` 才写，默认关闭）
- [x] 6.3 文档同步：README/README.zh/REQUIREMENTS/TECH-VERIFICATION
- [x] 6.4 git 提交推送（`robinwlive/dsh-subagent-pi`）
