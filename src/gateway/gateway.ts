/**
 * Long-lived Codex gateway: one `codex app-server --stdio` child, one durable
 * thread, and the message verbs the dsh agent layer will forward through.
 *
 * The gateway is runtime-agnostic (no dsh imports): it exposes raw
 * notifications and a running/idle projection so the dsh-facing adapter can
 * decide how to render and route them.
 *
 * @module dsh-subagent-codex-plus/gateway/gateway
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  CodexGatewayWire,
  type CodexGatewayNotification,
  type GatewayUserInput,
  type QueuedSubmissionView,
} from './wire.ts'

/** Process/thread lifecycle phase of one gateway. */
export type CodexGatewayPhase = 'stopped' | 'starting' | 'ready' | 'failed'

/** Whether the server currently has an active turn on this thread. */
export type CodexGatewayTurnState = 'idle' | 'running'

export interface CodexGatewayOptions {
  /** Working directory for the app-server child and the thread. */
  readonly cwd: string
  /**
   * App-server argv; defaults to `codex app-server --stdio` resolved through
   * PATH. The dsh profile supplies the package-local bin instead.
   */
  readonly argv?: readonly string[]
  /** Optional per-thread model override (left to Codex settings when absent). */
  readonly model?: string
  /** Optional approval policy passed to `thread/start`. */
  readonly approvalPolicy?: string
  /** Extra environment layered over the inherited environment. */
  readonly env?: Record<string, string>
  /** Diagnostic sink for child stderr lines. */
  readonly onStderr?: (line: string) => void
}

export interface SubmitOutcome {
  readonly kind: 'turn' | 'queued'
  readonly id: string
}

interface GatewayEvents {
  notification: [notification: CodexGatewayNotification]
  phase: [phase: CodexGatewayPhase]
  turn: [state: CodexGatewayTurnState]
  error: [error: Error]
}

export interface CodexGateway {
  on<K extends keyof GatewayEvents>(event: K, listener: (...args: GatewayEvents[K]) => void): this
  emit<K extends keyof GatewayEvents>(event: K, ...args: GatewayEvents[K]): boolean
}

/** One durable Codex thread driven by a dedicated app-server child. */
export class CodexGateway extends EventEmitter {
  private readonly cwd: string
  private readonly argv: readonly string[]
  private readonly model?: string
  private readonly approvalPolicy?: string
  private readonly env?: Record<string, string>
  private readonly onStderr?: (line: string) => void

  private child: ChildProcess | undefined
  private wire: CodexGatewayWire | undefined
  private phaseValue: CodexGatewayPhase = 'stopped'
  private turnStateValue: CodexGatewayTurnState = 'idle'
  private threadIdValue: string | undefined
  private turnIdValue: string | undefined
  private exitPromise: Promise<number | null> | undefined

  constructor(options: CodexGatewayOptions) {
    super()
    this.cwd = options.cwd
    this.argv = options.argv ?? ['codex', 'app-server', '--stdio']
    this.model = options.model
    this.approvalPolicy = options.approvalPolicy
    this.env = options.env
    this.onStderr = options.onStderr
  }

  /** Current lifecycle phase. */
  get phase(): CodexGatewayPhase {
    return this.phaseValue
  }

  /** Active-turn projection, kept in sync with server notifications. */
  get turnState(): CodexGatewayTurnState {
    return this.turnStateValue
  }

  /** Durable thread id once started. */
  get threadId(): string | undefined {
    return this.threadIdValue
  }

  /** Active turn id, present between `turn/started` and `turn/completed`. */
  get turnId(): string | undefined {
    return this.turnIdValue
  }

  /**
   * Start the app-server child and either create a fresh durable thread or
   * resume an existing one (C3 restart recovery).
   * @param resumeThreadId - durable thread id to reconnect to; absent creates a new thread.
   * @returns the thread id.
   */
  async start(resumeThreadId?: string): Promise<string> {
    if (this.phaseValue !== 'stopped') {
      throw new Error(`gateway: cannot start from phase ${this.phaseValue}`)
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
          if (line.length > 0) this.onStderr?.(line)
        }
      })
      child.on('error', (error) => this.fail(error))

      const stdout = child.stdout
      const stdin = child.stdin
      if (stdout === null || stdin === null) {
        throw new Error('gateway: app-server did not expose stdio pipes')
      }
      const wire = new CodexGatewayWire(stdout, stdin)
      this.wire = wire
      wire.onNotification((notification) => this.handleNotification(notification))
      wire.start()
      await wire.initialize()

      const threadId = resumeThreadId === undefined
        ? await wire.startThread(this.cwd, {
            ephemeral: false,
            ...this.model === undefined ? {} : { model: this.model },
            ...this.approvalPolicy === undefined ? {} : { approvalPolicy: this.approvalPolicy },
          })
        : await wire.resumeThread(resumeThreadId)
      this.threadIdValue = threadId
      this.setPhase('ready')
      return threadId
    } catch (error) {
      this.setPhase('failed')
      throw error
    }
  }

  /**
   * Submit user input: starts a turn when idle, enqueues behind an active
   * turn (auto-drain on completion).
   * @param input - text/image input blocks.
   * @param clientUserMessageId - stable caller-supplied identity for the submission.
   */
  async submit(
    input: readonly GatewayUserInput[],
    clientUserMessageId = `gateway-${Date.now()}`,
  ): Promise<SubmitOutcome> {
    const threadId = this.requireThread()
    if (this.turnState === 'running') {
      const id = await this.wireAsReady().queueAdd(threadId, input, clientUserMessageId)
      return { kind: 'queued', id }
    }
    const turnId = await this.wireAsReady().startTurn(threadId, input, { clientUserMessageId })
    this.turnIdValue = turnId
    this.setTurnState('running')
    return { kind: 'turn', id: turnId }
  }

  /** Redirect the active turn; when idle, starts a new turn instead. */
  async steer(input: readonly GatewayUserInput[], expectedTurnId?: string): Promise<string | undefined> {
    const threadId = this.requireThread()
    if (this.turnState === 'running') {
      const target = expectedTurnId ?? this.turnIdValue
      if (target === undefined) {
        throw new Error('gateway: active turn id unknown, cannot steer')
      }
      return this.wireAsReady().steer(threadId, target, input)
    }
    const turnId = await this.wireAsReady().startTurn(threadId, input)
    this.turnIdValue = turnId
    this.setTurnState('running')
    return turnId
  }

  /** Best-effort cancel of the active turn (keeps the thread/process alive). */
  cancel(): void {
    const threadId = this.threadIdValue
    const turnId = this.turnIdValue
    if (this.phaseValue !== 'ready' || threadId === undefined || turnId === undefined) return
    this.wireAsReady().interrupt(threadId, turnId)
  }

  /** Pending queue contents. */
  async queue(): Promise<readonly QueuedSubmissionView[]> {
    return this.wireAsReady().queueList(this.requireThread())
  }

  /** Remove one queued submission. */
  async dequeue(queuedSubmissionId: string): Promise<boolean> {
    return this.wireAsReady().queueDelete(this.requireThread(), queuedSubmissionId)
  }

  /** Reorder queued submissions (array order = new FIFO order). */
  async requeue(queuedSubmissionIds: readonly string[]): Promise<void> {
    await this.wireAsReady().queueReorder(this.requireThread(), queuedSubmissionIds)
  }

  /** Replace the input text of one queued submission. */
  async updateQueue(queuedSubmissionId: string, text: string): Promise<void> {
    await this.wireAsReady().queueUpdate(this.requireThread(), queuedSubmissionId, [{
      type: 'text',
      text,
      text_elements: [],
    }])
  }

  /**
   * Close the wire and terminate the child process tree. Idempotent; safe to
   * call from any phase.
   */
  async dispose(): Promise<void> {
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

  private handleNotification(notification: CodexGatewayNotification): void {
    switch (notification.method) {
      case 'turn/started':
        {
          const turn = notification.params.turn as { readonly id?: unknown } | undefined
          this.turnIdValue = readString(turn?.id)
          this.setTurnState('running')
          break
        }
      case 'turn/completed':
        this.turnIdValue = undefined
        this.setTurnState('idle')
        break
      default:
        break
    }
    this.emit('notification', notification)
  }

  private fail(error: Error): void {
    this.setPhase('failed')
    this.emit('error', error)
  }

  private setPhase(phase: CodexGatewayPhase): void {
    if (this.phaseValue === phase) return
    this.phaseValue = phase
    this.emit('phase', phase)
  }

  private setTurnState(state: CodexGatewayTurnState): void {
    if (this.turnStateValue === state) return
    this.turnStateValue = state
    this.emit('turn', state)
  }

  private requireThread(): string {
    const threadId = this.threadIdValue
    if (threadId === undefined) {
      throw new Error(`gateway: no thread (phase ${this.phaseValue})`)
    }
    return threadId
  }

  private wireAsReady(): CodexGatewayWire {
    const wire = this.wire
    if (this.phaseValue !== 'ready' || wire === undefined) {
      throw new Error(`gateway: not ready (phase ${this.phaseValue})`)
    }
    return wire
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
