/**
 * End-to-end smoke test for the gateway core against the real
 * `codex app-server --stdio` binary on this machine.
 *
 * Run: node --experimental-strip-types docs/verification/gateway-smoke.ts
 * Verifies: persistent thread create/resume, submit auto-dispatch
 * (idle -> turn/start, busy -> queue/add), queue auto-drain, steer,
 * interrupt, dispose.
 */
import { CodexGateway } from '../../src/gateway/gateway.ts'
import type { CodexGatewayNotification } from '../../src/gateway/wire.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(250)
  }
  throw new Error(`TIMEOUT waiting for ${label}`)
}

function passed(label: string, detail = ''): void {
  console.log(`[PASS] ${label}${detail ? ` (${detail})` : ''}`)
}

const results: string[] = []
let lastNotification: CodexGatewayNotification | undefined

const gateway = new CodexGateway({
  cwd: '/tmp',
  argv: ['codex', 'app-server', '--stdio'],
  onStderr: line => { if (line.includes('error') || line.includes('Error')) console.log('[stderr]', line) },
})
gateway.on('notification', n => { lastNotification = n })

try {
  // 1. persistent thread create
  const threadId = await gateway.start()
  passed('start + persistent thread', `thread=${threadId}`)

  // 2. idle submit -> turn
  const first = await gateway.submit([{ type: 'text', text: 'Reply with exactly: FIRST', text_elements: [] }], 'smoke-1')
  if (first.kind !== 'turn') throw new Error(`expected turn, got ${first.kind}`)
  passed('idle submit -> turn/start', `turn=${first.id}`)

  // 3. busy submit -> queue
  const queued = await gateway.submit([{ type: 'text', text: 'queued message', text_elements: [] }], 'smoke-2')
  if (queued.kind !== 'queued') throw new Error(`expected queued, got ${queued.kind}`)
  passed('busy submit -> queue/add', `queued=${queued.id}`)

  // 4. queue list
  const q1 = await gateway.queue()
  if (q1.length !== 1) throw new Error(`expected 1 queued, got ${q1.length}`)
  passed('queue/list', `count=${q1.length}`)

  // 5. first turn completes -> idle
  await waitFor('first turn completion', () => gateway.turnState === 'idle' && lastNotification?.method === 'turn/completed')
  passed('turn/completed -> idle')

  // 6. queue auto-drains into a new turn
  await waitFor('queue auto-drain turn', () => gateway.turnState === 'running')
  passed('queued item auto-started')
  await waitFor('queued turn completion', () => gateway.turnState === 'idle' && lastNotification?.method === 'turn/completed')
  const q2 = await gateway.queue()
  if (q2.length !== 0) throw new Error(`expected empty queue, got ${q2.length}`)
  passed('queue drained', 'count=0')

  // 7. steer a running turn
  const steerTurn = await gateway.submit([{ type: 'text', text: 'Reply with exactly: BETA', text_elements: [] }], 'smoke-3')
  await waitFor('steer target running', () => gateway.turnState === 'running')
  const steered = await gateway.steer([{ type: 'text', text: 'Reply with exactly: STEERED', text_elements: [] }], steerTurn.id)
  passed('turn/steer accepted', steered === undefined ? 'no turn_id in response' : `turn_id=${steered}`)
  await waitFor('steered turn completion', () => gateway.turnState === 'idle' && lastNotification?.method === 'turn/completed')

  // 8. interrupt a running turn (best-effort)
  await gateway.submit([{ type: 'text', text: 'Reply with exactly: GAMMA', text_elements: [] }], 'smoke-4')
  await waitFor('interrupt target running', () => gateway.turnState === 'running')
  gateway.cancel()
  passed('cancel() -> turn/interrupt dispatched')
  await waitFor('post-interrupt quiescence', () => gateway.turnState === 'idle', 60_000)

  // 9. dispose
  await gateway.dispose()
  passed('dispose', 'wire closed + process terminated')

  // 10. restart -> resume same durable thread (C3)
  const gateway2 = new CodexGateway({ cwd: '/tmp', argv: ['codex', 'app-server', '--stdio'] })
  const resumedId = await gateway2.start(threadId)
  if (resumedId !== threadId) throw new Error(`thread id changed on resume: ${resumedId}`)
  passed('thread/resume reconnect', `thread=${resumedId}`)
  const resumed = await gateway2.submit([{ type: 'text', text: 'Reply with exactly: RESUME_OK', text_elements: [] }], 'smoke-5')
  if (resumed.kind !== 'turn') throw new Error(`expected turn after resume, got ${resumed.kind}`)
  await waitFor('resumed turn completion', () => gateway2.turnState === 'idle' && lastNotification?.method === 'turn/completed')
  passed('post-resume submit works')
  await gateway2.dispose()

  results.push('ALL PASS')
} catch (error) {
  results.push(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  await gateway.dispose().catch(() => {})
}

console.log(`\n=== ${results.join(' | ')} ===`)
process.exit(results[0] === 'ALL PASS' ? 0 : 1)
