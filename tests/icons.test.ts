import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import manifest from '../scripts/icons.json'

const SRC = new URL('../src/', import.meta.url).pathname
const ICONS = new URL('../public/icons/', import.meta.url).pathname

/**
 * Glyphs the HUD used to draw with emoji, before the icon set arrived. Listed
 * by hand rather than by Unicode range so that ordinary typography — the em
 * dash, the minus sign, an arrow in a comment — does not trip the test.
 */
const EMOJI = ['🎥', '👁', '⛳', '⏭', '⏳', '🟢', '✕', '⛶', '➔', '⚠', '☠', '🟥', '🔴']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = `${dir}${entry}`
    if (statSync(path).isDirectory()) out.push(...sourceFiles(`${path}/`))
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('Icon set', () => {
  /**
   * The regression this guards: the battle HUD was drawn with emoji, which
   * render as a different typeface on every platform. They were replaced with
   * masked SVGs, and a stray one is easy to reintroduce — the turn badge kept
   * its 🟢 and ⏳ through the first pass because nothing was watching.
   */
  test('no screen draws itself with an emoji', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        // Console banners are for the developer's terminal, not the screen.
        if (line.includes('console.')) return
        for (const glyph of EMOJI) {
          if (line.includes(glyph)) offenders.push(`${file.slice(SRC.length)}:${index + 1} ${glyph}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })

  test('every icon the manifest names is generated', () => {
    const generated = new Set(
      readdirSync(ICONS)
        .filter((file) => file.endsWith('.svg'))
        .map((file) => file.slice(0, -4)),
    )

    const named = Object.keys(manifest).filter((key) => !key.startsWith('$'))
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) expect(generated.has(name)).toBe(true)
  })

  /**
   * Upstream files carry a full-canvas background path. `.gi` masks by alpha,
   * so one left in would draw that icon as a solid square.
   */
  test('no generated icon kept its background plate', () => {
    for (const file of readdirSync(ICONS).filter((name) => name.endsWith('.svg'))) {
      const svg = readFileSync(`${ICONS}${file}`, 'utf8')
      expect(svg).not.toContain('M0 0h512v512H0z')
    }
  })
})
