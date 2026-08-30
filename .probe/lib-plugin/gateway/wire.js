/**
 * Gateway protocol adapter for `codex app-server --stdio`. Owns the product
 * methods only: framing and correlation live in the shared line transport.
 *
 * Unlike the one-shot wire (`src/wire.ts`), this adapter keeps a persistent
 * thread, enables the experimental API surface (queue/steer), and streams
 * every server notification to the gateway layer for replay and forwarding.
 *
 * @module dsh-subagent-codex-plus/gateway/wire
 */
import { JsonRpcLineTransport } from "./transport.js";
function object(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`gateway: app-server returned invalid ${label}`);
    }
    return value;
}
function string(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`gateway: app-server returned invalid ${label}`);
    }
    return value;
}
/**
 * One long-lived app-server connection. Request methods return narrow,
 * validated projections; every notification is captured for replay and
 * forwarded through {@link onNotification}.
 */
export class CodexGatewayWire {
    clientName;
    clientVersion;
    transport;
    captured = [];
    notificationHandler;
    constructor(input, output, clientName = 'dsh-subagent-codex-plus', clientVersion = '0.1.0') {
        this.clientName = clientName;
        this.clientVersion = clientVersion;
        this.transport = new JsonRpcLineTransport(input, output);
        this.transport.onNotification((method, params) => {
            const notification = {
                method,
                params: params,
            };
            this.captured.push(notification);
            this.notificationHandler?.(notification);
        });
        this.transport.onRequest((method) => {
            // Unattended gateway: refuse every server-initiated request. Approval
            // flows are never expected (`approvalPolicy: never`).
            throw new Error(`gateway: unsupported server request ${method}`);
        });
    }
    /** Begin reading app-server frames. */
    start() {
        this.transport.start();
    }
    /** Subscribe to forwarded notifications; only one listener at a time. */
    onNotification(handler) {
        this.notificationHandler = handler;
    }
    /** Replay every notification observed so far, oldest first. */
    replayNotifications() {
        return this.captured;
    }
    /** Drop the replay buffer. */
    clearReplay() {
        this.captured.length = 0;
    }
    /**
     * Complete the initialize/initialized handshake with the experimental API
     * enabled (required for `thread/queue/*` and `turn/steer`).
     */
    async initialize(signal) {
        object(await this.transport.request('initialize', {
            clientInfo: {
                name: this.clientName,
                title: 'DeepSeek Harness',
                version: this.clientVersion,
            },
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
            },
        }, signal), 'initialize response');
        this.transport.notify('initialized');
    }
    /** Create a new thread; `ephemeral: false` keeps it durable on disk. */
    async startThread(cwd, options = {}, signal) {
        const response = object(await this.transport.request('thread/start', {
            cwd,
            ephemeral: options.ephemeral ?? false,
            ...options.model === undefined ? {} : { model: options.model },
            ...options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy },
        }, signal), 'thread/start response');
        const thread = object(response.thread, 'thread/start thread');
        return string(thread.id, 'thread/start thread id');
    }
    /** Reconnect to a durable thread by id (restart recovery). */
    async resumeThread(threadId, signal) {
        const response = object(await this.transport.request('thread/resume', {
            threadId,
        }, signal), 'thread/resume response');
        const thread = object(response.thread, 'thread/resume thread');
        return string(thread.id, 'thread/resume thread id');
    }
    /** Start one turn immediately; returns the new turn id. */
    async startTurn(threadId, input, options = {}, signal) {
        const response = object(await this.transport.request('turn/start', {
            threadId,
            input: [...input],
            ...options.clientUserMessageId === undefined ? {} : { clientUserMessageId: options.clientUserMessageId },
            ...options.model === undefined ? {} : { model: options.model },
        }, signal), 'turn/start response');
        const turn = object(response.turn, 'turn/start turn');
        return string(turn.id, 'turn/start turn id');
    }
    /** Enqueue one submission behind the active turn; returns its queue id. */
    async queueAdd(threadId, input, clientUserMessageId, signal) {
        const response = object(await this.transport.request('thread/queue/add', {
            threadId,
            input: [...input],
            clientUserMessageId,
        }, signal), 'thread/queue/add response');
        const submission = object(response.queuedSubmission, 'thread/queue/add queuedSubmission');
        return string(submission.id, 'thread/queue/add queuedSubmission id');
    }
    /** List pending queued submissions, oldest first. */
    async queueList(threadId, signal) {
        const response = object(await this.transport.request('thread/queue/list', {
            threadId,
        }, signal), 'thread/queue/list response');
        const data = response.data;
        if (!Array.isArray(data)) {
            throw new Error('gateway: app-server returned invalid thread/queue/list data');
        }
        return data.map((entry) => {
            const item = object(entry, 'thread/queue/list entry');
            return {
                id: string(item.id, 'thread/queue/list entry id'),
                input: Array.isArray(item.input) ? item.input : [],
                clientUserMessageId: typeof item.clientUserMessageId === 'string'
                    ? item.clientUserMessageId
                    : '',
            };
        });
    }
    /** Replace the input of one queued submission. */
    async queueUpdate(threadId, queuedSubmissionId, input, signal) {
        object(await this.transport.request('thread/queue/update', {
            threadId,
            queuedSubmissionId,
            input: [...input],
        }, signal), 'thread/queue/update response');
    }
    /** Remove one queued submission. */
    async queueDelete(threadId, queuedSubmissionId, signal) {
        const response = object(await this.transport.request('thread/queue/delete', {
            threadId,
            queuedSubmissionId,
        }, signal), 'thread/queue/delete response');
        return response.deleted === true;
    }
    /** Reorder queued submissions; the array order is the new FIFO order. */
    async queueReorder(threadId, queuedSubmissionIds, signal) {
        object(await this.transport.request('thread/queue/reorder', {
            threadId,
            queuedSubmissionIds: [...queuedSubmissionIds],
        }, signal), 'thread/queue/reorder response');
    }
    /** Manually start the next queued submission; returns the new turn id. */
    async queueStart(threadId, queuedSubmissionId, signal) {
        const response = object(await this.transport.request('thread/queue/start', {
            threadId,
            ...queuedSubmissionId === undefined ? {} : { queuedSubmissionId },
        }, signal), 'thread/queue/start response');
        const turn = object(response.turn, 'thread/queue/start turn');
        return string(turn.id, 'thread/queue/start turn id');
    }
    /**
     * Redirect the active turn to new input. Returns the new turn id when the
     * server reports one; steer is side-effectful, so `undefined` still means
     * the redirect was accepted.
     */
    async steer(threadId, expectedTurnId, input, signal) {
        const response = object(await this.transport.request('turn/steer', {
            threadId,
            expectedTurnId,
            input: [...input],
        }, signal), 'turn/steer response');
        const turnId = response.turn_id ?? response.turnId;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : undefined;
    }
    /** Best-effort cancellation of the active turn. */
    interrupt(threadId, turnId) {
        void this.transport.request('turn/interrupt', {
            threadId,
            turnId,
        }).catch(() => { });
    }
    /** Detach listeners and reject outstanding requests. Idempotent. */
    close() {
        this.transport.close();
    }
}
