/**
 * Gateway session manager: orchestrates attach/detach for live dsh sessions,
 * enforces the persistent 1:1 binding (Q4), restores bindings across restarts
 * (C3), and restores normal mode on detach (Q1).
 *
 * @module dsh-subagent-codex-plus/gateway/manager
 */
import { attachGateway, isGatewayAgent } from "./attach.js";
import { GatewayBindingStore } from "./binding.js";
/** Owns one live attachment per session plus its durable binding. */
export class GatewayManager {
    ctx;
    store;
    options;
    attached = new Map();
    constructor(ctx, store, options = {}) {
        this.ctx = ctx;
        this.store = store;
        this.options = options;
    }
    /** Whether a session is currently attached (live gateway). */
    isAttached(sessionId) {
        return this.attached.has(sessionId);
    }
    /** The live attachment for a session, if any. */
    get(sessionId) {
        return this.attached.get(sessionId);
    }
    /**
     * Attach a live session to a Codex thread and record the durable binding.
     * @param sessionId - live session to take over.
     * @param threadId - optional existing Codex thread to resume; absent creates one.
     * @returns the attachment.
     */
    async attach(sessionId, threadId) {
        const session = this.ctx.sessions.get(sessionId);
        if (session === undefined) {
            throw new Error(`gateway: session "${sessionId}" is not live; open it in the UI first`);
        }
        const cwd = session.header.cwd;
        if (cwd === undefined) {
            throw new Error('gateway: session has no working directory; cannot start Codex');
        }
        // Q4: the session must not already be bound, and a requested thread must
        // not already be owned by another session.
        if (this.store.get(sessionId) !== undefined) {
            throw new Error('gateway: this session is already bound to Codex (/codex-unlock to unbind)');
        }
        if (threadId !== undefined && this.store.threadOwner(threadId) !== undefined) {
            throw new Error(`gateway: Codex thread "${threadId}" is already bound to another dsh session`);
        }
        const attached = await attachGateway(this.ctx, sessionId, {
            cwd,
            ...this.options.argv === undefined ? {} : { argv: this.options.argv },
            ...this.options.model === undefined ? {} : { model: this.options.model },
            ...this.options.approvalPolicy === undefined ? {} : { approvalPolicy: this.options.approvalPolicy },
            ...this.options.env === undefined ? {} : { env: this.options.env },
            ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions },
            ...this.options.eventForwarder === undefined ? {} : { eventForwarder: this.options.eventForwarder },
            ...this.options.vision === undefined ? {} : { vision: this.options.vision },
            ...threadId === undefined ? {} : { threadId },
        });
        // The manager may have raced another attach for the same thread; the
        // store's 1:1 invariant is the final arbiter.
        this.store.bind(sessionId, attached.threadId);
        this.attached.set(sessionId, attached);
        return attached;
    }
    /**
     * Detach a session: stop the gateway, drop the binding, and leave the
     * session cold so the host's ordinary resume path restores normal mode (Q1).
     */
    async detach(sessionId) {
        const attached = this.attached.get(sessionId);
        if (attached === undefined) {
            throw new Error('gateway: session is not attached to Codex');
        }
        this.attached.delete(sessionId);
        await attached.detach();
        this.store.unbind(sessionId);
    }
    /** Attach count (diagnostics/UI). */
    get size() {
        return this.attached.size;
    }
    /**
     * Restore bindings after a dsh restart: whenever the host publishes a fresh
     * agent for a bound session, replace it with a gateway resumed on the same
     * durable Codex thread (C3). Skips our own agents.
     */
    installAutoReattach() {
        this.ctx.on('agent/created', ({ agent }) => {
            if (isGatewayAgent(agent))
                return;
            const binding = this.store.get(agent.session.id);
            if (binding === undefined)
                return;
            void this.restore(agent, binding).catch((error) => {
                this.ctx.logger?.warn?.(`[gateway] auto-reattach failed for "${agent.session.id}": ${String(error)}`);
            });
        });
    }
    async restore(agent, binding) {
        // Detach the just-published loop agent by swapping it out; the manager's
        // `attach` path would refuse because the binding already exists.
        const sessionId = agent.session.id;
        const attached = await attachGateway(this.ctx, sessionId, {
            cwd: agent.session.header.cwd ?? process.cwd(),
            ...this.options.argv === undefined ? {} : { argv: this.options.argv },
            ...this.options.model === undefined ? {} : { model: this.options.model },
            ...this.options.approvalPolicy === undefined ? {} : { approvalPolicy: this.options.approvalPolicy },
            ...this.options.env === undefined ? {} : { env: this.options.env },
            ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions },
            ...this.options.eventForwarder === undefined ? {} : { eventForwarder: this.options.eventForwarder },
            ...this.options.vision === undefined ? {} : { vision: this.options.vision },
            threadId: binding.codexThreadId,
        });
        this.attached.set(sessionId, attached);
    }
}
