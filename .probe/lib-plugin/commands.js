/**
 * Slash commands for the Codex true-gateway: `/codex-lock` binds the
 * current session to a Codex conversation, `/codex-unlock` restores normal
 * mode (Q1/Q4). Commands render through the official `conversation.chat.
 * commandview` slot, keyed by command name.
 *
 * @module dsh-subagent-codex-plus/commands
 */
function attachDefinition(manager) {
    return {
        name: 'codex-lock',
        description: '直连绑定一个 Codex 对话（真网关：本会话输入输出直接走 Codex，dsh 只搬运）',
        input: {
            hint: '可选：要恢复的 Codex 会话 thread id；留空则新建',
        },
        handler: async (invocation) => {
            const sessionId = invocation.agent.session.id;
            const requestedThread = invocation.rawInput.trim();
            try {
                const attached = await manager.attach(sessionId, requestedThread === '' ? undefined : requestedThread);
                return {
                    kind: 'success',
                    text: `已直连 Codex 会话 \`${attached.threadId}\`。本会话后续输入输出直接走 Codex；忙时新消息自动排队，可用悬浮窗查看/插入/取消。\n\n解除直连：\`/codex-unlock\`。`,
                };
            }
            catch (error) {
                return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
function detachDefinition(manager) {
    return {
        name: 'codex-unlock',
        description: '解除当前会话与 Codex 的直连，恢复 dsh 普通模式（Codex 会话保留，可随时重新 attach）',
        handler: async (invocation) => {
            const sessionId = invocation.agent.session.id;
            try {
                await manager.detach(sessionId);
                return {
                    kind: 'success',
                    text: '已解除直连，本会话恢复 dsh 普通模式。Codex 会话已保留，可随时 `/codex-lock <threadId>` 重新绑定。',
                };
            }
            catch (error) {
                return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
/** Register both gateway commands against one manager. */
export function applyGatewayCommands(register, manager) {
    register(attachDefinition(manager));
    register(detachDefinition(manager));
}
