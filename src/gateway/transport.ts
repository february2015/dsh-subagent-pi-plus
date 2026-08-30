/**
 * Minimal JSON-RPC 2.0 line transport over a paired stream. One newline-
 * terminated JSON frame per message; request correlation by numeric id.
 *
 * The gateway core is intentionally dependency-free: it must run in any
 * environment (smoke tests, dsh host, standalone) without touching the
 * published dsh package set. This transport mirrors the framing semantics of
 * the official `@deepseek-ai/dsh-sdk-protocol` line transport.
 *
 * @module dsh-subagent-codex-plus/gateway/transport
 */

import type { Readable, Writable } from 'node:stream'

/** Structured JSON-RPC error carried to callers of {@link JsonRpcLineTransport.request}. */
export class JsonRpcTransportError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'JsonRpcTransportError'
  }
}

export type JsonRpcRequestHandler = (
  method: string,
  params: unknown,
) => unknown | Promise<unknown>
export type JsonRpcNotificationHandler = (method: string, params: unknown) => void

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

interface JsonRpcFrame {
  jsonrpc?: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown } | null
}

function transportClosedError(): Error {
  return new Error('gateway: JSON-RPC transport closed')
}

/**
 * Frame, dispatch, and correlate JSON-RPC messages on one input/output pair.
 * Starts reading on {@link start}; requests reject once closed.
 */
export class JsonRpcLineTransport {
  private readonly pending = new Map<number, PendingRequest>()
  private buffer = ''
  private sequence = 0
  private closed = false
  private requestHandler: JsonRpcRequestHandler | undefined
  private notificationHandler: JsonRpcNotificationHandler | undefined

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  /** Register the handler for server-initiated requests. */
  onRequest(handler: JsonRpcRequestHandler): void {
    this.requestHandler = handler
  }

  /** Register the handler for server-initiated notifications. */
  onNotification(handler: JsonRpcNotificationHandler): void {
    this.notificationHandler = handler
  }

  /** Begin consuming input frames. Idempotent. */
  start(): void {
    this.input.setEncoding('utf8')
    this.input.on('data', (chunk: string) => this.onData(chunk))
    this.input.on('end', () => this.failAll(transportClosedError()))
    this.input.on('error', (error: Error) => this.failAll(error))
  }

  /**
   * Send one request and await its correlated response.
   * @param method - RPC method name.
   * @param params - positional or named parameters.
   * @param signal - optional abort for this request only.
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(transportClosedError())
    const id = ++this.sequence
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
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

  /** Send one fire-and-forget notification. */
  notify(method: string, params?: object): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** Reject all outstanding requests and stop accepting new ones. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.failAll(transportClosedError())
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
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(line) as JsonRpcFrame
    } catch {
      // Malformed frames are ignored; protocol failures surface through
      // request rejections or the terminal process state.
      return
    }
    if (typeof frame.method === 'string') {
      if (frame.id !== undefined && frame.id !== null) {
        this.handleServerRequest(frame)
      } else {
        try {
          this.notificationHandler?.(frame.method, frame.params)
        } catch (error: unknown) {
          this.failAll(thrown(error))
        }
      }
      return
    }
    if (typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined && frame.error !== null) {
        pending.reject(new JsonRpcTransportError(
          frame.error.code ?? -32603,
          frame.error.message ?? 'gateway: JSON-RPC error',
          frame.error.data,
        ))
      } else {
        pending.resolve(frame.result)
      }
    }
  }

  private handleServerRequest(frame: JsonRpcFrame): void {
    const respond = (result: unknown, error?: JsonRpcFrame['error']): void => {
      this.write(error === undefined
        ? { jsonrpc: '2.0', id: frame.id, result }
        : { jsonrpc: '2.0', id: frame.id, error })
    }
    if (this.requestHandler === undefined) {
      respond(undefined, { code: -32601, message: `method not supported: ${String(frame.method)}` })
      return
    }
    Promise.resolve()
      .then(() => this.requestHandler?.(frame.method as string, frame.params))
      .then(result => respond(result))
      .catch((error: unknown) => {
        respond(undefined, { code: -32603, message: thrown(error).message })
      })
  }

  private write(frame: JsonRpcFrame): void {
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
    : new Error(`gateway: JSON-RPC request aborted: ${String(signal.reason)}`)
}

function thrown(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
