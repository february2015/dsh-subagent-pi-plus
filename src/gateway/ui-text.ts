/**
 * Display helpers for the gateway UI. Kept in its own module so the host
 * service and any future host-side tests can share it without importing
 * the browser-facing types.
 *
 * @module dsh-subagent-codex-plus/gateway/ui-text
 */

import type { GatewayUserInput } from './wire.ts'

/** Join the text blocks of one gateway input list for display. */
export function textOf(input: readonly GatewayUserInput[]): string {
  return input
    .map((block) => (block.type === 'text' ? block.text : '[图片]'))
    .filter((text) => text.length > 0)
    .join('\n')
}
