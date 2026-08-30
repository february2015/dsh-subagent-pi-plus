---
description: "Fork of dsh-subagent-codex-plus: swaps the transport from Codex stdio JSON-RPC to Pi's native RPC (pi --mode rpc), keeping the true-gateway direct connection, queued/steered continuous conversation, live intermediate event forwarding, durable binding with auto-reattach, and image passthrough."
kind: "package-bundle"
---

# dsh-subagent-pi

English | [中文](README.zh.md)

`dsh-subagent-pi` is a **fork of `dsh-subagent-codex-plus`** (itself a fork of the official `@deepseek-ai/dsh-subagent-codex`). It replaces the protocol layer with **Pi's native RPC protocol** (`pi --mode rpc`) while reusing the rest of the architecture and UI, making **Pi a first-class citizen inside DeepSeek Harness (dsh)**: continuous conversation, live intermediate output, and a true-gateway mode where dsh only relays bytes between you and a Pi session — no model runs in between.

## Based on

| | |
|---|---|
| Direct source | [`dsh-subagent-codex-plus`](https://github.com/robinwlive/dsh-subagent-codex-plus) (robinwlive personal fork) |
| Upstream official | [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) |
| Renamed in this fork | package `dsh-subagent-pi` · plugin `subagent-pi` · provider `pi` |

**Protocol change (the core of this fork)**: codex-plus talks to Codex over `codex app-server --stdio` (stdio JSON-RPC); this plugin spawns `pi --mode rpc --session-dir <dir> --session-id <id>` and communicates over **JSONL commands/events** on stdin/stdout (`prompt` / `follow_up` / `steer` / `abort` / `get_state` commands; `response → turn_start → message_start/end → message_update(text_delta/toolcall_*) → turn_end → agent_end → agent_settled` events). **Not an HTTP API, not MCP.**

Pi auth, models, tools, and sandboxing stay native to the Pi process (reading the user's local Pi config); dsh does not take them over.

## Capabilities

### 1. True-gateway direct connection (core)

One local command binds your **current dsh conversation 1:1 to a durable Pi session**; from then on everything you type in the dsh composer goes straight to Pi — **dsh runs no model in between, it only relays**.

- `/pi-lock` binds the session to a persistent Pi session (spawns `pi --mode rpc`; creates one if no session id is given).
- `/pi-unlock` unbinds and restores the normal dsh agent loop; the Pi session is kept and can be rebound at any time.
- Binding is durable in `$DSH_HOME/pi-plus-gateway.json` (`sessionId ↔ piSessionId`, 1:1).
- **Auto-reattach across restarts (C3)**: after a dsh restart, reopening a bound session automatically reconnects the same Pi session (`agent/created` → swapped to a gateway agent → `pi --mode rpc` resumed with the original session id), no manual step needed.
- Mutual exclusivity (Q4): one Pi session can be bound to only one dsh session; re-binding is rejected.

### 2. Continuous conversation: queue + direct insert

- While Pi is busy, new messages are **queued** (dsh-side local FIFO; auto-drained when the current turn ends).
- The floating panel's steer input **inserts immediately**: sends Pi a `steer` command and the inserted message runs ahead of the queued ones on the next turn.
- The queue is fully manageable: view, promote, insert, edit, delete.

> Implementation note: Pi's internal `queue_update {steering:[], followUp:[]}` is a plain-text array with no per-item ids, so it cannot be edited or reordered on the Pi side — **queueing is maintained locally in dsh** (local message ids), released on `agent_settled`.

### 3. Live intermediate output (R1)

Pi's execution progress is forwarded into the dsh session stream in near real time: agent message deltas (`message_update` `text_delta`), tool calls (`toolcall_*`), and status events (`turn_start` / `turn_end` / `agent_end` / `agent_settled`). By default these are **log-only** — they do not enter the dsh model context (saves tokens, keeps the model focused).

**Turn numbering continues across restarts**: the session log is durable, so the forwarder reads the highest `turn` ordinal already recorded and keeps incrementing (instead of restarting at 1), keeping the dsh front-end conversation assembler from crashing on a duplicate `turn/start`.

### 4. Official slots for status + floating panel for control

- **Status** uses official dsh slots: `conversation.session.header` direct-connect badge (`PI-xxxx`, colored status dot + first 4 session id chars), `conversation.composer.dock` status bar, `conversation.input.dock` live queue list.
- **Control** lives in a floating overlay panel (dsh-pet pattern, `shell.overlay`): queue operations, steer/insert, unbind info.

### 5. Image / attachment passthrough (Q3)

Composer attachments pass through to Pi as image inputs (base64 / local path). **This plugin does not do vision understanding** — the vision fallback is owned by the TeamAI skill `ocgw-vision` (my-agent-hub): when a text-only model meets an image, it calls the ocgo gateway's `glm-5.3-flash` vision model to describe it.

### 6. Delegation and gateway coexist

One dsh conversation can hold multiple one-shot Pi delegations (model-triggered `subagent_delegate` with provider `pi`) **and** at most one user-attached gateway session at the same time.

## Quick start

### Install into a dsh profile

```sh
dsh plugin --profile <name> add /path/to/dsh-subagent-pi
dsh --profile <name>
```

Prerequisites: `pi` is installed and runnable (`pi --version`), and Pi is configured/logged in.

### Usage

1. Open any dsh session (cwd is your project).
2. Type `/pi-lock`: the header shows a `PI-xxxx` badge and a "Pi 直连 · …" status bar; input now goes straight to Pi.
3. While Pi is busy, further messages queue automatically; use the floating panel to view/promote/insert/edit/delete.
4. `/pi-unlock` disconnects; the Pi session is kept and can be rebound with `/pi-lock <piSessionId>`.

## Architecture

```text
DeepSeek Harness session (dsh)
    ↓ /pi-lock or subagent_delegate(provider=pi)
dsh-subagent-pi plugin
    ↓ spawn child
pi --mode rpc --session-dir ~/.dsh/pi-sessions --session-id <id>
    ↓ JSONL commands/events over stdin/stdout
Pi full agent loop (tools, file I/O, model inference)
    ↓ intermediate events (message_update/toolcall_*/turn_*) → dsh session log projection
    ↓ final result back to the dsh session
```

## Debugging

Diagnostic logging is off by default. Enable it and restart dsh:

```sh
export DSH_SUBAGENT_PI_DEBUG=1                        # on
export DSH_SUBAGENT_PI_DEBUG_LOG=/tmp/pi-gateway-debug.log   # optional, default $TMPDIR/pi-gateway-debug.log
```

## Docs

- `IMPLEMENTATION.md` — feature checklist (all done)
- `REQUIREMENTS.md` — requirements spec (R0-R4 + Q1-Q5 + C3)
- `TECH-VERIFICATION.md` — technical verification report (Pi RPC protocol probes + real end-to-end + restart recovery)
