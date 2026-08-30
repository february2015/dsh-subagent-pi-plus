/**
 * Wire types shared by the gateway host UI service (`src/gateway/ui.ts`)
 * and the browser client (`src/client/*`). Pure data interfaces with zero
 * imports so both compile units can consume them safely.
 *
 * @module dsh-subagent-pi/shared/types
 */

/** One queued Pi message as the browser sees it. */
export interface GatewayQueueItemView {
  /** Locally-held queue item id. */
  readonly id: string
  /** Human-readable text of the queued message. */
  readonly text: string
}

/** One durable dsh session ↔ Pi session binding. */
export interface GatewayBindingView {
  readonly sessionId: string
  readonly piSessionId: string
}

/** Per-session gateway state snapshot. */
export interface GatewaySessionView {
  readonly sessionId: string
  /** Whether this session is currently attached (live gateway). */
  readonly attached: boolean
  /** Durable Pi session id when attached or bound. */
  readonly threadId?: string
  /** PiGateway phase: stopped | starting | ready | failed. */
  readonly phase: string
  /** Whether a Pi run is currently active. */
  readonly running: boolean
  /** Pending locally-held queue (FIFO order). */
  readonly queue: readonly GatewayQueueItemView[]
  /** Last action error surfaced to the UI, if any. */
  readonly error?: string
}

/** Response of `GET /api/pi-plus/state`. */
export interface GatewayStateResponse {
  readonly ok: true
  /** State of the requested session, or null when it is not live. */
  readonly session: GatewaySessionView | null
  /** Every durable binding (for cross-session display). */
  readonly bindings: readonly GatewayBindingView[]
}

/** Response of any `/api/pi-plus/*` action. */
export interface GatewayActionResponse {
  readonly ok: boolean
  readonly error?: string
  /** Refreshed session state after the action, when a session was addressed. */
  readonly session?: GatewaySessionView | null
}

/** Request body of `POST /api/pi-plus/attach`. */
export interface GatewayAttachRequest {
  readonly sessionId: string
  /** Optional existing Pi session to resume; absent creates one. */
  readonly threadId?: string
}

/** Request body of session-addressed actions. */
export interface GatewaySessionRequest {
  readonly sessionId: string
}

/** Request body of `POST /api/pi-plus/queue/delete`. */
export interface GatewayQueueDeleteRequest extends GatewaySessionRequest {
  readonly id: string
}

/** Request body of `POST /api/pi-plus/queue/update`. */
export interface GatewayQueueUpdateRequest extends GatewaySessionRequest {
  /** Queue item id whose text is replaced. */
  readonly id: string
  /** New text for the queued message. */
  readonly text: string
}

/** Request body of `POST /api/pi-plus/queue/reorder`. */
export interface GatewayQueueReorderRequest extends GatewaySessionRequest {
  /** New FIFO order of queue item ids. */
  readonly ids: readonly string[]
}

/** Request body of `POST /api/pi-plus/steer`. */
export interface GatewaySteerRequest extends GatewaySessionRequest {
  /** Text inserted directly into the active run (not queued). */
  readonly text: string
}
