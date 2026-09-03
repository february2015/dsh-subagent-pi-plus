/**
 * Profile-named Pi subagent provider and true-gateway. Every accepted one-shot
 * run starts a fresh `pi --mode rpc` child in the delegating Session's
 * workspace; the true-gateway (`/pi-lock`) attaches the whole conversation to
 * one durable Pi session.
 *
 * @module dsh-subagent-pi-plus
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  startPiRun,
  type PiRunSpec,
} from './pi-run.ts'
import { applyGatewayCommands } from './commands.ts'
import { GatewayBindingStore } from './gateway/binding.ts'
import { GatewayManager } from './gateway/manager.ts'
import { GatewayUiService } from './gateway/ui.ts'

export const name = 'subagent-pi-plus'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'pi-plus'

/** Deployment-owned model, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `pi`). */
  providerName?: string
  /** Native Pi model fixed for this instance; omitted to inherit Pi settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
  /** Enable the true-gateway (attach/detach + auto-reattach), default true. */
  gatewayEnabled?: boolean
  /** Gateway binding store file (default `$DSH_HOME/pi-plus-gateway.json`). */
  gatewayBindingFile?: string
  /** Directory holding durable Pi session files (default `$DSH_HOME/pi-sessions`). */
  gatewaySessionDir?: string
  /** Forward Pi intermediate events into the dsh session log (R1-A1), default true. */
  gatewayEventForwarding?: boolean
  /** Abort a gateway run that emits no event for this long (ms). Default 5 min. */
  gatewayWatchdogIdleMs?: number
  /** Abort a single gateway turn that streams past this wall-clock duration (ms). Default 20 min. */
  gatewayWatchdogMaxTurnMs?: number
  /** After a watchdog abort, force-settle the turn if Pi still hasn't settled within this grace (ms). Default 60 s. */
  gatewayWatchdogAbortGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  gatewayEnabled: z.boolean().default(true),
  gatewayBindingFile: z.string().min(1),
  gatewaySessionDir: z.string().min(1),
  gatewayEventForwarding: z.boolean().default(true),
  gatewayWatchdogIdleMs: z.number().min(1_000).max(3_600_000),
  gatewayWatchdogMaxTurnMs: z.number().min(10_000).max(3_600_000_000),
  gatewayWatchdogAbortGraceMs: z.number().min(1_000).max(3_600_000),
})

type ResolvedConfig = Omit<
  Required<Config>,
  | 'model'
  | 'gatewayEnabled'
  | 'gatewayBindingFile'
  | 'gatewaySessionDir'
  | 'gatewayEventForwarding'
  | 'gatewayWatchdogIdleMs'
  | 'gatewayWatchdogMaxTurnMs'
  | 'gatewayWatchdogAbortGraceMs'
> & Pick<Config, 'model'>

class PiProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-pi-plus: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-pi-plus',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-pi-plus: request was aborted before RPC startup',
        )
      }
      throw error
    }
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const spec: PiRunSpec = {
      cwd,
      sessionDir: join(dshHome, 'pi-one-shot-sessions'),
      ...this.config.model === undefined ? {} : { model: this.config.model },
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-pi-plus "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startPiRun(request, spec)
  }
}

/**
 * Register one Profile-named Pi provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env as Record<string, string>,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  assertPositiveFinite(
    'subagent-pi-plus',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-pi-plus: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new PiProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
  if (config.gatewayEnabled !== false) {
    installGateway(ctx, config)
  }
}

/** Wire the true-gateway: binding store, manager, commands, auto-reattach. */
function installGateway(ctx: Context, config: Config): void {
  // The gateway needs the live session/agent registries, which only a full
  // host composition provides; lean compositions (headless one-shots, the
  // official loader fixture) simply skip it.
  if (ctx.get('agents') === undefined || ctx.get('sessions') === undefined) {
    ctx.logger?.warn?.('[pi-plus] installGateway skipped: agents/sessions missing')
    return
  }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const bindingFile = config.gatewayBindingFile
    ?? join(dshHome, 'pi-plus-gateway.json')
  const sessionDir = config.gatewaySessionDir
    ?? join(dshHome, 'pi-sessions')
  const store = new GatewayBindingStore(bindingFile)
  const manager = new GatewayManager(ctx, store, {
    sessionDir,
    ...config.model === undefined ? {} : { model: config.model },
    ...config.env === undefined ? {} : { env: config.env },
    eventForwarder: {
      enabled: config.gatewayEventForwarding ?? true,
    },
    ...(config.gatewayWatchdogIdleMs === undefined
      && config.gatewayWatchdogMaxTurnMs === undefined
      && config.gatewayWatchdogAbortGraceMs === undefined)
      ? {}
      : {
          watchdog: {
            ...config.gatewayWatchdogIdleMs === undefined ? {} : { idleMs: config.gatewayWatchdogIdleMs },
            ...config.gatewayWatchdogMaxTurnMs === undefined ? {} : { maxTurnMs: config.gatewayWatchdogMaxTurnMs },
            ...config.gatewayWatchdogAbortGraceMs === undefined ? {} : { abortGraceMs: config.gatewayWatchdogAbortGraceMs },
          },
        },
  })
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    applyGatewayCommands((definition) => commands.register(definition), manager)
  }
  // Browser surface: same-origin /api/pi-plus/* routes for the client slots
  // and floating control window. The host webserver usually registers after
  // this plugin's fiber settles (it is a sibling entry with its own startup
  // order), so wire the routes lazily: register immediately when the service
  // is already up, otherwise wait for `internal/service`. Headless profiles
  // never provide webServer and simply skip the browser surface.
  wireGatewayUi(ctx, manager)
  manager.installAutoReattach()
}

/** Lazily register the browser API surface once the host webserver exists. */
function wireGatewayUi(ctx: Context, manager: GatewayManager): void {
  const register = (webServer: unknown): void => {
    const ui = new GatewayUiService(ctx, manager)
    for (const route of ui.routes()) {
      ctx.effect(() => {
        const unregister = (webServer as {
          register(route: unknown): () => void
        }).register(route)
        return () => unregister()
      }, `gateway: ui route ${route.path}`)
    }
  }
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    register(webServer)
    return
  }
  let wired = false
  ctx.on('internal/service', (name: string, value: unknown) => {
    if (wired || name !== 'webServer' || value === undefined) return
    wired = true
    register(value)
  })
}
