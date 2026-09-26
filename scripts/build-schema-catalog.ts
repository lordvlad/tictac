/**
 * Generate the wire-shape catalog: every `NetworkMessage` command's declared
 * fields, and the serialized shape of every replicated ECS component.
 *
 * Usage:
 *   bun run schema:catalog          # rewrite the checked-in catalog
 *   bun run schema:catalog --check  # fail if a shape drifted without a version bump
 *
 * [RFC-0001] §9 and `ITEM-028`: once a roster is derived from a stored log, the
 * log is a schema, not a debug dump. `PROTOCOL_VERSION` (`src/version.ts`) is
 * already documented as "bumped by hand when the shape of the wire changes" —
 * but nothing made anybody actually do it. A command gains a field, every test
 * stays green (nothing sends the old shape to compare against), and a stored
 * match — or a live match between two builds — silently stops meaning the
 * same thing twice.
 *
 * Neither shape is hand-copied here: a hand-copied shape is a second source of
 * truth that itself drifts, which is the exact failure mode this file exists
 * to close.
 *
 * - `NetworkMessage` (`src/game/NetworkManager.ts`), read off the TypeScript
 *   parse tree — see `schemaCatalog.ts`.
 * - Every replicated component (`src/ecs/components/index.ts`), by
 *   instantiating one with its constructor defaults and reflecting the *keys*
 *   of what `serialize()` actually returns right now.
 *
 * Default construction is not exhaustive. `StatusesComponent`'s `list`
 * defaults to `[]`, so it reflects as `"array<unknown>"` rather than the shape
 * of one `StatusState` — filling in a realistic fixture for every component
 * would itself be a hand-maintained second source of truth. What this *does*
 * catch: a field added, removed or renamed at any level, and a value's
 * fundamental kind changing (an array becoming a number, and so on).
 *
 * `--check` fails in exactly two situations, and passes in every other — see
 * `decide` in `schemaCatalog.ts` for the exact rule.
 */
import { decide, liveCatalog } from './schemaCatalog'
import { PROTOCOL_VERSION } from '../src/version'

const OUT = 'docs/schemas/wire-shape-catalog.json'

const catalog = await liveCatalog(PROTOCOL_VERSION)
const rendered = `${JSON.stringify(catalog, null, 2)}\n`

if (process.argv.includes('--check')) {
  const existingText = await Bun.file(OUT).text().catch(() => '')
  if (!existingText) {
    console.error(`[schema:catalog] ${OUT} does not exist — run: bun run schema:catalog`)
    process.exit(1)
  }
  const verdict = decide(JSON.parse(existingText), catalog, OUT)
  if (verdict.ok) {
    console.info(`[schema:catalog] ${verdict.message}`)
  } else {
    console.error(`[schema:catalog] ${verdict.message}`)
    process.exit(1)
  }
} else {
  await Bun.write(OUT, rendered)
  console.info(`[schema:catalog] wrote ${OUT} at protocol ${catalog.protocolVersion}`)
}
