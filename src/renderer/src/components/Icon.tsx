import type { JSX } from 'react'

/**
 * Icon set.
 *
 * Hand-written inline SVG rather than an icon package. The app needs roughly
 * thirty glyphs, and a dependency would add weight (and a supply-chain surface)
 * to local-first financial software for no benefit. Every icon is drawn on a
 * 24x24 grid with `currentColor` and a 1.75 stroke so they sit consistently
 * beside text.
 */

export type IconName =
  | 'dashboard'
  | 'transactions'
  | 'accounts'
  | 'statistics'
  | 'budget'
  | 'subscriptions'
  | 'settings'
  | 'search'
  | 'plus'
  | 'import'
  | 'export'
  | 'trash'
  | 'edit'
  | 'close'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'check'
  | 'alert'
  | 'info'
  | 'wallet'
  | 'banknote'
  | 'landmark'
  | 'credit-card'
  | 'circle'
  | 'tag'
  | 'utensils'
  | 'car'
  | 'shopping-bag'
  | 'home'
  | 'gamepad'
  | 'book'
  | 'heart-pulse'
  | 'plane'
  | 'receipt'
  | 'repeat'
  | 'ellipsis'
  | 'briefcase'
  | 'laptop'
  | 'trending-up'
  | 'gift'
  | 'undo'
  | 'arrow-right'
  | 'arrow-left-right'
  | 'calendar'
  | 'database'
  | 'shield'
  | 'sun'
  | 'moon'
  | 'palette'
  | 'inbox'
  | 'refresh'
  | 'candlestick'
  | 'pie-chart'

/** Path data per icon. Single-path icons keep the renderer simple. */
const PATHS: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
  transactions: 'M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3',
  accounts: 'M3 10h18M5 10V6h14v4M5 10v8M19 10v8M3 18h18M9 14h6',
  statistics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  budget: 'M12 3a9 9 0 1 0 9 9h-9z M12 3v9h9A9 9 0 0 0 12 3z',
  subscriptions: 'M4 5h16v14H4zM4 10h16M8 15h4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.2a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  import: 'M12 3v12M8 11l4 4 4-4M4 19h16',
  export: 'M12 21V9M8 13l4-4 4 4M4 5h16',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  edit: 'M4 20h4l10-10-4-4L4 16v4zM14 6l4 4',
  close: 'M6 6l12 12M18 6L6 18',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  check: 'M4 12l5 5L20 6',
  alert: 'M12 3l9 16H3l9-16zM12 10v4M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8h.01M11 12h1v5h1',
  wallet: 'M3 7h18v12H3zM3 7l3-3h12l3 3M16 13h2',
  banknote: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 9v.01M19 15v.01',
  landmark: 'M3 21h18M4 21V10M9 21V10M15 21V10M20 21V10M2 10h20L12 3 2 10z',
  'credit-card': 'M2 6h20v12H2zM2 10h20M6 15h4',
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  tag: 'M3 12V4h8l10 10-8 8-10-10zM7.5 7.5h.01',
  utensils: 'M5 3v8a2 2 0 0 0 4 0V3M7 11v10M16 3c-1.5 2-1.5 5 0 6v12',
  car: 'M5 17h14M4 17v-5l2-5h12l2 5v5M6 17v2M18 17v2M7 12h10',
  'shopping-bag': 'M5 8h14l1 12H4L5 8zM9 8V6a3 3 0 0 1 6 0v2',
  home: 'M3 11l9-8 9 8M6 10v10h12V10M10 20v-6h4v6',
  gamepad: 'M7 12h4M9 10v4M16 11h.01M18 13h.01M6 7h12a4 4 0 0 1 4 4v4a4 4 0 0 1-7 2H9a4 4 0 0 1-7-2v-4a4 4 0 0 1 4-4z',
  book: 'M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z',
  'heart-pulse': 'M20.8 6.6a5 5 0 0 0-7.1 0L12 8.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 22l8.8-8.3a5 5 0 0 0 0-7.1zM3.5 12h4l1.5-3 2 5 1.5-2h3',
  plane: 'M10 21l2-6 8-3-1-2-8 2-4-6-2 1 2 6-4 1 1 2 4-1z',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  repeat: 'M4 10V8a3 3 0 0 1 3-3h10l-3-3M20 14v2a3 3 0 0 1-3 3H7l3 3',
  ellipsis: 'M6 12h.01M12 12h.01M18 12h.01',
  briefcase: 'M3 8h18v12H3zM8 8V5h8v3M3 13h18',
  laptop: 'M5 5h14v10H5zM2 19h20l-1-2H3z',
  'trending-up': 'M3 17l6-6 4 4 8-8M15 7h6v6',
  gift: 'M3 11h18v10H3zM3 7h18v4H3zM12 7v14M12 7c-3 0-4-1-4-2s2-2 3-1 1 3 1 3zM12 7c3 0 4-1 4-2s-2-2-3-1-1 3-1 3z',
  undo: 'M4 10h11a5 5 0 0 1 0 10H8M4 10l4-4M4 10l4 4',
  'arrow-right': 'M4 12h15M13 6l6 6-6 6',
  'arrow-left-right': 'M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  calendar: 'M3 6h18v15H3zM3 10h18M8 3v4M16 3v4',
  database: 'M12 8c5 0 9-1.3 9-3s-4-3-9-3-9 1.3-9 3 4 3 9 3zM3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3',
  shield: 'M12 3l8 3v6c0 5-3.4 8.4-8 9.9C7.4 20.4 4 17 4 12V6l8-3zM9 12l2 2 4-4',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  palette: 'M12 21a9 9 0 1 1 0-18c5 0 9 3.6 9 8 0 2.2-1.8 4-4 4h-1.5a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 21zM7.5 10.5h.01M11 7.5h.01M15.5 9h.01',
  inbox: 'M3 12h5l2 3h4l2-3h5M3 12l3-8h12l3 8v7H3z',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  // Two candles with wicks, drawn so the taller one reads as a rise.
  candlestick: 'M8 4v3M8 17v3M6 7h4v10H6zM16 9v2M16 19v2M14 11h4v8h-4z',
  'pie-chart': 'M12 3a9 9 0 1 0 9 9h-9z'
}

export interface IconProps {
  name: IconName
  /** Pixel size of the square. Defaults to 18. */
  size?: number
  className?: string
  /** Stroke width. Defaults to 1.75 for a consistent optical weight. */
  strokeWidth?: number
  /** Marks the icon decorative (default) or gives it a label. */
  title?: string
}

export function Icon({ name, size = 18, className, strokeWidth = 1.75, title }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      // Decorative by default so screen readers do not announce a glyph that
      // merely repeats adjacent text.
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  )
}

/**
 * Resolve an icon name stored on a category or account.
 *
 * Stored names come from user data and an older database may hold a name this
 * build does not know, so this never returns undefined — an unknown value falls
 * back to a neutral glyph rather than rendering nothing and leaving a gap.
 */
export function iconNameOr(value: string | null | undefined, fallback: IconName = 'tag'): IconName {
  if (value && Object.prototype.hasOwnProperty.call(PATHS, value)) return value as IconName
  return fallback
}
