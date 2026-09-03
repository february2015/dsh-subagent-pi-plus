/**
 * Gateway session manager: orchestrates attach/detach for live dsh sessions,
 * enforces the persistent 1:1 binding (Q4), restores bindings across restarts
 * (C3), and restores normal mode on detach (Q1).
 *
 * @module dsh-subagent-pi/gateway/manager
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { attachGateway, isGatewayAgent, type AttachedGateway } from './attach.ts'
import { debugLog } from './debug.ts'
import type { GatewayEventForwarderOptions } from './events.ts'
import type { PiGatewayWatchdogOptions } from './gateway.ts'
import type { GatewayBinding } from './binding.ts'
import { GatewayBindingStore } from './binding.ts'

export interface GatewayManagerOptions {
  /** Directory holding Pi session files (`--session-dir`). */
  readonly sessionDir: string
  /** Optional native Pi model override (`--model <pattern>`). */
  readonly model?: string
  /** Extra environment for the Pi child. */
  readonly env?: Record<string, string>
  /** Per-agent model options carried on registered gateway agents. */
  readonly agentOptions?: Record<string, unknown>
  /** Pi → dsh session event forwarding policy (R1-A1/A2). */
  readonly eventForwarder?: GatewayEventForwarderOptions
  /** Streaming watchdog knobs for every attached gateway (absent = defaults). */
  readonly watchdog?: PiGatewayWatchdogOptions
}

/** Build the `pi --mode rpc` argv for one durable session. */
export function piRpcArgv(
  sessionDir: string,
  sessionId: string,
  model?: string,
): readonly string[] {
  return [
    'pi',
    '--mode', 'rpc',
    '--session-dir', sessionDir,
    '--session-id', sessionId,
    ...model === undefined ? [] : ['--model', model],
  ]
}

/** Owns one live attachment per session plus its durable binding. */
export class GatewayManager {
  private readonly attached = new Map<SessionId, AttachedGateway>()

  constructor(
    private readonly ctx: Context,
    readonly store: GatewayBindingStore,
    private readonly options: GatewayManagerOptions,
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
   * Attach a live session to a Pi session and record the durable binding.
   * @param sessionId - live session to take over.
   * @param piSessionId - optional existing Pi session to resume; absent creates one.
   * @returns the attachment.
   */
  async attach(sessionId: SessionId, piSessionId?: string): Promise<AttachedGateway> {
    const session = this.ctx.get('sessions')?.get(sessionId)
    if (session === undefined) {
      throw new Error(`gateway: session "${sessionId}" is not live; open it in the UI first`)
    }
    const cwd = session.header.cwd
    if (cwd === undefined) {
      throw new Error('gateway: session has no working directory; cannot start Pi')
    }
    // Q4: the session must not already be bound, and a requested Pi session
    // must not already be owned by another dsh session.
    if (this.store.get(sessionId) !== undefined) {
      throw new Error('gateway: this session is already bound to Pi (/pi-unlock to unbind)')
    }
    if (piSessionId !== undefined && this.store.sessionOwner(piSessionId) !== undefined) {
      throw new Error(`gateway: Pi session "${piSessionId}" is already bound to another dsh session`)
    }
    const targetSessionId = piSessionId ?? randomUUID()
    const argv = piRpcArgv(this.options.sessionDir, targetSessionId, this.options.model)
    const attached = await attachGateway(this.ctx, sessionId, {
      cwd,
      argv,
      ...this.options.env === undefined ? {} : { env: this.options.env },
      ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions as never },
      ...this.options.eventForwarder === undefined ? {} : { eventForwarder: this.options.eventForwarder },
      ...this.options.watchdog === undefined ? {} : { watchdog: this.options.watchdog },
    })
    // The manager may have raced another attach for the same Pi session; the
    // store's 1:1 invariant is the final arbiter.
    this.store.bind(sessionId, attached.threadId)
    this.attached.set(sessionId, attached)
    return attached
  }

  /**
   * Detach a session: stop the gateway, drop the binding, and leave the
   * session cold so the host's ordinary resume path restores normal mode (Q1).
   * Idempotent: a session whose binding survives a restart without a live
   * attachment (no agent was created yet) is still unbound cleanly.
   */
  async detach(sessionId: SessionId): Promise<void> {
    const attached = this.attached.get(sessionId)
    if (attached !== undefined) {
      this.attached.delete(sessionId)
      await attached.detach()
    }
    this.store.unbind(sessionId)
  }

  /** Attach count (diagnostics/UI). */
  get size(): number {
    return this.attached.size
  }

  /**
   * Restore bindings after a dsh restart: whenever the host publishes a fresh
   * agent for a bound session, replace it with a gateway resumed on the same
   * durable Pi session (C3). Skips our own agents.
   */
  installAutoReattach(): void {
    this.ctx.on('agent/created', ({ agent }) => {
      const sessionId = agent.session.id
      debugLog(`[auto-reattach] agent/created ${sessionId} gateway=${isGatewayAgent(agent)}`)
      if (isGatewayAgent(agent)) return
      const binding = this.store.get(sessionId)
      if (binding === undefined) return
      void this.restore(sessionId, binding).catch((error: unknown) => {
        this.ctx.logger?.warn?.(`[gateway] auto-reattach failed for "${sessionId}": ${String(error)}`)
        debugLog(`[auto-reattach] FAILED ${sessionId}: ${String(error)}`)
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
    const argv = piRpcArgv(this.options.sessionDir, binding.piSessionId, this.options.model)
    const attached = await attachGateway(this.ctx, sessionId, {
      cwd: session.header.cwd ?? process.cwd(),
      argv,
      ...this.options.env === undefined ? {} : { env: this.options.env },
      ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions as never },
      ...this.options.eventForwarder === undefined ? {} : { eventForwarder: this.options.eventForwarder },
      ...this.options.watchdog === undefined ? {} : { watchdog: this.options.watchdog },
    })
    this.attached.set(sessionId, attached)
  }
}
