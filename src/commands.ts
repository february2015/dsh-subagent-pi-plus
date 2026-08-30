/**
 * Slash commands for the Pi true-gateway: `/pi-lock` binds the current
 * session to a Pi conversation, `/pi-unlock` restores normal mode (Q1/Q4).
 * Commands render through the official `conversation.chat.commandview`
 * slot, keyed by command name.
 *
 * @module dsh-subagent-pi/commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { GatewayManager } from './gateway/manager.ts'

function attachDefinition(manager: GatewayManager): CommandDefinition {
  return {
    name: 'pi-lock',
    description: '直连绑定一个 Pi 对话（真网关：本会话输入输出直接走 Pi，dsh 只搬运）',
    input: {
      hint: '可选：要恢复的 Pi 会话 session id；留空则新建',
    },
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const sessionId = invocation.agent.session.id
      const requestedSession = invocation.rawInput.trim()
      try {
        const attached = await manager.attach(sessionId, requestedSession === '' ? undefined : requestedSession)
        return {
          kind: 'success',
          text: `已直连 Pi 会话 \`${attached.threadId}\`。本会话后续输入输出直接走 Pi；忙时新消息自动排队，可用悬浮窗查看/插入/取消。\n\n解除直连：\`/pi-unlock\`。`,
        }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function detachDefinition(manager: GatewayManager): CommandDefinition {
  return {
    name: 'pi-unlock',
    description: '解除当前会话与 Pi 的直连，恢复 dsh 普通模式（Pi 会话保留，可随时重新 attach）',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const sessionId = invocation.agent.session.id
      try {
        await manager.detach(sessionId)
        return {
          kind: 'success',
          text: '已解除直连，本会话恢复 dsh 普通模式。Pi 会话已保留，可随时 `/pi-lock <sessionId>` 重新绑定。',
        }
      } catch (error: unknown) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** Register both gateway commands against one manager. */
export function applyGatewayCommands(register: (definition: CommandDefinition) => void, manager: GatewayManager): void {
  register(attachDefinition(manager))
  register(detachDefinition(manager))
}
