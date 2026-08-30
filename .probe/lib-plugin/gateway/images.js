/**
 * Resolve dsh image blocks to Codex `localImage` inputs (Q3), optionally with
 * a GLM vision description injected as text alongside the image (R4).
 *
 * dsh stores images as opaque content-addressed attachment refs; the resolver
 * reads the bytes through `ctx.attachments`, materializes them under a
 * per-gateway temp directory, and hands the local path to the app-server
 * (`localImage`, protocol-verified). When the vision bridge is configured,
 * the bytes are also described and the description text is appended after the
 * image input so Codex's model sees both.
 *
 * @module dsh-subagent-codex-plus/gateway/images
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaTypeExt } from "./vision.js";
/** Materializes dsh attachment bytes into Codex-local image files. */
export class GatewayImageResolver {
    ctx;
    dir;
    index = 0;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /**
     * Read one attachment and stage it for the app-server.
     * @param attachment - durable ref from the dsh message block.
     * @param vision - optional vision bridge; when present, describe the image.
     */
    async resolve(attachment, vision) {
        const stored = await this.ctx.attachments.readImage(attachment);
        const dir = await this.ensureDir();
        this.index += 1;
        const id = String(attachment.attachmentId).slice(0, 12);
        const path = join(dir, `img-${this.index}-${id}${mediaTypeExt(attachment.mediaType)}`);
        await writeFile(path, stored.data);
        const description = vision === undefined
            ? undefined
            : await vision.describe(stored.data, attachment.mediaType);
        return {
            input: { type: 'localImage', path },
            ...description === undefined ? {} : { description },
        };
    }
    /** Remove the staged image directory (idempotent). */
    async dispose() {
        if (this.dir === undefined)
            return;
        await rm(this.dir, { recursive: true, force: true });
        this.dir = undefined;
    }
    async ensureDir() {
        if (this.dir !== undefined)
            return this.dir;
        this.dir = await mkdtemp(join(tmpdir(), 'dsh-codex-plus-img-'));
        return this.dir;
    }
}
