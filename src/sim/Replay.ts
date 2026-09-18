import { Faction, SIM } from '../config'
import { NO_FOCUS, NO_FX } from '../core/Combatant'
import { generateMap } from '../core/MapGenerator'
import { distance, facingYaw } from '../core/math'
import { matchDice } from '../core/rng'
import { applyHitEffects, throwGrenade, type ResolvedHit } from '../game/Combat'
import {
  reportDivergence,
  shadowShot,
  shadowThrow,
  type Divergence,
} from '../game/Divergence'
import type { CombatRecording, RecordedEvent } from '../game/Recording'
import { Squads } from '../game/Squads'
import { compareDigests, digestWorld, type StateDigest } from '../game/StateDigest'
import { TurnManager } from '../game/TurnManager'
import { CombatSystem, ItemSystem, MovementSystem, TurnSystem } from '../ecs/systems'
import { createGlobalRules } from '../ecs/globals'
import { World } from '../ecs/World'
import type { WireHit } from '../game/NetworkManager'

/**
 * Replay a recorded match over the real ECS, with nothing watching.
 *
 * Why this exists rather than the rendered playback that already does it: a
 * replay is the one way to exercise the **receiving** side of the wire without
 * two browsers, a signalling broker and a second pair of hands. Every shot in
 * a recording arrives here exactly as a peer's shot arrives — resolved numbers,
 * hit dice, a stated hit chance — so the divergence check from `ITEM-020` and
 * the digest from `ITEM-021` are exercised end to end by running a file.
 *
 * Two things it is deliberately not:
 *
 * - **Not a second implementation of the rules.** Every command goes through
 *   the same systems a match uses: `CombatSystem.replayShot`, `throwGrenade`,
 *   `MovementSystem`, `TurnManager`.
 * - **Not the controller's applier.** It mirrors it, and the difference is
 *   stated where it matters: a *peer's* `reload` and `useItem` apply nothing,
 *   because HP, AP, clips and pouches arrive by component replication. A file
 *   replicates nothing, so a replay has to re-run them. That duplication is the
 *   honest cost of the controller's applier being tangled up with a HUD, and it
 *   is what `ITEM-025`'s referee would extract.
 */

/** What happened when the file was run. */
export interface ReplayOutcome {
  seed: number
  /** Events in the file. */
  events: number
  /** Events this build knew how to apply. */
  applied: number
  /** Events skipped, and why — an unknown command is a finding, not a no-op. */
  skipped: { seq: number; type: string; reason: string }[]
  /**
   * Disagreements between the numbers in the file and what this build resolves
   * from the same dice. Empty is the whole point.
   */
  divergences: { seq: number; at: string; found: Divergence[] }[]
  /** The final fingerprint, so two runs can be compared in one number. */
  digest: StateDigest
  /** Where everybody ended up. */
  units: {
    name: string
    faction: Faction
    hp: number
    maxHp: number
    ap: number
    armor: number
    tile: { x: number; y: number }
    dead: boolean
  }[]
  turns: number
}

export interface ReplayOptions {
  /** Print each divergence as it is found. Off by default so tests stay quiet. */
  verbose?: boolean
  /**
   * Movement is animated, so a replay has to advance time for a unit to arrive.
   * Fixed step, because a variable one would make the replay depend on how
   * fast the machine running it is.
   */
  step?: number
  /** Give up on a unit that never arrives, rather than looping forever. */
  maxStepsPerMove?: number
}

export function replay(recording: CombatRecording, options: ReplayOptions = {}): ReplayOutcome {
  const { header, events } = recording
  const step = options.step ?? SIM.step
  const maxSteps = options.maxStepsPerMove ?? 2000

  const map = generateMap(header.seed)
  const world = new World()
  createGlobalRules(world)
  const squads = new Squads(
    world,
    map.grid,
    map.spawns,
    undefined,
    Faction.Blue,
    header.sheets,
  )
  // Both sides from the file: a replay resolves nothing, but every number it
  // checks depends on what the two squads were carrying.
  squads.equipFaction(Faction.Blue, header.loadouts[Faction.Blue])
  squads.equipFaction(Faction.Red, header.loadouts[Faction.Red])

  const movement = new MovementSystem(map.grid)
  const combat = new CombatSystem(map.grid, squads, NO_FX, matchDice(header.seed))
  const items = new ItemSystem()
  const turns = new TurnSystem()
  const turnManager = new TurnManager(world, turns, squads, NO_FOCUS)
  world.addSystem(movement)
  world.addSystem(combat)
  world.addSystem(items)
  world.addSystem(turns)
  turnManager.autoSelectFirst()

  const skipped: ReplayOutcome['skipped'] = []
  const divergences: ReplayOutcome['divergences'] = []
  let applied = 0

  const unitAt = (faction: Faction, index: number) => squads.byFaction[faction][index]
  const localHits = (hits: readonly WireHit[]): ResolvedHit[] =>
    hits.flatMap((hit) => {
      const soldier = unitAt(hit.faction, hit.index)
      if (!soldier) return []
      return [
        {
          soldier,
          damage: hit.damage,
          armorShred: hit.armorShred,
          killed: false,
          status: hit.status,
          crit: hit.crit,
        },
      ]
    })

  const note = (seq: number, at: string, found: Divergence[]): void => {
    if (found.length === 0) return
    divergences.push({ seq, at, found })
    if (options.verbose) reportDivergence(`${at} (event ${seq})`, found)
  }

  /** Advance time until nothing is walking, so the next command sees the arrival. */
  const settleMovement = (): void => {
    for (let i = 0; i < maxSteps; i++) {
      if (!squads.soldiers.some((unit) => unit.isMoving)) return
      world.update(step)
    }
  }

  for (const event of events) {
    const command = event.command
    switch (command.type) {
      case 'moveUnit': {
        const soldier = unitAt(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'no such live unit' })
          break
        }
        movement.startMovement(world, soldier.entityId, command.path)
        settleMovement()
        applied++
        break
      }
      case 'fireShot': {
        const shooter = unitAt(command.shooterFaction, command.shooterIndex)
        const target = unitAt(command.targetFaction, command.targetIndex)
        if (!shooter || !target) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'shooter or target missing' })
          break
        }
        note(
          event.seq,
          `${shooter.name}'s shot at ${target.name}`,
          shadowShot(
            map.grid,
            shooter,
            target,
            squads.soldiers,
            command.mode,
            command.rolls,
            command.hits,
            command.chance,
          ),
        )
        combat.replayShot(shooter, target, command.rolls, localHits(command.hits))
        applied++
        break
      }
      case 'throwGrenade': {
        const thrower = unitAt(command.shooterFaction, command.shooterIndex)
        if (!thrower) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'no such thrower' })
          break
        }
        note(
          event.seq,
          `${thrower.name}'s ${command.kind}`,
          shadowThrow(map.grid, thrower, command.targetTile, command.kind, squads.soldiers, command.hits),
        )
        for (const hit of localHits(command.hits)) {
          applyHitEffects(hit.soldier, hit.damage, hit.armorShred, hit.status)
        }
        // The thrower's own costs. A peer's arrive by replication; a file's do
        // not, so the grenade is spent here as the thrower spent it.
        thrower.grenades[command.kind] = Math.max(0, (thrower.grenades[command.kind] ?? 1) - 1)
        thrower.ap = Math.max(0, thrower.ap - thrower.grenadeSpecs[command.kind].apCost)
        applied++
        break
      }
      case 'reload': {
        const soldier = unitAt(command.faction, command.squadIndex)
        if (!soldier) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'no such unit' })
          break
        }
        combat.reload(soldier)
        applied++
        break
      }
      case 'toggleCover': {
        const soldier = unitAt(command.faction, command.squadIndex)
        if (!soldier) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'no such unit' })
          break
        }
        combat.toggleCover(world, soldier.entityId)
        applied++
        break
      }
      case 'useItem': {
        const user = unitAt(command.faction, command.squadIndex)
        if (!user) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'no such unit' })
          break
        }
        const target =
          command.targetFaction !== undefined && command.targetIndex !== undefined
            ? unitAt(command.targetFaction, command.targetIndex)
            : undefined
        items.use(user, command.itemId, target ?? user, true)
        applied++
        break
      }
      case 'endUnitTurn': {
        const soldier = unitAt(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'no such live unit' })
          break
        }
        turnManager.finishSoldierTurn(soldier)
        applied++
        break
      }
      case 'endTurn': {
        turnManager.startNextTurn()
        applied++
        break
      }
      case 'rightClickFacing': {
        const soldier = unitAt(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) {
          skipped.push({ seq: event.seq, type: command.type, reason: 'no such live unit' })
          break
        }
        const dx = command.x - soldier.position.x
        const dz = command.z - soldier.position.z
        if (distance(dx, dz) > 0.01) soldier.targetYaw = facingYaw(dx, dz)
        applied++
        break
      }
      default:
        // Handshake and diagnostic frames are not intents and are never
        // recorded; anything else arriving here is a command this build does
        // not know, which is a finding about the file's version.
        skipped.push({ seq: event.seq, type: command.type, reason: 'unknown command' })
    }
  }

  return {
    seed: header.seed,
    events: events.length,
    applied,
    skipped,
    divergences,
    digest: digestWorld(world, squads.soldiers.map((unit) => unit.entityId), turnManager.turnNumber),
    units: squads.soldiers.map((unit) => ({
      name: unit.name,
      faction: unit.faction,
      hp: unit.hp,
      maxHp: unit.maxHp,
      ap: unit.ap,
      armor: unit.armor,
      tile: { ...unit.tile },
      dead: unit.isDead,
    })),
    turns: turnManager.turnNumber,
  }
}

/**
 * Run the same file twice and compare.
 *
 * The property a stored match has to have before a roster can be derived from
 * one: the same intents over the same seed produce the same world. Reported
 * rather than asserted, so a caller can decide whether it is a test failure or
 * a line in a report.
 */
export function replayIsReproducible(recording: CombatRecording): {
  reproducible: boolean
  differences: Divergence[]
} {
  const first = replay(recording)
  const second = replay(recording)
  const differences = compareDigests(first.digest, second.digest, (entityId) => `#${entityId}`)
  return { reproducible: differences.length === 0, differences }
}

/** One event, for a caller that wants to narrate a replay. */
export type { RecordedEvent }
