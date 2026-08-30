---
description: "Fork of @deepseek-ai/dsh-subagent-codex: keeps the official one-shot Codex delegation and adds a true-gateway direct connection, queued/steered continuous conversation, intermediate-event forwarding, image passthrough, and a GLM vision bridge for DeepSeek Harness."
kind: "package-bundle"
---

# dsh-subagent-codex-plus

[English](README.md) | [中文](README.zh.md)

`dsh-subagent-codex-plus` is a **fork of the official `@deepseek-ai/dsh-subagent-codex` plugin**. It keeps the official one-shot Codex delegation exactly as upstream ships it, and layers a set of extensions on top so that **Codex becomes a first-class citizen inside DeepSeek Harness (dsh)**: continuous conversation, live intermediate output, and a true-gateway mode where dsh only relays bytes between you and a Codex session.

## Based on the official plugin

| | |
|---|---|
| Upstream package | [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) |
| Fork baseline | upstream master TS source, `0.1.2-alpha.1` (same generation as dsh `0.1.1-rc.2`) |
| Renamed in this fork | package `dsh-subagent-codex-plus` · plugin `subagent-codex-plus` · provider `codex-plus` |

Upstream mechanism (unchanged): the plugin is an installable Profile Bundle. When the dsh model calls the delegation tool, the provider spawns a real local Codex child (`codex app-server --stdio`, stdio JSON-RPC — **not** an HTTP API and **not** MCP), creates one ephemeral thread in the parent session's cwd, runs one self-contained task, and returns the selected final answer. Codex authentication stays native (its own `~/.codex` config and login).

## What the official plugin already does (kept as the baseline)

- **One-shot delegation (R0)** — one call = one fresh Codex subprocess + ephemeral thread, final answer returned through the standard subagent result contract.
- **Profile Bundle install** — dormant until a delegation tool row binds it; official wrapper and platform payload included.
- **Unattended permission modes** — `never` / `approve-for-me` / `dangerously-bypass-approvals-and-sandbox` map into the thread's approval/reviewer/sandbox fields.
- **Native Codex configuration and authentication** remain authoritative.

All of the above still works in this fork and serves as the fallback path.

## What this fork adds

### 1. True-gateway direct connection (R3 — the core feature)

One local command binds your **current dsh conversation 1:1 to one durable Codex thread**, and from then on everything you type in the dsh composer goes straight to Codex — **dsh runs no model in between, it only relays**.

- `/codex-lock` binds the session to a persistent Codex thread (spawns `codex app-server --stdio`; `thread/resume` on restart).
- `/codex-unlock` unbinds and restores the normal dsh agent loop.
- Binding is durable in `$DSH_HOME/codex-plus-gateway.json` (`sessionId ↔ threadId`); reopening the dsh session auto-reattaches the same Codex thread. If a previous app-server still holds the thread writer lock after a restart, the gateway retries with exponential backoff (1s→16s) until it reconnects.
- Mutual exclusivity (Q4): one Codex thread can be bound to only one dsh session; re-binding is rejected.

### 2. Continuous conversation: queue + direct insert (R2)

- While Codex is busy, new messages are **queued** (FIFO `followup`, auto-drain when the turn ends).
- The floating control panel's steer input **inserts immediately**: it interrupts the current turn and runs the message as the next turn.
- Queue is fully manageable: view, cancel, reorder, update.

### 3. Live intermediate output (R1)

Codex's execution progress is forwarded into the dsh session stream in near real time: reasoning summaries, agent-message deltas, tool calls, and status events. By default these are **log-only** — they do not enter the dsh model context (saves tokens, keeps the model focused).

**Turn numbering continues across restarts**: the session log is durable, so the event forwarder reads the highest `turn` ordinal already recorded and keeps incrementing from there (instead of restarting at 1). This keeps the dsh front-end conversation assembler from crashing on a duplicate `turn/start` and hiding the whole conversation.

### 4. Official slots for status + floating panel for control (R2/B3)

- **Status** uses official dsh slots: `conversation.session.header` direct-connect badge, `conversation.composer.dock` status bar, `conversation.input.dock` live queue list.
- **Control** lives in a floating overlay panel (dsh-pet pattern, `shell.overlay`): queue operations, steer/insert, gateway on/off.

### 5. Image / attachment passthrough (Q3)

Composer attachments pass through as Codex `localImage` inputs (local path / base64), so you can paste screenshots and have Codex act on them.

### 6. Vision bridge fallback (R4) — owned by the OCGW gateway system

Images are **passed through untouched**: dsh attachments are materialized as Codex `localImage` inputs and handed to Codex as-is. Visual understanding is no longer plugin-provided; it is handled by the shared TeamAI skill **`ocgw-vision`** (`my-agent-hub/skills/ocgw-vision`, installed on DSH/PI/OMP/Codex): when the model cannot see images, it follows the skill, asks the user to save the image to a file, and runs `ocgw-vision.sh describe <path>` to get a Chinese description from the ocgo gateway (`glm-5.3-flash`). The plugin-side `ocgw-vision` service and description injection have been removed.

### 7. Delegation and gateway coexist (Q5)

One dsh conversation can hold multiple one-shot delegated Codex runs (model-triggered) **and** at most one user-attached gateway session at the same time; switch between them freely.

## Quick start

### Install into a dsh profile

```sh
# from this repo (local link install) — or any published tarball/npm name
dsh plugin --profile <name> add /path/to/dsh-subagent-codex-plus
dsh --profile <name>
```

The profile's `package.json` gets `"dsh-subagent-codex-plus": "link:<this repo>"`; rebuild with `npm run build` in this repo and restart the profile to pick up changes.

### Use the gateway

```sh
# inside a dsh conversation
/codex-lock    # bind this session to a fresh persistent Codex thread
/codex-unlock    # unbind; the Codex thread is kept for later re-attach
```

The session header shows a direct-connect badge, the composer dock shows gateway status, and the floating panel (open from the header button) shows the queue and steer controls.

### Delegation (official baseline, unchanged)

```yaml
# dsh profile settings
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex-plus
    toolName: subagent_codex
    backgroundMode: one-shot
```

## Gateway configuration

| Field | Default | Meaning |
|---|---|---|
| `gatewayEnabled` | `true` | Master switch for the gateway feature |
| `gatewayBindingFile` | `$DSH_HOME/codex-plus-gateway.json` | Durable 1:1 binding store (session ↔ thread) |
| `gatewayApprovalPolicy` | — | Approval policy for gateway turns (native Codex modes) |
| `gatewayEventForwarding` | `true` | Forward Codex intermediate events into the dsh session stream |
| `gatewayAppendFinalMessage` | — | Append the final answer into the dsh session as a normal message |

## Documentation

- [`REQUIREMENTS.md`](REQUIREMENTS.md) — finalized spec (R0–R4, Q1–Q5; true gateway = V1 core).
- [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — feature checklist with step-by-step status.
- [`TECH-VERIFICATION.md`](TECH-VERIFICATION.md) — verified facts: protocol probes, real-device end-to-end runs, image-gate and vision-bridge evidence.

## Known limitations

- **One-shot delegation** still creates a fresh process/thread per run (official behavior); the gateway path is the persistent-conversation alternative.
- **Authentication stays native** — the plugin provides the CLI but does not log in, trust projects, or rewrite Codex settings.
- **Vision descriptions need the `dsh-ocgw` plugin** — when it is not installed, images pass through undescribed (Codex then relies on its own model's vision ability).
- **Byte-level streaming render (A1-b)** is deferred: intermediate events are injected in event-block granularity, near real time, not per-byte.

## Repairing existing sessions

Older builds restarted turn numbering from 1 on every boot, so a durable log could end up with **duplicate turn ordinals**. The dsh front end then fails to load the conversation (`conversation Context N:deliverables1 received more than one start Match`) and the chat appears blank. Two layers of fix:

- **Code fix**: `src/gateway/events.ts` — `GatewayEventForwarder` picks up from the maximum turn ordinal already in the session log at construction time, so new writes never repeat.
- **Existing data**: run `node scripts/renumber-sessions.mjs` (scans `~/.dsh/sessions` by default; `--dry-run` reports without writing, `--sessions-dir` overrides the root). It rewrites each session frame-by-frame in dsh's multi-frame zstd format, treating every `turn/start` as a new turn instance and reassigning monotonic ordinals; the original file is kept as `session.jsonl.zstd.bak-<timestamp>`.
