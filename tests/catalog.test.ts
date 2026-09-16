import { describe, expect, test } from 'bun:test'
import { STATUSES, StatusKind } from '../src/core/Arsenal'
import { ITEMS, ItemId } from '../src/core/Items'
import { TRAITS, TraitId } from '../src/core/Traits'

const CATALOG = 'docs/design/gdd/status-and-trait-catalog.md'

const catalog = await Bun.file(CATALOG).text()

describe('The catalogue is in step with the code', () => {
  /**
   * The guard that makes the document worth reading.
   *
   * A hand-written catalogue is a second source of truth that goes wrong the
   * first time a number changes - which had already happened twice before this
   * existed: the docs named a wound trait that is actually a status, and quoted
   * a flat AP allowance that had been a range for weeks.
   */
  test('regenerating it changes nothing', async () => {
    const result = Bun.spawnSync(['bun', 'scripts/build-catalog.ts', '--check'])
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    expect(output).not.toContain('out of date')
    expect(result.exitCode).toBe(0)
  })

  test('every status appears, with its name and its stack limit', () => {
    for (const spec of Object.values(STATUSES)) {
      expect(catalog).toContain(`\`${spec.kind}\``)
      expect(catalog).toContain(spec.name)
    }
    // Suppression is the only thing that stacks, and the table has to say so:
    // "-12 to hit" without "x3" beside it understates it by three times.
    expect(catalog).toContain(`| ${STATUSES[StatusKind.Suppressed].maxStacks} |`)
  })

  test('every trait appears, with where it can be got', () => {
    for (const spec of Object.values(TRAITS)) {
      expect(catalog).toContain(`\`${spec.id}\``)
      expect(catalog).toContain(spec.name)
    }
    // The three routes a trait reaches a unit by. If one stops appearing, a
    // whole source has gone unlisted rather than one row being wrong.
    expect(catalog).toContain('born with')
    expect(catalog).toContain('wound')
    expect(catalog).toContain('worn (')
  })

  test('no trait is listed as unreachable', () => {
    // The generator writes `unreachable` for a trait nothing can grant, which
    // is either dead data or a source it failed to find - both worth knowing.
    expect(catalog).not.toContain('unreachable')
  })

  test('every item appears, on the side of the line it belongs', () => {
    for (const id of Object.values(ItemId)) {
      expect(catalog).toContain(ITEMS[id].name)
    }
    // Worn kit is listed by what carrying it does; a consumable by what using
    // it does. Mixing them is how a passive item ends up looking usable.
    expect(catalog).toContain('## 3. Worn kit')
    expect(catalog).toContain('Consumables, for contrast')
  })

  test('it says it is generated, and how', () => {
    // Without this a reader edits it by hand and loses the work.
    expect(catalog).toContain('bun run docs:catalog')
  })
})

describe('What the catalogue asserts about the data', () => {
  test('a passive item grants at least one trait and has no action', () => {
    for (const id of Object.values(ItemId)) {
      const spec = ITEMS[id]
      if (!spec.passive) continue
      expect(spec.traits?.length ?? 0).toBeGreaterThan(0)
      expect(spec.effects).toEqual([])
    }
  })

  test('the wound traits are traits and the exhaustion one is a status', () => {
    // These were conflated in the docs: `Winded` is temporary and ticks away,
    // while a wound lasts as long as the injury. Keeping the names distinct is
    // what stops the confusion coming back.
    expect(TRAITS[TraitId.Limping]).toBeDefined()
    expect(TRAITS[TraitId.Concussed]).toBeDefined()
    expect(Object.keys(TRAITS)).not.toContain('winded')
    expect(STATUSES[StatusKind.Winded]).toBeDefined()
  })
})
