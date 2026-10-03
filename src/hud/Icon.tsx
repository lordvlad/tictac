import type { CSSProperties } from 'react'

/**
 * A game-icons.net glyph, masked so it takes the surrounding text colour.
 *
 * The files under public/icons are generated from the collection pinned at
 * vendor/game-icons by `bun run icons`; `scripts/icons.json` maps these names
 * onto it, so a new icon is a manifest line rather than a hand-drawn path.
 *
 * The URL is absolute on purpose: a relative one inside a custom property is
 * resolved against the stylesheet that substitutes it — game.css, which the dev
 * server serves from a different directory — not against this document.
 */
export function Icon({ file, className }: { file: string; className?: string }) {
  const href = new URL(`./icons/${file}.svg`, document.baseURI).href
  const style = { '--gi': `url('${href}')` } as CSSProperties
  return <span className={className ? `gi ${className}` : 'gi'} style={style} />
}
