/**
 * Notification-stream capture probe for `codex app-server --stdio`.
 * Prints every JSON-RPC notification observed during one simple turn, with
 * shapes truncated for readability. Ground truth for the 1.6 event mapping
 * (see TECH-VERIFICATION §3.6); rerun when upgrading Codex to catch drift.
 *
 * Run: node docs/verification/capture-notifs.mjs
 */
import { spawn } from 'node:child_process'
const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = '', id = 0
const pending = new Map()
const notifs = []
function send(method, params) {
  const msg = { jsonrpc: '2.0', id: ++id, method, params }
  child.stdin.write(JSON.stringify(msg) + '\n')
  return new Promise((res, rej) => pending.set(id, { res, rej, method }))
}
child.stdout.on('data', (chunk) => {
  buf += chunk; let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (msg.method) {
      notifs.push(msg)
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
    }
  }
})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const wait = async (pred, label, timeout = 240000) => {
  const d = Date.now() + timeout
  while (Date.now() < d) { if (pred()) return; await sleep(250) }
  throw new Error('TIMEOUT ' + label)
}
await send('initialize', { clientInfo: { name: 'capture', title: 'capture', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
const t0 = await send('thread/start', { cwd: '/tmp', ephemeral: false })
const threadId = t0.thread.id
console.log('THREAD', threadId)
const r = await send('turn/start', { threadId, input: [{ type: 'text', text: 'What is 2+2? Reply with ONLY the number.', text_elements: [] }], clientUserMessageId: 'cap-1' })
console.log('TURN', r.turn.id)
await wait(() => notifs.some(n => n.method === 'turn/completed'), 'turn completed')
console.log('\n=== NOTIFICATIONS (' + notifs.length + ') ===')
for (const n of notifs) {
  const p = n.params ?? {}
  const summary = JSON.stringify(p).slice(0, 300)
  console.log(n.method + '  ' + summary)
}
child.kill('SIGTERM')
process.exit(0)
