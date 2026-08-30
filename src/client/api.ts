/**
 * Browser half of the gateway API: same-origin JSON endpoints under
 * `/api/codex-plus/*`. Plain `fetch`; the host webserver's authority checks
 * gate the `/api` prefix, so a remote or untrusted origin cannot reach it.
 *
 * @module dsh-subagent-codex-plus/client/api
 */

import type {
  GatewayActionResponse,
  GatewayStateResponse,
} from '../shared/types.ts'

/** Browser-facing gateway API. */
export interface GatewayApi {
  state(sessionId: string): Promise<GatewayStateResponse>
  attach(sessionId: string, threadId?: string): Promise<GatewayActionResponse>
  detach(sessionId: string): Promise<GatewayActionResponse>
  queueDelete(sessionId: string, id: string): Promise<GatewayActionResponse>
  queueUpdate(sessionId: string, id: string, text: string): Promise<GatewayActionResponse>
  queueReorder(sessionId: string, ids: readonly string[]): Promise<GatewayActionResponse>
  steer(sessionId: string, text: string): Promise<GatewayActionResponse>
  cancel(sessionId: string): Promise<GatewayActionResponse>
}

const BASE = '/api/codex-plus'

/** GET JSON (no body). */
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`)
  }
  return (await response.json()) as T
}

/** POST JSON. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`)
  }
  return (await response.json()) as T
}

/** The live host API instance (failures surface per call). */
export function makeGatewayApi(): GatewayApi {
  return {
    state: (sessionId) => getJson(`${BASE}/state?session=${encodeURIComponent(sessionId)}`),
    attach: (sessionId, threadId) => postJson(`${BASE}/attach`, { sessionId, ...threadId === undefined ? {} : { threadId } }),
    detach: (sessionId) => postJson(`${BASE}/detach`, { sessionId }),
    queueDelete: (sessionId, id) => postJson(`${BASE}/queue/delete`, { sessionId, id }),
    queueUpdate: (sessionId, id, text) => postJson(`${BASE}/queue/update`, { sessionId, id, text }),
    queueReorder: (sessionId, ids) => postJson(`${BASE}/queue/reorder`, { sessionId, ids }),
    steer: (sessionId, text) => postJson(`${BASE}/steer`, { sessionId, text }),
    cancel: (sessionId) => postJson(`${BASE}/cancel`, { sessionId }),
  }
}
