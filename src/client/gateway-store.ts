/**
 * Browser-side gateway store: per-session state snapshots polled from the
 * host plus the floating-window visibility/position controller. Plain
 * module singletons + `useSyncExternalStore`; components never own the
 * polling lifecycle (the last subscriber for a session stops its timer).
 *
 * @module dsh-subagent-codex-plus/client/gateway-store
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { GatewayApi } from './api.ts'
import type { GatewaySessionView } from '../shared/types.ts'

/** One session's snapshot entry. */
export interface GatewayViewEntry {
  readonly view: GatewaySessionView | null
  readonly loading: boolean
  readonly error?: string
}

const EMPTY: GatewayViewEntry = { view: null, loading: true }

const POLL_MS = 600

let api: GatewayApi | undefined
const entries = new Map<string, GatewayViewEntry>()
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setInterval>>()
const refcounts = new Map<string, number>()

function emit(): void {
  for (const listener of listeners) listener()
}

function setEntry(sessionId: string, entry: GatewayViewEntry): void {
  entries.set(sessionId, entry)
  emit()
}

function poll(sessionId: string): void {
  const current = api
  if (current === undefined) return
  current.state(sessionId).then(
    (response) => {
      setEntry(sessionId, { view: response.session, loading: false })
    },
    (error: unknown) => {
      setEntry(sessionId, {
        view: null,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  )
}

function subscribe(sessionId: string | undefined, onChange: () => void): () => void {
  if (sessionId === undefined) return () => {}
  listeners.add(onChange)
  const count = (refcounts.get(sessionId) ?? 0) + 1
  refcounts.set(sessionId, count)
  if (!timers.has(sessionId)) {
    poll(sessionId)
    timers.set(sessionId, setInterval(() => poll(sessionId), POLL_MS))
  }
  return () => {
    listeners.delete(onChange)
    const next = (refcounts.get(sessionId) ?? 1) - 1
    if (next <= 0) {
      refcounts.delete(sessionId)
      const timer = timers.get(sessionId)
      if (timer !== undefined) {
        clearInterval(timer)
        timers.delete(sessionId)
      }
    } else {
      refcounts.set(sessionId, next)
    }
  }
}

/** Set the live API instance (client apply body). */
export function setGatewayApi(instance: GatewayApi): void {
  api = instance
}

/** Subscribe a React component to one session's gateway snapshot. */
export function useGatewayView(sessionId: string | undefined): GatewayViewEntry {
  const subscribeToSession = useCallback(
    (onChange: () => void) => subscribe(sessionId, onChange),
    [sessionId],
  )
  return useSyncExternalStore(
    subscribeToSession,
    () => (sessionId === undefined ? EMPTY : entries.get(sessionId) ?? EMPTY),
  )
}

/** Force an immediate poll (after an action). */
export function refreshGateway(sessionId: string): void {
  poll(sessionId)
}

/** Run one host action, refresh the session view, and return the error text. */
export async function runGatewayAction(
  sessionId: string,
  action: (instance: GatewayApi) => Promise<GatewayActionLike>,
): Promise<string | undefined> {
  const current = api
  if (current === undefined) return 'gateway api unavailable'
  try {
    const result = await action(current)
    if (!result.ok) return result.error ?? 'gateway action failed'
    refreshGateway(sessionId)
    return undefined
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Structural subset of GatewayActionResponse for the action helper. */
interface GatewayActionLike {
  readonly ok: boolean
  readonly error?: string
}

/** Floating-window visibility and position (module singleton). */
export interface PanelState {
  readonly open: boolean
  readonly x: number
  readonly y: number
  /** Whether the user has dragged the window; default anchors to chat top. */
  readonly userMoved: boolean
}

const PANEL_KEY = 'dsh-codex-plus-panel'
const PANEL_WIDTH = 320

/** Default anchor: top-right of the chat column when no user position yet. */
function chatAnchor(): { x: number; y: number } {
  try {
    const column = document.querySelector('[class$="_centerCol"]') as HTMLElement | null
    if (column !== null) {
      const rect = column.getBoundingClientRect()
      return {
        x: Math.max(8, Math.round(rect.right - PANEL_WIDTH - 16)),
        y: Math.max(8, Math.round(rect.top + 8)),
      }
    }
  } catch {
    // Fall through to the plain default.
  }
  return { x: 24, y: 16 }
}

function loadPanel(): PanelState {
  try {
    const raw = localStorage.getItem(PANEL_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<PanelState>
      if (typeof parsed.open === 'boolean' && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return { open: parsed.open, x: parsed.x, y: parsed.y, userMoved: parsed.userMoved === true }
      }
    }
  } catch {
    // Unreadable storage: fall back to defaults.
  }
  return { open: false, x: 24, y: 16, userMoved: false }
}

let panel = loadPanel()
const panelListeners = new Set<() => void>()

function emitPanel(): void {
  for (const listener of panelListeners) listener()
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panel))
  } catch {
    // Storage may be unavailable; the panel still works for this session.
  }
}

/** Toggle the floating control window. */
export function togglePanel(open?: boolean): void {
  const next = open ?? !panel.open
  if (next && !panel.open) {
    // Clamp back into the viewport: a stale persisted position can leave the
    // window off-screen where its controls are unreachable.
    const maxX = Math.max(0, window.innerWidth - PANEL_WIDTH)
    const maxY = Math.max(0, window.innerHeight - 120)
    const base = panel.userMoved ? panel : chatAnchor()
    panel = {
      x: Math.min(Math.max(base.x, 0), maxX),
      y: Math.min(Math.max(base.y, 0), maxY),
      userMoved: panel.userMoved,
      open: next,
    }
  } else {
    panel = { ...panel, open: next }
  }
  emitPanel()
}

/** Move the floating control window (drag). */
export function movePanel(x: number, y: number): void {
  panel = { ...panel, x, y, userMoved: true }
  emitPanel()
}

/** Subscribe to the panel state. */
export function usePanelState(): PanelState {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => {
      panelListeners.add(onChange)
      return () => {
        panelListeners.delete(onChange)
      }
    }, []),
    () => panel,
  )
}
