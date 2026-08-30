/**
 * Routing smoke test for GatewayAgent against a real Codex app-server.
 * Verifies the dsh Agent contract verbs forward correctly: followup,
 * steer, inject, cancel, whenIdle.
 *
 * Run: node --experimental-transform-types docs/verification/gateway-agent-smoke.ts
 */
// Machine-specific note: the dsh-session runtime is loaded from the user's
// dsh profile (~/.dsh/profiles/node_modules) at integration time. This smoke
// test avoids runtime imports entirely and uses structural message shapes.
import { CodexGateway } from '../../src/gateway/gateway.ts'
import { GatewayAgent, type GatewayAgentHost } from '../../src/gateway/agent.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(250)
  }
  throw new Error(`TIMEOUT waiting for ${label}`)
}

const passed = (label: string, detail = ''): void =>
  console.log(`[PASS] ${label}${detail ? ` (${detail})` : ''}`)

const text = (text: string) =>
  ({ role: 'user', content: [{ type: 'text', text }] })

const recordedInbox = {
  append() { /* structural stub: the smoke host carries no real dsh session */ },
} as unknown as GatewayAgentHost['inbox']
// Structural session stub: the smoke host carries no real dsh session, but the
// event forwarder (R1-A1) calls `session.append` on every Codex notification.
const sessionEvents: Array<{ type: string; data: unknown }> = []
const fakeSession = {
  append(type: string, data: unknown) {
    sessionEvents.push({ type, data })
    return { seq: sessionEvents.length, type, data, time: Date.now() }
  },
} as unknown as NonNullable<GatewayAgentHost['session']>
const host = {
  id: 'gateway-agent-smoke',
  session: fakeSession,
  inbox: recordedInbox,
  ctx: { logger: undefined },
  options: { provider: 'codex-plus' },
} as unknown as GatewayAgentHost

const gateway = new CodexGateway({ cwd: '/tmp', argv: ['codex', 'app-server', '--stdio'] })
const agent = new GatewayAgent(host, gateway)

let lastTurnEnd = 0
gateway.on('notification', n => {
  if (n.method === 'turn/completed') lastTurnEnd = Date.now()
})

try {
  const threadId = await gateway.start()
  passed('gateway attached', `thread=${threadId}`)

  // followup -> turn
  agent.followup(text('Reply with exactly: AGENT_OK'))
  await waitFor('followup turn', () => agent.status === 'running')
  passed('followup -> running')
  await waitFor('followup completion', () => agent.status === 'idle')
  passed('followup -> idle (turn/completed)')
  const sessionTypes = sessionEvents.map((event) => event.type)
  for (const expected of ['turn/start', 'step/start', 'assistant/chunk', 'step/end', 'turn/end']) {
    if (!sessionTypes.includes(expected)) throw new Error(`forwarder: missing ${expected}`)
  }
  if (sessionEvents.some((e) => ['user/message', 'assistant/message', 'tool/result'].includes(e.type))) {
    throw new Error('forwarder: surface event leaked into the fake session')
  }
  passed('forwarder logged intermediate events (no surface pollution)',
    `events=${sessionTypes.join(',')}`)

  // whenIdle resolves
  await agent.whenIdle()
  passed('whenIdle resolves when idle')

  // steer during a running turn
  agent.followup(text('Reply with exactly: BETA'))
  await waitFor('steer target', () => agent.status === 'running')
  const steerPromise = agent.whenIdle()
  agent.steer(text('Reply with exactly: STEERED'))
  await steerPromise
  passed('steer redirects active turn')

  // inject merges into the next followup
  agent.inject(text('Context: keep it terse.'))
  agent.followup(text('Reply with exactly: DONE'))
  await waitFor('inject+followup completion', () => agent.status === 'idle' && Date.now() > lastTurnEnd)
  await sleep(500)
  passed('inject buffered + merged into next followup')

  // cancel during a running turn
  agent.followup(text('Reply with exactly: GAMMA'))
  await waitFor('cancel target', () => agent.status === 'running')
  agent.cancel('disposed')
  await waitFor('post-cancel idle', () => agent.status === 'idle', 60_000)
  passed('cancel -> interrupt -> idle')

  await gateway.dispose()
  passed('dispose')
  console.log('\n=== AGENT SMOKE ALL PASS ===')
  process.exit(0)
} catch (error) {
  console.error('\n=== AGENT SMOKE FAIL ===', error instanceof Error ? error.message : error)
  await gateway.dispose().catch(() => {})
  process.exit(1)
}
