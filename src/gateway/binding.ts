/**
 * Persistent 1:1 binding between one dsh session and one durable Pi session
 * (C3/Q4). Single local JSON file, atomic replace on write; survives dsh
 * restarts so a bound session reconnects to the same Pi session.
 *
 * Invariants enforced here:
 * - one dsh session binds at most one Pi session (Q4 first half);
 * - one Pi session is owned by at most one dsh session (Q4 second half).
 *
 * @module dsh-subagent-pi-plus/gateway/binding
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One durable session↔Pi-session binding. */
export interface GatewayBinding {
  /** Durable Pi session id (`--session-id` resume target). */
  readonly piSessionId: string
  /** Unix ms when the binding was established. */
  readonly boundAt: number
}

export interface GatewayBindingState {
  readonly version: 1
  /** dsh session id → binding. */
  readonly bindings: Record<string, GatewayBinding>
}

const CURRENT_VERSION = 1 as const

function emptyState(): GatewayBindingState {
  return { version: CURRENT_VERSION, bindings: {} }
}

/**
 * File-backed binding store. Reads once at construction and writes
 * atomically (temp file + rename) on every mutation.
 */
export class GatewayBindingStore {
  private state: GatewayBindingState

  constructor(private readonly file: string) {
    this.state = this.load()
  }

  /** Resolve one session's binding, if any. */
  get(sessionId: string): GatewayBinding | undefined {
    return this.state.bindings[sessionId]
  }

  /** Which dsh session owns the given Pi session, if any. */
  sessionOwner(piSessionId: string): string | undefined {
    for (const [sessionId, binding] of Object.entries(this.state.bindings)) {
      if (binding.piSessionId === piSessionId) return sessionId
    }
    return undefined
  }

  /** Snapshot of every live binding, session-id order stable by key. */
  list(): readonly (readonly [string, GatewayBinding])[] {
    return Object.entries(this.state.bindings)
  }

  /**
   * Bind one session to one Pi session. Refuses both halves of the 1:1
   * invariant: a session already bound, or a Pi session already owned by
   * another dsh session.
   * @returns the recorded binding.
   */
  bind(sessionId: string, piSessionId: string): GatewayBinding {
    const existing = this.state.bindings[sessionId]
    if (existing !== undefined) {
      throw new Error(`gateway: session "${sessionId}" is already bound to Pi session "${existing.piSessionId}"`)
    }
    const owner = this.sessionOwner(piSessionId)
    if (owner !== undefined) {
      throw new Error(`gateway: Pi session "${piSessionId}" is already bound to dsh session "${owner}"`)
    }
    const binding: GatewayBinding = {
      piSessionId,
      boundAt: Date.now(),
    }
    this.state = {
      ...this.state,
      bindings: {
        ...this.state.bindings,
        [sessionId]: binding,
      },
    }
    this.save()
    return binding
  }

  /** Remove one session's binding. Idempotent. */
  unbind(sessionId: string): boolean {
    if (this.state.bindings[sessionId] === undefined) return false
    const bindings = { ...this.state.bindings }
    delete bindings[sessionId]
    this.state = { ...this.state, bindings }
    this.save()
    return true
  }

  /** Raw file path (diagnostics). */
  get filePath(): string {
    return this.file
  }

  private load(): GatewayBindingState {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as GatewayBindingState
      if (
        parsed === null
        || typeof parsed !== 'object'
        || parsed.version !== CURRENT_VERSION
        || typeof parsed.bindings !== 'object'
        || parsed.bindings === null
      ) {
        return emptyState()
      }
      return parsed
    } catch {
      // Missing or unreadable file: start clean. Corrupt JSON must not
      // prevent the gateway from coming up; the user can re-attach.
      return emptyState()
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    renameSync(temp, this.file)
  }
}
