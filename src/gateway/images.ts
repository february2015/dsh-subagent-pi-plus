/**
 * Resolve dsh image blocks to Codex `localImage` inputs (Q3).
 *
 * dsh stores images as opaque content-addressed attachment refs; the resolver
 * reads the bytes through `ctx.attachments`, materializes them under a
 * per-gateway temp directory, and hands the local path to the app-server
 * (`localImage`, protocol-verified). Images pass through untouched: visual
 * understanding is handled by the hosts' shared `ocgw-vision` skill (TeamAI),
 * not by this plugin.
 *
 * @module dsh-subagent-codex-plus/gateway/images
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GatewayLocalImageInput } from './wire.ts'

const MEDIA_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** Map a dsh media type to a file extension (falls back to `.img`). */
export function mediaTypeExt(mediaType: string): string {
  return MEDIA_EXT[mediaType] ?? '.img'
}

/** One resolved image: the Codex input block. */
export interface ResolvedImage {
  readonly input: GatewayLocalImageInput
}

/** Materializes dsh attachment bytes into Codex-local image files. */
export class GatewayImageResolver {
  private dir: string | undefined
  private index = 0

  constructor(private readonly ctx: Context) {}

  /**
   * Read one attachment and stage it for the app-server.
   * @param attachment - durable ref from the dsh message block.
   */
  async resolve(attachment: ImageAttachmentRef): Promise<ResolvedImage> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('gateway: attachments service is not available; image passthrough disabled')
    }
    const stored = await attachments.readImage(attachment)
    const dir = await this.ensureDir()
    this.index += 1
    const id = String(attachment.attachmentId).slice(0, 12)
    const path = join(dir, `img-${this.index}-${id}${mediaTypeExt(attachment.mediaType)}`)
    await writeFile(path, stored.data)
    return { input: { type: 'localImage', path } }
  }

  /** Remove the staged image directory (idempotent). */
  async dispose(): Promise<void> {
    if (this.dir === undefined) return
    await rm(this.dir, { recursive: true, force: true })
    this.dir = undefined
  }

  private async ensureDir(): Promise<string> {
    if (this.dir !== undefined) return this.dir
    this.dir = await mkdtemp(join(tmpdir(), 'dsh-codex-plus-img-'))
    return this.dir
  }
}
