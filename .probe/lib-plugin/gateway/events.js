/**
 * Codex app-server notification stream → dsh session log (R1-A1).
 *
 * Every Codex turn/item/delta is projected onto the dsh session's append-only
 * log as **log-only** events (`turn/start`, `turn/end`, `step/start`,
 * `step/end`, `assistant/chunk`, `tool/call`). These types never carry a
 * `surfaceOp`, so they never enter the model-visible surface (A2): the dsh
 * host keeps building requests solely from the session's own messages, while
 * the session log preserves the full Codex intermediate transcript for UI,
 * tooling, and replay.
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
export const DEFAULT_EVENT_FORWARDER_OPTIONS = {
    enabled: true,
    appendFinalMessage: false,
};
function itemType(value) {
    if (value === 'reasoning' || value === 'agentMessage')
        return value;
    if (value === 'dynamicToolCall' || value === 'functionCall')
        return value;
    return undefined;
}
function readString(value, label) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/** Map a Codex turn status onto the dsh `TurnEndReason` vocabulary. */
function turnEndReason(status, error) {
    switch (status) {
        case 'interrupted':
            return { kind: 'aborted', reason: { kind: 'user' } };
        case 'failed': {
            const detail = asRecord(error);
            return {
                kind: 'error',
                error: {
                    message: typeof detail?.message === 'string' && detail.message.length > 0
                        ? detail.message
                        : 'codex turn failed',
                    code: 'UNKNOWN',
                },
            };
        }
        default:
            return { kind: 'completed' };
    }
}
/**
 * Project one app-server notification onto the bound dsh session log. Safe to
 * call for every observed notification; unrecognized methods are ignored.
 * Append failures (e.g. a disposed session) are swallowed so the gateway
 * stream never dies from a logging side effect.
 */
export class GatewayEventForwarder {
    session;
    options;
    /** dsh turn ordinal for the active Codex turn (1-based). */
    turn = 0;
    /** dsh step ordinal within the active turn (1; one step per Codex turn). */
    step = 0;
    activeTurnId;
    stepOpen = false;
    constructor(session, options = DEFAULT_EVENT_FORWARDER_OPTIONS) {
        this.session = session;
        this.options = options;
        // `Session.append` is a class method that reads instance state; keep the
        // reference bound so the projection never throws on a detached `this`.
        this.appendBound = session.append.bind(session);
    }
    appendBound;
    forward(notification) {
        if (!this.options.enabled)
            return;
        try {
            this.dispatch(notification);
        }
        catch (error) {
            // Logging must never break the gateway stream; report and continue.
            const message = error instanceof Error ? error.message : String(error);
            this.options.onError?.(`[gateway-events] dropped notification ${notification.method}: ${message}`);
        }
    }
    dispatch(notification) {
        switch (notification.method) {
            case 'turn/started':
                this.onTurnStarted(notification.params);
                break;
            case 'turn/completed':
                this.onTurnCompleted(notification.params);
                break;
            case 'item/started':
                this.onItemStarted(notification.params);
                break;
            case 'item/agentMessage/delta':
                this.onTextDelta(notification.params);
                break;
            case 'item/reasoning/textDelta':
                this.onReasoningDelta(notification.params);
                break;
            default:
                break;
        }
    }
    onTurnStarted(params) {
        const turn = asRecord(params.turn);
        const turnId = readString(turn?.id, 'turn id') ?? `codex-${this.turn + 1}`;
        // A new active turn begins; if the server reported a second start without
        // a completion (e.g. resume racing), close the stale projection first.
        if (this.activeTurnId !== undefined) {
            this.closeStep();
            this.append('turn/end', { turn: this.turn, reason: { kind: 'interrupted' } });
        }
        this.turn += 1;
        this.step = 1;
        this.activeTurnId = turnId;
        this.stepOpen = false;
        this.append('turn/start', { turn: this.turn });
        this.openStep();
    }
    onTurnCompleted(params) {
        if (this.activeTurnId === undefined)
            return;
        const turn = asRecord(params.turn);
        this.closeStep();
        this.append('turn/end', {
            turn: this.turn,
            reason: turnEndReason(turn?.status, turn?.error),
        });
        this.activeTurnId = undefined;
    }
    onItemStarted(params) {
        const item = asRecord(params.item);
        if (item === undefined || this.activeTurnId === undefined)
            return;
        const type = itemType(item.type);
        if (type === 'dynamicToolCall' || type === 'functionCall') {
            this.recordToolCall(item);
        }
    }
    onTextDelta(params) {
        const delta = readString(params.delta, 'delta');
        if (delta === undefined || this.activeTurnId === undefined)
            return;
        this.appendChunk({ type: 'text-delta', index: 0, text: delta });
    }
    onReasoningDelta(params) {
        const delta = readString(params.delta, 'delta');
        if (delta === undefined || this.activeTurnId === undefined)
            return;
        const index = typeof params.contentIndex === 'number' ? params.contentIndex : 0;
        this.appendChunk({ type: 'reasoning-delta', index, text: delta });
    }
    recordToolCall(item) {
        const rawCallId = readString(item.id, 'item id') ?? readString(item.callId, 'call id');
        if (rawCallId === undefined)
            return;
        const callId = rawCallId;
        const name = readString(item.tool, 'tool name') ?? readString(item.name, 'tool name') ?? 'unknown';
        const args = item.arguments;
        this.append('tool/call', {
            turn: this.turn,
            step: this.step,
            callId,
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        });
    }
    appendChunk(chunk) {
        this.append('assistant/chunk', {
            turn: this.turn,
            step: this.step,
            chunk,
        });
    }
    openStep() {
        if (this.stepOpen)
            return;
        this.stepOpen = true;
        this.append('step/start', { turn: this.turn, step: this.step });
    }
    closeStep() {
        if (!this.stepOpen)
            return;
        this.stepOpen = false;
        this.append('step/end', { turn: this.turn, step: this.step });
    }
    append(type, data) {
        // The six event types are log-only (never surface), so no SurfaceIntent
        // is required; the cast widens the generic append signature.
        void this.appendBound(type, data);
    }
}
