/**
 * Gateway host UI service: same-origin JSON endpoints under
 * `/api/codex-plus/*` that the browser client (header badge, dock status
 * line, queue dock, floating control window) drives. Wraps the
 * {@link GatewayManager} and mirrors the durable bindings (C3) so the UI
 * can show direct-connect state, the live queue, steer insertion, cancel,
 * and attach/detach without touching any dsh model path.
 *
 * Route registration follows the dsh-pet pattern: plain `WebRoute`s on the
 * host webserver; the connection plugin's authority checks gate `/api/*`.
 *
 * @module dsh-subagent-codex-plus/gateway/ui
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  GatewayActionResponse,
  GatewayAttachRequest,
  GatewayBindingView,
  GatewayQueueDeleteRequest,
  GatewayQueueItemView,
  GatewayQueueReorderRequest,
  GatewaySessionRequest,
  GatewaySessionView,
  GatewayStateResponse,
  GatewaySteerRequest,
  GatewayQueueUpdateRequest,
} from '../shared/types.ts'
import type { GatewayManager } from './manager.ts'
import { textOf } from './ui-text.ts'

/** Browser-facing base path of the gateway API. */
export const GATEWAY_UI_PREFIX = '/api/codex-plus'

/** Validate a JSON-body session id and lift it to the branded type. */
function sessionIdOf(value: unknown): SessionId | undefined {
  return typeof value === 'string' && value.length > 0
    ? value as SessionId
    : undefined
}

/** One JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Require the method or answer 405. */
function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  json(res, 405, { ok: false, error: 'method-not-allowed' })
  return false
}

/** Read a bounded JSON request body. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body-too-large'))
        queueMicrotask(() => req.destroy())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

/** Wrap one async call as a GET route (request URL passed through). */
function getRoute(path: string, run: (url: string | undefined) => Promise<unknown>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!requireMethod(req, res, 'GET')) return
      run(req.url).then(
        (value) => json(res, 200, value),
        (error) => json(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    },
  }
}

/** Wrap one async call as a POST route (JSON body passed through). */
function postRoute(path: string, run: (body: Record<string, unknown>) => Promise<unknown>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!requireMethod(req, res, 'POST')) return Promise.resolve()
      return readJsonBody(req).then(
        (body) => run(body).then(
          (value) => json(res, 200, value),
          (error) => json(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        (error) => {
          json(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
    },
  }
}

/** The browser-facing gateway API surface. */
export class GatewayUiService {
  constructor(
    private readonly ctx: Context,
    private readonly manager: GatewayManager,
  ) {}

  /** Every route the host webserver should register. */
  routes(): WebRoute[] {
    return [
      getRoute(`${GATEWAY_UI_PREFIX}/state`, (url) => this.handleState(url)),
      postRoute(`${GATEWAY_UI_PREFIX}/attach`, (body) => this.handleAttach(body)),
      postRoute(`${GATEWAY_UI_PREFIX}/detach`, (body) => this.handleDetach(body)),
      postRoute(`${GATEWAY_UI_PREFIX}/queue/delete`, (body) => this.handleQueueDelete(body)),
      postRoute(`${GATEWAY_UI_PREFIX}/queue/update`, (body) => this.handleQueueUpdate(body)),
      postRoute(`${GATEWAY_UI_PREFIX}/queue/reorder`, (body) => this.handleQueueReorder(body)),
      postRoute(`${GATEWAY_UI_PREFIX}/steer`, (body) => this.handleSteer(body)),
      postRoute(`${GATEWAY_UI_PREFIX}/cancel`, (body) => this.handleCancel(body)),
    ]
  }

  private async handleState(url: string | undefined): Promise<GatewayStateResponse> {
    const raw = new URL(url ?? '', 'http://dsh.local').searchParams.get('session')
    const sessionId = raw === null ? undefined : sessionIdOf(raw)
    return {
      ok: true,
      session: sessionId === undefined ? null : await this.view(sessionId),
      bindings: this.bindings(),
    }
  }

  private async handleAttach(body: Record<string, unknown>): Promise<GatewayActionResponse> {
    const { threadId } = body as unknown as GatewayAttachRequest
    const sessionId = sessionIdOf(body.sessionId)
    if (sessionId === undefined) {
      return { ok: false, error: 'missing sessionId' }
    }
    if (threadId !== undefined && typeof threadId !== 'string') {
      return { ok: false, error: 'threadId must be a string' }
    }
    try {
      await this.manager.attach(sessionId, threadId)
      return {
        ok: true,
        session: await this.view(sessionId),
      }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async handleDetach(body: Record<string, unknown>): Promise<GatewayActionResponse> {
    const sessionId = sessionIdOf(body.sessionId)
    if (sessionId === undefined) {
      return { ok: false, error: 'missing sessionId' }
    }
    try {
      await this.manager.detach(sessionId)
      return { ok: true, session: await this.view(sessionId) }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async handleQueueDelete(body: Record<string, unknown>): Promise<GatewayActionResponse> {
    const { id } = body as unknown as GatewayQueueDeleteRequest
    const sessionId = sessionIdOf(body.sessionId)
    if (sessionId === undefined) {
      return { ok: false, error: 'missing sessionId' }
    }
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'missing queue id' }
    }
    const attached = this.manager.get(sessionId)
    if (attached === undefined) {
      return { ok: false, error: 'gateway: session is not attached to Codex' }
    }
    try {
      await attached.gateway.dequeue(id)
      return { ok: true, session: await this.view(sessionId) }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async handleQueueReorder(body: Record<string, unknown>): Promise<GatewayActionResponse> {
    const { ids } = body as unknown as GatewayQueueReorderRequest
    const sessionId = sessionIdOf(body.sessionId)
    if (sessionId === undefined) {
      return { ok: false, error: 'missing sessionId' }
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return { ok: false, error: 'ids must be an array of strings' }
    }
    const attached = this.manager.get(sessionId)
    if (attached === undefined) {
      return { ok: false, error: 'gateway: session is not attached to Codex' }
    }
    try {
      await attached.gateway.requeue(ids as readonly string[])
      return { ok: true, session: await this.view(sessionId) }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async handleQueueUpdate(body: Record<string, unknown>): Promise<GatewayActionResponse> {
    const { id, text } = body as unknown as GatewayQueueUpdateRequest
    const sessionId = sessionIdOf(body.sessionId)
    if (sessionId === undefined) {
      return { ok: false, error: 'missing sessionId' }
    }
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'missing queue id' }
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, error: 'queue text is empty' }
    }
    const attached = this.manager.get(sessionId)
    if (attached === undefined) {
      return { ok: false, error: 'gateway: session is not attached to Codex' }
    }
    try {
      await attached.gateway.updateQueue(id, text.trim())
      return { ok: true, session: await this.view(sessionId) }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async handleSteer(body: Record<string, unknown>): Promise<GatewayActionResponse> {
    const { text } = body as unknown as GatewaySteerRequest
    const sessionId = sessionIdOf(body.sessionId)
    if (sessionId === undefined) {
      return { ok: false, error: 'missing sessionId' }
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, error: 'steer text is empty' }
    }
    const attached = this.manager.get(sessionId)
    if (attached === undefined) {
      return { ok: false, error: 'gateway: session is not attached to Codex' }
    }
    try {
      // Route through the GatewayAgent so the inserted prompt lands on the
      // session surface as a durable `user/message`; steering the raw gateway
      // would redirect Codex without recording the prompt, so the insert never
      // shows up in the chat.
      attached.agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return { ok: true, session: await this.view(sessionId) }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async handleCancel(body: Record<string, unknown>): Promise<GatewayActionResponse> {
    const sessionId = sessionIdOf(body.sessionId)
    if (sessionId === undefined) {
      return { ok: false, error: 'missing sessionId' }
    }
    const attached = this.manager.get(sessionId)
    if (attached === undefined) {
      return { ok: false, error: 'gateway: session is not attached to Codex' }
    }
    attached.gateway.cancel()
    return { ok: true, session: await this.view(sessionId) }
  }

  /** Build the per-session state snapshot the browser polls. */
  async view(sessionId: SessionId): Promise<GatewaySessionView | null> {
    const session = this.ctx.get('sessions')?.get(sessionId)
    if (session === undefined) {
      // Not a live session in this host: still report the durable binding,
      // so a restarted host shows "直连已保存" instead of a blank badge.
      const binding = this.manager.store.get(sessionId)
      return binding === undefined
        ? null
        : {
            sessionId,
            attached: false,
            threadId: binding.codexThreadId,
            phase: 'stopped',
            running: false,
            queue: [],
          }
    }
    const attached = this.manager.get(sessionId)
    if (attached === undefined) {
      const binding = this.manager.store.get(sessionId)
      return {
        sessionId,
        attached: false,
        ...binding === undefined ? {} : { threadId: binding.codexThreadId },
        phase: 'stopped',
        running: false,
        queue: [],
      }
    }
    let queue: readonly GatewayQueueItemView[] = []
    try {
      queue = (await attached.gateway.queue()).map((entry) => ({
        id: entry.id,
        text: textOf(entry.input),
      }))
    } catch {
      // Queue read failure must not blank the badge; keep the last-known view
      // and surface the transient state through phase.
    }
    return {
      sessionId,
      attached: true,
      threadId: attached.threadId,
      phase: attached.gateway.phase,
      running: attached.gateway.turnState === 'running',
      queue,
    }
  }

  private bindings(): readonly GatewayBindingView[] {
    return this.manager.store.list().map(([sessionId, binding]) => ({
      sessionId,
      codexThreadId: binding.codexThreadId,
    }))
  }
}
