import { describe, expect, test } from 'bun:test'
import { Faction, GRID_SIZE, SQUAD_SIZE } from '../src/config'
import { ShotMode } from '../src/core/Arsenal'
import { characterSheet } from '../src/core/Characters'
import { NO_FOCUS, NO_FX } from '../src/core/Combatant'
import { Grid, type Tile } from '../src/core/Grid'
import { Rng } from '../src/core/rng'
import { createGlobalRules } from '../src/ecs/globals'
import { TurnSystem } from '../src/ecs/systems'
import { World } from '../src/ecs/World'
import type { Soldier } from '../src/entities/Soldier'
import { Squads } from '../src/entities/Squads'
import { MatchSession } from '../src/game/MatchSession'
import {
  type Aiming,
  headlessView,
  type MatchView,
  type Outcome,
  type ShootAim,
  type ViewIntent,
} from '../src/game/MatchView'
import { NetworkManager, type NetworkMode } from '../src/game/NetworkManager'
import type { Command } from '../src/rules/Command'
import { TurnManager } from '../src/sim/TurnManager'
import { RpcMethods } from '../src/wire/JsonRpc'
import { loopback } from '../src/wire/Transport'
import { stockSquads } from './support/squads'

/**
 * `MatchSession` with no DOM and no WebGL: intents in, commands out.
 *
 * Nothing in this file touches a scene. The session is built from the same
 * pieces the headless host is built from, a view that records what it is told
 * stands where the screen would, and the one door every command goes through
 * (`CommandSystem.apply`) is watched to see what the session decided.
 */

const row = (y: number): Tile[] => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 6 + i * 2, y }))

/** What the view was told, in order: the screen's side of the conversation. */
interface Told {
  applied: { type: Command['type']; origin: string }[]
  shown: ViewIntent['type'][]
  ended: Outcome[]
  turnsSwitched: number
}

/** A view that writes down what it is told, over the aiming the test supplies. */
function watching(aiming: Aiming = headlessView().aiming): { view: MatchView; told: Told } {
  const told: Told = { applied: [], shown: [], ended: [], turnsSwitched: 0 }
  const view: MatchView = {
    aiming,
    refreshHud() {},
    renderOverlay() {},
    recomputeVisibility() {},
    turnSwitched() {
      told.turnsSwitched++
    },
    commandApplied(command, _result, origin) {
      told.applied.push({ type: command.type, origin })
    },
    show(intent) {
      told.shown.push(intent.type)
    },
    matchEnded(outcome) {
      told.ended.push(outcome)
    },
  }
  return { view, told }
}

interface Rig {
  session: MatchSession
  squads: Squads
  turnManager: TurnManager
  /** Every command the session put through the door, refused or not. */
  issued: { command: Command; origin: string }[]
  left: { count: number }
  told: Told
}

function build(options: { network?: NetworkManager; aiming?: Aiming; watching?: 'spectate' | 'replay' } = {}): Rig {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(GRID_SIZE)
  const sheet = () => ({ ...characterSheet(new Rng(4)), traits: [] })
  const squads = new Squads(
    world,
    grid,
    { [Faction.Blue]: row(3), [Faction.Red]: row(32) },
    stockSquads({
      [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, sheet),
      [Faction.Red]: Array.from({ length: SQUAD_SIZE }, sheet),
    }),
  )
  const turnManager = new TurnManager(world, new TurnSystem(), squads, NO_FOCUS)
  const left = { count: 0 }
  const session = new MatchSession({
    world,
    grid,
    squads,
    turnManager,
    dice: new Rng(7),
    fx: NO_FX,
    onLeave: () => left.count++,
    network: options.network ?? null,
    ...(options.watching ? { watching: options.watching } : {}),
  })
  const { view, told } = watching(options.aiming)
  session.attach(view)

  const issued: Rig['issued'] = []
  const apply = session.commands.apply.bind(session.commands)
  session.commands.apply = (command, origin) => {
    issued.push({ command, origin })
    return apply(command, origin)
  }
  turnManager.autoSelectFirst()
  return { session, squads, turnManager, issued, left, told }
}

/** A seat at the far end of a loopback, and the frames it has been sent. */
function seated(mode: NetworkMode, faction: Faction): { network: NetworkManager; frames: string[] } {
  const network = new NetworkManager()
  network.mode = mode
  network.myFaction = faction
  const [ours, theirs] = loopback()
  network.attach(ours)
  const frames: string[] = []
  theirs.onFrame((frame) => {
    if ('method' in frame) frames.push(frame.method)
  })
  return { network, frames }
}

/** A shoot aim that offers `target` for every shot, and remembers what was chosen. */
function offering(target: Soldier | null): { aiming: Aiming; chosen: ShotMode[] } {
  const chosen: ShotMode[] = []
  const shoot: ShootAim = {
    active: true,
    selectedTarget: null,
    enter: () => true,
    exit() {},
    selectTarget() {},
    choose: (_shooter, mode) => {
      chosen.push(mode)
      return target
    },
  }
  return { aiming: { ...headlessView().aiming, shoot }, chosen }
}

describe('MatchSession: intents become commands through the one door', () => {
  test('a HUD press on the selected unit is applied as a local command, and the view is told', () => {
    const { session, issued, told, squads } = build()
    const unit = squads.byFaction[Faction.Blue][0]!

    session.handleIntent({ type: 'toggleCover' })

    expect(issued.map((entry) => [entry.command.type, entry.origin])).toEqual([['toggleCover', 'local']])
    expect(unit.isCrouching).toBe(true)
    expect(told.applied).toEqual([{ type: 'toggleCover', origin: 'local' }])
  })

  test('a press with nothing selected issues nothing', () => {
    const { session, issued, turnManager } = build()
    turnManager.selectSoldier(null)

    session.handleIntent({ type: 'toggleCover' })
    session.handleIntent({ type: 'overwatch' })
    session.handleIntent({ type: 'endUnitTurn' })

    expect(issued).toEqual([])
  })

  test('a shot is only commanded at the target the aim offers, in the mode pressed', () => {
    const scratch = build()
    const red = scratch.squads.byFaction[Faction.Red][1]!
    const offered = offering(red)
    const withTarget = build({ aiming: offered.aiming })

    withTarget.session.handleIntent({ type: 'fireShot', mode: ShotMode.Aimed })

    expect(offered.chosen).toEqual([ShotMode.Aimed])
    expect(withTarget.issued).toHaveLength(1)
    expect(withTarget.issued[0]!.command).toMatchObject({
      type: 'fireShot',
      shooterFaction: Faction.Blue,
      shooterIndex: 0,
      targetFaction: Faction.Red,
      targetIndex: 1,
      mode: ShotMode.Aimed,
    })

    const refused = build({ aiming: offering(null).aiming })
    refused.session.handleIntent({ type: 'fireShot', mode: ShotMode.Snap })
    expect(refused.issued).toEqual([])
  })

  test('a confirmed route from the planner is commanded as a move, with the path as plain tiles', () => {
    const route: Tile[] = [
      { x: 6, y: 4 },
      { x: 6, y: 5 },
    ]
    const movement = {
      ...headlessView().aiming.movement,
      handleClick(soldier: Soldier) {
        movement.onMovementStarted?.(soldier, route)
        return true
      },
    }
    const { session, issued } = build({ aiming: { ...headlessView().aiming, movement } })

    session.handlePointer({ type: 'tap', tile: { x: 6, y: 5 }, friendly: null, enemy: null, additive: false })

    expect(issued).toHaveLength(1)
    expect(issued[0]!.command).toEqual({ type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: route })
    expect(issued[0]!.origin).toBe('local')
  })

  test('tapping another squadmate selects them instead of walking', () => {
    const { session, issued, turnManager, squads } = build()

    session.handlePointer({ type: 'tap', tile: { x: 8, y: 3 }, friendly: 2, enemy: null, additive: false })

    expect(turnManager.selectedSoldier).toBe(squads.byFaction[Faction.Blue][2]!)
    expect(issued).toEqual([])
  })

  test('a right-click turns the selected unit, unless that unit is down', () => {
    const { session, issued, squads } = build()

    session.handlePointer({ type: 'face', x: 4, z: 9 })
    expect(issued[0]!.command).toEqual({ type: 'rightClickFacing', faction: Faction.Blue, squadIndex: 0, x: 4, z: 9 })

    issued.length = 0
    squads.byFaction[Faction.Blue][0]!.hp = 0
    session.handlePointer({ type: 'face', x: 4, z: 9 })
    expect(issued).toEqual([])
  })

  test('a hot-seat turn switch asks the screen first, then ends the turn and tells the view', () => {
    const { session, issued, told, turnManager } = build()

    session.handleIntent({ type: 'requestTurnSwitch' })
    expect(told.shown).toEqual(['requestTurnSwitch'])
    expect(issued).toEqual([])

    session.handleIntent({ type: 'confirmTurnSwitch' })

    expect(told.shown).toEqual(['requestTurnSwitch', 'confirmTurnSwitch'])
    expect(issued.map((entry) => entry.command.type)).toEqual(['endTurn'])
    expect(turnManager.activeFaction).toBe(Faction.Red)
    expect(told.turnsSwitched).toBe(1)
  })

  test('on one screen the side taking the chair has its first unit selected', () => {
    const { session, turnManager, squads } = build()
    expect(turnManager.selectedSoldier?.faction).toBe(Faction.Blue)

    session.handleIntent({ type: 'confirmTurnSwitch' })

    expect(turnManager.selectedSoldier).toBe(squads.byFaction[Faction.Red][0]!)
  })

  test("over a network the other side's turn selects nothing, and this side's turn selects its first unit", () => {
    const { network } = seated('host', Faction.Blue)
    const { session, turnManager, squads } = build({ network })

    session.handleIntent({ type: 'requestTurnSwitch' })
    expect(turnManager.selectedSoldier).toBeNull()

    session.handleRemoteNetworkMessage({ type: 'endTurn', faction: Faction.Red })
    session.update(0)
    expect(turnManager.activeFaction).toBe(Faction.Blue)
    expect(turnManager.selectedSoldier).toBe(squads.byFaction[Faction.Blue][0]!)
  })
})

describe('MatchSession: the turn gate', () => {
  test('a window waiting for the other side commands nothing, by button or by tap', () => {
    const { network, frames } = seated('join', Faction.Red)
    const { session, issued, told } = build({ network })

    session.handleIntent({ type: 'toggleCover' })
    session.handleIntent({ type: 'selectLevel', level: 1 })
    session.handlePointer({ type: 'face', x: 1, z: 1 })
    session.handlePointer({ type: 'tap', tile: { x: 6, y: 5 }, friendly: null, enemy: null, additive: false })

    expect(issued).toEqual([])
    expect(frames).toEqual([])
    expect(told.shown).toEqual([])
  })

  test('on its own turn a window commands, and what it commands travels', () => {
    const { network, frames } = seated('host', Faction.Blue)
    const { session, issued } = build({ network })

    session.handleIntent({ type: 'toggleCover' })

    expect(issued).toHaveLength(1)
    expect(frames).toEqual([RpcMethods.toggleCover])
  })

  test('canAct is one answer per mode, and the HUD is handed it', () => {
    expect(build().session.canAct).toBe(true)

    const { network: blue } = seated('host', Faction.Blue)
    const host = build({ network: blue })
    expect(host.session.mode).toBe('host')
    expect(host.session.state).toMatchObject({ canAct: true, seat: Faction.Blue })

    const { network: red } = seated('join', Faction.Red)
    const guest = build({ network: red })
    expect(guest.session.mode).toBe('join')
    expect(guest.session.state).toMatchObject({ canAct: false, seat: Faction.Red })

    // The turn passing is what flips it, for both seats.
    host.session.handleIntent({ type: 'requestTurnSwitch' })
    expect(host.turnManager.activeFaction).toBe(Faction.Red)
    expect(host.session.canAct).toBe(false)

    for (const watching of ['spectate', 'replay'] as const) {
      const watcher = build({ watching })
      expect(watcher.session.mode).toBe(watching)
      expect(watcher.session.state).toMatchObject({ canAct: false, seat: null })
    }
  })

  test('the end screen answers on any side: leaving is not gated by whose turn it was', () => {
    const { network } = seated('join', Faction.Red)
    const { session, left, told } = build({ network })

    session.handleIntent({ type: 'endScreenNext' })
    session.handleIntent({ type: 'backToMenu' })

    expect(told.shown).toEqual(['endScreenNext'])
    expect(left.count).toBe(1)
  })

  test('a spectator may look around but never command', () => {
    const { session, issued, told, left } = build({ watching: 'replay' })

    session.handleIntent({ type: 'toggleCover' })
    session.handleIntent({ type: 'endUnitTurn' })
    session.handleIntent({ type: 'confirmTurnSwitch' })
    session.handlePointer({ type: 'face', x: 1, z: 1 })
    session.handleIntent({ type: 'selectLevel', level: 1 })
    session.handleIntent({ type: 'toggleFreelook' })
    session.handleIntent({ type: 'backToMenu' })

    expect(issued).toEqual([])
    expect(told.shown).toEqual(['selectLevel', 'toggleFreelook'])
    expect(left.count).toBe(1)
  })

  test('a spectator tapping a unit of the side that is up selects it, and nothing is commanded', () => {
    const { session, issued, turnManager, squads } = build({ watching: 'replay' })

    session.handlePointer({ type: 'tap', tile: { x: 8, y: 3 }, friendly: 3, enemy: null, additive: false })

    expect(turnManager.selectedSoldier).toBe(squads.byFaction[Faction.Blue][3]!)
    expect(issued).toEqual([])
  })
})

describe('MatchSession: retreat asks twice', () => {
  test('the first press arms it, and any other press stands it down', () => {
    const { session, issued } = build()

    session.handleIntent({ type: 'requestRetreat' })
    expect(session.state.retreatArmed).toBe(true)

    session.handleIntent({ type: 'toggleCover' })
    expect(session.state.retreatArmed).toBe(false)

    session.handleIntent({ type: 'confirmRetreat' })
    // Confirmed without being armed first still asks the rules, which is the
    // one that says no: the gate for "twice" is the prompt, the rest is theirs.
    expect(issued.map((entry) => entry.command.type)).toEqual(['toggleCover', 'retreat'])
  })

  test('a press on the field does not stand an armed retreat down', () => {
    const { session } = build()

    session.handleIntent({ type: 'requestRetreat' })
    session.handlePointer({ type: 'face', x: 4, z: 9 })

    expect(session.state.retreatArmed).toBe(true)
  })
})

describe('MatchSession: state out', () => {
  test('is what the HUD needs from input: network, side, and whether the rules are acting', () => {
    const { network } = seated('host', Faction.Blue)
    const { session } = build({ network })

    expect(session.state).toMatchObject({
      canAct: true,
      seat: Faction.Blue,
      rulesActing: false,
      retreatArmed: false,
      retreatNote: null,
      item: null,
    })
    expect(session.viewerFaction).toBe(Faction.Blue)
  })

  test('a match with nobody else in it is local, and the screen is the side whose turn it is', () => {
    const { session } = build()
    expect(session.state).toMatchObject({ canAct: true, seat: null })

    session.handleIntent({ type: 'confirmTurnSwitch' })
    expect(session.viewerFaction).toBe(Faction.Red)
  })

  test('the match ends when a side has nobody standing: once, and with who won', () => {
    const { session, squads, told } = build()
    for (const unit of squads.byFaction[Faction.Red]) unit.hp = 0

    session.update(1 / 60)
    session.update(1 / 60)

    expect(told.ended).toHaveLength(1)
    expect(told.ended[0]!.winner).toBe(Faction.Blue)
    expect(told.ended[0]!.viewer).toBeNull()
  })

  test('a spectator is never shown an end: there is nobody to show it to', () => {
    const { session, squads, told } = build({ watching: 'replay' })
    for (const unit of squads.byFaction[Faction.Red]) unit.hp = 0

    session.update(1 / 60)

    expect(told.ended).toEqual([])
  })
})
