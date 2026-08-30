/**
 * One-shot Pi child lifecycle: spawn the real Pi RPC child through the
 * subprocess seam, publish only after the session is ready, run one prompt,
 * and dispose to whole-tree quiescence.
 *
 * @module dsh-subagent-pi/pi-run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type RunResultSettlement,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { PiRpcWire, type PiEvent } from './gateway/pi-wire.ts'
import type { GatewayTextInput, GatewayUserInput } from './gateway/wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

export interface PiRunSpec {
  /** Working directory for the Pi child. */
  readonly cwd: string
  /** Directory holding the one-shot Pi session file. */
  readonly sessionDir: string
  /** Optional native Pi model override. */
  readonly model?: string
  /** Extra environment for the Pi child. */
  readonly env?: Record<string, string>
  /** Grace in milliseconds for process-tree termination. */
  readonly disposeGraceMs: number
  /** Spawns the child through the host's subprocess seam. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for flattened child failures. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** Reduce a dsh prompt to plain text for one Pi prompt message. */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type === 'text' && block.text.trim().length > 0) texts.push(block.text)
  }
  return texts
}

/** Build the `pi --mode rpc` argv for one ephemeral run. */
export function piRunArgv(spec: Pick<PiRunSpec, 'sessionDir' | 'model'>, sessionId: string): string[] {
  return [
    'pi',
    '--mode', 'rpc',
    '--session-dir', spec.sessionDir,
    '--session-id', sessionId,
    ...spec.model === undefined ? [] : ['--model', spec.model],
  ]
}

/** Extract the final assistant text blocks from the last turn_end message. */
function lastAssistantText(events: readonly PiEvent[]): ContentBlock[] {
  let blocks: ContentBlock[] = []
  for (const event of events) {
    if (event.type !== 'turn_end') continue
    const message = event.message
    if (message === null || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    const next: ContentBlock[] = []
    for (const entry of content) {
      if (entry === null || typeof entry !== 'object') continue
      const block = entry as { type?: unknown; text?: unknown }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        next.push({ type: 'text', text: block.text })
      }
    }
    if (next.length > 0) blocks = next
  }
  return blocks
}

/** Run one one-shot Pi delegation and publish the seam run handle. */
export async function startPiRun(
  request: SubagentStartRequest,
  spec: PiRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-pi: request was aborted before RPC startup')
  }
  const sessionId = randomUUID()

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: piRunArgv(spec, sessionId),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new Error(`subagent-pi: failed to spawn Pi child: ${error instanceof Error ? error.message : String(error)}`)
  }

  const wire = new PiRpcWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
  )
  const disposeProcess = async (): Promise<void> => {
    wire.close()
    if (child.pid > 0) {
      let outcome: SubprocessOutcome | undefined
      void child.done.then(
        (value) => { outcome = value },
        /* v8 ignore next -- a positive pid excludes spawn-level done rejection. */
        () => {},
      )
      try {
        child.stdin?.end()
      } catch {
        // A concurrently closed stdin does not change tree ownership below.
      }
      child.terminate()
      try {
        await child.waitForExit()
      } catch (error: unknown) {
        throw new Error(`subagent-pi: failed to terminate Pi child: ${error instanceof Error ? error.message : String(error)}`)
      }
      await child.done
    } else {
      await child.done.catch(() => {})
    }
  }

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-pi: run cancelled locally'))
    void wire.command({ type: 'abort' }).catch(() => {})
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  wire.start()
  const events: PiEvent[] = []
  let terminalError: string | undefined
  const settled = createSettleTracker()
  wire.onEvent((event) => {
    events.push(event)
    if (event.type === 'response' && event.success === false) {
      terminalError = typeof event.error === 'string' && event.error.length > 0
        ? event.error
        : 'pi run failed'
    }
    if (event.type === 'agent_settled') settled.signal()
  })

  const collectOutput = (): ContentBlock[] => lastAssistantText(events)

  const settlement: RunResultSettlement = {
    attempt: async () => {
      try {
        const response = await wire.command({
          type: 'prompt',
          message: texts.join('\n\n'),
          streamingBehavior: 'followUp',
        }, runAbort.signal)
        if (!response.success) {
          return { output: collectOutput(), stopReason: 'error', diagnostic: response.error }
        }
        await settled.wait(runAbort.signal)
        if (runAbort.signal.aborted) {
          return { output: collectOutput(), stopReason: 'aborted' }
        }
        if (terminalError !== undefined) {
          return { output: collectOutput(), stopReason: 'error', diagnostic: terminalError }
        }
        return { output: collectOutput(), stopReason: 'completed' }
      } catch (error: unknown) {
        if (runAbort.signal.aborted) {
          return { output: collectOutput(), stopReason: 'aborted' }
        }
        throw error
      }
    },
    collectOutput,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  }

  const result = settleRunResult(settlement)

  return subprocessRunHandle({
    id: SessionId(sessionId),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}

/**
 * Tracks the `agent_settled` terminal marker observed by the run's event
 * sink. `signal()` is idempotent; `wait()` resolves on the marker or rejects
 * on abort.
 */
function createSettleTracker(): {
  signal(): void
  wait(signal: AbortSignal): Promise<void>
} {
  let settled = false
  const resolvers: (() => void)[] = []
  return {
    signal(): void {
      if (settled) return
      settled = true
      const pending = resolvers.splice(0)
      for (const resolve of pending) resolve()
    },
    wait(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          cleanup()
          reject(abortReason(signal))
        }
        const cleanup = (): void => {
          signal.removeEventListener('abort', onAbort)
          const index = resolvers.indexOf(resolve)
          if (index >= 0) resolvers.splice(index, 1)
        }
        if (settled) {
          resolve()
          return
        }
        if (signal.aborted) {
          reject(abortReason(signal))
          return
        }
        resolvers.push(resolve)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-pi: run aborted: ${String(signal.reason)}`)
}
