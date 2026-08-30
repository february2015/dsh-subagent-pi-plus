/**
 * Official-slot entries for the Codex true-gateway: a session-header action
 * (direct-connect badge), a composer-dock status line, and an input-dock
 * queue strip. Status display lives in the official slots; controls live in
 * the floating window (`ControlPanel`).
 *
 * @module dsh-subagent-codex-plus/client/components
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  runGatewayAction,
  togglePanel,
  useGatewayView,
  usePanelState,
} from './gateway-store.ts'
import type { GatewaySessionView } from '../shared/types.ts'
import { THEME } from './theme.ts'

/** Short stable thread label for badges. */
function shortThread(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 10)}…` : threadId
}

const BADGE_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 24,
  padding: '0 8px',
  borderRadius: 6,
  border: `1px solid ${THEME.borderStrong}`,
  background: 'transparent',
  color: THEME.textPrimary,
  fontSize: 12,
  lineHeight: '24px',
  whiteSpace: 'nowrap' as const,
  cursor: 'pointer',
}

function dotColor(view: GatewaySessionView | null): string {
  if (view?.attached) return view.running ? '#e6a23c' : '#2ea043'
  if (view?.threadId !== undefined) return '#9aa4af'
  return '#9aa4af'
}

function badgeLabel(view: GatewaySessionView | null): string {
  if (view?.attached) {
    return `CDX-${(view.threadId ?? '').slice(0, 4)}`
  }
  if (view?.threadId !== undefined) {
    return `CDX-${view.threadId.slice(0, 4)}`
  }
  return '直连 CDX'
}

/** Session-header action: the direct-connect badge (status display). */
export function HeaderAction(props: PropsRuntime<'conversation.session.header.actions'>) {
  const { view } = useGatewayView(props.sessionId)
  const panel = usePanelState()
  return (
    <button
      type="button"
      style={{
        ...BADGE_BASE,
        color: view?.attached
          ? THEME.textPrimary
          : THEME.textTertiary,
        boxShadow: view?.attached ? 'inset 0 0 0 1px ' + dotColor(view) : undefined,
      }}
      title={view?.threadId !== undefined
        ? `Codex 直连线程 ${view.threadId}${view.attached ? '（点击打开控制窗）' : '（重启后自动恢复，点击打开控制窗）'}`
        : '将本会话直连到 Codex（点击打开控制窗）'}
      onClick={() => togglePanel(!panel.open)}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor(view),
          display: 'inline-block',
        }}
      />
      {badgeLabel(view)}
    </button>
  )
}

const STATUS_LINE = {
  boxSizing: 'border-box' as const,
  color: THEME.textTertiary,
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: '20px',
  margin: '0 auto',
  maxWidth: 'var(--dsh-chat-content-width, 900px)',
  overflow: 'hidden',
  padding: '0 var(--dsh-composer-side-clearance, 16px)',
  textAlign: 'center' as const,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  width: '100%',
}

function statusText(view: GatewaySessionView | null): string | null {
  if (view?.attached) {
    const parts = [
      `Codex 直连 · ${shortThread(view.threadId ?? '')}`,
      view.running ? '运行中' : '空闲',
    ]
    if (view.queue.length > 0) parts.push(`队列 ${view.queue.length}`)
    return parts.join(' · ')
  }
  if (view?.threadId !== undefined) {
    return `Codex 直连已保存（线程 ${shortThread(view.threadId)}），重启后自动恢复`
  }
  return null
}

/** Composer-dock status line: only when the session is bound or attached. */
export function DockStatus(props: PropsRuntime<'conversation.composer.dock'>) {
  const { view } = useGatewayView(props.sessionId)
  const text = statusText(view)
  if (text === null) return null
  return (
    <div
      style={STATUS_LINE}
      role="status"
      onClick={() => togglePanel(true)}
      title="点击打开 Codex 网关控制窗"
    >
      {text}
    </div>
  )
}

/** Shared action helper used by the control panel. */
export function gatewayError(
  sessionId: string,
  action: (api: import('./api.ts').GatewayApi) => Promise<{ ok: boolean; error?: string }>,
): Promise<string | undefined> {
  return runGatewayAction(sessionId, action)
}
