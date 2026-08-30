/**
 * Browser half of the Codex true-gateway. Registers the official-slot
 * status seats (session-header badge, composer-dock status line, input-dock
 * queue strip) and the floating control window in the `shell.overlay`
 * layer. State flows from the host through same-origin `/api/codex-plus/*`
 * endpoints; the client never talks to Codex directly.
 *
 * @module dsh-subagent-codex-plus/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (header/composer/input
// dock seats) and the ui-layout SlotMap merge (shell.overlay).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { makeGatewayApi } from './api.ts'
import { DockStatus, HeaderAction } from './components.tsx'
import { ControlPanel } from './ControlPanel.tsx'
import { QueuePanel } from './QueuePanel.tsx'
import { setGatewayApi } from './gateway-store.ts'

/** Required services: the slot registry. */
export const inject = ['slots']

/** Plugin id used for every slot registration. */
const ENTRY_ID = 'codex-plus'

/**
 * Register the gateway status seats and the floating control window.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  setGatewayApi(makeGatewayApi())

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: ENTRY_ID,
    order: 200,
  }, HeaderAction))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: ENTRY_ID,
    order: 200,
  }, DockStatus))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: ENTRY_ID,
    order: 500,
  }, ControlPanel))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: `${ENTRY_ID}-queue`,
    order: 400,
  }, QueuePanel))
}
