/**
 * Legacy image-helper module (R5): the vision bridge was removed — images
 * pass through undescribed, and visual understanding is handled by the hosts'
 * shared `ocgw-vision` skill (TeamAI). Only `mediaTypeExt` is kept here to
 * satisfy the probe mirror's import chain.
 */
const MEDIA_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}
/** Map a dsh media type to a file extension (falls back to `.img`). */
export function mediaTypeExt(mediaType) {
  return MEDIA_EXT[mediaType] ?? '.img'
}
