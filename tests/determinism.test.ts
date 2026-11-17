import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { Faction } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { rollSquadSheets } from '../src/core/Characters'
import { Grid } from '../src/core/Grid'
import { distance, facingYaw } from '../src/core/math'
import { matchDice, Rng } from '../src/core/rng'
import { createGlobalRules } from '../src/ecs/globals'
import { World } from '../src/ecs/World'
import { Squads } from '../src/entities/Squads'
import { stockSquads } from './support/squads'
import { digestWorld } from '../src/sim/WorldDigest'
import { MatchHost } from '../src/sim/MatchHost'
import { SimMatch, type SquadPlan } from '../src/sim/SimMatch'

/**
 * Where the headless rules live: directories that must run on a server, in a
 * worker and in a browser and arrive at the same numbers.
 *
 * A match's outcome is a function of its seed and its intents, or it is not
 * reproducible — and everything under these directories is part of that
 * function. `render`, `hud` and `camera` are deliberately absent: a puff of
 * smoke may be as random as it likes. `src/rules` and `src/wire` are listed
 * before they exist so a file moved into them is covered the moment it lands.
 */
const HEADLESS_DIRS = ['src/core', 'src/ecs', 'src/sim', 'src/rules', 'src/wire']

/** The directories the match stream is guarded in: headless code, plus the client code still beside it. */
const RULES_DIRS = [...HEADLESS_DIRS, 'src/game']

/** What the server reads time through: the referee and the stores answer to a clock the host builds. */
const SERVER_DIRS = ['src/server', 'workers']

/**
 * A file with its comments blanked out, newlines kept so a line number found in
 * the result is the line number in the file.
 *
 * The guards below read *code*, and a comment explaining why something is
 * forbidden mentions the forbidden thing by name — which would otherwise make
 * the explanation a violation. Only real comments go: a line that merely
 * *starts* with `*` is a multiplication continued from the line above, and a
 * `//` inside a string is a url. Strings and template literals (including the
 * code inside `${}`) are walked so neither is mistaken for a comment.
 *
 * Throws if the file does not end back in plain code: a stripper that lost its
 * place would silently skip the rest of the file, which is the one failure a
 * guard cannot be allowed to have. (A regex literal holding a quote is the
 * known way to lose it; quoted strings end at a newline so one cannot lose
 * more than a line.)
 */
function code(text: string): string {
  type Mode = 'code' | 'line' | 'block' | "'" | '"' | '`'
  let mode: Mode = 'code'
  let out = ''
  let braces = 0
  // The brace depth each open `${` has to come back to before the template resumes.
  const templates: number[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1] ?? ''
    if (mode === 'code') {
      if (c === '/' && next === '/') {
        mode = 'line'
        out += '  '
        i += 2
      } else if (c === '/' && next === '*') {
        mode = 'block'
        out += '  '
        i += 2
      } else {
        if (c === "'" || c === '"' || c === '`') mode = c
        else if (c === '{') braces++
        else if (c === '}') {
          if (templates.at(-1) === braces) {
            templates.pop()
            mode = '`'
          } else braces--
        }
        out += c
        i++
      }
    } else if (mode === 'line') {
      if (c === '\n') {
        mode = 'code'
        out += c
      } else out += ' '
      i++
    } else if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code'
        out += '  '
        i += 2
      } else {
        out += c === '\n' ? '\n' : ' '
        i++
      }
    } else if (c === '\\') {
      out += c + next
      i += 2
    } else if (mode === '`' && c === '$' && next === '{') {
      templates.push(braces)
      mode = 'code'
      out += '${'
      i += 2
    } else {
      // A quoted string cannot span lines; a template can.
      if (c === mode || (c === '\n' && mode !== '`')) mode = 'code'
      out += c
      i++
    }
  }
  if (mode !== 'code' && mode !== 'line') throw new Error(`comment stripper ended inside ${mode}`)
  if (braces !== 0 || templates.length > 0) throw new Error('comment stripper lost count of braces')
  return out
}

/** Every `.ts` file under a directory, recursively; none if it does not exist (yet). */
async function sources(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...(await sources(path)))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** The code, comments gone, of every `.ts` file under `dirs`. */
async function scan(dirs: readonly string[]): Promise<{ path: string; code: string }[]> {
  const files: { path: string; code: string }[] = []
  for (const dir of dirs) {
    for (const path of await sources(dir)) files.push({ path, code: code(await Bun.file(path).text()) })
  }
  return files
}

/** `path:line: text` for every line of `files` that `pattern` matches. */
function hits(files: readonly { path: string; code: string }[], pattern: RegExp): string[] {
  return files.flatMap(({ path, code: text }) =>
    text
      .split('\n')
      .flatMap((line, index) => (pattern.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : [])),
  )
}

describe('The scans read code, and only code', () => {
  test('a line that starts with `*` is code; a comment that mentions a call is not', () => {
    const text = [
      'const area = width',
      '  * Math.sqrt(depth) // Date.now() would be wrong here',
      '/* Math.random',
      ' * is forbidden */',
      "const url = 'http://x/' + `${Date.now()} // still code`",
    ].join('\n')
    const stripped = code(text)

    expect(stripped).toContain('* Math.sqrt(depth)')
    expect(stripped).not.toContain('would be wrong')
    expect(stripped).not.toContain('Math.random')
    expect(stripped).toContain("'http://x/'")
    expect(stripped).toContain('${Date.now()}')
    expect(stripped.split('\n')).toHaveLength(text.split('\n').length)
  })

  test('every directory the guards cover exists or is named for later, and the core ones are not empty', async () => {
    for (const dir of ['src/core', 'src/ecs', 'src/sim', 'src/server']) {
      expect((await sources(dir)).length).toBeGreaterThan(0)
    }
    // Parsing every file is itself the check that the stripper never loses its place.
    await scan([...RULES_DIRS, ...SERVER_DIRS])
  })
})

/**
 * Time is read in one place per layer.
 *
 * The headless rules read none at all: a match's outcome is a function of its
 * seed and its intents, and a clock is a third input no peer, replay or sweep
 * can supply (`Characters.ts` once seeded a squad's rolls from `Date.now()`).
 * The server reads it through the `ServerClock` its host builds, so a
 * handover's expiry, a squad's route and a session's lifetime can all be
 * turned by hand — `src/server/Clock.ts` is the one place the wall clock is
 * named. A browser's own clocks (`render`, `hud`, `camera`, `main.tsx`) are
 * presentation and are not scanned.
 */
const CLOCK_APIS = /\bDate\.now\b|\bperformance\.now\b|\bnew Date\(\s*\)/

/** The ports that own a clock read, each with the reason it is allowed to. */
const CLOCK_ALLOWLIST: Record<string, string> = {
  'src/server/Clock.ts': '`WALL_CLOCK`, the one factory a server host builds its `ServerClock` from',
}

describe('Nothing headless or server-side reads a clock of its own', () => {
  test('`Date.now`, `performance.now` and `new Date()` appear only in the allowed port', async () => {
    const files = (await scan([...HEADLESS_DIRS, ...SERVER_DIRS])).filter(({ path }) => !(path in CLOCK_ALLOWLIST))

    expect(hits(files, CLOCK_APIS)).toEqual([])
  })

  test('every allowed port still reads the clock, so the list cannot go stale', async () => {
    for (const path of Object.keys(CLOCK_ALLOWLIST)) {
      expect(code(await Bun.file(path).text())).toMatch(CLOCK_APIS)
    }
  })
})

describe('Nothing in the rules reaches for its own randomness', () => {
  test('`Math.random` appears nowhere the rules can see it', async () => {
    // The one rule about the match stream: only the rules draw from it, and
    // they draw from *it*. A `Math.random` in here is a number no peer, replay
    // or sweep can reproduce — which is how a match ends up only knowable by
    // being told its outcome.
    const files = (await scan(RULES_DIRS)).filter(({ path }) => path !== 'src/core/rng.ts')

    expect(hits(files, /Math\.random/)).toEqual([])
  })

  test('`entropy()` is the one allowed exception, and says why', async () => {
    // `entropy` chooses a *seed* for a match played offline. That is the one
    // draw that cannot come from the stream, because it is what creates it —
    // and it lives in `main.tsx`, not `core/rng.ts`, so `core/rng.ts` itself
    // needs no exception at all. A match on a server never draws one: its room
    // issues the seed (`tests/refereed.test.ts`).
    const rngText = await Bun.file('src/core/rng.ts').text()
    expect(code(rngText).includes('Math.random')).toBe(false)

    const mainText = code(await Bun.file('src/main.tsx').text())
    const uses = mainText.split('Math.random').length - 1
    expect(uses).toBe(1)
    const entropy = mainText.match(/function entropy\(\)[^}]*\}/)
    expect(entropy?.[0]).toContain('Math.random')
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

/**
 * Library maths the rules may call, file by file, each with the port that owns it.
 *
 * `Math.sqrt` is correctly rounded by IEEE 754, so two engines agree on it bit
 * for bit; everything else here is a library routine whose last bit is
 * implementation-defined. A file listed uses only the functions named, and
 * none of them may feed a match or a digest.
 */
const LIBRARY_MATH = /\bMath\.(?:cos|sin|tan|acos|asin|atan|atan2|sqrt|cbrt|hypot|exp|expm1|log|log1p|log2|log10|pow|sinh|cosh|tanh)\b/g

const MATH_ALLOWLIST: Record<string, { allowed: readonly string[]; why: string }> = {
  'src/core/math.ts': {
    allowed: ['sqrt', 'atan2'],
    why: '`distance` is squares and one square root; `facingYaw` quantises `atan2` finely enough that the last bit cannot drift',
  },
  'src/core/Throw.ts': {
    allowed: ['sqrt'],
    why: 'a throw is flown by both peers, so it is arithmetic and square roots only',
  },
  'src/core/Characters.ts': {
    allowed: ['sqrt'],
    why: 'a soldier model\'s scale from its appearance sheet, rounded by IEEE',
  },
  'src/core/Meetings.ts': {
    allowed: ['cos', 'sqrt'],
    why: 'the world map\'s closest approach; the server\'s figures are the ones recorded and nothing here feeds a match or a digest',
  },
  'src/core/Travel.ts': {
    allowed: ['sin', 'cos', 'atan2', 'sqrt'],
    why: 'the world map\'s great-circle distance; the server\'s figures are the ones recorded and a client\'s own only draw the squad',
  },
}

async function mathUses(): Promise<Map<string, string[]>> {
  const uses = new Map<string, string[]>()
  for (const { path, code: text } of await scan(RULES_DIRS)) {
    const found = [...new Set([...text.matchAll(LIBRARY_MATH)].map((m) => m[0].slice('Math.'.length)))].sort()
    if (found.length > 0) uses.set(path, found)
  }
  return uses
}

describe('Nothing in the rules branches on a number two engines may disagree about', () => {
  test('library maths is called only where a file is listed for it', async () => {
    const uses = await mathUses()
    const unlisted = [...uses].flatMap(([path, found]) => {
      const allowed = MATH_ALLOWLIST[path]?.allowed ?? []
      const extra = found.filter((name) => !allowed.includes(name))
      return extra.length > 0 ? [`${path}: ${extra.join(', ')}`] : []
    })

    expect(unlisted).toEqual([])
  })

  test('a listed file still uses what it is listed for, so the list cannot go stale', async () => {
    const uses = await mathUses()
    const stale = Object.entries(MATH_ALLOWLIST).flatMap(([path, { allowed }]) => {
      const found = uses.get(path) ?? []
      const unused = allowed.filter((name) => !found.includes(name))
      return unused.length > 0 ? [`${path}: ${unused.join(', ')}`] : []
    })

    expect(stale).toEqual([])
  })

  test('no allowlist entry goes without a reason', () => {
    for (const { why } of Object.values(MATH_ALLOWLIST)) expect(why.length).toBeGreaterThan(20)
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
      stockSquads({
        [Faction.Blue]: rollSquadSheets(new Rng(7)),
        [Faction.Red]: rollSquadSheets(new Rng(8)),
      }),
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

    expect(digestWorld(a.world, ids(a), 1, new Rng(7)).total).toBe(
      digestWorld(b.world, ids(b), 1, new Rng(7)).total,
    )
  })
})

const STOCK: SquadPlan = {
  weapons: [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun],
  ammo: AmmoId.Standard,
  grenades: { frag: 1, flash: 0, smoke: 0 },
  items: {},
  attachments: [],
}

/** A short match the AI played, as the intents it sent: real commands, and every shot drawing the match's dice. */
function intentLog(seed: number, turnCap: number) {
  const match = new SimMatch({ seed, blue: STOCK, red: STOCK, turnCap, record: true })
  match.run()
  const recording = match.recording
  expect(recording).not.toBeNull()
  return recording!
}

describe('Two hosts fed the same intents hold the same world at every turn', () => {
  const recording = intentLog(4242, 6)

  test('the log is real: it moves, shoots and hands over, and the dice are drawn', () => {
    const types = new Set(recording.events.map((event) => event.command.type))

    expect(types.has('moveUnit')).toBe(true)
    expect(types.has('fireShot')).toBe(true)
    expect(types.has('endTurn') || types.has('endUnitTurn')).toBe(true)
  })

  test('digests, dice included, agree after every command and so at every turn', () => {
    const a = new MatchHost(recording.header)
    const b = new MatchHost(recording.header)
    expect(a.digest()).toEqual(b.digest())

    const dice = new Set([a.digest().dice])
    const turns = new Set([a.turnNumber])
    for (const event of recording.events) {
      expect(a.apply(event.command).applied).toBe(true)
      expect(b.apply(event.command).applied).toBe(true)

      const mine = a.digest()
      expect({ seq: event.seq, digest: mine }).toEqual({ seq: event.seq, digest: b.digest() })
      expect(a.turnNumber).toBe(b.turnNumber)
      dice.add(mine.dice)
      turns.add(a.turnNumber)
    }

    // Agreeing about nothing would pass too: the stream has to have moved on
    // from where it started, and the match across more than one turn.
    expect(dice.size).toBeGreaterThan(1)
    expect(turns.size).toBeGreaterThan(1)
  })

  test('a die drawn off the books is a divergence, found by the dice alone', () => {
    // The digest carries the stream's position, so a peer that rolled once more
    // or less than the other disagrees even while the world still looks alike.
    const a = new MatchHost(recording.header)
    const b = new MatchHost(recording.header)
    b.rewindable.dice.next()

    expect(a.digest().dice).not.toBe(b.digest().dice)
    expect(a.digest().total).not.toBe(b.digest().total)
    expect({ ...a.digest(), dice: 0, total: 0 }).toEqual({ ...b.digest(), dice: 0, total: 0 })
  })

  test('a different seed over the same intents is a different match', () => {
    const other = new MatchHost({ ...recording.header, seed: recording.header.seed + 1 })
    const same = new MatchHost(recording.header)

    expect(other.digest().total).not.toBe(same.digest().total)
  })
})

describe('The referee compares a digest only when its host has nothing pending', () => {
  // `Room.check` takes `host.digest()` synchronously, while a client compares
  // in `whenSettled`. That is the same moment only because `MatchHost.apply`
  // returns with the world at rest: nothing walking and nothing queued, so the
  // referee never fingerprints a world a client has yet to finish building.
  const recording = intentLog(4242, 6)

  test('after every intent nobody is walking and nothing is queued', () => {
    const host = new MatchHost(recording.header)

    for (const event of recording.events) {
      host.apply(event.command)
      expect({ seq: event.seq, busy: host.commands.busy, pending: host.commands.pending }).toEqual({
        seq: event.seq,
        busy: false,
        pending: false,
      })
    }
  })

  test('so time passing changes nothing the referee would have compared', () => {
    const host = new MatchHost(recording.header)

    for (const event of recording.events) {
      host.apply(event.command)
      const settled = host.digest()
      for (let i = 0; i < 5; i++) host.world.update(1 / 60)
      expect({ seq: event.seq, digest: host.digest() }).toEqual({ seq: event.seq, digest: settled })
    }
  })
})
