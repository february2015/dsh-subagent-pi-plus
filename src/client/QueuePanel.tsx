/**
 * Floating queue window for the Codex true-gateway, seated in the official
 * `shell.overlay` layer. Anchored just above the composer, it lists pending
 * Codex queue submissions in FIFO order and offers the standard operations:
 * promote to front, insert (steer) into the active turn, delete, and edit.
 * It appears automatically whenever the queue is non-empty and hides when it
 * drains.
 *
 * @module dsh-subagent-codex-plus/client/queue-panel
 */

import { useCallback, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { runGatewayAction, useGatewayView } from './gateway-store.ts'
import { PANEL_HOVER_CSS, THEME } from './theme.ts'

/** Locate the chat composer textarea to anchor the window above it. */
function chatInputRect(): { left: number; width: number; top: number } | null {
  const candidates = [...document.querySelectorAll('textarea')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 400 && x.r.top > window.innerHeight * 0.4)
    .sort((a, b) => b.r.width - a.r.width)
  const best = candidates[0]
  if (best === undefined) return null
  return { left: best.r.left, width: best.r.width, top: best.r.top }
}

const PANEL_STYLE = {
  position: 'fixed',
  zIndex: 9998,
  boxSizing: 'border-box' as const,
  pointerEvents: 'auto' as const,
  borderRadius: 10,
  border: `1px solid ${THEME.borderStrong}`,
  background: THEME.surface,
  color: THEME.textPrimary,
  boxShadow: '0 8px 28px rgba(0,0,0,0.35)',
  fontFamily: 'var(--dsh-font-sans, -apple-system, "PingFang SC", sans-serif)',
  fontSize: 12,
  overflow: 'hidden',
} as const

const HEADER = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderBottom: `1px solid ${THEME.borderSubtle}`,
  color: THEME.textSecondary,
  fontSize: 11,
  fontWeight: 600,
} as const

const ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderTop: `1px solid ${THEME.borderSubtle}`,
} as const

const TEXT = {
  flex: '1 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  fontSize: 12,
  lineHeight: '18px',
  minWidth: 0,
} as const

const ICON_BUTTON = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 22,
  borderRadius: 5,
  border: `1px solid ${THEME.borderStrong}`,
  background: THEME.buttonBg,
  color: THEME.textPrimary,
  fontSize: 11,
  lineHeight: 1,
  cursor: 'pointer',
  flex: '0 0 auto',
} as const

const TEXT_BUTTON = {
  ...ICON_BUTTON,
  width: 'auto',
  padding: '0 8px',
  fontSize: 11,
} as const

const DANGER_TEXT = {
  ...TEXT_BUTTON,
  borderColor: THEME.danger,
  color: THEME.danger,
} as const

const FOOTER = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderTop: `1px solid ${THEME.borderSubtle}`,
} as const

const EDIT_INPUT = {
  boxSizing: 'border-box' as const,
  flex: '1 1 auto',
  minWidth: 0,
  height: 24,
  padding: '0 6px',
  borderRadius: 5,
  border: `1px solid ${THEME.borderStrong}`,
  background: THEME.surfaceInput,
  color: THEME.textPrimary,
  fontSize: 12,
}

/** Floating queue window anchored above the composer (shell.overlay entry). */
export function QueuePanel(props: PropsRuntime<'shell.overlay'>) {
  const sessionId: string | undefined = props.useSessions((state) => state.current)
  const { view } = useGatewayView(sessionId)
  const [anchor, setAnchor] = useState<{ left: number; width: number; top: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  const refreshAnchor = useCallback(() => setAnchor(chatInputRect()), [])
  useEffect(() => {
    refreshAnchor()
    window.addEventListener('resize', refreshAnchor)
    window.addEventListener('scroll', refreshAnchor, true)
    return () => {
      window.removeEventListener('resize', refreshAnchor)
      window.removeEventListener('scroll', refreshAnchor, true)
    }
  }, [refreshAnchor])

  const run = useCallback(async (
    action: (api: import('./api.ts').GatewayApi) => Promise<{ ok: boolean; error?: string }>,
  ): Promise<boolean> => {
    if (sessionId === undefined) return false
    const error = await runGatewayAction(sessionId, action)
    setActionError(error)
    return error === undefined
  }, [sessionId])

  const queue = view?.attached === true ? view.queue : []
  if (queue.length === 0 || anchor === null) return null

  const promote = async (index: number): Promise<void> => {
    if (index === 0 || sessionId === undefined) return
    const ids = queue.map((item) => item.id)
    const [moved] = ids.splice(index, 1)
    if (moved === undefined) return
    ids.unshift(moved)
    await run((api) => api.queueReorder(sessionId, ids))
  }

  const insertNow = async (item: { id: string; text: string }): Promise<void> => {
    if (sessionId === undefined) return
    const ok = await run((api) => api.steer(sessionId, item.text))
    if (ok) await run((api) => api.queueDelete(sessionId, item.id))
  }

  const saveEdit = async (item: { id: string }): Promise<void> => {
    const text = editText.trim()
    if (text === '' || sessionId === undefined) return
    const ok = await run((api) => api.queueUpdate(sessionId, item.id, text))
    if (ok) {
      setEditingId(null)
      setEditText('')
    }
  }

  const bottom = Math.max(8, window.innerHeight - anchor.top + 8)
  const maxHeight = Math.max(120, anchor.top - 24)

  return (
    <div
      role="region"
      aria-label="Codex 排队消息"
      style={{
        ...PANEL_STYLE,
        left: anchor.left,
        width: anchor.width,
        bottom,
        maxHeight,
      }}
    >
      <style>{PANEL_HOVER_CSS}</style>
      <div style={HEADER}>
        <span aria-hidden>⏳</span>
        <span>排队消息（{queue.length}）</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontWeight: 400 }}>置顶 · 插入 · 编辑 · 删除</span>
      </div>
      <div style={{ maxHeight: Math.max(0, maxHeight - 36), overflowY: 'auto' }}>
        {queue.map((item, index) => (
          <div key={item.id} style={ROW}>
            <span
              style={{
                flex: '0 0 auto',
                width: 18,
                color: THEME.textTertiary,
                fontSize: 11,
                textAlign: 'center',
              }}
            >
              {index + 1}
            </span>
            {editingId === item.id ? (
              <>
                <input
                  style={EDIT_INPUT}
                  value={editText}
                  onChange={(event) => setEditText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { void saveEdit(item) }
                    if (event.key === 'Escape') { setEditingId(null); setEditText('') }
                  }}
                  autoFocus
                />
                <button type="button" className="codex-plus-btn" style={ICON_BUTTON} title="保存" onClick={() => { void saveEdit(item) }}>✓</button>
                <button type="button" className="codex-plus-btn" style={ICON_BUTTON} title="取消" onClick={() => { setEditingId(null); setEditText('') }}>✕</button>
              </>
            ) : (
              <>
                <span style={TEXT} title={item.text}>{item.text}</span>
                <button
                  type="button"
                  className="codex-plus-btn"
                  style={TEXT_BUTTON}
                  title="置顶"
                  disabled={index === 0}
                  onClick={() => { void promote(index) }}
                >
                  置顶
                </button>
                <button
                  type="button"
                  className="codex-plus-btn"
                  style={TEXT_BUTTON}
                  title="直接插入当前回合"
                  onClick={() => { void insertNow(item) }}
                >
                  插入
                </button>
                <button
                  type="button"
                  className="codex-plus-btn"
                  style={TEXT_BUTTON}
                  title="编辑"
                  onClick={() => { setEditingId(item.id); setEditText(item.text) }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="codex-plus-btn-danger"
                  style={DANGER_TEXT}
                  title="删除"
                  onClick={() => { void run((api) => api.queueDelete(sessionId!, item.id)) }}
                >
                  删除
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {view?.attached === true && view.running && (
        <div style={FOOTER}>
          <button
            type="button"
            className="codex-plus-btn-danger"
            style={{
              ...ICON_BUTTON,
              width: 'auto',
              padding: '0 10px',
              borderColor: THEME.danger,
              color: THEME.danger,
            }}
            title="中断当前 Codex 回合"
            onClick={() => { void run((api) => api.cancel(sessionId!)) }}
          >
            中断当前
          </button>
          <span style={{ flex: 1 }} />
          <span style={{ color: THEME.textTertiary, fontSize: 11 }}>
            排队消息在 Codex 忙时自动入队
          </span>
        </div>
      )}
      {actionError !== undefined && (
        <div style={{ padding: '6px 12px', color: THEME.danger, fontSize: 11, borderTop: `1px solid ${THEME.borderSubtle}` }}>
          {actionError}
        </div>
      )}
    </div>
  )
}
