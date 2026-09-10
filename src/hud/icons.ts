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
export function icon(file: string, extra = ''): string {
  const href = new URL(`./icons/${file}.svg`, document.baseURI).href
  return `<span class="gi ${extra}" style="--gi: url('${href}');"></span>`
}
