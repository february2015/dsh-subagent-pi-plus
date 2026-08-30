# dsh-subagent-codex-plus 功能开发清单

> 用法：按顺序执行，每完成一步把 `[ ]` 改成 `[x]` 并提交。
> 依据：`REQUIREMENTS.md`（v1.1 定稿）、`TECH-VERIFICATION.md`（已验证事实）。

## 阶段 0：基线（已完成）

- [x] 0.1 fork + 改名：包 `dsh-subagent-codex-plus` / 插件 `subagent-codex-plus` / provider `codex-plus`（含 git 基线提交）
- [x] 0.2 技术验证 + 记录：`TECH-VERIFICATION.md` + 协议探针 `docs/verification/probe2-4.mjs`
- [x] 0.3 需求定稿：`REQUIREMENTS.md` v1.1（R0-R4 + Q1-Q5；真网关 = V1 首发核心）
- [x] 0.4 视觉渠道实测：ocgo 网关 `glm-5.3-flash` 看图成功（红色 PNG → Maroon）
- [x] 0.5 运行环境升级：dsh 0.1.0-rc.7 → **0.1.1-rc.2**（CLI + profile 运行时）；独立 tsconfig；全量类型检查通过

## 阶段 1：网关核心（真网关最小闭环）

- [x] 1.1 `CodexGateway` 进程与线程生命周期：spawn `codex app-server --stdio`（experimentalApi:true）、持久线程创建/`thread/resume`、优雅 dispose —— 冒烟全过
- [x] 1.2 消息原语：submit 自动分流（空闲→`turn/start`，忙→`thread/queue/add`）、`turn/steer`、interrupt/cancel、队列 list/update/delete/reorder —— 冒烟全过
- [x] 1.3 `GatewayAgent` 契约：实现 dsh `Agent` 接口（send/followup/steer/inject/cancel/whenIdle），内部转发 CodexGateway —— 冒烟全过（含修复 turn/completed 未发 `turn` 事件的 bug）
- [x] 1.4 绑定持久化：dsh sessionId ↔ Codex threadId 1:1 本地 JSON + 重启恢复（C3）
- [x] 1.5 `/codex-lock`、`/codex-unlock` 命令 + Q4 重复绑定拒绝 + 解除后恢复普通模式（Q1）
- [x] 1.6 事件透出（R1-A1）：Codex 中间事件 → dsh 会话流（assistant/chunk、tool/call、状态），默认不进模型上下文（A2）

## 阶段 2：界面与视觉

- [x] 2.1 状态槽位：`conversation.session.header` 直连徽标 + `conversation.composer.dock` 状态条 + `conversation.input.dock` 排队列表
- [x] 2.2 悬浮控制窗（dsh-pet 模式）：队列查看/取消/改序、steer 插入、网关开关
- [x] 2.3 图片透传（Q3）：composer 附件 → Codex image UserInput（localImage）
- [x] 2.4 Vision Bridge（R4）：图片 → `glm-5.3-flash` 结构化描述 → 文本注入；状态条提示命中（**R5 已移除**，见 3.7）

## 阶段 3：并存与收尾

- [x] 3.1 委派式 one-shot 回归（R0）+ 与网关并存（Q5）
- [x] 3.2 端到端真机验证：attach → 直连 → 排队 → steer → 图片 → 解除 → 重启恢复
- [x] 3.3 文档同步（README/REQUIREMENTS/TECH-VERIFICATION）+ 发布包内容核对
- [x] 3.4 依赖升级与真机闭环复验：`extensions/dsh-ocgw` 升 `@deepseek-ai/*@0.1.1-rc.2`（`dsh-llm-deepseek` 原生 `inputModalities`，删除 vendor 补丁）；3080 单实例下 图片门禁→GLM 视觉桥→Codex 看图 真机回归通过；修复双实例并发写坏会话日志（截断重编码）
- [x] 3.5 自动重连抗锁竞争：`GatewayManager.installAutoReattach` 对 `already has an active writer` 类 resume 失败增加指数退避重试（1s→16s，至多 5 次），重启后无需人工干预恢复直连
- [x] 3.6 视觉兜底迁移到 OCGW 体系（R4 架构定稿 2026-08-30）：删除插件内 `VisionBridge`/`gatewayVision*` 配置；能力归 `dsh-ocgw`（`ocgw-vision` 服务，cordis `ctx.provide`），本插件经 `ctx.get('ocgw-vision', false)` 惰性消费（strict=false 跨 fiber），服务缺失/失败优雅降级纯透传；真机验证：纯红 PNG → `ocgw-vision` 描述注入 → Codex 答复"红色。"
- [x] 3.7 跨重启 turn 编号延续 + 会话修复（2026-08-30）：修复 `GatewayEventForwarder` 每次启动从 1 重新编号导致持久日志出现重复 `turn` 序号、dsh 前端对话装配器崩溃（`more than one start Match`）从而整段对话不显示的问题；forwarder 构造时从会话日志续接最大 turn 编号；新增 `scripts/renumber-sessions.mjs` 按 zstd 多帧格式逐帧重编号存量污染会话（含备份）。真机验证：修复后历史消息完整渲染，DSH 重启后新 turn 从 21 继续（非 1），`assistant/message` 在 `turn/end` 前落盘。
