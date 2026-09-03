/**
 * Shared gateway input types. The Pi gateway accepts text blocks and image
 * blocks; images are materialized to local files by the resolver and
 * re-encoded to Pi's base64 `image` content at command time.
 *
 * @module dsh-subagent-pi-plus/gateway/wire
 */

/** Text input accepted by every Pi message verb. */
export interface GatewayTextInput {
  readonly type: 'text'
  readonly text: string
  readonly text_elements: readonly unknown[]
}

/** Local-path image input (resolved from a dsh attachment). */
export interface GatewayLocalImageInput {
  readonly type: 'localImage'
  readonly path: string
}

/** Remote-URL image input. */
export interface GatewayImageInput {
  readonly type: 'image'
  readonly url: string
}

export type GatewayUserInput =
  | GatewayTextInput
  | GatewayLocalImageInput
  | GatewayImageInput
