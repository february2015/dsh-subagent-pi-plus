/**
 * Deterministic smoke for the Codex → dsh session event forwarder (R1-A1/A2).
 *
 * Feeds the exact notification shapes captured from a real
 * `codex app-server --stdio` stream (TECH-VERIFICATION §3.6) into a fake
 * session and asserts the projected log-only dsh events.
 */
import { GatewayEventForwarder } from '../../src/gateway/events.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CodexGatewayNotification } from '../../src/gateway/wire.ts'

const events: Array<{ type: string; data: unknown }> = []
const session = {
  append(type: string, data: unknown) {
    events.push({ type, data })
    return { seq: events.length, type, data, time: Date.now() }
  },
} as unknown as Session

function notif(method: string, params: Record<string, unknown>): CodexGatewayNotification {
  return { method, params }
}

let failed = 0
function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`[PASS] ${label}${detail ? ` (${detail})` : ''}`)
  } else {
    failed += 1
    console.error(`[FAIL] ${label}${detail ? ` (${detail})` : ''}`)
  }
}

// --- run 1: happy path with reasoning + text + tool + completed ---
const fwd = new GatewayEventForwarder(session)
fwd.forward(notif('turn/started', {
  threadId: 'thr-1',
  turn: { id: 'turn-1', status: 'inProgress', items: [] },
}))
fwd.forward(notif('item/reasoning/textDelta', {
  threadId: 'thr-1', turnId: 'turn-1', itemId: 'r1', delta: 'Let me think', contentIndex: 0,
}))
fwd.forward(notif('item/agentMessage/delta', {
  threadId: 'thr-1', turnId: 'turn-1', itemId: 'a1', delta: 'Answer:',
}))
fwd.forward(notif('item/started', {
  threadId: 'thr-1', turnId: 'turn-1', startedAtMs: 1,
  item: { type: 'dynamicToolCall', id: 'call-1', tool: 'shell', arguments: { command: 'echo hi' }, status: 'inProgress' },
}))
fwd.forward(notif('item/completed', {
  threadId: 'thr-1', turnId: 'turn-1', completedAtMs: 2,
  item: { type: 'dynamicToolCall', id: 'call-1', tool: 'shell', arguments: { command: 'echo hi' }, status: 'completed' },
}))
fwd.forward(notif('turn/completed', {
  threadId: 'thr-1',
  turn: { id: 'turn-1', status: 'completed', items: [] },
}))

check('turn/start logged', events[0]?.type === 'turn/start', JSON.stringify(events[0]))
check('turn/start data', events[0]?.data?.turn === 1)
check('step/start logged after turn/start', events[1]?.type === 'step/start', JSON.stringify(events[1]))
check('reasoning delta -> assistant/chunk', events[2]?.type === 'assistant/chunk'
  && events[2]?.data?.chunk?.type === 'reasoning-delta'
  && events[2]?.data?.chunk?.text === 'Let me think', JSON.stringify(events[2]?.data?.chunk))
check('text delta -> assistant/chunk', events[3]?.type === 'assistant/chunk'
  && events[3]?.data?.chunk?.type === 'text-delta'
  && events[3]?.data?.chunk?.text === 'Answer:', JSON.stringify(events[3]?.data?.chunk))
const toolCall = events.find((e) => e.type === 'tool/call')
check('tool item -> tool/call', toolCall !== undefined, JSON.stringify(toolCall?.data))
check('tool/call name+args', toolCall?.data?.name === 'shell'
  && toolCall?.data?.callId === 'call-1'
  && toolCall?.data?.arguments === '{"command":"echo hi"}', JSON.stringify(toolCall?.data))
check('step/end before turn/end', events.at(-2)?.type === 'step/end', JSON.stringify(events.at(-2)))
const turnEnd = events.at(-1)
check('turn/end logged', turnEnd?.type === 'turn/end', JSON.stringify(turnEnd))
check('turn/end reason completed', turnEnd?.data?.reason?.kind === 'completed', JSON.stringify(turnEnd?.data?.reason))
check('no surface events appended', events.every((e) => !['user/message', 'assistant/message', 'tool/result'].includes(e.type)))

// --- run 2: failed turn -> error reason; interrupted -> aborted ---
const events2: Array<{ type: string; data: unknown }> = []
const session2 = {
  append(type: string, data: unknown) {
    events2.push({ type, data })
    return { seq: events2.length, type, data, time: Date.now() }
  },
} as unknown as Session
const fwd2 = new GatewayEventForwarder(session2)
fwd2.forward(notif('turn/started', { turn: { id: 't2', status: 'inProgress' } }))
fwd2.forward(notif('turn/completed', { turn: { id: 't2', status: 'failed', error: { message: 'boom' } } }))
check('failed -> turn/end error', events2.at(-1)?.type === 'turn/end'
  && events2.at(-1)?.data?.reason?.kind === 'error'
  && events2.at(-1)?.data?.reason?.error?.message === 'boom', JSON.stringify(events2.at(-1)?.data?.reason))

const events3: Array<{ type: string; data: unknown }> = []
const session3 = {
  append(type: string, data: unknown) {
    events3.push({ type, data })
    return { seq: events3.length, type, data, time: Date.now() }
  },
} as unknown as Session
const fwd3 = new GatewayEventForwarder(session3)
fwd3.forward(notif('turn/started', { turn: { id: 't3', status: 'inProgress' } }))
fwd3.forward(notif('turn/completed', { turn: { id: 't3', status: 'interrupted' } }))
check('interrupted -> turn/end aborted', events3.at(-1)?.type === 'turn/end'
  && events3.at(-1)?.data?.reason?.kind === 'aborted', JSON.stringify(events3.at(-1)?.data?.reason))

// --- run 3: disabled forwarder appends nothing ---
const events4: Array<{ type: string; data: unknown }> = []
const session4 = {
  append(type: string, data: unknown) {
    events4.push({ type, data })
    return { seq: events4.length, type, data, time: Date.now() }
  },
} as unknown as Session
const fwd4 = new GatewayEventForwarder(session4, { enabled: false, appendFinalMessage: false })
fwd4.forward(notif('turn/started', { turn: { id: 't4', status: 'inProgress' } }))
fwd4.forward(notif('item/agentMessage/delta', { itemId: 'a4', delta: 'x' }))
check('disabled forwarder appends nothing', events4.length === 0)

console.log(failed === 0 ? '[EVENTS-SMOKE-COMPLETE]' : `[EVENTS-SMOKE-FAILED] failures=${failed}`)
process.exit(failed === 0 ? 0 : 1)
