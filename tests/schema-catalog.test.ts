import { describe, expect, test } from 'bun:test'
import { RpcMethods } from '../src/game/JsonRpc'
import { PROTOCOL_VERSION } from '../src/version'
import {
  commandShapes,
  componentShapes,
  decide,
  liveCatalog,
  REPLICATED_COMPONENTS,
  type WireShapeCatalog,
} from '../scripts/schemaCatalog'

const OUT = 'docs/schemas/wire-shape-catalog.json'

describe('The wire-shape catalog is in step with the code', () => {
  /**
   * The guard that makes the checked-in catalog worth reading: the same
   * property `tests/catalog.test.ts` checks for the trait catalogue, over the
   * real CLI rather than its internals.
   */
  test('regenerating it changes nothing', () => {
    const result = Bun.spawnSync(['bun', 'scripts/build-schema-catalog.ts', '--check'])
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    expect(output).not.toContain('out of date')
    expect(output).not.toContain('PROTOCOL_VERSION')
    expect(result.exitCode).toBe(0)
  })

  test('every command RpcMethods knows about is in the catalog, and nothing else is', async () => {
    const commands = await commandShapes()
    expect(Object.keys(commands).sort()).toEqual(Object.keys(RpcMethods).sort())
  })

  test('every replicated component is in the catalog, keyed by its own name', () => {
    const components = componentShapes()
    const names = REPLICATED_COMPONENTS.map((c) => c.name).sort()
    expect(Object.keys(components).sort()).toEqual(names)
    // Every component names itself something different, or one would shadow
    // another in replication as well as in this catalog.
    expect(new Set(names).size).toBe(names.length)
  })

  test('an optional command field is recorded as optional', async () => {
    const commands = await commandShapes()
    expect(commands.useItem?.targetFaction).toBe('optional Faction')
    expect(commands.useItem?.targetIndex).toBe('optional number')
    // A required field beside it is not marked optional.
    expect(commands.useItem?.faction).toBe('Faction')
  })
})

describe('Whether the catalog is trusted, `decide`', () => {
  const live: WireShapeCatalog = {
    protocolVersion: 3,
    commands: { hello: { type: "'hello'", build: 'string' } },
    components: { health: { hp: 'number' } },
  }

  test('an identical catalog at the same version passes', () => {
    const verdict = decide(structuredClone(live), live, OUT)
    expect(verdict.ok).toBe(true)
  })

  test('reordering keys is not a shape change', () => {
    const reordered: WireShapeCatalog = {
      ...live,
      commands: { hello: { build: 'string', type: "'hello'" } },
    }
    expect(decide(reordered, live, OUT).ok).toBe(true)
  })

  test('a shape change at the same version demands a version bump, not a regeneration', () => {
    const stale: WireShapeCatalog = { ...live, commands: { hello: { type: "'hello'" } } }
    const verdict = decide(stale, live, OUT)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('needs-version-bump')
      expect(verdict.message).toContain('bump PROTOCOL_VERSION')
    }
  })

  test('a shape change at a new version demands regeneration, not a version bump', () => {
    const stale: WireShapeCatalog = {
      protocolVersion: 2,
      commands: { hello: { type: "'hello'" } },
      components: live.components,
    }
    const verdict = decide(stale, live, OUT)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('stale')
      expect(verdict.message).not.toContain('bump PROTOCOL_VERSION')
      expect(verdict.message).toContain('bun run schema:catalog')
    }
  })

  test('a version bump alone, with no shape change, passes', () => {
    const bumped: WireShapeCatalog = { ...live, protocolVersion: live.protocolVersion - 1 }
    expect(decide(bumped, live, OUT).ok).toBe(true)
  })

  test('a component shape change is caught the same way a command change is', () => {
    const stale: WireShapeCatalog = { ...live, components: { health: { hp: 'number', maxHp: 'number' } } }
    const verdict = decide(stale, live, OUT)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('needs-version-bump')
  })
})

describe('This build is running the protocol version its own catalog was written at', () => {
  test('the checked-in catalog matches the live shape at the current protocol version', async () => {
    const checkedIn = JSON.parse(await Bun.file(OUT).text()) as WireShapeCatalog
    const live = await liveCatalog(PROTOCOL_VERSION)
    expect(decide(checkedIn, live, OUT)).toEqual({ ok: true, message: `${OUT} is in step with the code` })
  })
})
