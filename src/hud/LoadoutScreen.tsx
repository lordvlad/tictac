import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AMMO, AmmoId, GRENADES, GrenadeId, SHOT_MODES, WEAPONS, WeaponId } from '../core/Arsenal'
import { ATTACHMENTS, AttachmentId } from '../core/Attachments'
import { derive, type CharacterAppearance, type CharacterSheet } from '../core/Characters'
import { ITEMS, ItemId } from '../core/Items'
import { MELEE, MeleeId } from '../core/Melee'
import { TEMPERAMENTS } from '../core/Morale'
import { resolveTraits, TRAITS, type TraitId } from '../core/Traits'
import { ROLES, RoleId } from '../core/Roles'
import { FACTION_INFO, Faction } from '../config'
import type { EngineContext } from '../engine'
import {
  canAddGrenade,
  canAddItem,
  canEquipAmmo,
  canEquipSidearm,
  canEquipWeapon,
  canFitAttachment,
  defaultLoadout,
  addGrenade,
  addItem,
  equipAmmo,
  equipSidearm,
  equipWeapon,
  fitAttachment,
  itemsCarried,
  railSpace,
  remaining,
  removeGrenade,
  removeItem,
  unfitAttachment,
  type SquadLoadout,
  type UnitLoadout,
  setRole,
} from '../game/Loadout'
import { Icon } from './Icon'
import { LoadoutScene } from '../render/LoadoutScene'
import type { OffscreenPortraits } from '../render/Portraits'

/** What a press on the screen asks for. */
type LoadoutAction =
  | { kind: 'select'; index: number }
  | { kind: 'weapon'; id: WeaponId }
  | { kind: 'ammo'; id: AmmoId }
  | { kind: 'sidearm'; id: MeleeId }
  | { kind: 'grenade'; id: GrenadeId; delta: number }
  | { kind: 'item'; id: ItemId; delta: number }
  | { kind: 'attachment'; id: AttachmentId; delta: number }
  | { kind: 'role'; id: RoleId }
  | { kind: 'appearance'; field: keyof CharacterAppearance; value: number }
  | { kind: 'deploy' }
type Apply = (action: LoadoutAction) => void

/**
 * The pre-combat loadout screen: the squad staged on a semi-circle behind a
 * panel of kit, sharing one crate of equipment.
 *
 * A view over {@link SquadLoadout}. Every press goes through the loadout
 * helpers, which own the rules about what the crate can still cover and what a
 * soldier can carry, and then the view re-renders from the mutated loadout.
 *
 * Mounted on <body> rather than #ui, which is `pointer-events: none` with only
 * buttons re-enabled; this screen has steppers and hoverable rows.
 */
export class LoadoutScreen {
  private readonly container: HTMLDivElement
  private readonly view: Root
  private readonly scene: LoadoutScene
  private readonly loadout: SquadLoadout
  private selected = 0
  private waitingLabel: string | null = null
  private readonly deployed = Promise.withResolvers<SquadLoadout>()
  private disposed = false

  constructor(
    engine: EngineContext,
    private readonly portraits: OffscreenPortraits,
    seed: number,
    private readonly faction: Faction,
    /**
     * The squad's people, as opposed to their kit. Given by the caller,
     * because where a squad comes from is not this screen's business: a local
     * match rolls one, and a match on a server that keeps rosters deploys the
     * one the server holds.
     */
    readonly sheets: CharacterSheet[],
  ) {
    // One kit per person who is actually deploying: a kept roster with an
    // empty slot brings fewer than a full squad, and so does its loadout.
    this.loadout = defaultLoadout(sheets.length)
    this.scene = new LoadoutScene(engine, seed, faction, sheets)

    this.container = document.createElement('div')
    this.container.className = 'loadout-root'
    document.body.appendChild(this.container)
    this.view = createRoot(this.container)

    this.render()
  }

  /** Resolves with the squad's kit once the player presses Deploy. */
  show(): Promise<SquadLoadout> {
    return this.deployed.promise
  }

  /** Swap the Deploy button for a status line while the peer finishes. */
  markWaiting(label: string): void {
    this.waitingLabel = label
    this.render()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.view.unmount()
    this.container.remove()
    this.scene.dispose()
  }

  private readonly apply: Apply = (action) => {
    switch (action.kind) {
      case 'select':
        this.selected = action.index
        this.scene.select(action.index)
        break
      case 'weapon':
        equipWeapon(this.loadout, this.selected, action.id)
        break
      case 'ammo':
        equipAmmo(this.loadout, this.selected, action.id)
        break
      case 'sidearm':
        equipSidearm(this.loadout, this.selected, action.id)
        break
      case 'grenade':
        if (action.delta > 0) addGrenade(this.loadout, this.selected, action.id)
        else removeGrenade(this.loadout, this.selected, action.id)
        break
      case 'item':
        // The pouch is the soldier's, not the rules': the gate has to be told
        // how much this one can carry, and asked whether this one is allowed
        // the item at all.
        if (action.delta > 0) {
          const sheet = this.sheets[this.selected]!
          if (!meetsRequirement(sheet, action.id)) break
          addItem(this.loadout, this.selected, action.id, derive(sheet).carrySlots)
        } else removeItem(this.loadout, this.selected, action.id)
        break
      case 'attachment':
        if (action.delta > 0) fitAttachment(this.loadout, this.selected, action.id)
        else unfitAttachment(this.loadout, this.selected, action.id)
        break
      case 'role':
        setRole(this.loadout, this.selected, action.id)
        break
      case 'appearance': {
        const sheet = this.sheets[this.selected]!
        sheet.appearance[action.field] = Number(action.value.toFixed(3))
        this.scene.updateProportions(this.selected, sheet.appearance)
        this.portraits.update(this.faction, this.selected, sheet)
        break
      }
      case 'deploy':
        this.deployed.resolve(this.loadout)
        return
    }

    this.render()
  }

  private render(): void {
    if (this.disposed) return
    this.view.render(
      <LoadoutView
        faction={this.faction}
        loadout={this.loadout}
        selected={this.selected}
        sheets={this.sheets}
        portraits={this.portraits}
        waitingLabel={this.waitingLabel}
        apply={this.apply}
      />,
    )
  }
}

/**
 * Whether a member clears an item's Intelligence bar.
 *
 * Separate from {@link canAddItem}, which answers about the crate and the
 * pouch: this is a fact about the person, and the same predicate
 * `ItemSystem.canUse` will apply in the match. Shared between the render and
 * the press so a dead + and a refused press cannot disagree.
 */
function meetsRequirement(sheet: CharacterSheet, id: ItemId): boolean {
  const min = ITEMS[id].minIntelligence
  return min === undefined || sheet.attributes.intelligence >= min
}

/** `base` plus each modifier that holds, space-separated. */
function classes(base: string, modifiers: Record<string, boolean>): string {
  let out = base
  for (const [name, on] of Object.entries(modifiers)) if (on) out += ` ${name}`
  return out
}

// -----------------------------------------------------------------------------
// Panels
// -----------------------------------------------------------------------------

function LoadoutView({
  faction,
  loadout,
  selected,
  sheets,
  portraits,
  waitingLabel,
  apply,
}: {
  faction: Faction
  loadout: SquadLoadout
  selected: number
  sheets: CharacterSheet[]
  portraits: OffscreenPortraits
  waitingLabel: string | null
  apply: Apply
}) {
  return (
    <>
      <div className="loadout-title">
        <div className="loadout-heading">LOADOUT</div>
        <div className="loadout-sub">{FACTION_INFO[faction].label} — share out the crate, then deploy</div>
        <div className="loadout-credit">Icons by game-icons.net (CC BY 3.0)</div>
      </div>
      <Pool loadout={loadout} />
      <Panel faction={faction} loadout={loadout} selected={selected} sheet={sheets[selected]!} apply={apply} />
      <Cards faction={faction} loadout={loadout} selected={selected} sheets={sheets} portraits={portraits} apply={apply} />
      {waitingLabel === null ? (
        <button
          className="hud-btn hud-btn-danger loadout-deploy interactive"
          onClick={() => apply({ kind: 'deploy' })}
        >
          <Icon file="ui-deploy" /> Deploy
        </button>
      ) : (
        <div className="loadout-waiting">{waitingLabel}</div>
      )}
    </>
  )
}

function Pool({ loadout }: { loadout: SquadLoadout }) {
  const left = remaining(loadout)
  const row = (file: string, name: string, count: number) => (
    <div key={file} className={classes('loadout-pool-row', { depleted: count === 0 })}>
      <Icon file={file} />
      <span className="loadout-pool-name">{name}</span>
      <span className="loadout-pool-count">{count}</span>
    </div>
  )

  return (
    <div className="loadout-pool">
      <div className="loadout-pool-head">
        <Icon file="ui-pool" /> Squad crate
      </div>
      {Object.values(WeaponId).map((id) => row(`weapon-${id}`, WEAPONS[id].name, left.weapons[id]))}
      {Object.values(AmmoId).map((id) => row(`ammo-${id}`, AMMO[id].name, left.ammo[id]))}
      {Object.values(GrenadeId)
        // Issued kit (a stone) is nobody's to hand out.
        .filter((id) => GRENADES[id].issued === 0)
        .map((id) => row(`grenade-${id}`, GRENADES[id].name, left.grenades[id]))}
      {Object.values(ItemId).map((id) => row(`item-${id}`, ITEMS[id].name, left.items[id]))}
      {Object.values(AttachmentId).map((id) =>
        row(`attachment-${id}`, ATTACHMENTS[id].name, left.attachments[id]),
      )}
      {Object.values(MeleeId)
        // Fists are not in the crate: a row for them would read as a stock
        // that could run out.
        .filter((id) => id !== MeleeId.Fists)
        .map((id) => row(`melee-${id}`, MELEE[id].name, left.sidearms[id]))}
    </div>
  )
}

function Panel({
  faction,
  loadout,
  selected,
  sheet,
  apply,
}: {
  faction: Faction
  loadout: SquadLoadout
  selected: number
  sheet: CharacterSheet
  apply: Apply
}) {
  const unit = loadout[selected]!
  const name = FACTION_INFO[faction].squadNames[selected] ?? ''

  const pick = (file: string, label: string, active: boolean, enabled: boolean, action: LoadoutAction) => (
    <button
      key={file}
      className={classes('action-btn interactive', { active })}
      disabled={!enabled}
      onClick={() => apply(action)}
    >
      <Icon file={file} />
      <span className="loadout-pick-name">{label}</span>
    </button>
  )

  const stepper = (
    file: string,
    label: string,
    count: number,
    canAdd: boolean,
    minus: LoadoutAction,
    plus: LoadoutAction,
    note: ReactNode = null,
  ) => (
    <div key={file} className="loadout-stepper">
      <Icon file={file} />
      <span className="loadout-pick-name">{label}</span>
      {note}
      <button className="loadout-step interactive" disabled={count <= 0} onClick={() => apply(minus)}>
        −
      </button>
      <span className="loadout-count">{count}</span>
      <button className="loadout-step interactive" disabled={!canAdd} onClick={() => apply(plus)}>
        +
      </button>
    </div>
  )
  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (val: number) => void,
  ) => {
    const percent = Math.round(value * 100)
    return (
      <div key={label} className="loadout-slider-row">
        <div className="loadout-slider-header">
          <span className="loadout-slider-label">{label}</span>
          <span className="loadout-slider-val">{percent}%</span>
        </div>
        <div className="loadout-slider-controls">
          <button
            className="loadout-step interactive"
            disabled={value <= min}
            onClick={() => onChange(Math.max(min, Number((value - step * 2).toFixed(3))))}
          >
            −
          </button>
          <input
            type="range"
            className="loadout-slider interactive"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <button
            className="loadout-step interactive"
            disabled={value >= max}
            onClick={() => onChange(Math.min(max, Number((value + step * 2).toFixed(3))))}
          >
            +
          </button>
        </div>
      </div>
    )
  }

  // The sidearm and the weapon are the picks whose options are not simply
  // better or worse than each other, so their buttons have to carry enough
  // of the table to choose on: what a blow or a round costs and does, and a
  // one-line character from `sidearmCharacter` or `weaponCharacter`. The
  // count sits on the sidearm button rather than only in the crate because a
  // greyed-out knife needs its reason beside it, the same argument the pouch
  // pips make. Fists are never short, so they show no number at all rather
  // than a zero or an infinity to puzzle over.
  const left = remaining(loadout)
  const sidearm = (id: MeleeId) => {
    const spec = MELEE[id]
    return (
      <button
        key={id}
        className={classes('action-btn interactive loadout-specced', { active: unit.sidearm === id })}
        disabled={!canEquipSidearm(loadout, selected, id)}
        title={`Accuracy ${spec.accuracy}% · parry ${spec.parry} · crit ${spec.critChance}% ×${spec.critMultiplier}`}
        onClick={() => apply({ kind: 'sidearm', id })}
      >
        <Icon file={`melee-${id}`} />
        <span className="loadout-pick-name">{spec.name}</span>
        {id === MeleeId.Fists ? null : <span className="loadout-pool-count">×{left.sidearms[id]}</span>}
        <span className="loadout-pick-spec">
          {spec.apCost} AP · {spec.damage} dmg · {Math.round(spec.armorPen * 100)}% pen
          <br />
          {sidearmCharacter(id)}
        </span>
      </button>
    )
  }

  // The in-match shot panel says only whether a round lands and what it
  // does, so this is where a weapon's character is read. Spread is shown as
  // centimetres of miss at ten metres because metres-per-metre is a number
  // nobody can picture; the tooltip keeps the raw table for whoever wants it.
  // The character word rides on the name row, where a sidearm shows its
  // stock: the spec lines are already as long as the panel is wide.
  const weapon = (id: WeaponId) => {
    const spec = WEAPONS[id]
    const damage = spec.pellets > 1 ? `${spec.pellets}×${spec.damage}` : `${spec.damage}`
    const spread = Math.round(errorAt10(id) * 100)
    const modes = spec.availableModes.map((mode) => SHOT_MODES[mode].name).join(', ')
    const bias = spec.critRangeBias > 0 ? 'far' : spec.critRangeBias < 0 ? 'close' : 'anywhere'
    return (
      <button
        key={id}
        className={classes('action-btn interactive loadout-specced', { active: unit.weaponId === id })}
        disabled={!canEquipWeapon(loadout, selected, id)}
        title={`Sway ${spec.sway} m · spread ${spec.spread} m per m · ${Math.round(spec.armorPen * 100)}% pen · ${modes} · crits best ${bias}`}
        onClick={() => apply({ kind: 'weapon', id })}
      >
        <Icon file={`weapon-${id}`} />
        <span className="loadout-pick-name">{spec.name}</span>
        <span className="loadout-pick-tag">{weaponCharacter(id)}</span>
        <span className="loadout-pick-spec">
          {spec.apCost} AP · {damage} dmg · {spec.maxRange} m · clip {spec.maxClip}
          <br />
          spread {spread} cm @10m · crit {spec.critChance}% ×{spec.critMultiplier}
        </span>
      </button>
    )
  }

  // Shown here as well as on the card because this is where the + goes
  // dead: a stepper that stops responding needs its reason in the same
  // panel. Same pips as the weapon rail — it is the same question about a
  // different container, and a second vocabulary for it would be one more
  // thing to learn.
  const { carrySlots } = derive(sheet)
  const carried = itemsCarried(unit)

  // The Intelligence bar, printed on the row it stops. A + that will not
  // move is indistinguishable from an empty crate otherwise, and the bar is
  // worth reading even when it is met: it is the same INT the squad cards
  // carry, so the number beside the item says which members could take it.
  // Red on the ones who cannot, as a losing weapon proficiency is.
  const { intelligence } = sheet.attributes
  const requirement = (id: ItemId): ReactNode => {
    const min = ITEMS[id].minIntelligence
    if (min === undefined) return null
    const short = intelligence < min
    const why = short
      ? `${ITEMS[id].name} needs Intelligence ${min}; ${name} has ${intelligence}`
      : `${ITEMS[id].name} needs Intelligence ${min}`
    return (
      <span className={classes('loadout-stat', { penalty: short })} title={why}>
        <span className="loadout-stat-name">INT</span>
        <span className="loadout-stat-value">{min}</span>
      </span>
    )
  }

  return (
    <div className="loadout-panel">
      <div className="loadout-panel-head">{name}</div>

      <div className="loadout-section">Physique</div>
      {slider('Height', sheet.appearance.height, 0.88, 1.12, 0.01, (val) =>
        apply({ kind: 'appearance', field: 'height', value: val }),
      )}
      {slider('Bulkiness', sheet.appearance.bulkiness, 0.8, 1.3, 0.01, (val) =>
        apply({ kind: 'appearance', field: 'bulkiness', value: val }),
      )}
      {slider('Gut', sheet.appearance.gut, 0.8, 1.4, 0.01, (val) =>
        apply({ kind: 'appearance', field: 'gut', value: val }),
      )}
      <div className="loadout-section">Role</div>
      {Object.values(RoleId).map((id) =>
        pick(`role-${id}`, ROLES[id].name, unit.role === id, true, { kind: 'role', id }),
      )}

      <div className="loadout-section">Weapon</div>
      {Object.values(WeaponId).map(weapon)}

      <div className="loadout-section">Ammo</div>
      {Object.values(AmmoId).map((id) =>
        pick(`ammo-${id}`, AMMO[id].name, unit.ammoId === id, canEquipAmmo(loadout, selected, id), {
          kind: 'ammo',
          id,
        }),
      )}

      <div className="loadout-section">Sidearm</div>
      {Object.values(MeleeId).map(sidearm)}

      <div className="loadout-section">Grenades</div>
      {Object.values(GrenadeId)
        .filter((id) => GRENADES[id].issued === 0)
        .map((id) =>
          stepper(
            `grenade-${id}`,
            GRENADES[id].name,
            unit.grenades[id],
            canAddGrenade(loadout, selected, id),
            { kind: 'grenade', id, delta: -1 },
            { kind: 'grenade', id, delta: 1 },
          ),
        )}

      <div className="loadout-section loadout-section-cap">
        Items
        <Slots used={carried} total={carrySlots} />
        <span className="loadout-cap-count">
          SLOTS {carried}/{carrySlots}
        </span>
      </div>
      {Object.values(ItemId).map((id) =>
        stepper(
          `item-${id}`,
          ITEMS[id].name,
          unit.items[id],
          canAddItem(loadout, selected, id, carrySlots) && meetsRequirement(sheet, id),
          { kind: 'item', id, delta: -1 },
          { kind: 'item', id, delta: 1 },
          requirement(id),
        ),
      )}

      <div className="loadout-section">Attachments</div>
      {Object.values(AttachmentId).map((id) =>
        stepper(
          `attachment-${id}`,
          ATTACHMENTS[id].name,
          unit.attachments.includes(id) ? 1 : 0,
          canFitAttachment(loadout, selected, id),
          { kind: 'attachment', id, delta: -1 },
          { kind: 'attachment', id, delta: 1 },
        ),
      )}
    </div>
  )
}

/** A row of pips, the first `used` of `total` filled. */
function Slots({ used, total }: { used: number; total: number }) {
  return (
    <span className="loadout-slots">
      {Array.from({ length: total }, (_, at) => (
        <span key={at} className={classes('loadout-slot', { filled: at < used })} />
      ))}
    </span>
  )
}

/**
 * What a sidearm is *for*, in a few words, worked out from the table rather
 * than written beside it: the debug panel edits `MELEE` live, and a caption
 * saying "best at crits" over a blade that no longer is would be worse than
 * no caption.
 *
 * Only the differences are named. Every sidearm has some crit chance and
 * some armour penetration, so listing both on each would make three lines
 * that look alike; the crit note goes to whichever crits best, the armour
 * note to whatever strips plate or, at the other end, to whatever plate
 * stops entirely. A sidearm made for backs says so. Noise is always named,
 * because it is a yes/no a player plans around.
 */
function sidearmCharacter(id: MeleeId): string {
  const spec = MELEE[id]
  const notes: string[] = []
  const bestCrit = Object.values(MELEE).every((other) => spec.critChance >= other.critChance)
  if (bestCrit && spec.critChance > 0) notes.push(`crits ${spec.critChance}% ×${spec.critMultiplier}`)
  if (spec.fromBehind > 1) notes.push(`×${spec.fromBehind} from behind`)
  if (spec.armorShred > 0) notes.push(`shreds ${spec.armorShred} armour`)
  else if (spec.armorPen === 0) notes.push('armour stops it')
  notes.push(spec.loudness > 0 ? `heard at ${spec.loudness} m` : 'silent')
  return notes.join(' · ')
}

/** Metres a snap shot misses by at ten metres: the one distance every weapon reaches. */
function errorAt10(id: WeaponId): number {
  const spec = WEAPONS[id]
  return spec.sway + spec.spread * 10
}

/**
 * What a weapon is *for*, in a word or two, worked out from `WEAPONS` for
 * the same reason `sidearmCharacter` is: the table is edited live and a
 * caption has to follow it.
 *
 * Only a weapon that stands out is named, so one in the middle of the table
 * carries no word at all. A shell is `buckshot` rather than `wide`: it is
 * wide, but a fan of pellets that each roll is the thing to know about it.
 */
function weaponCharacter(id: WeaponId): string {
  const spec = WEAPONS[id]
  const error = errorAt10(id)
  const others = Object.values(WeaponId).map((other) => errorAt10(other))
  const notes: string[] = []
  if (spec.pellets > 1) notes.push('buckshot')
  else if (others.every((other) => error <= other)) notes.push('pinpoint')
  else if (others.every((other) => error >= other)) notes.push('wide')
  // A weapon with one way to fire is defined by it: nobody aims a Gatling.
  const [only] = spec.availableModes
  if (spec.availableModes.length === 1 && only) notes.push(`${only} only`)
  return notes.join(' · ')
}

/**
 * The combat squad card, reused: same chrome and selection treatment, with
 * the HP/AP/AR bars — meaningless before a shot is fired — replaced by what
 * the member is carrying and who they are.
 */
function Cards({
  faction,
  loadout,
  selected,
  sheets,
  portraits,
  apply,
}: {
  faction: Faction
  loadout: SquadLoadout
  selected: number
  sheets: CharacterSheet[]
  portraits: OffscreenPortraits
  apply: Apply
}) {
  return (
    <div className="loadout-cards">
      {loadout.map((unit, index) => {
        const name = FACTION_INFO[faction].squadNames[index] ?? ''
        const carried = [
          ...Object.values(GrenadeId).map((id) => ({
            file: `grenade-${id}`,
            name: GRENADES[id].name,
            count: unit.grenades[id],
          })),
          ...Object.values(ItemId).map((id) => ({
            file: `item-${id}`,
            name: ITEMS[id].name,
            count: unit.items[id],
          })),
        ].filter((entry) => entry.count > 0)

        return (
          <div
            key={index}
            className={classes('squad-card interactive', { selected: index === selected })}
            onClick={() => apply({ kind: 'select', index })}
          >
            <img className="squad-portrait" src={portraits.getPortrait(faction, index)} alt={name} />
            <div className="squad-name">{name}</div>
            <div className="loadout-card-role" title={ROLES[unit.role].description}>
              <Icon file={`role-${unit.role}`} />
              {ROLES[unit.role].name}
            </div>
            <div className="loadout-card-kit">
              <Icon file={`weapon-${unit.weaponId}`} className="big" />
              <Icon file={`ammo-${unit.ammoId}`} className="big" />
              {
                // Only a carried blade or club earns a glyph: every card would
                // otherwise show the same fist, and the row is for telling the
                // four apart.
                unit.sidearm === MeleeId.Fists ? null : (
                  <span className="loadout-carried" title={MELEE[unit.sidearm].name}>
                    <Icon file={`melee-${unit.sidearm}`} className="big" />
                  </span>
                )
              }
              {carried.map((entry) => (
                <span key={entry.file} className="loadout-carried" title={entry.name}>
                  <Icon file={entry.file} />
                  {entry.count}
                </span>
              ))}
            </div>
            <Rail unit={unit} />
            <Sheet unit={unit} sheet={sheets[index]!} />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Who the soldier is, under what they are carrying.
 *
 * Only the proficiency for the weapon currently in this unit's hands is
 * shown. The question the card answers is whether this kit suits this
 * soldier, and all four classes at once would bury the one number being
 * decided — the crate rows above already say what the alternatives are.
 *
 * The four attributes sit above the numbers they produce rather than in
 * place of them: the roll is what the player is stuck with, the derived
 * stats are what it bought, and a card showing only one of the two leaves a
 * good sheet indistinguishable from a lucky one. Throw and Item earn their
 * rows the same way — without them Strength and Intelligence would be on
 * the card with nothing a player could point at.
 *
 * Traits granted by kit — worn or bolted on — are listed beside the innate
 * ones. Neither has an action panel row in combat, so this is the only place
 * they explain themselves.
 */
function Sheet({ unit, sheet }: { unit: UnitLoadout; sheet: CharacterSheet }) {
  const traits: { id: TraitId; worn: boolean }[] = sheet.traits.map((id) => ({ id, worn: false }))
  for (const id of Object.values(ItemId)) {
    if (unit.items[id] <= 0) continue
    for (const granted of ITEMS[id].traits ?? []) traits.push({ id: granted, worn: true })
  }

  // Fitted glass is in force the moment it goes on the rail, and this is the
  // screen it is chosen on: a scope missing from the fold would leave Skill
  // reading the number the unit had before the player fitted it.
  for (const id of unit.attachments) {
    for (const granted of ATTACHMENTS[id].traits) traits.push({ id: granted, worn: true })
  }
  // The role's own training, the same "worn" glyph as gear: dropped the
  // instant a different role is picked, the same as a vest taken off.
  const roleTrait = ROLES[unit.role].trait
  if (roleTrait) traits.push({ id: roleTrait, worn: true })

  // Every number here is what the unit will deploy with, traits folded in,
  // because the card is being used to decide kit: a Nimble soldier who reads
  // as their bare sheet would look like a worse pick than they are, and a
  // vest that costs evasion would look free. Same fold the soldier does, so
  // the same answer.
  const fielded = resolveTraits(traits.map((trait) => trait.id))
  const stats = derive(sheet)
  const proficiency = sheet.proficiency[unit.weaponId] + fielded.accuracy
  const evasion = Math.max(0, stats.evasion + fielded.evasion)

  const stat = (label: string, value: string, penalty = false) => (
    <div className={classes('loadout-stat', { penalty })}>
      <span className="loadout-stat-name">{label}</span>
      <span className="loadout-stat-value">{value}</span>
    </div>
  )

  const attr = (label: string, value: number) => (
    <div className="loadout-attr">
      <span className="loadout-attr-name">{label}</span>
      <span className="loadout-attr-value">{value}</span>
    </div>
  )

  // Both halves of the sheet read as deltas, and a bare `3` beside a `-2`
  // would look like a different kind of number.
  const signed = (value: number): string => `${value > 0 ? '+' : ''}${value}`
  const { health, agility, strength, intelligence } = sheet.attributes

  return (
    <div className="loadout-sheet">
      <div className="loadout-attrs">
        {attr('HEA', health)}
        {attr('AGI', agility)}
        {attr('STR', strength)}
        {attr('INT', intelligence)}
      </div>
      <div className="loadout-stats">
        {stat('HP', `${stats.maxHp + fielded.maxHp}`)}
        {stat('AP', `${stats.maxAp + fielded.maxAp}`)}
        {stat('Eva', `${evasion}%`)}
        {stat('Skill', `${signed(proficiency)}%`, proficiency < 0)}
        {stat('Throw', signed(stats.throwRange), stats.throwRange < 0)}
        {stat('Item', `${signed(stats.itemApDelta)} AP`, stats.itemApDelta > 0)}
      </div>
      <div className="loadout-spec">{WEAPONS[sheet.specialism].name} specialist</div>
      <div className="loadout-spec" title={TEMPERAMENTS[sheet.temperament].description}>
        {TEMPERAMENTS[sheet.temperament].name}
      </div>
      <div className="loadout-traits">
        {traits.length === 0 ? (
          <span className="loadout-trait none">No traits</span>
        ) : (
          traits.map((trait, at) => (
            <span
              key={at}
              className={classes('loadout-trait', { worn: trait.worn })}
              title={TRAITS[trait.id].description}
            >
              {TRAITS[trait.id].name}
            </span>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * The weapon in this member's hands as a thing rather than a class: what it
 * is, how much rail it has, and what is bolted to it.
 *
 * The empty pips carry the row: a shotgun with its one slot and a rifle with
 * three read as different weapons before either count is read, which is what
 * makes handing the glass to the sniper an obvious move.
 */
function Rail({ unit }: { unit: UnitLoadout }) {
  const { used, total } = railSpace(unit)

  return (
    <>
      <div className="loadout-rail">
        <span className="loadout-rail-name">{WEAPONS[unit.weaponId].name}</span>
        <Slots used={used} total={total} />
        <span className="loadout-rail-count">
          SLOTS {used}/{total}
        </span>
      </div>
      <div className="loadout-fitted">
        {unit.attachments.length === 0 ? (
          <span className="loadout-fit none">Bare rail</span>
        ) : (
          unit.attachments.map((id) => (
            <span key={id} className="loadout-fit" title={ATTACHMENTS[id].description}>
              <Icon file={`attachment-${id}`} />
              {ATTACHMENTS[id].name}
            </span>
          ))
        )}
      </div>
    </>
  )
}
