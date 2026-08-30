/**
 * Pi RPC event stream → dsh session log (R1-A1).
 *
 * Every Pi agent/turn/message event is projected onto the dsh session's
 * append-only log as **log-only** events (`turn/start`, `turn/end`,
 * `step/start`, `step/end`, `assistant/chunk`, `tool/call`), which never
 * carry a `surfaceOp` and therefore never enter the model-visible surface
 * (A2).
 *
 * Two message-producing events DO join the surface (`surfaceOp: 'append'`):
 * the user prompt is recorded by the agent when its turn starts, and on
 * `turn_end` the turn's final assistant message is appended as a durable
 * `assistant/message`. Without that durable message the chat fold has no
 * settled node and renders every finished reply as a synthetic interrupted
 * node ("已停止"); with it the reply renders as a normal completed bubble
 * while the session log still preserves the full Pi intermediate transcript.
 *
 * Mapping (verified against a real `pi --mode rpc` stream):
 * - `turn_start` → `turn/start` + `step/start`
 * - `message_update` (`text_delta`) → `assistant/chunk` (`text-delta`)
 * - `message_update` (`thinking_delta`) → `assistant/chunk` (`reasoning-delta`)
 * - `message_update` (`toolcall_end`) → `tool/call`
 * - `turn_end` → `step/end` + durable `assistant/message` + `turn/end`
 *
 * @module dsh-subagent-pi/gateway/events
 */

import { createAssistantMessage, type CallId, type ContentBlock, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { PiEvent } from './pi-wire.ts'

/** Forwarding policy for the Pi → dsh session event stream. */
export interface GatewayEventForwarderOptions {
  /** Append Pi turn/step/chunk/tool events to the session log (A1). */
  readonly enabled: boolean
  /** Forwarding-side diagnostics sink (defaults to no-op). */
  readonly onError?: (message: string) => void
}

export const DEFAULT_EVENT_FORWARDER_OPTIONS: GatewayEventForwarderOptions = {
  enabled: true,
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readString(value: unknown, label: string): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Map a Pi assistant stop reason onto the dsh `TurnEndReason` vocabulary. */
function turnEndReason(stopReason: unknown, errorMessage: unknown): TurnEndReason {
  switch (stopReason) {
    case 'aborted':
      return { kind: 'aborted', reason: { kind: 'user' } }
    case 'error': {
      const message = readString(errorMessage, 'error message')
      return {
        kind: 'error',
        error: {
          message: message ?? 'pi turn failed',
          code: 'UNKNOWN',
        },
      }
    }
    default:
      return { kind: 'completed' }
  }
}

/** Extract text/thinking blocks from one Pi assistant message content list. */
function blocksOfContent(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (!Array.isArray(content)) return blocks
  for (const entry of content) {
    const block = asRecord(entry)
    if (block === undefined) continue
    if (block.type === 'text') {
      const text = readString(block.text, 'text')
      if (text !== undefined && text.length > 0) blocks.push({ type: 'text', text })
    } else if (block.type === 'thinking') {
      const text = readString(block.text, 'thinking text')
      if (text !== undefined && text.length > 0) blocks.push({ type: 'reasoning', text })
    }
  }
  return blocks
}

/**
 * Project one Pi RPC event onto the bound dsh session log. Safe to call for
 * every observed event; unrecognized event types are ignored. Append
 * failures (e.g. a disposed session) are swallowed so the gateway stream
 * never dies from a logging side effect.
 */
export class GatewayEventForwarder {
  /** dsh turn ordinal for the active Pi run (1-based). */
  private turn = 0
  /** dsh step ordinal within the active turn (1; one step per Pi turn). */
  private step = 0
  private stepOpen = false

  constructor(
    private readonly session: Session,
    private readonly options: GatewayEventForwarderOptions = DEFAULT_EVENT_FORWARDER_OPTIONS,
  ) {
    // `Session.append` is a class method that reads instance state; keep the
    // reference bound so the projection never throws on a detached `this`.
    this.appendBound = session.append.bind(session) as (type: string, data: unknown, opts?: unknown) => unknown
    // Continue turn numbering across process restarts: the session event log
    // is durable, so a fresh forwarder must pick up after the last recorded
    // gateway turn instead of renumbering from 1. Duplicate turn ordinals
    // corrupt the Harness front-end conversation assembler (it rejects a
    // second `start` match for the same context) and hide the whole
    // conversation.
    this.turn = GatewayEventForwarder.recordedTurnCount(session)
    if (!this.options.enabled) {
      this.appendBound = () => undefined
      this.appendSurfaceBound = () => undefined
    }
  }

  /** Highest turn ordinal already present in the durable event log (0 when empty). */
  private static recordedTurnCount(session: Session): number {
    let max = 0
    try {
      for (const event of session.events) {
        const turn = (event.data as { turn?: unknown }).turn
        if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn > max) max = turn
      }
    } catch {
      // A disposed or incomplete session log must not block the gateway.
    }
    return max
  }

  /** Process one event; call with every raw Pi event, oldest first. */
  forward(event: PiEvent): void {
    if (!this.options.enabled) return
    try {
      this.dispatch(event)
    } catch (error: unknown) {
      // Logging must never break the gateway stream; report and continue.
      const message = error instanceof Error ? error.message : String(error)
      this.options.onError?.(`[gateway-events] dropped event ${event.type}: ${message}`)
    }
  }

  private dispatch(event: PiEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.onTurnStart()
        break
      case 'turn_end':
        this.onTurnEnd(event)
        break
      case 'message_update':
        this.onMessageUpdate(event)
        break
      default:
        break
    }
  }

  private onTurnStart(): void {
    this.turn += 1
    this.step = 1
    this.openStep()
    this.append('turn/start', { turn: this.turn })
  }

  private onTurnEnd(event: PiEvent): void {
    const message = asRecord(event.message)
    const content = message === undefined ? undefined : message.content
    this.closeStep()
    // Settle the durable reply BEFORE closing the turn: the Harness surface
    // folds an `assistant/message` into the turn it belongs to, and a message
    // arriving after `turn/end` renders as an orphan (metadata only, no body).
    this.appendFinalMessage(content, message)
    this.append('turn/end', {
      turn: this.turn,
      reason: turnEndReason(message?.stopReason, message?.errorMessage),
    })
    this.stepOpen = false
  }

  private onMessageUpdate(event: PiEvent): void {
    if (!this.stepOpen) return
    const assistant = asRecord(event.assistantMessageEvent)
    if (assistant === undefined) return
    switch (assistant.type) {
      case 'text_delta': {
        const delta = readString(assistant.delta, 'text delta')
        if (delta === undefined) return
        const index = typeof assistant.contentIndex === 'number' ? assistant.contentIndex : 0
        this.appendChunk({ type: 'text-delta', index, text: delta })
        break
      }
      case 'thinking_delta': {
        const delta = readString(assistant.delta, 'thinking delta')
        if (delta === undefined) return
        const index = typeof assistant.contentIndex === 'number' ? assistant.contentIndex : 0
        this.appendChunk({ type: 'reasoning-delta', index, text: delta })
        break
      }
      case 'toolcall_end': {
        const toolCall = asRecord(assistant.toolCall)
        if (toolCall === undefined) return
        const rawCallId = readString(toolCall.id, 'tool call id') ?? readString(toolCall.callId, 'tool call id')
        if (rawCallId === undefined) return
        const name = readString(toolCall.name, 'tool name') ?? readString(toolCall.tool, 'tool name') ?? 'unknown'
        const args = toolCall.arguments
        this.append('tool/call', {
          turn: this.turn,
          step: this.step,
          callId: rawCallId as CallId,
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        })
        break
      }
      default:
        break
    }
  }

  /** Assemble the turn's final assistant message from the authoritative content. */
  private appendFinalMessage(content: unknown, message: Record<string, unknown> | undefined): void {
    const blocks = blocksOfContent(content)
    const dshMessage = createAssistantMessage({
      content: blocks,
      source: { provider: 'pi', model: typeof message?.model === 'string' ? message.model : 'pi' },
    })
    this.appendSurface('assistant/message', {
      turn: this.turn,
      step: this.step,
      message: dshMessage,
      ...message?.stopReason === 'aborted' ? { interrupted: true } : {},
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
    void this.appendSurfaceBound(type, data, { surfaceOp: 'append' })
  }

  private appendBound: (type: string, data: unknown, opts?: unknown) => unknown
  private appendSurfaceBound: (type: string, data: unknown, opts?: unknown) => unknown = (
    type: string,
    data: unknown,
    opts?: unknown,
  ) => this.appendBound(type, data, opts)
}
