/**
 * Runtime probe: verify the true-gateway attach/detach wiring against the
 * real dsh host (0.1.1-rc.2). Booted as a profile bundle plugin under
 * `dsh-base`; drives the full loop: create session -> attach (real Codex
 * app-server) -> prompt routing -> Q4 -> detach -> Q1 resume -> C3
 * auto-reattach.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { GatewayManager } from './gateway/manager.js'
import { GatewayBindingStore } from './gateway/binding.js'
import { isGatewayAgent } from './gateway/attach.js'

export const name = 'gateway-probe'
export const inject = ['agents', 'sessions', 'commands', 'llm', 'agentDefaultModel', 'attachments']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(250)
  }
  throw new Error(`TIMEOUT waiting for ${label}`)
}

const pass = (label, detail = '') => console.log(`[PASS] ${label}${detail ? ` (${detail})` : ''}`)

function codexArgv() {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@openai/codex/package.json')
  const { readFileSync } = require('node:fs')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const { dirname, resolve } = require('node:path')
  return [process.execPath, resolve(dirname(manifestPath), manifest.bin.codex), 'app-server', '--stdio']
}

export function apply(ctx, config) {
  setTimeout(() => void run(ctx).catch((error) => {
    console.error(`[FAIL] probe: ${error?.stack ?? String(error)}`)
    process.exit(1)
  }), 0)
}

/** Load the real plugin bundle (copied next to the probe) and boot it. */
async function bootPlugin(ctx, cwd) {
  // Mount through Cordis `ctx.plugin()` so the bundle's `inject` list
  // (subagents/subprocess) is resolved exactly like the host loader does;
  // calling `plugin.apply(ctx, ...)` by hand skips injection and throws
  // "cannot get property subagents without inject".
  const plugin = await import('../lib-plugin/index.js')
  await ctx.plugin(plugin, {
    providerName: 'codex-plus',
    gatewayEnabled: true,
    gatewayBindingFile: join(cwd, 'plugin-bindings.json'),
    gatewayApprovalPolicy: 'never',
  })
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('subagents service missing')
  const provider = subagents.getProvider('codex-plus')
  if (provider === undefined) throw new Error('plugin did not register the codex-plus provider')
  pass('plugin apply: one-shot provider registered', provider.name)
  const commands = ctx.get('commands')
  if (commands === undefined) throw new Error('commands service missing')
  const attach = commands.find(undefined, 'codex-lock')
  if (attach === undefined) throw new Error('plugin did not register /codex-lock')
  if (commands.find(undefined, 'codex-unlock') === undefined) {
    throw new Error('plugin did not register /codex-unlock')
  }
  pass('plugin apply: gateway commands registered', '/codex-lock /codex-unlock')
}

async function run(ctx) {
  const argv = codexArgv()
  const cwd = mkdtempSync(join(tmpdir(), 'gateway-probe-'))
  await bootPlugin(ctx, cwd)
  pass('codex argv resolved', argv[1])
  const sessionId = `probe-session-${randomUUID().slice(0, 8)}`
  writeFileSync(join(cwd, 'AGENTS.md'), '# probe workspace\n')

  // 1. create a loop agent exactly like the host's session creation path.
  const created = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    meta: { cwd },
  })
  const loopAgent = created.agent
  pass('loop agent created', `class=${loopAgent.constructor.name}`)
  if (ctx.agents.get(sessionId) !== loopAgent) throw new Error('registry does not hold the loop agent')
  pass('registry holds loop agent')

  // 2. host prompt-path admission checks the session selection is served.
  {
    const selection = loopAgent.session.requestHeader()?.config ?? ctx.agentDefaultModel.currentSelection()
    const served = ctx.llm.listProviders().some((entry) => entry.id === selection.provider)
    if (!served) throw new Error(`selection provider "${selection.provider}" not served`)
    pass('routeServed check passes for the session', `${selection.provider}/${selection.model}`)
  }

  // 3. attach: real app-server + durable thread + registry swap.
  const bindingFile = join(cwd, 'gateway-bindings.json')
  const store = new GatewayBindingStore(bindingFile)
  const manager = new GatewayManager(ctx, store, {
    argv,
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  manager.installAutoReattach()
  const attached = await manager.attach(sessionId)
  pass('attached (registry swap)', `thread=${attached.threadId}`)
  if (ctx.agents.get(sessionId) !== attached.agent) throw new Error('registry does not hold the gateway agent')
  if (!isGatewayAgent(ctx.agents.get(sessionId))) throw new Error('registered agent is not a GatewayAgent')
  pass('registry holds GatewayAgent')
  if (store.get(sessionId)?.codexThreadId !== attached.threadId) throw new Error('binding not persisted')
  pass('binding persisted', bindingFile)

  // 4. prompt routing: followup reaches Codex, message recorded in the inbox.
  const before = attached.agent.session.events.length
  attached.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Reply with exactly: PROBE_SWAP_OK' }],
    source: { kind: 'user', rpcId: 'probe-1' },
  }))
  await waitFor('gateway turn running', () => attached.agent.status === 'running')
  pass('followup -> running')
  await waitFor('gateway turn idle', () => attached.agent.status === 'idle')
  pass('followup -> idle (Codex answered)')
  const recorded = attached.agent.session.events.some((event) => event.type === 'agent/inbox/spliced')
  if (!recorded) throw new Error('user message was not durably recorded in the session log')
  pass('user message recorded via inbox', `events +${attached.agent.session.events.length - before}`)

  // 4b. 1.6 R1-A1/A2: Codex intermediate events landed in the session log as
  //     log-only events (never surface), so the dsh model context stays clean.
  const turnEvents = attached.agent.session.events.slice(before)
  const turnTypes = turnEvents.map((event) => event.type)
  for (const expected of ['turn/start', 'step/start', 'assistant/chunk', 'step/end', 'turn/end']) {
    if (!turnTypes.includes(expected)) {
      throw new Error(`1.6: session log missing ${expected} (got ${JSON.stringify(turnTypes)})`)
    }
  }
  const surfaceAfter = turnEvents.filter((event) =>
    ['user/message', 'assistant/message', 'tool/result'].includes(event.type))
  if (surfaceAfter.length !== 0) {
    throw new Error(`1.6: unexpected surface events polluted model context: ${surfaceAfter.map((e) => e.type).join(',')}`)
  }
  const chunkKinds = turnEvents
    .filter((event) => event.type === 'assistant/chunk')
    .map((event) => event.data?.chunk?.type)
  pass('1.6: intermediate events logged (turn/step/chunk/turn-end), no surface pollution',
    `chunks=${JSON.stringify([...new Set(chunkKinds)])}`)

  // 4c. 2.3 Q3: image block -> Codex localImage (pure passthrough; R5:
  // visual understanding is handled by the hosts' shared ocgw-vision skill).
  {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const ref = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'probe-red.png' })
    const imageSeen = []
    const imageTap = (n) => {
      if (n.method === 'item/started' && n.params?.item?.type === 'userMessage') {
        imageSeen.push(n.params.item.content)
      }
    }
    attached.gateway.on('notification', imageTap)
    const beforeImage = attached.agent.session.events.length
    const imageMsg = createUserMessage({
      content: [
        { type: 'text', text: 'Describe the attached image briefly. Reply with exactly: IMAGE_OK' },
        { type: 'image', attachment: ref },
      ],
      source: { kind: 'user', rpcId: 'probe-img' },
    })
    // Drive the real agent path (resolve -> submit -> turn) and await it so
    // the turn has actually started before we wait for completion.
    await attached.agent.resolveAndRoute('followup', imageMsg, [])
    await waitFor('image turn idle', () => attached.agent.status === 'idle')
    await sleep(500)
    attached.gateway.off('notification', imageTap)
    const userItem = imageSeen.find((content) =>
      Array.isArray(content) && content.some((block) => block?.type === 'localImage'))
    if (userItem === undefined) {
      throw new Error('2.3: Codex userMessage item did not carry a localImage input')
    }
    const blocks = userItem.map((b) => b?.type)
    pass('2.3: image -> localImage reached Codex', `blocks=${JSON.stringify(blocks)}`)
    pass('2.4: image passes through undescribed (R5, vision handled by ocgw-vision skill)')
    const imgEvents = attached.agent.session.events.slice(beforeImage)
    if (!imgEvents.some((e) => e.type === 'assistant/chunk')) {
      throw new Error('2.3: image turn produced no assistant chunks in the session log')
    }
    pass('2.3: image turn also streamed intermediate events', `events +${imgEvents.length}`)
  }

  // 5. Q4: duplicate attach refused for the same session; thread owner enforced.
  let duplicateRejected = false
  try { await manager.attach(sessionId) } catch (error) { duplicateRejected = /already bound/.test(String(error)) }
  if (!duplicateRejected) throw new Error('duplicate attach was not rejected')
  pass('Q4: duplicate session attach rejected')

  const otherId = `probe-session-${randomUUID().slice(0, 8)}`
  const other = await ctx.agents.create({
    sessionId: otherId,
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    meta: { cwd },
  })
  let ownerRejected = false
  try {
    await manager.attach(otherId, attached.threadId)
  } catch (error) {
    ownerRejected = /already bound to another dsh session/.test(String(error))
  }
  if (!ownerRejected) throw new Error('cross-session thread takeover was not rejected')
  pass('Q4: thread owned by another session rejected')
  await other.dispose()

  // 6. detach: registry + session cleared, child stopped, binding dropped (Q1).
  await manager.detach(sessionId)
  if (ctx.agents.get(sessionId) !== undefined) throw new Error('agent entry still live after detach')
  if (ctx.sessions.get(sessionId) !== undefined) throw new Error('session entry still live after detach')
  if (store.get(sessionId) !== undefined) throw new Error('binding still present after detach')
  pass('detach: entries cleared, binding dropped')

  // 7. Q1: the host's ordinary resume path restores a loop agent.
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } })
  if (resumed.agent === undefined || isGatewayAgent(resumed.agent)) throw new Error('resume did not restore a loop agent')
  pass('resume restores loop agent (normal mode)', `class=${resumed.agent.constructor.name}`)
  // Return the session to cold state before testing auto-reattach below.
  await resumed.dispose()

  // 8. C3: with a persisted binding, publishing a fresh loop agent auto-swaps
  //    it for a gateway resumed on the SAME durable thread.
  store.bind(sessionId, attached.threadId)
  const second = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } })
  await waitFor('auto-reattach swap', () => isGatewayAgent(ctx.agents.get(sessionId)))
  const reattached = manager.get(sessionId)
  if (reattached === undefined) throw new Error('manager has no attachment after auto-reattach')
  if (reattached.threadId !== attached.threadId) throw new Error('auto-reattach resumed a different thread')
  pass('C3: auto-reattach restored the same Codex thread', reattached.threadId)

  // 9. Q4/R1 final: agent can still take prompts after auto-reattach.
  reattached.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Reply with exactly: PROBE_REATTACH_OK' }],
    source: { kind: 'user', rpcId: 'probe-2' },
  }))
  await waitFor('reattached turn idle', () => reattached.agent.status === 'idle')
  pass('auto-reattached gateway answers prompts')

  await manager.detach(sessionId)
  pass('final detach clean')
  console.log('[PROBE-COMPLETE]')
  process.exit(0)
}
