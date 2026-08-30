/**
 * Profile-named Codex one-shot subagent provider. Every accepted run starts a
 * fresh official package-local Codex wrapper with `app-server --stdio` in the
 * delegating Session's workspace and publishes only after an ephemeral thread exists.
 *
 * @module dsh-subagent-codex-plus
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { assertPositiveFinite, NO_START_CAPABILITIES, resolveChildCwd, } from '@deepseek-ai/dsh-subagent';
import { CODEX_PERMISSION_MODES, DEFAULT_CODEX_PERMISSION_MODE, DEFAULT_DISPOSE_GRACE_MS, codexAppServerArgv, codexStartupFailure, startCodexRun, } from "./run.js";
import { applyGatewayCommands } from "./commands.js";
import { GatewayBindingStore } from "./gateway/binding.js";
import { GatewayManager } from "./gateway/manager.js";
export const name = 'subagent-codex-plus';
export const inject = ['subagents', 'subprocess'];
const DEFAULT_PROVIDER_NAME = 'codex-plus';
export const Config = z.object({
    providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
    model: z.string().min(1),
    env: z.dict(z.string()).default({}),
    permissionMode: z.union([...CODEX_PERMISSION_MODES])
        .default(DEFAULT_CODEX_PERMISSION_MODE),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
    gatewayEnabled: z.boolean().default(true),
    gatewayBindingFile: z.string().min(1),
    gatewayApprovalPolicy: z.string().min(1),
    gatewayEventForwarding: z.boolean().default(true),
    gatewayAppendFinalMessage: z.boolean().default(false),
});
class CodexProvider {
    name;
    ctx;
    config;
    capabilities = NO_START_CAPABILITIES;
    inheritsParentContext = false;
    constructor(name, ctx, config) {
        this.name = name;
        this.ctx = ctx;
        this.config = config;
    }
    start(request) {
        const parentCwd = request.parent.session.header.cwd;
        if (parentCwd === undefined) {
            throw new Error('subagent-codex-plus: no working directory for the child — delegate from a parent session that has one');
        }
        let cwd;
        try {
            cwd = resolveChildCwd('subagent-codex-plus', undefined, parentCwd);
        }
        catch (error) {
            if (request.signal.aborted) {
                throw new Error('subagent-codex-plus: request was aborted before app-server startup');
            }
            throw codexStartupFailure(error);
        }
        const spec = {
            cwd,
            ...this.config.model === undefined ? {} : { model: this.config.model },
            permissionMode: this.config.permissionMode,
            env: this.config.env,
            disposeGraceMs: this.config.disposeGraceMs,
            spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
            onError: (error, stopReason) => {
                this.ctx.logger.warn(`subagent-codex-plus "${this.name}": child run failed (${stopReason}): ${error.message}`);
            },
        };
        return startCodexRun(request, spec);
    }
}
/**
 * Register one Profile-named Codex provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx, config) {
    const resolved = {
        providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
        ...config.model === undefined ? {} : { model: config.model },
        env: config.env,
        permissionMode: config.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
        disposeGraceMs: config.disposeGraceMs,
    };
    assertPositiveFinite('subagent-codex-plus', 'disposeGraceMs', resolved.disposeGraceMs);
    if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
        throw new Error(`subagent-codex-plus: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
    }
    ctx.subagents.registerProvider(new CodexProvider(resolved.providerName, ctx, resolved));
    if (config.gatewayEnabled !== false) {
        installGateway(ctx, config);
    }
}
/** Wire the true-gateway: binding store, manager, commands, auto-reattach. */
function installGateway(ctx, config) {
    // The gateway needs the live session/agent registries, which only a full
    // host composition provides; lean compositions (headless one-shots, the
    // official loader fixture) simply skip it.
    if (ctx.get('agents') === undefined || ctx.get('sessions') === undefined)
        return;
    const bindingFile = config.gatewayBindingFile
        ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codex-plus-gateway.json');
    const store = new GatewayBindingStore(bindingFile);
    const manager = new GatewayManager(ctx, store, {
        argv: codexAppServerArgv(),
        ...config.model === undefined ? {} : { model: config.model },
        ...config.gatewayApprovalPolicy === undefined
            ? {}
            : { approvalPolicy: config.gatewayApprovalPolicy },
        ...config.env === undefined ? {} : { env: config.env },
        eventForwarder: {
            enabled: config.gatewayEventForwarding ?? true,
            appendFinalMessage: config.gatewayAppendFinalMessage ?? false,
        },
    });
    const commands = ctx.get('commands');
    if (commands !== undefined) {
        applyGatewayCommands((definition) => commands.register(definition), manager);
    }
    manager.installAutoReattach();
}
