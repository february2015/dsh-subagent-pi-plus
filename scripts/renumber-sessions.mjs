#!/usr/bin/env node
/**
 * Repair dsh session logs whose `turn` ordinals restart after a process
 * restart (dsh-subagent-codex-plus bug: the forwarder began numbering from 1
 * every boot, so a durable log ended up with duplicate turn numbers). The
 * Harness front-end conversation assembler rejects a second `start` match for
 * the same context ("received more than one start Match") and hides the whole
 * conversation.
 *
 * The `.jsonl.zstd` artifact is a CONCATENATION of independently compressed,
 * checksummed zstd frames (first frame = header line, then one frame per
 * durable append batch). Migration must therefore preserve frame boundaries:
 * each frame is decoded, its events renumbered, and re-encoded as its own
 * frame. A torn trailing frame is left untouched.
 *
 * Strategy: walk each session's events in order and treat every `turn/start`
 * as a NEW turn instance (regardless of its recorded ordinal), assigning a
 * monotonic replacement number. Every later event carrying `data.turn`
 * belongs to the currently open instance, so its number is rewritten with the
 * instance's replacement. Order and surface metadata are untouched.
 *
 * Usage:
 *   node scripts/renumber-sessions.mjs [--dry-run] [--sessions-dir DIR]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DRY_RUN = process.argv.includes('--dry-run')
const dirIndex = process.argv.indexOf('--sessions-dir')
const SESSIONS_DIR = dirIndex >= 0 && process.argv[dirIndex + 1]
  ? process.argv[dirIndex + 1]
  : join(homedir(), '.dsh', 'sessions')

const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const ZSTD_MAGIC = 4247762216 // 0xFD2FB528

/** Locate complete zstd frame ranges (mirror of dsh-session-persistence-jsonl). */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if ((descriptor & 4) !== 0) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

// Turn-instance state shared across the frames of one session.
let nextTurn = 0
const instanceOf = new Map()

function resetTurnState() {
  nextTurn = 0
  instanceOf.clear()
}

/** Rewrite turn ordinals inside one decoded frame. */
function renumberFrame(text) {
  const lines = text.split('\n')
  let changes = 0
  const out = []
  for (const line of lines) {
    if (line.trim() === '') {
      out.push(line)
      continue
    }
    const row = JSON.parse(line)
    const data = row.data
    if (data === null || typeof data !== 'object' || typeof data.turn !== 'number') {
      out.push(line)
      continue
    }
    let rewritten = false
    if (row.type === 'turn/start') {
      nextTurn += 1
      instanceOf.set(data.turn, nextTurn)
      if (data.turn !== nextTurn) {
        data.turn = nextTurn
        rewritten = true
      }
    } else {
      const replacement = instanceOf.get(data.turn)
      if (replacement !== undefined && data.turn !== replacement) {
        data.turn = replacement
        rewritten = true
      }
    }
    if (rewritten) {
      changes += 1
      out.push(JSON.stringify(row))
    } else {
      out.push(line)
    }
  }
  return { text: out.join('\n'), changes }
}

function isPolluted(rows) {
  const seen = new Set()
  for (const row of rows) {
    if (row.type === 'turn/start' && typeof row.data?.turn === 'number') {
      if (seen.has(row.data.turn)) return true
      seen.add(row.data.turn)
    }
  }
  return false
}

async function main() {
  if (!existsSync(SESSIONS_DIR)) {
    console.error(`sessions dir not found: ${SESSIONS_DIR}`)
    process.exit(1)
  }
  const projects = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  let dirty = 0
  for (const project of projects) {
    const projectDir = join(SESSIONS_DIR, project.name)
    const sessions = readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    for (const session of sessions) {
      const file = join(projectDir, session.name, 'session.jsonl.zstd')
      if (!existsSync(file)) continue
      const raw = readFileSync(file)
      const { frames, tornStart } = scanZstdFrames(raw)
      resetTurnState()
      let fullText = ''
      for (const frame of frames) {
        fullText += zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString()
      }
      const rows = fullText.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
      if (!isPolluted(rows)) {
        console.log(`OK   ${project.name}/${session.name}`)
        continue
      }
      resetTurnState()
      const parts = []
      let changes = 0
      for (const frame of frames) {
        const decoded = zstdDecompressSync(raw.subarray(frame.start, frame.end)).toString()
        const { text, changes: frameChanges } = renumberFrame(decoded)
        changes += frameChanges
        parts.push(zstdCompressSync(Buffer.from(text), CHECKSUM_OPTIONS))
      }
      console.log(`DIRTY ${project.name}/${session.name} (rewrites ${changes} rows)`)
      dirty += 1
      if (DRY_RUN) continue
      const backup = `${file}.bak-${Date.now()}`
      renameSync(file, backup)
      let out = Buffer.concat(parts)
      if (tornStart !== undefined) {
        out = Buffer.concat([out, raw.subarray(tornStart)])
      }
      writeFileSync(file, out)
      console.log(`  -> rewrote ${file}`)
      console.log(`  -> backup ${backup}`)
    }
  }
  console.log(DRY_RUN ? `dry-run: ${dirty} dirty session(s), no files modified` : `done: ${dirty} dirty session(s) repaired`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
