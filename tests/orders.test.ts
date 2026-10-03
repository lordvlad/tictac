import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import type { NetworkMessage } from '../src/game/NetworkManager'
import { STOCK_PLAN } from '../src/sim/Balance'
import { MatchHost } from '../src/sim/MatchHost'
import { Policy, type StandingOrder } from '../src/sim/Policy'
import { replay } from '../src/sim/Replay'
import { SimMatch } from '../src/sim/SimMatch'

/** A fresh match, both squads on their own way out, and the policy about to play Blue's first turn. */
function opening(order: StandingOrder, seed = 11) {
  const { header } = new SimMatch({ seed, blue: STOCK_PLAN, red: STOCK_PLAN, record: true }).recording!
  const host = new MatchHost(header)
  const issued: NetworkMessage[] = []
  const policy = new Policy(
    host,
    (command) => {
      issued.push(command)
      return host.apply(command)
    },
    { orders: { [Faction.Blue]: order } },
  )
  return { host, issued, policy, blue: host.squads.byFaction[Faction.Blue] }
}

const retreated = (issued: readonly NetworkMessage[]) => issued.some((command) => command.type === 'retreat')

describe('A standing order', () => {
  test('stand never retreats, however hurt', () => {
    const m = opening('stand')
    for (const unit of m.blue) unit.hp = 1
    m.policy.playTurn()
    expect(retreated(m.issued)).toBe(false)
  })

  test('evade retreats on its first turn', () => {
    const m = opening('evade')
    m.policy.playTurn()
    expect(m.issued.at(-1)).toEqual({ type: 'retreat', faction: Faction.Blue })
  })

  test('cautious holds until its first wound, then gets out', () => {
    const steady = opening('cautious')
    steady.policy.playTurn()
    expect(retreated(steady.issued)).toBe(false)

    const hurt = opening('cautious')
    hurt.blue[2]!.hp -= 1
    hurt.policy.playTurn()
    expect(retreated(hurt.issued)).toBe(true)
  })

  test('opportunist gets out once it is down to half its health, not before', () => {
    const fresh = opening('opportunist')
    fresh.policy.playTurn()
    expect(retreated(fresh.issued)).toBe(false)

    const halved = opening('opportunist')
    for (const unit of halved.blue) unit.hp = Math.floor(unit.hp / 2)
    halved.policy.playTurn()
    expect(retreated(halved.issued)).toBe(true)
  })

  test('cautious never pulls out of a fight before its side has been hurt', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const match = new SimMatch({ seed, blue: { ...STOCK_PLAN, order: 'cautious' }, red: STOCK_PLAN, record: true })
      const outcome = match.run()
      const { header, events } = match.recording!
      const host = new MatchHost(header)
      const start = host.squads.byFaction[Faction.Blue].map((unit) => unit.hp)
      for (const event of events) {
        if (event.command.type === 'retreat') {
          const blue = host.squads.byFaction[Faction.Blue]
          expect(blue.some((unit, i) => unit.isDead || unit.hp < start[i]!)).toBe(true)
          break
        }
        host.apply(event.command)
      }
      if (outcome.withdrew === Faction.Blue) expect(outcome.winner).toBe(Faction.Red)
    }
  })
})

describe('A match the AI retreated from', () => {
  test('replays to the same match from its recording', () => {
    const match = new SimMatch({ seed: 4, blue: { ...STOCK_PLAN, order: 'evade' }, red: STOCK_PLAN, record: true })
    const outcome = match.run()
    expect(outcome.withdrew).toBe(Faction.Blue)
    expect(outcome.winner).toBe(Faction.Red)

    const refought = replay(match.recording!)
    expect(refought.skipped).toEqual([])
    expect(refought.digest).toEqual(match.host.digest())
  })
})
