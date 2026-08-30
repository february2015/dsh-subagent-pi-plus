---
description: "Forked from the official @deepseek-ai/dsh-subagent-codex: makes Pi a first-class citizen in DeepSeek Harness — true-gateway direct connection, queued/steered continuous conversation, live intermediate output, durable binding with auto-reattach, and image passthrough."
kind: "package-bundle"
---

# dsh-subagent-pi

English | [中文](README.zh.md)

**This plugin is forked from the official `@deepseek-ai/dsh-subagent-codex` plugin** (via the personal `dsh-subagent-codex-plus` project), switching the direct-connected agent from Codex to Pi — making **Pi a first-class citizen inside DeepSeek Harness (dsh)**.

## Features

### 1. True-gateway direct connection (core)

One local command binds your **current dsh conversation 1:1 to a durable Pi session**; from then on everything you type in the dsh composer goes straight to Pi — **dsh runs no model in between, it only relays**.

- `/pi-lock` binds the session to a persistent Pi session (an existing Pi session can be resumed by id).
- `/pi-unlock` unbinds and restores the normal dsh agent loop; the Pi session is kept and can be rebound anytime.
- **Durable binding**: after shutting down / restarting dsh, reopening the session auto-reconnects the same Pi session, no manual step needed.
- One Pi session can be bound to only one dsh session.

### 2. Continuous conversation: queue + direct insert

- While Pi is busy, new messages are **queued** automatically and run in order when the current turn ends.
- The floating panel can **insert** a message directly (it runs ahead of queued messages on the next turn).
- The queue is fully manageable: view, promote, insert, edit, delete.

### 3. Live intermediate output

Pi's execution progress (message deltas, tool calls, status events) shows up in the dsh session in near real time — not just the final answer. By default it is display-only and never enters the dsh model context.

### 4. Status display

Once bound, the session header shows a `PI-xxxx` badge (colored status dot + first 4 session id chars) and the composer dock shows a "Pi 直连 · …" status line. **Unbound sessions show nothing**, keeping the UI clean.

### 5. Image / attachment passthrough

Paste or upload images and hand them to Pi as-is. Vision fallback is handled by the TeamAI skill `ocgw-vision` (this plugin does no vision understanding).

### 6. Delegation and gateway coexist

One dsh conversation can use model-triggered one-shot Pi delegations and a user-attached gateway session at the same time, without interference.

## Quick start

### Install

```sh
dsh plugin --profile <name> add /path/to/dsh-subagent-pi
dsh --profile <name>
```

Prerequisites: `pi` installed and configured (login/model) on this machine.

### Usage

1. Open any dsh session (cwd is your project).
2. Type `/pi-lock`: after binding succeeds the header shows a `PI-xxxx` badge, and input goes straight to Pi.
3. While Pi is busy, further messages queue automatically; use the floating panel to view/promote/insert/edit/delete.
4. `/pi-unlock` disconnects; the Pi session is kept and can be rebound with `/pi-lock <piSessionId>`.

## Docs

- `IMPLEMENTATION.md` — feature checklist (implementation details)
- `REQUIREMENTS.md` — requirements spec
- `TECH-VERIFICATION.md` — technical verification report (implementation technology)
