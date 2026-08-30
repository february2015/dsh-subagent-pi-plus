/**
 * Floating info window for the Codex true-gateway, seated in the official
 * `shell.overlay` layer. Opened from the session-header badge, this window is
 * deliberately informational only: direct-connect state, durable thread /
 * session ids, detach, and interrupt. Queue management (reorder / insert /
 * delete / edit) lives in the queue window above the composer instead.
 *
 * @module dsh-subagent-codex-plus/client/control-panel
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  movePanel,
  runGatewayAction,
  togglePanel,
  useGatewayView,
  usePanelState,
} from './gateway-store.ts'
import type { GatewaySessionView } from '../shared/types.ts'
import { PANEL_HOVER_CSS, THEME } from './theme.ts'

const PANEL_WIDTH = 340

const PANEL_STYLE = {
  position: 'fixed',
  zIndex: 9999,
  width: PANEL_WIDTH,
  boxSizing: 'border-box' as const,
  pointerEvents: 'auto' as const,
  borderRadius: 10,
  border: `1px solid ${THEME.borderStrong}`,
  background: THEME.surface,
  color: THEME.textPrimary,
  boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
  fontFamily: 'var(--dsh-font-sans, -apple-system, "PingFang SC", sans-serif)',
  fontSize: 13,
  overflow: 'hidden',
} as const

const SECTION = {
  padding: '10px 12px',
  borderTop: `1px solid ${THEME.borderSubtle}`,
} as const

const SECTION_TITLE = {
  color: THEME.textSecondary,
  fontSize: 11,
  fontWeight: 600,
  marginBottom: 6,
} as const

const BUTTON = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  height: 28,
  padding: '0 12px',
  borderRadius: 6,
  border: `1px solid ${THEME.borderStrong}`,
  background: THEME.buttonBg,
  color: THEME.textPrimary,
  fontSize: 12,
  cursor: 'pointer',
} as const

const DANGER_BUTTON = {
  ...BUTTON,
  borderColor: THEME.danger,
  color: THEME.danger,
} as const

const CLOSE_BUTTON = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 6,
  border: `1px solid ${THEME.borderStrong}`,
  background: THEME.buttonBg,
  color: THEME.textPrimary,
  fontSize: 15,
  lineHeight: 1,
  cursor: 'pointer',
} as const

const INPUT = {
  boxSizing: 'border-box' as const,
  width: '100%',
  height: 28,
  padding: '0 8px',
  borderRadius: 6,
  border: `1px solid ${THEME.borderStrong}`,
  background: THEME.surfaceInput,
  color: THEME.textPrimary,
  fontSize: 12,
} as const

function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 18)}…` : id
}

function statusBadge(view: GatewaySessionView | null): string {
  if (view?.attached) return view.running ? '运行中' : '空闲'
  return '未直连'
}

/** Floating gateway info window (shell.overlay entry, opened from the badge). */
export function ControlPanel(props: PropsRuntime<'shell.overlay'>) {
  const panel = usePanelState()
  const sessionId: string | undefined = props.useSessions((state) => state.current)
  const { view, loading, error: pollError } = useGatewayView(sessionId)
  const [attachThread, setAttachThread] = useState('')
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // The close button lives in the title bar; never capture a drag over it,
    // otherwise the synthetic click never reaches the button.
    if ((event.target as HTMLElement).closest('button') !== null) return
    drag.current = { dx: event.clientX - panel.x, dy: event.clientY - panel.y }
    ;(event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId)
  }, [panel.x, panel.y])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return
    movePanel(
      Math.max(0, Math.min(window.innerWidth - PANEL_WIDTH, event.clientX - drag.current.dx)),
      Math.max(0, event.clientY - drag.current.dy),
    )
  }, [])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    ;(event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId)
  }, [])

  const run = useCallback(async (
    action: (api: import('./api.ts').GatewayApi) => Promise<{ ok: boolean; error?: string }>,
  ): Promise<boolean> => {
    if (sessionId === undefined) return false
    const error = await runGatewayAction(sessionId, action)
    setActionError(error)
    return error === undefined
  }, [sessionId])

  if (!panel.open) return null

  return (
    <div
      role="dialog"
      aria-label="Codex 直连网关"
      style={{ ...PANEL_STYLE, left: panel.x, top: panel.y }}
    >
      <style>{PANEL_HOVER_CSS}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          cursor: 'grab',
          userSelect: 'none',
          borderBottom: `1px solid ${THEME.borderSubtle}`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="拖动移动窗口"
      >
        <span aria-hidden style={{ fontSize: 14 }}>🔗</span>
        <span style={{ fontWeight: 600 }}>Codex 直连网关</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          className="codex-plus-close"
          style={CLOSE_BUTTON}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => togglePanel(false)}
        >
          ✕
        </button>
      </div>

      {sessionId === undefined ? (
        <div style={SECTION}>当前没有选中会话。</div>
      ) : (
        <>
          <div style={SECTION}>
            <div style={SECTION_TITLE}>直连开关</div>
            {view?.attached === true ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ color: THEME.textSecondary, fontSize: 12, lineHeight: '18px' }}>
                  已直连线程 <code style={{ fontSize: 11 }}>{shortId(view.threadId ?? '')}</code>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="codex-plus-btn-danger"
                    style={DANGER_BUTTON}
                    onClick={() => { void run((api) => api.detach(sessionId)) }}
                  >
                    断开直连
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  style={INPUT}
                  placeholder="恢复已有线程 id（留空 = 新建）"
                  value={attachThread}
                  onChange={(event) => setAttachThread(event.currentTarget.value)}
                />
                <button
                  type="button"
                  className="codex-plus-btn"
                  style={{
                    ...BUTTON,
                    borderColor: THEME.accent,
                    background: THEME.accent,
                    color: '#fff',
                  }}
                  onClick={() => {
                    void run((api) => api.attach(sessionId, attachThread.trim() === '' ? undefined : attachThread.trim()))
                  }}
                >
                  {view?.threadId !== undefined ? '重新直连（已保存线程）' : '直连 Codex'}
                </button>
                {view?.threadId !== undefined && (
                  <div style={{ color: THEME.textTertiary, fontSize: 11 }}>
                    已保存线程 <code>{shortId(view.threadId)}</code>，重启后自动恢复
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={SECTION}>
            <div style={SECTION_TITLE}>信息</div>
            <div style={{ color: THEME.textSecondary, fontSize: 12, lineHeight: '20px' }}>
              会话 <code style={{ fontSize: 11 }}>{shortId(sessionId)}</code>
              {loading && ' · 载入中'}
            </div>
            <div style={{ color: THEME.textSecondary, fontSize: 12, lineHeight: '20px' }}>
              状态：{statusBadge(view)}{view?.attached === true ? ` · 队列 ${view.queue.length}` : ''}
            </div>
          </div>

          {(actionError ?? pollError) !== undefined && (
            <div style={{ ...SECTION, color: THEME.danger, fontSize: 11 }}>
              {actionError ?? pollError}
            </div>
          )}
        </>
      )}
    </div>
  )
}
