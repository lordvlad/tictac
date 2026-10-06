import type { ChangeEvent, KeyboardEvent, ReactNode, Ref } from 'react'

/**
 * The pieces every menu panel is built from.
 *
 * The start menu had one inline `style` object per element — ten copies of the
 * same button and five of the same text field, each free to drift from the
 * others, which is how two buttons on the same row ended up a pixel apart.
 * They live here instead, as the small number of shapes the menu actually
 * has: a button in a tone and a size, a field, a group with a heading, a line
 * of status text.
 *
 * Plain inline styles rather than a stylesheet, because that is what the rest
 * of `src/hud` does — the HUD is drawn over a WebGL canvas with no cascade to
 * share — and because a tone here is a value the panels pass around.
 */

/**
 * Colour by *what a thing does*, not by where it sits: the three groups on the
 * main screen are told apart by tone, and a panel reached from a group keeps
 * its group's tone.
 */
const TONES = {
  /** Playing on a match server, and the account that makes it worth doing. */
  server: '#14b8a6',
  serverDeep: '#0d9488',
  /** Peer to peer: hosting, and joining. */
  peerHost: '#0ea5e9',
  peerJoin: '#3b82f6',
  /** Nothing on the other end: local, the AI, a recording. */
  offline: '#6366f1',
  offlineAi: '#8b5cf6',
  /** Back, copy, sign out — anything that is not a way into a match. */
  neutral: '#475569',
  neutralDark: '#334155',
} as const

export type MenuTone = keyof typeof TONES

export const MENU_COLOURS = {
  accent: '#38bdf8',
  muted: '#94a3b8',
  danger: '#ef4444',
  signedIn: '#2dd4bf',
  field: '#0f172a',
  line: '#475569',
  text: '#f8fafc',
} as const

const SIZES = {
  /** A whole row to itself: the main screen's choices. */
  lg: { padding: 12, fontSize: undefined as number | undefined, fontWeight: 600 },
  /** Side by side with its peers at the foot of a panel. */
  md: { padding: 10, fontSize: undefined as number | undefined, fontWeight: 600 },
  /** Beside a field, where the field is the subject and this is the verb. */
  sm: { padding: '8px 10px', fontSize: 12, fontWeight: 400 },
} as const

export function MenuButton({
  id,
  tone,
  size = 'md',
  grow,
  onClick,
  children,
}: {
  id?: string
  tone: MenuTone
  size?: keyof typeof SIZES
  /** Share the row evenly with the other growing buttons on it. */
  grow?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const metrics = SIZES[size]
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      style={{
        flex: grow ? 1 : undefined,
        padding: metrics.padding,
        fontSize: metrics.fontSize,
        fontWeight: metrics.fontWeight,
        background: TONES[tone],
        color: 'white',
        border: 'none',
        borderRadius: size === 'lg' ? 6 : 4,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

export function MenuInput({
  id,
  value,
  placeholder,
  onChange,
  onEnter,
  inputRef,
  readOnly,
  maxLength,
  grow,
}: {
  id?: string
  value: string
  placeholder?: string
  onChange?: (value: string) => void
  /** Submit from the keyboard, for a field whose whole panel is one action. */
  onEnter?: () => void
  inputRef?: Ref<HTMLInputElement>
  readOnly?: boolean
  maxLength?: number
  grow?: boolean
}) {
  return (
    <input
      id={id}
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      maxLength={maxLength}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (onEnter && event.key === 'Enter') onEnter()
      }}
      style={{
        flex: grow ? 1 : undefined,
        width: grow ? undefined : '100%',
        boxSizing: 'border-box',
        padding: 8,
        background: MENU_COLOURS.field,
        border: `1px solid ${MENU_COLOURS.line}`,
        color: MENU_COLOURS.text,
        borderRadius: 4,
        fontFamily: 'monospace',
        fontSize: 12,
      }}
    />
  )
}

/**
 * One of the main screen's three answers to "who is on the other end?" — a
 * match server, another browser, or nobody.
 */
export function MenuGroup({
  id,
  title,
  caption,
  tone,
  children,
}: {
  id?: string
  title: string
  caption: string
  tone: MenuTone
  children: ReactNode
}) {
  return (
    <section id={id} style={{ textAlign: 'left' }}>
      <h2
        style={{
          margin: '0 0 2px 0',
          fontSize: 11,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          color: TONES[tone],
        }}
      >
        {title}
      </h2>
      <p style={{ margin: '0 0 8px 0', fontSize: 11, color: MENU_COLOURS.muted }}>{caption}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </section>
  )
}

/** A line of prose under a panel: what just happened, or what went wrong. */
export function StatusLine({
  id,
  text,
  colour = MENU_COLOURS.muted,
}: {
  id?: string
  text: string
  colour?: string
}) {
  return (
    <p id={id} style={{ fontSize: 12, color: colour, margin: '8px 0 0 0' }}>
      {text}
    </p>
  )
}

/** A panel's own heading, for the screens behind a group's buttons. */
export function PanelTitle({ text, tone }: { text: string; tone: MenuTone }) {
  return (
    <p style={{ fontSize: 14, color: TONES[tone], margin: '0 0 8px 0' }}>{text}</p>
  )
}
