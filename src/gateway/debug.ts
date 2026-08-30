/**
 * Diagnostic sink for the Pi gateway. Writes one line at a time to
 * `$DSH_SUBAGENT_PI_DEBUG_LOG` (default `$TMPDIR/pi-gateway-debug.log`)
 * only when `DSH_SUBAGENT_PI_DEBUG=1` is set, so production runs stay
 * quiet and the trail is available on demand.
 *
 * @module dsh-subagent-pi/gateway/debug
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const enabled = process.env.DSH_SUBAGENT_PI_DEBUG === '1'
const file =
  process.env.DSH_SUBAGENT_PI_DEBUG_LOG ??
  join(tmpdir(), 'pi-gateway-debug.log')

/** Append one diagnostic line when the debug switch is on. */
export function debugLog(line: string): void {
  if (!enabled) return
  try {
    appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`)
  } catch { /* diagnostic sink */ }
}
