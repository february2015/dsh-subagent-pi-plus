/**
 * Codex app-server notification stream → dsh session log (R1-A1).
 *
 * Every Codex turn/item/delta is projected onto the dsh session's append-only
 * log as **log-only** events (`turn/start`, `turn/end`, `step/start`,
 * `step/end`, `assistant/chunk`, `tool/call`), which never carry a
 * `surfaceOp` and therefore never enter the model-visible surface (A2).
 *
 * Two message-producing events DO join the surface (`surfaceOp: 'append'`):
 * the user prompt is recorded by the agent when its turn starts, and on
 * `turn/completed` the streamed deltas are assembled into a durable
 * `assistant/message`. Without that durable message the chat fold has no
 * settled node and renders every finished reply as a synthetic interrupted
 * node ("已停止"); with it the reply renders as a normal completed bubble
 * while the session log still preserves the full Codex intermediate
 * transcript for UI, tooling, and replay.
 *
 * Mapping (verified against a real `codex app-server --stdio` stream, see
 * TECH-VERIFICATION §3.6):
 * - `turn/started` → `turn/start` + `step/start`
 * - `turn/completed` → `step/end` + `turn/end`
 * - `item/reasoning/textDelta` → `assistant/chunk` (`reasoning-delta`)
 * - `item/agentMessage/delta` → `assistant/chunk` (`text-delta`)
 * - `item/started|completed` with a tool item → `tool/call`
 *
 * @module dsh-subagent-codex-plus/gateway/events
 */

import { createAssistantMessage, type CallId, type ContentBlock, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { CodexGatewayNotification } from './wire.ts'

/** Forwarding policy for the Codex → dsh session event stream. */
export interface GatewayEventForwarderOptions {
  /** Append Codex turn/step/chunk/tool events to the session log (A1). */
  readonly enabled: boolean
  /** Forwarding-side diagnostics sink (defaults to no-op). */
  readonly onError?: (message: string) => void
}

export const DEFAULT_EVENT_FORWARDER_OPTIONS: GatewayEventForwarderOptions = {
  enabled: true,
}

/** Item types whose lifecycle carries intermediate work worth logging. */
type ForwardedItem = 'reasoning' | 'agentMessage' | 'dynamicToolCall' | 'functionCall'

function itemType(value: unknown): ForwardedItem | undefined {
  if (value === 'reasoning' || value === 'agentMessage') return value
  if (value === 'dynamicToolCall' || value === 'functionCall') return value
  return undefined
}

function readString(value: unknown, label: string): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Map a Codex turn status onto the dsh `TurnEndReason` vocabulary. */
function turnEndReason(status: unknown, error: unknown): TurnEndReason {
  switch (status) {
    case 'interrupted':
      return { kind: 'aborted', reason: { kind: 'user' } }
    case 'failed': {
      const detail = asRecord(error)
      return {
        kind: 'error',
        error: {
          message: typeof detail?.message === 'string' && detail.message.length > 0
            ? detail.message
            : 'codex turn failed',
          code: 'UNKNOWN',
        },
      }
    }
    default:
      return { kind: 'completed' }
  }
}

/**
 * Project one app-server notification onto the bound dsh session log. Safe to
 * call for every observed notification; unrecognized methods are ignored.
 * Append failures (e.g. a disposed session) are swallowed so the gateway
 * stream never dies from a logging side effect.
 */
export class GatewayEventForwarder {
  /** dsh turn ordinal for the active Codex turn (1-based). */
  private turn = 0
  /** dsh step ordinal within the active turn (1; one step per Codex turn). */
  private step = 0
  private activeTurnId: string | undefined
  private stepOpen = false
  /** Reasoning deltas keyed by Codex item id, in first-seen order. */
  private readonly reasoningByItem = new Map<string, { readonly itemId: string; readonly index: number; text: string }>()
  private readonly reasoningOrder: string[] = []
  /** Text deltas keyed by content index (agentMessage deltas carry none). */
  private readonly textByIndex = new Map<number, string>()
  private readonly textOrder: number[] = []

  constructor(
    private readonly session: Session,
    private readonly options: GatewayEventForwarderOptions = DEFAULT_EVENT_FORWARDER_OPTIONS,
  ) {
    // `Session.append` is a class method that reads instance state; keep the
    // reference bound so the projection never throws on a detached `this`.
    this.appendBound = session.append.bind(session) as (type: string, data: unknown, opts?: unknown) => unknown
    // Continue turn numbering across process restarts: the session log is
    // durable, so a fresh forwarder must pick up after the last recorded turn
    // instead of renumbering from 1. Duplicate turn ordinals corrupt the
    // Harness front-end conversation assembler (it rejects a second `start`
    // match for the same context) and hide the whole conversation.
    this.turn = GatewayEventForwarder.recordedTurnCount(session)
  }

  private readonly appendBound: (type: string, data: unknown, opts?: unknown) => unknown

  /** Highest turn ordinal already present in the durable event log (0 when empty). */
  private static recordedTurnCount(session: Session): number {
    let max = 0
    for (const event of session.events) {
      const turn = (event.data as { turn?: unknown }).turn
      if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn > max) max = turn
    }
    return max
  }

  forward(notification: CodexGatewayNotification): void {
    if (!this.options.enabled) return
    try {
      this.dispatch(notification)
    } catch (error: unknown) {
      // Logging must never break the gateway stream; report and continue.
      const message = error instanceof Error ? error.message : String(error)
      this.options.onError?.(`[gateway-events] dropped notification ${notification.method}: ${message}`)
    }
  }

  private dispatch(notification: CodexGatewayNotification): void {
    switch (notification.method) {
      case 'turn/started':
        this.onTurnStarted(notification.params)
        break
      case 'turn/completed':
        this.onTurnCompleted(notification.params)
        break
      case 'item/started':
        this.onItemStarted(notification.params)
        break
      case 'item/agentMessage/delta':
        this.onTextDelta(notification.params)
        break
      case 'item/reasoning/textDelta':
        this.onReasoningDelta(notification.params)
        break
      default:
        break
    }
  }

  private onTurnStarted(params: Record<string, unknown>): void {
    const turn = asRecord(params.turn)
    const turnId = readString(turn?.id, 'turn id') ?? `codex-${this.turn + 1}`
    this.resetAccumulators()
    // A new active turn begins; if the server reported a second start without
    // a completion (e.g. resume racing), close the stale projection first.
    if (this.activeTurnId !== undefined) {
      this.closeStep()
      this.append('turn/end', { turn: this.turn, reason: { kind: 'interrupted' } })
    }
    this.turn += 1
    this.step = 1
    this.activeTurnId = turnId
    this.stepOpen = false
    this.append('turn/start', { turn: this.turn })
    this.openStep()
  }

  private onTurnCompleted(params: Record<string, unknown>): void {
    if (this.activeTurnId === undefined) return
    const turn = asRecord(params.turn)
    this.closeStep()
    // Settle the durable reply BEFORE closing the turn: the Harness surface
    // folds an `assistant/message` into the turn it belongs to, and a message
    // arriving after `turn/end` renders as an orphan (metadata only, no body).
    this.appendFinalMessage(turn?.status)
    this.append('turn/end', {
      turn: this.turn,
      reason: turnEndReason(turn?.status, turn?.error),
    })
    this.activeTurnId = undefined
    this.resetAccumulators()
  }

  private onItemStarted(params: Record<string, unknown>): void {
    const item = asRecord(params.item)
    if (item === undefined || this.activeTurnId === undefined) return
    const type = itemType(item.type)
    if (type === 'dynamicToolCall' || type === 'functionCall') {
      this.recordToolCall(item)
    }
  }

  private onTextDelta(params: Record<string, unknown>): void {
    const delta = readString(params.delta, 'delta')
    if (delta === undefined || this.activeTurnId === undefined) return
    const index = typeof params.contentIndex === 'number' ? params.contentIndex : 0
    if (!this.textByIndex.has(index)) this.textOrder.push(index)
    this.textByIndex.set(index, (this.textByIndex.get(index) ?? '') + delta)
    this.appendChunk({ type: 'text-delta', index, text: delta })
  }

  private onReasoningDelta(params: Record<string, unknown>): void {
    const delta = readString(params.delta, 'delta')
    if (delta === undefined || this.activeTurnId === undefined) return
    const itemId = readString(params.itemId, 'item id') ?? `reasoning-${this.reasoningOrder.length}`
    const index = typeof params.contentIndex === 'number' ? params.contentIndex : 0
    let accumulator = this.reasoningByItem.get(itemId)
    if (accumulator === undefined) {
      accumulator = { itemId, index, text: '' }
      this.reasoningByItem.set(itemId, accumulator)
      this.reasoningOrder.push(itemId)
    }
    accumulator.text += delta
    this.appendChunk({ type: 'reasoning-delta', index, text: delta })
  }

  /**
   * Assemble the streamed deltas into the durable `assistant/message` that
   * closes the step on the surface. Interrupted turns carry `interrupted`
   * exactly like a cancelled dsh turn, so the UI marks only genuinely
   * aborted replies; completed turns settle normally.
   */
  private appendFinalMessage(status: unknown): void {
    const blocks: ContentBlock[] = []
    for (const itemId of this.reasoningOrder) {
      const accumulator = this.reasoningByItem.get(itemId)
      if (accumulator !== undefined && accumulator.text !== '') {
        blocks.push({ type: 'reasoning', text: accumulator.text })
      }
    }
    for (const index of this.textOrder) {
      const text = this.textByIndex.get(index)
      if (text !== undefined && text !== '') {
        blocks.push({ type: 'text', text })
      }
    }
    const message = createAssistantMessage({
      content: blocks,
      source: { provider: 'codex', model: 'codex' },
    })
    this.appendSurface('assistant/message', {
      turn: this.turn,
      step: this.step,
      message,
      ...status === 'interrupted' ? { interrupted: true } : {},
    })
  }

  private resetAccumulators(): void {
    this.reasoningByItem.clear()
    this.reasoningOrder.length = 0
    this.textByIndex.clear()
    this.textOrder.length = 0
  }

  private recordToolCall(item: Record<string, unknown>): void {
    const rawCallId = readString(item.id, 'item id') ?? readString(item.callId, 'call id')
    if (rawCallId === undefined) return
    const callId = rawCallId as CallId
    const name = readString(item.tool, 'tool name') ?? readString(item.name, 'tool name') ?? 'unknown'
    const args = item.arguments
    this.append('tool/call', {
      turn: this.turn,
      step: this.step,
      callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    })
  }

  private appendChunk(chunk: Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' }>): void {
    this.append('assistant/chunk', {
      turn: this.turn,
      step: this.step,
      chunk,
    })
  }

  private openStep(): void {
    if (this.stepOpen) return
    this.stepOpen = true
    this.append('step/start', { turn: this.turn, step: this.step })
  }

  private closeStep(): void {
    if (!this.stepOpen) return
    this.stepOpen = false
    this.append('step/end', { turn: this.turn, step: this.step })
  }

  private append(
    type: 'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'assistant/chunk' | 'tool/call',
    data: unknown,
  ): void {
    // The six event types are log-only (never surface), so no SurfaceIntent
    // is required; the cast widens the generic append signature.
    void this.appendBound(type, data)
  }

  /** Append a message-producing event on the model-visible surface (A2). */
  private appendSurface(type: 'user/message' | 'assistant/message', data: unknown): void {
    void this.appendBound(type, data, { surfaceOp: 'append' })
  }
}
