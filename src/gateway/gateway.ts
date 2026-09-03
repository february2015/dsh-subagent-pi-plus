/**
 * Long-lived Pi gateway: one `pi --mode rpc` child, one durable session,
 * and the message verbs the dsh agent layer forwards through. Queueing is
 * held locally on the dsh side (Pi's internal followUp/steering queues are
 * plain text arrays with no per-item ids, so they cannot be edited or
 * reordered); steering is delegated to Pi's own `steer` command so an
 * inserted message runs ahead of the follow-up queue on the next turn.
 *
 * The gateway is runtime-agnostic (no dsh imports): it exposes raw events
 * and a running/idle projection so the dsh-facing adapter decides how to
 * render and route them.
 *
 * @module dsh-subagent-pi/gateway/gateway
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { debugLog } from './debug.ts'
import {
  PiRpcWire,
  type PiCommandResponse,
  type PiEvent,
} from './pi-wire.ts'
import type {
  GatewayImageInput,
  GatewayLocalImageInput,
  GatewayTextInput,
  GatewayUserInput,
} from './wire.ts'

/** Process/session lifecycle phase of one gateway. */
export type PiGatewayPhase = 'stopped' | 'starting' | 'ready' | 'failed'

/** Whether Pi currently has an active agent run. */
export type PiGatewayTurnState = 'idle' | 'running'

/**
 * Streaming watchdog knobs (defaults tuned for a single long turn).
 *
 * A Pi run exposes no wall-clock limit of its own: a degenerate model loop
 * keeps streaming `message_update` events forever, so neither the dsh turn
 * nor the gateway's `running` projection ever settles — the run looks
 * "stuck running / cannot be stopped". The watchdog aborts such runs and,
 * if Pi still fails to settle afterwards, force-closes the turn locally so
 * every status surface (pi-plus window, dingo cards) unsticks.
 */
export interface PiGatewayWatchdogOptions {
  /** Abort when a running turn emits no event for this long (ms). Default 5 min. */
  readonly idleMs?: number
  /** Abort a single turn that keeps streaming past this wall-clock duration (ms). Default 20 min. */
  readonly maxTurnMs?: number
  /** After a watchdog abort, force-settle the turn if Pi still hasn't settled within this grace (ms). Default 60 s. */
  readonly abortGraceMs?: number
}

const DEFAULT_WATCHDOG_IDLE_MS = 5 * 60_000
const DEFAULT_WATCHDOG_MAX_TURN_MS = 20 * 60_000
const DEFAULT_WATCHDOG_ABORT_GRACE_MS = 60_000
/** Watchdog check cadence. */
const WATCHDOG_TICK_MS = 5_000

export interface PiGatewayOptions {
  /** Working directory for the Pi child and its session. */
  readonly cwd: string
  /**
   * Pi argv; defaults to `pi --mode rpc`. The manager supplies the
   * session-dir/session-id pair so bindings survive restarts.
   */
  readonly argv?: readonly string[]
  /** Extra environment layered over the inherited environment. */
  readonly env?: Record<string, string>
  /** Diagnostic sink for child stderr lines. */
  readonly onStderr?: (line: string) => void
  /** Streaming watchdog; absent = built-in defaults. */
  readonly watchdog?: PiGatewayWatchdogOptions
}

export interface SubmitOutcome {
  readonly kind: 'turn' | 'queued'
  readonly id: string
}

/** One locally-held queued message (managed on the dsh side). */
export interface PiQueuedItem {
  readonly id: string
  /** Message text; mutable for queue editing. */
  text: string
}

interface GatewayEvents {
  notification: [event: PiEvent]
  phase: [phase: PiGatewayPhase]
  turn: [state: PiGatewayTurnState]
  error: [error: Error]
}

export interface PiGateway {
  on<K extends keyof GatewayEvents>(event: K, listener: (...args: GatewayEvents[K]) => void): this
  emit<K extends keyof GatewayEvents>(event: K, ...args: GatewayEvents[K]): boolean
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Convert a localImage input block to Pi's base64 `image` content block. */
function toPiImageBlock(input: GatewayLocalImageInput): Record<string, unknown> {
  const data = readFileSync(input.path).toString('base64')
  const mimeType = MIME_BY_EXT[extname(input.path).toLowerCase()] ?? 'image/png'
  return { type: 'image', data, mimeType }
}

/** Serialize one gateway input list to Pi `ImageContent[]` (empty for text-only). */
function piImages(inputs: readonly GatewayUserInput[]): Record<string, unknown>[] {
  const images: Record<string, unknown>[] = []
  for (const block of inputs) {
    if (block.type === 'localImage') images.push(toPiImageBlock(block))
    else if (block.type === 'image') {
      images.push({ type: 'image', data: Buffer.from(block.url).toString('base64'), mimeType: 'image/png' })
    }
  }
  return images
}

/** Join the text blocks of one input list for a Pi command message. */
function textOf(inputs: readonly GatewayUserInput[]): string {
  return inputs
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * One durable Pi session driven by a dedicated RPC child. Submit routes to
 * the local queue while a run is active; drainPending releases queued
 * messages one at a time when Pi settles.
 */
export class PiGateway extends EventEmitter {
  private readonly cwd: string
  private readonly argv: readonly string[]
  private readonly env?: Record<string, string>
  private readonly onStderr?: (line: string) => void

  private child: ChildProcess | undefined
  private wire: PiRpcWire | undefined
  private phaseValue: PiGatewayPhase = 'stopped'
  private turnStateValue: PiGatewayTurnState = 'idle'
  private sessionIdValue: string | undefined
  private exitPromise: Promise<number | null> | undefined
  private readonly queued: PiQueuedItem[] = []
  private readonly watchdog?: PiGatewayWatchdogOptions
  /** Wall-clock start of the current run (reset on settle). */
  private runningSince: number | undefined
  /** Last moment any Pi event was observed (idle watchdog). */
  private lastEventAt = 0
  /** A watchdog/exited run was force-closed locally; swallow Pi's own turn_end. */
  private forceSettled = false
  private watchdogTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: PiGatewayOptions) {
    super()
    this.cwd = options.cwd
    this.argv = options.argv ?? ['pi', '--mode', 'rpc']
    this.env = options.env
    this.onStderr = options.onStderr
    this.watchdog = options.watchdog
  }

  /** Current lifecycle phase. */
  get phase(): PiGatewayPhase {
    return this.phaseValue
  }

  /** Active-run projection, kept in sync with Pi events. */
  get turnState(): PiGatewayTurnState {
    return this.turnStateValue
  }

  /** Durable Pi session id once started. */
  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  /** Pending locally-held queue (FIFO order). */
  get queue(): readonly PiQueuedItem[] {
    return [...this.queued]
  }

  /**
   * Start the Pi RPC child. The argv already carries the session id, so an
   * existing session resumes and a fresh id creates one.
   */
  async start(): Promise<string> {
    if (this.phaseValue !== 'stopped') {
      throw new Error(`pi gateway: cannot start from phase ${this.phaseValue}`)
    }
    this.setPhase('starting')
    try {
      const child = spawn(this.argv[0], this.argv.slice(1), {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      this.exitPromise = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code))
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.length > 0) {
            this.onStderr?.(line)
            debugLog(`[pi-stderr] ${line}`)
          }
        }
      })
      child.on('error', (error) => this.fail(error))
      // Diagnose unexpected exits: an RPC child must stay alive between
      // commands. Surface the exit facts through the diagnostic sink so a
      // vanished child is explainable without a debugger.
      child.on('exit', (code, signal) => {
        const line = `[pi-gateway] child exited code=${code} signal=${signal}\n`
        this.onStderr?.(`[pi-gateway] child exited code=${code} signal=${signal}`)
        debugLog(line)
        // A dead child can never settle a running turn; close it locally as
        // aborted so the dsh session turn and every status card unstick
        // instead of staying "running" forever.
        if (this.turnStateValue === 'running') {
          this.forceCloseTurn('pi 子进程意外退出，已中止当前轮次')
        }
      })

      const stdout = child.stdout
      const stdin = child.stdin
      if (stdout === null || stdin === null) {
        throw new Error('pi gateway: RPC child did not expose stdio pipes')
      }
      const wire = new PiRpcWire(stdout, stdin)
      this.wire = wire
      wire.onEvent((event) => this.handleEvent(event))
      wire.start()

      const sessionId = sessionIdOfArgv(this.argv)
      if (sessionId === undefined) {
        throw new Error('pi gateway: argv must include --session-id')
      }
      this.sessionIdValue = sessionId
      this.setPhase('ready')
      this.startWatchdog()
      return sessionId
    } catch (error) {
      this.setPhase('failed')
      throw error
    }
  }

  /**
   * Submit user input: starts a prompt when idle, holds it in the local
   * queue behind an active run (released on settle, in order).
   * @param input - text/image input blocks.
   * @param clientUserMessageId - stable caller-supplied identity for the submission.
   */
  async submit(
    input: readonly GatewayUserInput[],
    clientUserMessageId = `pi-${Date.now()}`,
  ): Promise<SubmitOutcome> {
    const text = textOf(input)
    if (text.trim().length === 0) {
      throw new Error('pi gateway: user message carried no text')
    }
    if (this.turnState === 'running') {
      this.queued.push({ id: clientUserMessageId, text })
      this.emit('notification', { type: 'local_queue_update', queued: this.queued.length })
      return { kind: 'queued', id: clientUserMessageId }
    }
    const images = piImages(input)
    await this.wireAsReady().command({
      type: 'prompt',
      message: text,
      streamingBehavior: 'followUp',
      ...images.length === 0 ? {} : { images },
    })
    // A fresh user-initiated run starts a new turn: a previous watchdog
    // force-settle must not swallow the events of this one.
    this.forceSettled = false
    this.setTurnState('running')
    return { kind: 'turn', id: clientUserMessageId }
  }

  /**
   * Redirect into the active run: while running, Pi's `steer` runs the
   * message ahead of the follow-up queue on the next turn; when idle a fresh
   * prompt starts instead.
   */
  async steer(input: readonly GatewayUserInput[]): Promise<string | undefined> {
    const text = textOf(input)
    if (text.trim().length === 0) {
      throw new Error('pi gateway: steer carried no text')
    }
    const images = piImages(input)
    if (this.turnState === 'running') {
      await this.wireAsReady().command({
        type: 'steer',
        message: text,
        ...images.length === 0 ? {} : { images },
      })
      return undefined
    }
    await this.wireAsReady().command({
      type: 'prompt',
      message: text,
      streamingBehavior: 'followUp',
      ...images.length === 0 ? {} : { images },
    })
    this.forceSettled = false
    this.setTurnState('running')
    return text
  }

  /** Best-effort abort of the active run (keeps the session/process alive). */
  cancel(): void {
    if (this.phaseValue !== 'ready') return
    void this.wireAsReady().command({ type: 'abort' }).catch(() => {})
  }

  /** Pending locally-held queue (FIFO order). */
  async pendingQueue(): Promise<readonly PiQueuedItem[]> {
    return this.queued
  }

  /** Remove one locally-held queued message. */
  async dequeue(id: string): Promise<boolean> {
    const index = this.queued.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.queued.splice(index, 1)
    this.emit('notification', { type: 'local_queue_update', queued: this.queued.length })
    return true
  }

  /** Reorder locally-held queued messages (array order = new FIFO order). */
  async requeue(ids: readonly string[]): Promise<void> {
    const byId = new Map(this.queued.map((item) => [item.id, item]))
    const next: PiQueuedItem[] = []
    for (const id of ids) {
      const item = byId.get(id)
      if (item === undefined) {
        throw new Error(`pi gateway: unknown queued message "${id}"`)
      }
      next.push(item)
    }
    if (next.length !== this.queued.length) {
      throw new Error('pi gateway: reorder list must cover every queued message')
    }
    this.queued.length = 0
    this.queued.push(...next)
    this.emit('notification', { type: 'local_queue_update', queued: this.queued.length })
  }

  /** Replace the text of one locally-held queued message. */
  async updateQueue(id: string, text: string): Promise<void> {
    const item = this.queued.find((entry) => entry.id === id)
    if (item === undefined) {
      throw new Error(`pi gateway: unknown queued message "${id}"`)
    }
    if (text.trim().length === 0) {
      throw new Error('pi gateway: queue text is empty')
    }
    item.text = text
    this.emit('notification', { type: 'local_queue_update', queued: this.queued.length })
  }

  /**
   * Release the next locally-held queued message once Pi is idle. Called on
   * `agent_settled`; a single release keeps the wire sequential and the rest
   * of the queue flows turn by turn.
   */
  drainPending(): void {
    if (this.turnState !== 'idle' || this.queued.length === 0) return
    const next = this.queued.shift()
    if (next === undefined) return
    void this.wireAsReady().command({
      type: 'prompt',
      message: next.text,
      streamingBehavior: 'followUp',
    }).then(() => {
      this.forceSettled = false
      this.setTurnState('running')
      this.emit('notification', { type: 'local_queue_update', queued: this.queued.length })
    }).catch((error: unknown) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    })
  }

  /**
   * Close the wire and terminate the child process tree. Idempotent; safe to
   * call from any phase.
   */
  async dispose(): Promise<void> {
    this.stopWatchdog()
    const child = this.child
    const wire = this.wire
    this.child = undefined
    this.wire = undefined
    if (wire !== undefined) wire.close()
    if (child === undefined || child.pid === undefined) return
    const exit = this.exitPromise ?? Promise.resolve(null)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
    await Promise.race([
      exit,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    this.setPhase('stopped')
  }

  private handleEvent(event: PiEvent): void {
    this.lastEventAt = Date.now()
    switch (event.type) {
      case 'turn_start':
        // A real Pi turn invalidates any earlier watchdog force-settle.
        this.forceSettled = false
        this.runningSince ??= Date.now()
        this.setTurnState('running')
        break
      case 'agent_settled':
        this.runningSince = undefined
        this.setTurnState('idle')
        // Pi drains its own steering/follow-up queues before settling, so
        // `agent_settled` is the one moment this gateway owns the wire.
        this.drainPending()
        break
      case 'turn_end':
        // The turn was force-closed locally (watchdog abort grace elapsed or
        // the child died); Pi's own turn_end would duplicate the durable end.
        if (this.forceSettled) return
        break
      default:
        break
    }
    this.emit('notification', event)
  }

  private fail(error: Error): void {
    this.setPhase('failed')
    this.emit('error', error)
  }

  /**
   * Streaming watchdog: bounds one run so a degenerate model loop cannot hold
   * the gateway "running" (and every status surface) indefinitely. Checks run
   * only while a turn is active.
   */
  private startWatchdog(): void {
    this.stopWatchdog()
    const timer = setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS)
    timer.unref?.()
    this.watchdogTimer = timer
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = undefined
    }
  }

  private watchdogTick(): void {
    if (this.phaseValue !== 'ready' || this.turnStateValue !== 'running') return
    const now = Date.now()
    const idleMs = this.watchdog?.idleMs ?? DEFAULT_WATCHDOG_IDLE_MS
    const maxTurnMs = this.watchdog?.maxTurnMs ?? DEFAULT_WATCHDOG_MAX_TURN_MS
    // No events at all while running → the run hung (upstream stall, wire loss).
    if (this.lastEventAt > 0 && now - this.lastEventAt > idleMs) {
      this.watchdogAbort('Pi 长时间无输出，已自动中止当前轮次')
      return
    }
    // Continuous streaming past the per-turn cap → degenerate loop (the
    // "keeps going forever" case with constant output).
    if (this.runningSince !== undefined && now - this.runningSince > maxTurnMs) {
      this.watchdogAbort(`Pi 单轮执行超过 ${Math.round(maxTurnMs / 60_000)} 分钟，已自动中止`)
    }
  }

  /** Abort the active run; if Pi still doesn't settle, force-close the turn. */
  private watchdogAbort(reason: string): void {
    if (this.phaseValue !== 'ready') return
    const graceMs = this.watchdog?.abortGraceMs ?? DEFAULT_WATCHDOG_ABORT_GRACE_MS
    this.emit('notification', { type: 'watchdog_abort', message: reason })
    void this.wireAsReady().command({ type: 'abort' }).catch(() => {})
    const timer = setTimeout(() => {
      if (this.phaseValue !== 'ready' || this.turnStateValue !== 'running') return
      this.forceCloseTurn(reason)
    }, graceMs)
    timer.unref?.()
  }

  /**
   * Close the active turn locally and reset the running projection. Used when
   * Pi can no longer settle it (watchdog abort ignored, child exited): the dsh
   * session turn and every running indicator must not stay stuck forever.
   * Pi's own later `turn_end` is swallowed via {@link forceSettled}.
   */
  private forceCloseTurn(reason: string): void {
    if (this.turnStateValue !== 'running') return
    this.handleEvent({
      type: 'turn_end',
      message: { stopReason: 'aborted', content: [] },
    } as PiEvent)
    this.forceSettled = true
    this.runningSince = undefined
    this.setTurnState('idle')
    this.emit('notification', { type: 'watchdog_forced_settle', message: reason })
  }

  private setPhase(phase: PiGatewayPhase): void {
    if (this.phaseValue === phase) return
    this.phaseValue = phase
    this.emit('phase', phase)
  }

  private setTurnState(state: PiGatewayTurnState): void {
    if (this.turnStateValue === state) return
    this.turnStateValue = state
    this.emit('turn', state)
  }

  private wireAsReady(): PiRpcWire {
    const wire = this.wire
    if (this.phaseValue !== 'ready' || wire === undefined) {
      throw new Error(`pi gateway: not ready (phase ${this.phaseValue})`)
    }
    return wire
  }
}

/** Extract the session id from the argv (the value after `--session-id`). */
function sessionIdOfArgv(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--session-id')
  if (index < 0 || index + 1 >= argv.length) return undefined
  return argv[index + 1]
}
