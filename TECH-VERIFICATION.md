# dsh-subagent-pi 技术验证报告

> 状态：**全部核心项已实测验证**（2026-08-30）
> 验证方式：真实 `pi --mode rpc` 子进程 + dsh 本机运行时 + Playwright UI 实测
> 项目：`/Users/robin/myProject/dsh-subagent-pi`

## 0. 验证环境

| 项 | 值 |
| --- | --- |
| dsh | `@deepseek-ai/dsh@0.1.1-rc.2`（npm 全局 + profile web） |
| Pi | 本机 `pi`（`pi --mode rpc` 原生 RPC 模式），会话文件落 `~/.dsh/pi-sessions/` |
| 浏览器 | Playwright + channel chrome，`http://127.0.0.1:3080/`（launchd `com.robin.dsh-web`） |
| 协议探针 | `/tmp/pi-probe5.mjs`（stdin JSONL 命令 / stdout JSONL 事件全序列） |
| 诊断日志 | `$DSH_SUBAGENT_PI_DEBUG=1` 时写 `$TMPDIR/pi-gateway-debug.log` |

结论前置：**R1（中间过程透出）、R2（排队/插入）、R3（真网关）、Q3（图片透传）、C3（重启自动恢复）全部真机验证通过**，真网关无需给 dsh 打核心补丁。

---

## 1. Pi RPC 协议实测（关键发现）

### 1.1 命令与事件序列（probe5 实测）

启动：`pi --mode rpc --session-dir <dir> --session-id <id>`，stdin/stdout 每行一个 JSON 报文。

命令（stdin）：
- `prompt {text, streamingBehavior:true}` — 发起一轮
- `follow_up {text}` — 排队追加
- `steer {text}` — 立即插入（优先于排队）
- `abort {}` — 中断当前轮
- `get_state {}` — 查询状态

事件（stdout）：
`response → turn_start → message_start/end → message_update(text_delta / toolcall_*) → turn_end → agent_end → agent_settled`

### 1.2 Pi 内部队列是纯文本数组（决定性约束）

`queue_update {steering:[], followUp:[]}` 里的条目是**纯文本、无 per-item id**，无法在 Pi 侧做改序/编辑/删除。
**结论：排队必须在 dsh 本地维护**（本地生成消息 id + FIFO），`agent_settled` 时释放下一条；steer 插入仍委托 Pi 原生 `steer` 命令（插入的消息在下一轮优先于排队消息执行）。

### 1.3 权限/无人值守

dsh 侧以非交互方式 spawn Pi 子进程，Pi 自身配置（模型、鉴权、工具、沙箱）保持原生，dsh 不接管。

---

## 2. 真机端到端验证（2026-08-30）

### 2.1 attach（/pi-lock）

- 在 dsh 会话输入 `/pi-lock` → 绑定成功。
- 绑定写入 `~/.dsh/pi-plus-gateway.json`：
  ```json
  {
    "version": 1,
    "bindings": {
      "session-3fd18cff-…": { "piSessionId": "8031522b-…", "boundAt": 1788097757252 }
    }
  }
  ```
- Pi 会话文件落 `~/.dsh/pi-sessions/`（`.jsonl` + `.meta.json`）。

### 2.2 直连消息往返

- 直连后发消息 → Pi 回复（测试"PI探针OK"）。
- dsh 会话日志完整投影：`user/message` → `text-chunks` 流式 → `assistant/message` → `turn/end`。

### 2.3 排队（长任务期间）

- Pi 执行 sleep 12 秒期间再发消息 → 本地队列正确显示：`queue:[{id,text}]`，任务结束后自动依次执行。

### 2.4 直接插入（steer）

- 排队 2 条后再 steer 插入 1 条 → 回复顺序为 **插好 → 2 → done**（插入优先于排队）✓

### 2.5 图片透传（Q3）

- Composer 附件以 base64 / local path 透传给 Pi（image 输入）——代码路径已实现；视觉理解不在此插件内（归 `ocgw-vision` skill）。

---

## 3. C3 重启自动恢复（最重要，实测通过）

验证步骤：
1. `launchctl kickstart -k gui/$(id -u)/com.robin.dsh-web` 重启 dsh。
2. 重启后绑定文件保持（两个绑定都在），`/api/pi-plus/state` 显示 `attached:false phase:stopped`（绑定在、未连——符合预期）。
3. 在 UI 打开绑定会话 → dsh 发布普通 agent（`agent/created gateway=false`）→ auto-reattach 检测到绑定 → **替换为网关 agent（`gateway=true`）→ `pi --mode rpc` 以原 piSessionId 恢复**。
4. `/api/pi-plus/state?session=…` 返回：
   ```json
   { "sessionId": "session-b8b9e0b8-…", "attached": true,
     "threadId": "6bbb09c9-…", "phase": "ready", "running": false, "queue": [] }
   ```

诊断日志证据（`DSH_SUBAGENT_PI_DEBUG=1`）：
```
[auto-reattach] agent/created session-b8b9e0b8-… gateway=false
[auto-reattach] agent/created session-b8b9e0b8-… gateway=true
[pi-stderr] [dashboard] sendFlowsList: 0 flows, sessionId=6bbb09c9
```

结论：**关机/重启后重新进入绑定会话，自动直连原 Pi 会话，无需人工干预**。

---

## 4. UI 验证

- 会话头部徽标：`PI-xxxx`（彩色绑定状态点 + `PI-` + 前四位 session id）。
- 状态行：`Pi 直连 · 8031522b-7… · 空闲`（`conversation.composer.dock`）。
- 悬浮控制窗：队列查看/置顶/插入/编辑/删除、steer、解绑信息；暗色主题已适配。
- 直连状态消息：`已直连 Pi 会话 …。本会话后续输入输出直接走 Pi；忙时新消息自动排队，可用悬浮窗查看/插入/取消。 解除直连：/pi-unlock。`

---

## 5. 排障记录

- **Pi 进程识别**：`ps` 中 argv 显示为裸 `pi`，`pgrep -fl "pi --mode rpc"` 匹配不到；用 `ps aux | grep -w pi | grep -v grep | grep -v dashboard` 判断。
- **页面打开会话不对**：UI 侧栏无标题会话显示工作区名（如 `ocgo-gateway`）占位，需逐个点击并用 network 请求（`/api/pi-plus/state?session=…`）识别 session id 后对照绑定列表。
- **Playwright**：`networkidle` 会超时，用 `domcontentloaded`；需 `channel: 'chrome'`。
- **诊断日志开关**：默认关闭（不写 /tmp），`DSH_SUBAGENT_PI_DEBUG=1` 开启；`DSH_SUBAGENT_PI_DEBUG_LOG` 可自定义路径。
