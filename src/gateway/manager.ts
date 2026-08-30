/**
 * Gateway session manager: orchestrates attach/detach for live dsh sessions,
 * enforces the persistent 1:1 binding (Q4), restores bindings across restarts
 * (C3), and restores normal mode on detach (Q1).
 *
 * @module dsh-subagent-codex-plus/gateway/manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { attachGateway, isGatewayAgent, type AttachedGateway } from './attach.ts'
import type { GatewayEventForwarderOptions } from './events.ts'
import type { GatewayBinding } from './binding.ts'
import { GatewayBindingStore } from './binding.ts'

/** Base delay for auto-reattach retries after transient writer-lock contention. */
const REATTACH_RETRY_BASE_MS = 1000
/** Maximum number of backoff retries (1s, 2s, 4s, 8s, 16s ≈ 31s window). */
const REATTACH_RETRY_MAX_ATTEMPTS = 5

/**
 * Whether a resume failure is transient contention on the thread's writer
 * lock: when a previous app-server still holds
 * `~/.codex/thread-writer-locks/<thread>.lock` after a dsh restart,
 * `thread/resume` fails with "already has an active writer". The lock is
 * released when that process exits, so retrying with backoff recovers without
 * user intervention.
 */
function isRetryableResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already has an active writer|active writer|writer lock/i.test(message)
}

export interface GatewayManagerOptions {
  /** App-server argv for every gateway (defaults to the package-local codex bin). */
  readonly argv?: readonly string[]
  /** Optional per-thread model override. */
  readonly model?: string
  /** Optional approval policy for gateway turns. */
  readonly approvalPolicy?: string
  /** Extra environment for the app-server child. */
  readonly env?: Record<string, string>
  /** Per-agent model options carried on registered gateway agents. */
  readonly agentOptions?: Record<string, unknown>
  /** Codex → dsh session event forwarding policy (R1-A1/A2). */
  readonly eventForwarder?: GatewayEventForwarderOptions
}

/** Owns one live attachment per session plus its durable binding. */
export class GatewayManager {
  private readonly attached = new Map<SessionId, AttachedGateway>()
  private readonly reattachRetries = new Map<SessionId, { attempt: number; timer: NodeJS.Timeout }>()

  constructor(
    private readonly ctx: Context,
    readonly store: GatewayBindingStore,
    private readonly options: GatewayManagerOptions = {},
  ) {}

  /** Whether a session is currently attached (live gateway). */
  isAttached(sessionId: SessionId): boolean {
    return this.attached.has(sessionId)
  }

  /** The live attachment for a session, if any. */
  get(sessionId: SessionId): AttachedGateway | undefined {
    return this.attached.get(sessionId)
  }

  /**
   * Attach a live session to a Codex thread and record the durable binding.
   * @param sessionId - live session to take over.
   * @param threadId - optional existing Codex thread to resume; absent creates one.
   * @returns the attachment.
   */
  async attach(sessionId: SessionId, threadId?: string): Promise<AttachedGateway> {
    const session = this.ctx.get('sessions')?.get(sessionId)
    if (session === undefined) {
      throw new Error(`gateway: session "${sessionId}" is not live; open it in the UI first`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined) {
      throw new Error('gateway: session has no working directory; cannot start Codex')
    }
    // Q4: the session must not already be bound, and a requested thread must
    // not already be owned by another session.
    if (this.store.get(sessionId) !== undefined) {
      throw new Error('gateway: this session is already bound to Codex (/codex-unlock to unbind)')
    }
    if (threadId !== undefined && this.store.threadOwner(threadId) !== undefined) {
      throw new Error(`gateway: Codex thread "${threadId}" is already bound to another dsh session`)
    }
    const attached = await attachGateway(this.ctx, sessionId, {
      cwd,
      ...this.options.argv === undefined ? {} : { argv: this.options.argv },
      ...this.options.model === undefined ? {} : { model: this.options.model },
      ...this.options.approvalPolicy === undefined ? {} : { approvalPolicy: this.options.approvalPolicy },
      ...this.options.env === undefined ? {} : { env: this.options.env },
      ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions as never },
      ...this.options.eventForwarder === undefined ? {} : { eventForwarder: this.options.eventForwarder },
      ...threadId === undefined ? {} : { threadId },
    })
    // The manager may have raced another attach for the same thread; the
    // store's 1:1 invariant is the final arbiter.
    this.store.bind(sessionId, attached.threadId)
    this.attached.set(sessionId, attached)
    return attached
  }

  /**
   * Detach a session: stop the gateway, drop the binding, and leave the
   * session cold so the host's ordinary resume path restores normal mode (Q1).
   */
  async detach(sessionId: SessionId): Promise<void> {
    const attached = this.attached.get(sessionId)
    if (attached === undefined) {
      throw new Error('gateway: session is not attached to Codex')
    }
    this.attached.delete(sessionId)
    await attached.detach()
    this.store.unbind(sessionId)
  }

  /** Attach count (diagnostics/UI). */
  get size(): number {
    return this.attached.size
  }

  /**
   * Restore bindings after a dsh restart: whenever the host publishes a fresh
   * agent for a bound session, replace it with a gateway resumed on the same
   * durable Codex thread (C3). Skips our own agents. Resume failures caused
   * by a still-held thread writer lock are retried with backoff.
   */
  installAutoReattach(): void {
    this.ctx.on('agent/created', ({ agent }) => {
      if (isGatewayAgent(agent)) return
      const sessionId = agent.session.id
      const binding = this.store.get(sessionId)
      if (binding === undefined) return
      void this.restore(sessionId, binding).catch((error: unknown) => {
        this.ctx.logger?.warn?.(`[gateway] auto-reattach failed for "${sessionId}": ${String(error)}`)
        if (isRetryableResumeError(error)) {
          this.scheduleReattachRetry(sessionId, binding)
        }
      })
    })
  }

  private async restore(sessionId: SessionId, binding: GatewayBinding): Promise<void> {
    const session = this.ctx.get('sessions')?.get(sessionId)
    if (session === undefined) {
      throw new Error(`gateway: session "${sessionId}" is not live; open it in the UI first`)
    }
    // Detach the just-published loop agent by swapping it out; the manager's
    // `attach` path would refuse because the binding already exists.
    const attached = await attachGateway(this.ctx, sessionId, {
      cwd: session.header.cwd ?? process.cwd(),
      ...this.options.argv === undefined ? {} : { argv: this.options.argv },
      ...this.options.model === undefined ? {} : { model: this.options.model },
      ...this.options.approvalPolicy === undefined ? {} : { approvalPolicy: this.options.approvalPolicy },
      ...this.options.env === undefined ? {} : { env: this.options.env },
      ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions as never },
      ...this.options.eventForwarder === undefined ? {} : { eventForwarder: this.options.eventForwarder },
      threadId: binding.codexThreadId,
    })
    this.attached.set(sessionId, attached)
  }

  /**
   * Schedule a backoff retry of a failed auto-reattach. At most one in-flight
   * retry per session; the retry drops itself when the binding or session goes
   * away meanwhile.
   */
  private scheduleReattachRetry(sessionId: SessionId, binding: GatewayBinding, attempt = 1): void {
    if (attempt > REATTACH_RETRY_MAX_ATTEMPTS || this.reattachRetries.has(sessionId)) return
    const delay = REATTACH_RETRY_BASE_MS * 2 ** (attempt - 1)
    const timer = setTimeout(() => {
      this.reattachRetries.delete(sessionId)
      void this.runReattachRetry(sessionId, binding, attempt)
    }, delay)
    timer.unref?.()
    this.reattachRetries.set(sessionId, { attempt, timer })
  }

  private async runReattachRetry(sessionId: SessionId, binding: GatewayBinding, attempt: number): Promise<void> {
    // The user may have detached/unbound or the session may have closed while
    // we were waiting; drop the retry in those cases.
    if (this.store.get(sessionId) === undefined || this.attached.has(sessionId)) return
    try {
      await this.restore(sessionId, binding)
      this.ctx.logger?.info?.(`[gateway] auto-reattach recovered for "${sessionId}" after retry ${attempt}`)
    } catch (error) {
      this.ctx.logger?.warn?.(`[gateway] auto-reattach retry ${attempt} failed for "${sessionId}": ${String(error)}`)
      if (isRetryableResumeError(error)) {
        this.scheduleReattachRetry(sessionId, binding, attempt + 1)
      }
    }
  }
}
