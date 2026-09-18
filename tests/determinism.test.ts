import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { Faction } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { rollSquadSheets } from '../src/core/Characters'
import { Grid } from '../src/core/Grid'
import { distance, facingYaw } from '../src/core/math'
import { matchDice, Rng } from '../src/core/rng'
import { createGlobalRules } from '../src/ecs/globals'
import { World } from '../src/ecs/World'
import { Squads } from '../src/game/Squads'
import { digestWorld } from '../src/game/StateDigest'

/**
 * Where the rules live.
 *
 * A match's outcome is a function of its seed and its intents, or it is not
 * reproducible — and everything under these directories is part of that
 * function. `render`, `hud` and `camera` are deliberately absent: a puff of
 * smoke may be as random as it likes.
 */
const RULES_DIRS = ['src/core', 'src/ecs', 'src/sim', 'src/game']

/**
 * A file with its comments removed.
 *
 * The guards below read *code*, and a comment explaining why something is
 * forbidden mentions the forbidden thing by name — which would otherwise make
 * the explanation a violation.
 */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

/** Every `.ts` file under a directory, recursively. */
async function sources(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await sources(path)))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

async function rulesSources(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = []
  for (const dir of RULES_DIRS) {
    for (const path of await sources(dir)) {
      files.push({ path, text: await Bun.file(path).text() })
    }
  }
  return files
}

describe('Nothing in the rules reaches for its own randomness', () => {
  test('`Math.random` appears nowhere the rules can see it', async () => {
    // The one rule about the match stream: only the rules draw from it, and
    // they draw from *it*. A `Math.random` in here is a number no peer, replay
    // or sweep can reproduce — which is how a match ends up only knowable by
    // being told its outcome.
    const offenders = (await rulesSources())
      .filter(({ path, text }) => path !== 'src/core/rng.ts' && code(text).includes('Math.random'))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  test('the seed picker is the one allowed exception, and says why', async () => {
    // `resolveSeed` chooses a *seed* when the URL names none. That is the one
    // draw that cannot come from the stream, because it is what creates it.
    const rng = await Bun.file('src/core/rng.ts').text()
    const uses = code(rng).split('Math.random').length - 1

    expect(uses).toBe(1)
    expect(rng).toContain('resolveSeed')
  })

  test('the same seed is the same dice, and a different seed is not', () => {
    const a = matchDice(4242)
    const b = matchDice(4242)
    const c = matchDice(4243)
    const draw = (roll: () => number) => Array.from({ length: 8 }, roll)

    expect(draw(a)).toEqual(draw(b))
    expect(draw(c)).not.toEqual(draw(matchDice(4242)))
  })
})

describe('Nothing in the rules branches on a number two engines may disagree about', () => {
  test('no rules file calls `Math.hypot` or `Math.atan2`', async () => {
    // `sqrt` is correctly rounded by IEEE 754, so two engines agree on it bit
    // for bit. `Math.hypot` is a library routine whose accuracy is
    // implementation-defined, and it fed every range check in the game;
    // `Math.atan2` fed a facing that is replicated and digested.
    const offenders = (await rulesSources())
      .filter(({ path, text }) => path !== 'src/core/math.ts')
      .filter(({ text }) => code(text).includes('Math.hypot') || code(text).includes('Math.atan2'))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  test('distance is squares and one square root', () => {
    // Pinned against the closed form rather than against `Math.hypot`: the
    // point is that this is the arithmetic IEEE requires engines to agree on.
    expect(distance(3, 4)).toBe(5)
    expect(distance(1, 2, 2)).toBe(3)
    expect(distance(0.3, 0.4)).toBe(Math.sqrt(0.3 * 0.3 + 0.4 * 0.4))
  })

  test('a facing is quantised, finely enough that nobody can see it', () => {
    const yaw = facingYaw(1, 2)
    // Rounded to a grid, so an implementation-defined last bit cannot drift.
    expect(yaw).toBe(Math.round(yaw * 1000) / 1000)
    // And still far finer than a degree, so facing reads as continuous.
    expect(Math.abs(yaw - Math.atan2(1, 2))).toBeLessThan(0.001)
  })
})

describe('Two peers dealt the same match hold the same world', () => {
  const peer = () => {
    const world = new World()
    createGlobalRules(world)
    const grid = new Grid(24)
    const squads = new Squads(
      world,
      grid,
      { [Faction.Blue]: [{ x: 4, y: 4 }], [Faction.Red]: [{ x: 4, y: 9 }] },
      undefined,
      Faction.Blue,
      {
        [Faction.Blue]: rollSquadSheets(new Rng(7)),
        [Faction.Red]: rollSquadSheets(new Rng(8)),
      },
    )
    for (const unit of squads.soldiers) unit.equip(WeaponId.Rifle, AmmoId.Standard)
    return { world, squads }
  }

  test('entity ids are the same on both sides', () => {
    // Every command addresses a unit by faction and slot, but a digest and a
    // component update address it by entity id. Two peers that numbered their
    // entities differently would agree about a match and disagree about which
    // rows of state it applied to.
    const a = peer()
    const b = peer()

    expect(a.squads.soldiers.map((u) => u.entityId)).toEqual(
      b.squads.soldiers.map((u) => u.entityId),
    )
    expect([...a.world.entityIds()]).toEqual([...b.world.entityIds()])
  })

  test('and therefore the same fingerprint', () => {
    const a = peer()
    const b = peer()
    const ids = (p: ReturnType<typeof peer>) => p.squads.soldiers.map((u) => u.entityId)

    expect(digestWorld(a.world, ids(a), 1).total).toBe(digestWorld(b.world, ids(b), 1).total)
  })
})
