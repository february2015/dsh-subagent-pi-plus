/**
 * Pi RPC line protocol adapter (`pi --mode rpc`). Commands are JSON lines on
 * stdin, responses and events are JSON lines on stdout. Unlike Codex's
 * JSON-RPC there is no initialize handshake: the child begins streaming
 * events immediately after spawn, and every command carries its own id that
 * the matching `response` echoes back.
 *
 * The wire owns the product surface only: command/response correlation and
 * the raw event stream. Queue/steer semantics and the dsh session projection
 * live in the gateway layer (`gateway.ts`) and the event forwarder
 * (`events.ts`).
 *
 * @module dsh-subagent-pi-plus/gateway/pi-wire
 */

import type { Readable, Writable } from 'node:stream'

/** One server-initiated event (agent/turn/message/queue …). */
export interface PiEvent {
  readonly type: string
  readonly [key: string]: unknown
}

/** Success payload of a `response` frame. */
export interface PiCommandResult {
  readonly success: true
  readonly data?: Record<string, unknown>
}

/** Failure payload of a `response` frame. */
export interface PiCommandFailure {
  readonly success: false
  readonly error: string
}

export type PiCommandResponse = PiCommandResult | PiCommandFailure

interface PendingCommand {
  readonly resolve: (value: PiCommandResponse) => void
  readonly reject: (error: Error) => void
}

function wireClosedError(): Error {
  return new Error('pi gateway: RPC wire closed')
}

/**
 * One long-lived Pi RPC child connection. Command methods return validated
 * responses; every event is captured for replay and forwarded through
 * {@link onEvent}.
 */
export class PiRpcWire {
  private readonly pending = new Map<number, PendingCommand>()
  private readonly captured: PiEvent[] = []
  private buffer = ''
  private sequence = 0
  private closed = false
  private eventHandler: ((event: PiEvent) => void) | undefined

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  /** Begin reading stdout frames. Idempotent. */
  start(): void {
    this.input.setEncoding('utf8')
    this.input.on('data', (chunk: string) => this.onData(chunk))
    this.input.on('end', () => this.failAll(wireClosedError()))
    this.input.on('error', (error: Error) => this.failAll(error))
  }

  /** Subscribe to forwarded events; only one listener at a time. */
  onEvent(handler: (event: PiEvent) => void): void {
    this.eventHandler = handler
  }

  /** Replay every event observed so far, oldest first. */
  replayEvents(): readonly PiEvent[] {
    return this.captured
  }

  /** Drop the replay buffer. */
  clearReplay(): void {
    this.captured.length = 0
  }

  /**
   * Send one command and await its correlated `response`. The Pi child
   * answers every command, so the promise settles on the matching frame.
   * @param command - command fields (minus the generated id).
   * @param signal - optional abort for this command only.
   */
  command(command: Record<string, unknown>, signal?: AbortSignal): Promise<PiCommandResponse> {
    if (this.closed) return Promise.reject(wireClosedError())
    const id = ++this.sequence
    const promise = new Promise<PiCommandResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ id, ...command })
    if (signal !== undefined) {
      if (signal.aborted) {
        const pending = this.pending.get(id)
        if (pending !== undefined) {
          this.pending.delete(id)
          pending.reject(abortError(signal))
        }
        return promise
      }
      const onAbort = (): void => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        pending.reject(abortError(signal))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      return promise.finally(() => signal.removeEventListener('abort', onAbort))
    }
    return promise
  }

  /** Reject all outstanding commands and stop accepting new ones. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(wireClosedError())
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim().length === 0) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Malformed frames are ignored; protocol failures surface through
      // command rejections or the terminal process state.
      return
    }
    if (frame.type === 'response') {
      const id = frame.id
      if (typeof id === 'number') {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        if (frame.success === true) {
          pending.resolve({
            success: true,
            ...frame.data === undefined || frame.data === null ? {} : { data: frame.data as Record<string, unknown> },
          })
        } else {
          pending.resolve({
            success: false,
            error: typeof frame.error === 'string' && frame.error.length > 0
              ? frame.error
              : 'pi gateway: command failed',
          })
        }
      }
      return
    }
    if (typeof frame.type === 'string' && frame.type.length > 0) {
      const event = frame as PiEvent
      this.captured.push(event)
      this.eventHandler?.(event)
    }
  }

  private write(frame: Record<string, unknown>): void {
    if (this.closed) return
    this.output.write(`${JSON.stringify(frame)}\n`)
  }

  private failAll(error: Error): void {
    if (this.pending.size === 0) return
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const item of pending) item.reject(error)
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`pi gateway: command aborted: ${String(signal.reason)}`)
}
