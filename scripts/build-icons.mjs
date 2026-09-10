// Copies the icons the game uses out of the game-icons.net collection pinned at
// vendor/game-icons, into public/icons/<app name>.svg.
//
// Adding an icon is one line in scripts/icons.json plus `bun run icons`; the
// output is committed so a plain clone runs without initialising the submodule.
//
// game-icons.net artwork is CC BY 3.0, which asks for the author to be named,
// so the run also writes public/icons/CREDITS.txt from the manifest.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const vendorDir = new URL('vendor/game-icons/', root)
const outDir = new URL('public/icons/', root)

const manifest = JSON.parse(await readFile(new URL('icons.json', import.meta.url), 'utf8'))
const entries = Object.entries(manifest).filter(([name]) => !name.startsWith('$'))

try {
  await readdir(fileURLToPath(vendorDir))
} catch {
  console.error('[icons] vendor/game-icons is empty — run: git submodule update --init')
  process.exit(1)
}

/**
 * Upstream files are a black full-canvas background path followed by the white
 * glyph. The background has to go: `.gi` masks by alpha channel, and a filled
 * 512x512 rect is opaque everywhere, so every icon would come out a solid
 * square. The glyph's own fill is normalised to white so a file opened on its
 * own looks like what the HUD draws.
 */
const BACKGROUND_PATH = /<path[^>]*\sd="M0 ?0h512v512H0z"[^>]*\/>/g

function normalise(svg, source) {
  const single = svg.replace(/\n\s*/g, '').trim()
  if (!single.startsWith('<svg') || !single.endsWith('</svg>')) {
    throw new Error(`${source}: not a plain single-root SVG`)
  }

  const stripped = single.replace(BACKGROUND_PATH, '')
  if (stripped === single) throw new Error(`${source}: no full-canvas background to strip`)
  if (!/<(path|circle|rect|ellipse|polygon|g)\b/.test(stripped)) {
    throw new Error(`${source}: nothing left after stripping the background`)
  }

  return `${stripped.replace(/fill="(?!none)[^"]*"/g, 'fill="#fff"')}\n`
}

await mkdir(fileURLToPath(outDir), { recursive: true })

const credits = []
for (const [name, source] of entries) {
  const svg = await readFile(new URL(`${source}.svg`, vendorDir), 'utf8').catch(() => null)
  if (svg === null) throw new Error(`${name}: ${source}.svg is not in the collection`)

  await writeFile(new URL(`${name}.svg`, outDir), normalise(svg, source))
  credits.push(`${name}: ${source.split('/')[1]} by ${source.split('/')[0]}`)
}

/** The commit the superproject has the submodule pinned to, for the credits. */
async function pinnedRevision() {
  const gitDir = new URL('.git/modules/vendor/game-icons/', root)
  const head = (await readFile(new URL('HEAD', gitDir), 'utf8').catch(() => '')).trim()
  if (!head.startsWith('ref: ')) return head
  return (await readFile(new URL(head.slice(5), gitDir), 'utf8').catch(() => '')).trim()
}

const revision = (await pinnedRevision()).slice(0, 12)

await writeFile(
  new URL('CREDITS.txt', outDir),
  [
    'Icons from game-icons.net, licensed CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/).',
    `Collection pinned at vendor/game-icons${revision ? ` (${revision})` : ''}.`,
    '',
    ...credits,
    '',
  ].join('\n'),
)

console.info(`[tictac] wrote ${entries.length} icons → public/icons/`)
