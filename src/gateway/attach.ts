/**
 * Host wiring: attach/detach a live dsh session to one durable Codex thread.
 *
 * The generic prompt path (`session.prompt` → `agent.followup`/`steer`)
 * routes to whatever agent the registry holds for the session id. Replacing
 * that entry with a {@link GatewayAgent} therefore redirects the whole
 * conversation to Codex without any dsh host patch; removing it returns the
 * session to cold state, so the host's ordinary resume path rebuilds a
 * standard loop agent on the next prompt (Q1).
 *
 * Registry replacement uses the public `enter`/`announce` primitives for our
 * own entry and removes the superseded entries from the registries' stores:
 * the loop factory never exposes the old entry's detach capability, and the
 * stores explicitly reject same-id replacement. The superseded loop agent is
 * cancelled (parked); its factory-owned teardown later finds its detach
 * already consumed and no-ops safely.
 *
 * @module dsh-subagent-codex-plus/gateway/attach
 */

import type { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { GatewayAgent } from './agent.ts'
import type { GatewayEventForwarderOptions } from './events.ts'
import { CodexGateway, type CodexGatewayOptions } from './gateway.ts'

import { GatewayImageResolver } from './images.ts'

/** A live session↔Codex attachment. */
export interface AttachedGateway {
  /** The registered gateway agent (now the session's routing target). */
  readonly agent: GatewayAgent
  /** The underlying app-server/thread gateway. */
  readonly gateway: CodexGateway
  /** Durable Codex thread id. */
  readonly threadId: string
  /** Detach: unregister, restore the session to cold state, stop the child. */
  detach(): Promise<void>
}

export interface AttachGatewayOptions {
  /** Working directory for the app-server child and thread. */
  readonly cwd: string
  /** App-server argv (defaults to the package-local codex bin). */
  readonly argv?: readonly string[]
  /** Resume an existing durable thread instead of creating one. */
  readonly threadId?: string
  /** Optional per-thread model override. */
  readonly model?: string
  /** Optional approval policy for gateway turns. */
  readonly approvalPolicy?: string
  /** Extra environment for the app-server child. */
  readonly env?: Record<string, string>
  /** Per-agent model options carried on the registered agent. */
  readonly agentOptions?: AgentOptions
  /** Codex → dsh session event forwarding policy (R1-A1/A2). */
  readonly eventForwarder?: GatewayEventForwarderOptions
}

/** Narrow structural view of the registries' private stores. */
interface AgentStoreEntry {
  readonly agent: Agent
}
interface SessionStoreEntry {
  readonly session: unknown
  /** The entry's own teardown: removes it and emits the paired disposal. */
  readonly detach: () => void
}

/**
 * Attach a session to a Codex thread: start (or resume) the gateway, build a
 * scoped GatewayAgent, and swap it into the registries in place of the
 * session's live loop agent.
 * @param ctx - host context carrying `agents`/`sessions`.
 * @param sessionId - the live session to take over.
 * @param options - gateway and agent configuration.
 * @returns the attachment; call `detach()` to restore normal mode.
 * @throws when the session is not live, is already attached, or the swap fails.
 */
export async function attachGateway(
  ctx: Context,
  sessionId: SessionId,
  options: AttachGatewayOptions,
): Promise<AttachedGateway> {
  const session = ctx.get('sessions')?.get(sessionId)
  if (session === undefined) {
    throw new Error(`gateway: session "${sessionId}" is not live; open it in the UI first`)
  }
  const registry = ctx.get('agents')
  if (registry === undefined) {
    throw new Error('gateway: agents service is not available')
  }
  const existing = registry.get(sessionId)
  if (existing !== undefined && isGatewayAgent(existing)) {
    throw new Error(`gateway: session "${sessionId}" is already attached to Codex`)
  }

  const gateway = new CodexGateway({
    cwd: options.cwd,
    ...options.argv === undefined ? {} : { argv: options.argv },
    ...options.model === undefined ? {} : { model: options.model },
    ...options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy },
    ...options.env === undefined ? {} : { env: options.env },
  })
  let threadId: string
  try {
    threadId = await gateway.start(options.threadId)
  } catch (error) {
    void gateway.dispose()
    throw error
  }

  const imageResolver = new GatewayImageResolver(ctx)
  const agent = new GatewayAgent({
    id: sessionId,
    session,
    inbox: existing?.inbox ?? new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    }),
    ctx: undefined,
    options: options.agentOptions ?? {},
  }, gateway, {
    imageResolver,
    ...options.eventForwarder === undefined ? {} : { eventForwarder: options.eventForwarder },
  })
  const scope = createScope(ctx, agent)
  agent.bindCtx(scope.ctx.extend({ agent }))

  if (existing !== undefined) {
    // Park the superseded loop agent: clear its pending work and abort its
    // active turn. Its registry entry is retired through the store's own
    // disposal path (emitting `agent/disposed`); the factory's later teardown
    // no-ops on the already-consumed entry.
    existing.cancel({ kind: 'user' })
    detachAgentEntry(registry, sessionId)
  }
  const detachAgent = registry.enter(agent, undefined)
  registry.announce(agent)

  return {
    agent,
    gateway,
    threadId,
    detach: async () => {
      detachAgent()
      // The session entry was installed by the superseded loop creation and
      // stays live through the attachment (the UI keeps rendering it). Retire
      // it through the entry's own teardown so `session/disposed` fires: the
      // persistence coordinator releases its live-owner claim on that event,
      // which the host's ordinary resume path requires on the next prompt.
      detachSessionEntry(ctx.get('sessions'), sessionId)
      await gateway.dispose()
      await imageResolver.dispose()
    },
  }
}

/** Whether an agent is one of ours (guards boot-time auto-reattach loops). */
export function isGatewayAgent(agent: Agent): agent is GatewayAgent {
  return agent instanceof GatewayAgent
}

/** Retire one live agent entry through the registry's own disposal path. */
function detachAgentEntry(registry: unknown, id: SessionId): void {
  const store = (registry as { store?: Map<SessionId, AgentStoreEntry> }).store
  if (store === undefined) return
  const entry = store.get(id)
  if (entry === undefined) return
  const detachEntered = (registry as {
    detachEntered?: (entry: AgentStoreEntry) => void
  }).detachEntered
  if (detachEntered !== undefined) {
    // Cordis service tracing wraps registry methods; invoke through the
    // registry receiver so `this` stays bound to the registry instance.
    Reflect.apply(detachEntered, registry, [entry])
  } else {
    store.delete(id)
  }
}

/** Retire one live session entry through the entry's own teardown. */
function detachSessionEntry(sessions: unknown, id: SessionId): void {
  const store = (sessions as { store?: Map<SessionId, SessionStoreEntry> }).store
  if (store === undefined) return
  const entry = store.get(id)
  if (entry === undefined) return
  entry.detach()
}
