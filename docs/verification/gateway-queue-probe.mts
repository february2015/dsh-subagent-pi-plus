import { CodexGateway } from '../../src/gateway/gateway.ts'
import type { CodexGatewayNotification } from '../../src/gateway/wire.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (label: string, detail = ''): void => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}${detail ? ` (${detail})` : ''}`)
}

const gateway = new CodexGateway({
  cwd: '/tmp',
  argv: ['codex', 'app-server', '--stdio'],
  onStderr: (line) => { if (/error|fail/i.test(line)) console.log('[stderr]', line) },
})
gateway.on('notification', (n: CodexGatewayNotification) => {
  const t = n.method === 'turn/started' ? n.params.turn?.id ?? '' : ''
  log(`NOTIF ${n.method}${t ? ` turn=${t}` : ''}`)
})

try {
  const threadId = await gateway.start()
  log('thread started', threadId)

  const first = await gateway.submit([{ type: 'text', text: '请 sleep 25 秒，然后回复：第一条完成', text_elements: [] }], 'probe-1')
  log('submit#1 ->', first.kind)

  // 等 turn 确实 running（turn/started 通知到达）再发第二条
  await sleep(3000)
  const q0 = await gateway.queue()
  log('queue before #2', `count=${q0.length}`)

  const second = await gateway.submit([{ type: 'text', text: '第二条：请回答 2+2=?', text_elements: [] }], 'probe-2')
  log('submit#2 ->', `${second.kind} id=${second.id}`)

  // 立刻查队列（应该能看到第二条）
  const q1 = await gateway.queue()
  log('queue right after #2', `count=${q1.length} items=${q1.map((x) => x.clientUserMessageId).join(',')}`)

  // 每 2 秒查一次队列，直到 turn 完成或队列变化
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const q = await gateway.queue()
    log('poll queue', `count=${q.length} turnState=${gateway.turnState}`)
    if (gateway.turnState === 'idle' && q.length === 0) {
      log('all drained')
      break
    }
  }
  await sleep(15000)
  log('final', `turnState=${gateway.turnState}`)
  const qf = await gateway.queue()
  log('final queue', `count=${qf.length}`)
  await gateway.dispose()
  console.log('DONE')
} catch (error) {
  console.error('FAIL', error)
  await gateway.dispose().catch(() => {})
  process.exit(1)
}
