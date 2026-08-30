/**
 * DSH semantic color tokens for the floating gateway windows. The variable
 * names below are the ones the Harness actually defines (light/dark switch
 * automatically); earlier code used non-existent aliases (`surface-raised`,
 * `stroke-strong`, …) whose fallbacks forced white-on-white in dark mode.
 * Fallbacks are chosen for dark mode since that is where they matter most.
 *
 * @module dsh-subagent-codex-plus/client/theme
 */

export const THEME = {
  /** Panel / card surface. */
  surface: 'var(--dsw-alias-bg-layer-1, #232324)',
  /** Input surface (slightly lighter). */
  surfaceInput: 'var(--dsw-alias-bg-layer-2, #2c2c2e)',
  /** Primary text. */
  textPrimary: 'var(--dsw-alias-label-primary, #f9fafb)',
  /** Secondary text. */
  textSecondary: 'var(--dsw-alias-label-secondary, #cfd3d6)',
  /** Tertiary / muted text. */
  textTertiary: 'var(--dsw-alias-label-tertiary, #adb2b8)',
  /** Strong border (panel outline). */
  borderStrong: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
  /** Subtle border (section separators). */
  borderSubtle: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
  /** Default button fill. */
  buttonBg: 'var(--dsw-alias-button-floating-fill, #2c2c2e)',
  /** Raised button fill. */
  buttonBgStrong: 'var(--dsw-alias-button-elevated-fill, #43454a)',
  /** Accent / primary action. */
  accent: 'var(--dsw-alias-state-business-primary, #679efe)',
  /** Danger / destructive action. */
  danger: 'var(--dsw-alias-state-error-secondary, #f25a5a)',
  /** Plain hover overlay. */
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))',
  /** Danger hover overlay. */
  hoverDanger: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(242,90,90,0.16))',
} as const

/** Injected once per floating window; inline styles cannot express `:hover`. */
export const PANEL_HOVER_CSS = `
.codex-plus-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)) !important; }
.codex-plus-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(242,90,90,0.16)) !important; }
.codex-plus-close:hover { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(242,90,90,0.16)) !important; color: var(--dsw-alias-state-error-secondary, #f25a5a) !important; }
`
