import { describe, expect, test } from 'bun:test'
import { readdir, stat } from 'node:fs/promises'
import manifest from '../scripts/icons.json'

const SRC = new URL('../src/', import.meta.url).pathname
const ICONS = new URL('../public/icons/', import.meta.url).pathname

/**
 * Glyphs the HUD used to draw with emoji, before the icon set arrived. Listed
 * by hand rather than by Unicode range so that ordinary typography — the em
 * dash, the minus sign, an arrow in a comment — does not trip the test.
 */
const EMOJI = ['🎥', '👁', '⛳', '⏭', '⏳', '🟢', '✕', '⛶', '➔', '⚠', '☠', '🟥', '🔴']

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir)
  for (const entry of entries) {
    const path = `${dir}${entry}`
    const entryStat = await stat(path)
    if (entryStat.isDirectory()) {
      const nested = await sourceFiles(`${path}/`)
      out.push(...nested)
    } else if (entry.endsWith('.ts')) {
      out.push(path)
    }
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
  test('no screen draws itself with an emoji', async () => {
    const offenders: string[] = []
    const files = await sourceFiles(SRC)

    for (const file of files) {
      const text = await Bun.file(file).text()
      const lines = text.split('\n')
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

  test('every icon the manifest names is generated', async () => {
    const iconFiles = await readdir(ICONS)
    const generated = new Set(
      iconFiles
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
  test('generated SVGs do not contain rect backgrounds', async () => {
    const iconFiles = await readdir(ICONS)
    for (const file of iconFiles) {
      if (!file.endsWith('.svg')) continue
      const content = await Bun.file(`${ICONS}${file}`).text()
      expect(content).not.toContain('<rect')
    }
  })
})
