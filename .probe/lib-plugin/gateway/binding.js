/**
 * Persistent 1:1 binding between one dsh session and one durable Codex
 * thread (C3/Q4). Single local JSON file, atomic replace on write; survives
 * dsh restarts so a bound session reconnects to the same Codex thread.
 *
 * Invariants enforced here:
 * - one dsh session binds at most one Codex thread (Q4 first half);
 * - one Codex thread is owned by at most one dsh session (Q4 second half).
 *
 * @module dsh-subagent-codex-plus/gateway/binding
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const CURRENT_VERSION = 1;
function emptyState() {
    return { version: CURRENT_VERSION, bindings: {} };
}
/**
 * File-backed binding store. Reads once at construction and writes
 * atomically (temp file + rename) on every mutation.
 */
export class GatewayBindingStore {
    file;
    state;
    constructor(file) {
        this.file = file;
        this.state = this.load();
    }
    /** Resolve one session's binding, if any. */
    get(sessionId) {
        return this.state.bindings[sessionId];
    }
    /** Which dsh session owns the given Codex thread, if any. */
    threadOwner(codexThreadId) {
        for (const [sessionId, binding] of Object.entries(this.state.bindings)) {
            if (binding.codexThreadId === codexThreadId)
                return sessionId;
        }
        return undefined;
    }
    /** Snapshot of every live binding, session-id order stable by key. */
    list() {
        return Object.entries(this.state.bindings);
    }
    /**
     * Bind one session to one thread. Refuses both halves of the 1:1
     * invariant: a session already bound, or a thread already owned by
     * another session.
     * @returns the recorded binding.
     */
    bind(sessionId, codexThreadId) {
        const existing = this.state.bindings[sessionId];
        if (existing !== undefined) {
            throw new Error(`gateway: session "${sessionId}" is already bound to Codex thread "${existing.codexThreadId}"`);
        }
        const owner = this.threadOwner(codexThreadId);
        if (owner !== undefined) {
            throw new Error(`gateway: Codex thread "${codexThreadId}" is already bound to dsh session "${owner}"`);
        }
        const binding = {
            codexThreadId,
            boundAt: Date.now(),
        };
        this.state = {
            ...this.state,
            bindings: {
                ...this.state.bindings,
                [sessionId]: binding,
            },
        };
        this.save();
        return binding;
    }
    /** Remove one session's binding. Idempotent. */
    unbind(sessionId) {
        if (this.state.bindings[sessionId] === undefined)
            return false;
        const bindings = { ...this.state.bindings };
        delete bindings[sessionId];
        this.state = { ...this.state, bindings };
        this.save();
        return true;
    }
    /** Raw file path (diagnostics). */
    get filePath() {
        return this.file;
    }
    load() {
        try {
            const raw = readFileSync(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed === null
                || typeof parsed !== 'object'
                || parsed.version !== CURRENT_VERSION
                || typeof parsed.bindings !== 'object'
                || parsed.bindings === null) {
                return emptyState();
            }
            return parsed;
        }
        catch {
            // Missing or unreadable file: start clean. Corrupt JSON must not
            // prevent the gateway from coming up; the user can re-attach.
            return emptyState();
        }
    }
    save() {
        mkdirSync(dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
        renameSync(temp, this.file);
    }
}
