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
import { Inbox } from '@deepseek-ai/dsh-agent';
import { createScope } from '@deepseek-ai/dsh-scope';
import { GatewayAgent } from "./agent.js";
import { CodexGateway } from "./gateway.js";
import { GatewayImageResolver } from "./images.js";
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
export async function attachGateway(ctx, sessionId, options) {
    const session = ctx.sessions.get(sessionId);
    if (session === undefined) {
        throw new Error(`gateway: session "${sessionId}" is not live; open it in the UI first`);
    }
    const registry = ctx.agents;
    const existing = registry.get(sessionId);
    if (existing !== undefined && isGatewayAgent(existing)) {
        throw new Error(`gateway: session "${sessionId}" is already attached to Codex`);
    }
    const gateway = new CodexGateway({
        cwd: options.cwd,
        ...options.argv === undefined ? {} : { argv: options.argv },
        ...options.model === undefined ? {} : { model: options.model },
        ...options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy },
        ...options.env === undefined ? {} : { env: options.env },
    });
    let threadId;
    try {
        threadId = await gateway.start(options.threadId);
    }
    catch (error) {
        void gateway.dispose();
        throw error;
    }
    const imageResolver = new GatewayImageResolver(ctx);
    const agent = new GatewayAgent({
        id: sessionId,
        session,
        inbox: existing?.inbox ?? new Inbox(session, {
            inserted: () => { },
            discarded: () => { },
            claimed: () => { },
        }),
        ctx: undefined,
        options: options.agentOptions ?? {},
    }, gateway, {
        imageResolver,
        ...options.eventForwarder === undefined ? {} : { eventForwarder: options.eventForwarder },
        ...options.vision === undefined ? {} : { vision: options.vision },
    });
    const scope = createScope(ctx, agent);
    agent.bindCtx(scope.ctx.extend({ agent }));
    if (existing !== undefined) {
        // Park the superseded loop agent: clear its pending work and abort its
        // active turn. Its registry entry is retired through the store's own
        // disposal path (emitting `agent/disposed`); the factory's later teardown
        // no-ops on the already-consumed entry.
        existing.cancel({ kind: 'user' });
        detachAgentEntry(registry, sessionId);
    }
    const detachAgent = registry.enter(agent, undefined);
    registry.announce(agent);
    return {
        agent,
        gateway,
        threadId,
        detach: async () => {
            detachAgent();
            // The session entry was installed by the superseded loop creation and
            // stays live through the attachment (the UI keeps rendering it). Retire
            // it through the entry's own teardown so `session/disposed` fires: the
            // persistence coordinator releases its live-owner claim on that event,
            // which the host's ordinary resume path requires on the next prompt.
            detachSessionEntry(ctx.sessions, sessionId);
            await gateway.dispose();
            await imageResolver.dispose();
        },
    };
}
/** Whether an agent is one of ours (guards boot-time auto-reattach loops). */
export function isGatewayAgent(agent) {
    return agent instanceof GatewayAgent;
}
/** Retire one live agent entry through the registry's own disposal path. */
function detachAgentEntry(registry, id) {
    const store = registry.store;
    if (store === undefined)
        return;
    const entry = store.get(id);
    if (entry === undefined)
        return;
    const detachEntered = registry.detachEntered;
    if (detachEntered !== undefined) {
        // Cordis service tracing wraps registry methods; invoke through the
        // registry receiver so `this` stays bound to the registry instance.
        Reflect.apply(detachEntered, registry, [entry]);
    }
    else {
        store.delete(id);
    }
}
/** Retire one live session entry through the entry's own teardown. */
function detachSessionEntry(sessions, id) {
    const store = sessions.store;
    if (store === undefined)
        return;
    const entry = store.get(id);
    if (entry === undefined)
        return;
    entry.detach();
}
