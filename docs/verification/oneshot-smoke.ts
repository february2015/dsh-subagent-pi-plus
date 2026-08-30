/**
 * R0 one-shot delegate regression (3.1): drive `startCodexRun` against the real
 * `codex app-server --stdio` binary through a minimal local spawn, exactly like
 * the profile's `codex-plus` SubagentProvider does per delegation.
 *
 * Run: node --experimental-strip-types docs/verification/oneshot-smoke.ts
 * Verifies: spawn -> initialize -> ephemeral thread -> runTurn -> final result,
 * then clean dispose. Must coexist with the gateway (both live in one package).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { startCodexRun, type CodexRunSpec } from '../../src/run.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const passed = (label: string, detail = ''): void => {
  console.log(`[PASS] ${label}${detail ? ` (${detail})` : ''}`)
}

/** Minimal real-child SubprocessHandle used only by this probe. */
function localSpawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  const child: ChildProcess = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(spec.env ?? {}) },
  })
  let settled = false
  let outcome: SubprocessOutcome = { exitCode: null, signal: null }
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    child.once('spawn', () => { if (child.pid === undefined) reject(new Error('spawn failed')) })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      outcome = { exitCode: code, signal }
      settled = true
      resolve(outcome)
    })
  })
  const terminate = (): void => {
    if (settled) return
    child.kill('SIGTERM')
    setTimeout(() => { if (!settled) child.kill('SIGKILL') }, spec.graceMs ?? 3_000).unref()
  }
  return {
    pid: child.pid ?? -1,
    stdin: child.stdin ?? undefined,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    collected: { stdout: '', stderr: '' },
    done,
    terminate,
    waitForExit: async () => {
      await done.catch(() => {})
      return settled
    },
  }
}

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as SubagentStartRequest['parent']

const request: SubagentStartRequest = {
  runId: SubagentRunId('oneshot-smoke-1'),
  prompt: [{ type: 'text', text: 'Reply with exactly: ONESHOT-OK' }],
  parent: fakeParent,
  signal: new AbortController().signal,
}

const spec: CodexRunSpec = {
  cwd: '/tmp',
  permissionMode: 'never',
  env: {},
  disposeGraceMs: 3_000,
  spawn: localSpawn,
  onError: (error, stopReason) => {
    console.log('[stderr]', stopReason, error.message)
  },
}

try {
  const run = await startCodexRun(request, spec)
  passed('startCodexRun published a run', `id=${run.id}`)

  const result = await Promise.race([
    run.result,
    sleep(240_000).then(() => { throw new Error('TIMEOUT waiting for one-shot result') }),
  ])
  const stopReason = (result as { stopReason: SubagentStopReason }).stopReason
  const blocks = (result as { output: Array<{ type: string; text?: string }> }).output
  const text = blocks.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('\n')
  if (stopReason !== 'completed') throw new Error(`expected completed, got ${JSON.stringify(stopReason)}`)
  if (!text.includes('ONESHOT-OK')) throw new Error(`expected ONESHOT-OK in output, got: ${text.slice(0, 200)}`)
  passed('one-shot final result', `stopReason=${stopReason}`)
  passed('output contains ONESHOT-OK', text.trim().slice(0, 60))

  await run.dispose()
  passed('dispose clean')
  console.log('[PROBE-COMPLETE]')
} finally {
  // no-op
}
