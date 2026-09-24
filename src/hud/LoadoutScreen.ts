import { AMMO, AmmoId, GRENADES, GrenadeId, SHOT_MODES, WEAPONS, WeaponId } from '../core/Arsenal'
import { ATTACHMENTS, AttachmentId } from '../core/Attachments'
import { derive, rollSquadSheets, type CharacterSheet } from '../core/Characters'
import { ITEMS, ItemId } from '../core/Items'
import { MELEE, MeleeId } from '../core/Melee'
import { TEMPERAMENTS } from '../core/Morale'
import { resolveTraits, TRAITS, type TraitId } from '../core/Traits'
import { FACTION_INFO, Faction, SQUAD_SIZE } from '../config'
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
} from '../game/Loadout'
import { icon } from './icons'
import { LoadoutScene } from '../render/LoadoutScene'
import type { OffscreenPortraits } from '../render/Portraits'

/** What a press on the screen asks for. Serialised into `data-action`. */
type LoadoutAction =
  | { kind: 'select'; index: number }
  | { kind: 'weapon'; id: WeaponId }
  | { kind: 'ammo'; id: AmmoId }
  | { kind: 'sidearm'; id: MeleeId }
  | { kind: 'grenade'; id: GrenadeId; delta: number }
  | { kind: 'item'; id: ItemId; delta: number }
  | { kind: 'attachment'; id: AttachmentId; delta: number }
  | { kind: 'deploy' }

/**
 * The pre-combat loadout screen: the squad staged on a semi-circle behind a
 * panel of kit, sharing one crate of equipment.
 *
 * A view over {@link SquadLoadout}. Every press goes through the loadout
 * helpers, which own the rules about what the crate can still cover and what a
 * soldier can carry, and then the whole thing re-renders — the same
 * rebuild-and-delegate approach the combat HUD uses, for the same reason:
 * per-element handlers would have to be rebound on every change.
 *
 * Mounted on <body> rather than #ui, which is `pointer-events: none` with only
 * buttons re-enabled; this screen has steppers and hoverable rows.
 */
export class LoadoutScreen {
  private readonly root: HTMLDivElement
  private readonly scene: LoadoutScene
  private readonly loadout: SquadLoadout = defaultLoadout()
  /**
   * The squad's people, as opposed to their kit. Rolled once here and read by
   * the caller once Deploy is pressed, so the match is fought by the squad the
   * player was shown: every press re-renders the whole screen, and rolling per
   * render would reshuffle them each time a stepper was touched.
   */
  readonly sheets: CharacterSheet[] = rollSquadSheets()
  private selected = 0
  private waitingLabel: string | null = null
  private readonly deployed = Promise.withResolvers<SquadLoadout>()
  private disposed = false

  constructor(
    engine: EngineContext,
    private readonly portraits: OffscreenPortraits,
    seed: number,
    private readonly faction: Faction,
  ) {
    this.scene = new LoadoutScene(engine, seed, faction)

    this.root = document.createElement('div')
    this.root.className = 'loadout-root'
    this.root.addEventListener('click', this.onClick)
    document.body.appendChild(this.root)

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
    this.root.removeEventListener('click', this.onClick)
    this.root.remove()
    this.scene.dispose()
  }

  // ---------------------------------------------------------------------------
  // Intent plumbing
  // ---------------------------------------------------------------------------

  private readonly onClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest('[data-action]')
    if (!(target instanceof HTMLElement)) return
    if (target instanceof HTMLButtonElement && target.disabled) return

    const action = JSON.parse(target.dataset.action ?? 'null') as LoadoutAction | null
    if (!action) return

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
          if (!this.meetsRequirement(action.id)) break
          const { carrySlots } = derive(this.sheets[this.selected]!)
          addItem(this.loadout, this.selected, action.id, carrySlots)
        } else removeItem(this.loadout, this.selected, action.id)
        break
      case 'attachment':
        if (action.delta > 0) fitAttachment(this.loadout, this.selected, action.id)
        else unfitAttachment(this.loadout, this.selected, action.id)
        break
      case 'deploy':
        this.deployed.resolve(this.loadout)
        return
    }

    this.render()
  }

  private static actionAttr(action: LoadoutAction): string {
    return `data-action='${JSON.stringify(action)}'`
  }

  /**
   * Whether the selected member clears an item's Intelligence bar.
   *
   * Separate from {@link canAddItem}, which answers about the crate and the
   * pouch: this is a fact about the person, and the same predicate
   * `ItemSystem.canUse` will apply in the match. Shared between the render and
   * the press so a dead + and a refused press cannot disagree.
   */
  private meetsRequirement(id: ItemId): boolean {
    const min = ITEMS[id].minIntelligence
    return min === undefined || this.sheets[this.selected]!.attributes.intelligence >= min
  }


  // ---------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = `
      <div class="loadout-title">
        <div class="loadout-heading">LOADOUT</div>
        <div class="loadout-sub">${FACTION_INFO[this.faction].label} — share out the crate, then deploy</div>
        <div class="loadout-credit">Icons by game-icons.net (CC BY 3.0)</div>
      </div>
      ${this.renderPool()}
      ${this.renderPanel()}
      ${this.renderCards()}
      ${
        this.waitingLabel === null
          ? `<button class="hud-btn hud-btn-danger loadout-deploy interactive" ${LoadoutScreen.actionAttr({ kind: 'deploy' })}>
        ${icon('ui-deploy')} Deploy
      </button>`
          : `<div class="loadout-waiting">${this.waitingLabel}</div>`
      }
    `
  }

  private renderPool(): string {
    const left = remaining(this.loadout)
    const row = (file: string, name: string, count: number): string => `
      <div class="loadout-pool-row ${count === 0 ? 'depleted' : ''}">
        ${icon(file)}
        <span class="loadout-pool-name">${name}</span>
        <span class="loadout-pool-count">${count}</span>
      </div>`

    return `
      <div class="loadout-pool">
        <div class="loadout-pool-head">${icon('ui-pool')} Squad crate</div>
        ${Object.values(WeaponId)
          .map((id) => row(`weapon-${id}`, WEAPONS[id].name, left.weapons[id]))
          .join('')}
        ${Object.values(AmmoId)
          .map((id) => row(`ammo-${id}`, AMMO[id].name, left.ammo[id]))
          .join('')}
        ${Object.values(GrenadeId)
          // Issued kit (a stone) is nobody's to hand out.
          .filter((id) => GRENADES[id].issued === 0)
          .map((id) => row(`grenade-${id}`, GRENADES[id].name, left.grenades[id]))
          .join('')}
        ${Object.values(ItemId)
          .map((id) => row(`item-${id}`, ITEMS[id].name, left.items[id]))
          .join('')}
        ${Object.values(AttachmentId)
          .map((id) => row(`attachment-${id}`, ATTACHMENTS[id].name, left.attachments[id]))
          .join('')}
        ${Object.values(MeleeId)
          // Fists are not in the crate: a row for them would read as a stock
          // that could run out.
          .filter((id) => id !== MeleeId.Fists)
          .map((id) => row(`melee-${id}`, MELEE[id].name, left.sidearms[id]))
          .join('')}
      </div>`
  }

  private renderPanel(): string {
    const unit = this.loadout[this.selected]!
    const name = FACTION_INFO[this.faction].squadNames[this.selected] ?? ''

    const pick = (file: string, label: string, active: boolean, enabled: boolean, action: LoadoutAction): string => `
      <button class="action-btn interactive ${active ? 'active' : ''}" ${enabled ? '' : 'disabled'} ${LoadoutScreen.actionAttr(action)}>
        ${icon(file)}<span class="loadout-pick-name">${label}</span>
      </button>`

    const stepper = (file: string, label: string, count: number, canAdd: boolean, minus: LoadoutAction, plus: LoadoutAction, note = ''): string => `
      <div class="loadout-stepper">
        ${icon(file)}
        <span class="loadout-pick-name">${label}</span>
        ${note}
        <button class="loadout-step interactive" ${count > 0 ? '' : 'disabled'} ${LoadoutScreen.actionAttr(minus)}>−</button>
        <span class="loadout-count">${count}</span>
        <button class="loadout-step interactive" ${canAdd ? '' : 'disabled'} ${LoadoutScreen.actionAttr(plus)}>+</button>
      </div>`

    // The sidearm and the weapon are the picks whose options are not simply
    // better or worse than each other, so their buttons have to carry enough
    // of the table to choose on: what a blow or a round costs and does, and a
    // one-line character from `sidearmCharacter` or `weaponCharacter`. The
    // count sits on the sidearm button rather than only in the crate because a
    // greyed-out knife needs its reason beside it, the same argument the pouch
    // pips make. Fists are never short, so they show no number at all rather
    // than a zero or an infinity to puzzle over.
    const left = remaining(this.loadout)
    const sidearm = (id: MeleeId): string => {
      const spec = MELEE[id]
      const stock = id === MeleeId.Fists ? '' : `<span class="loadout-pool-count">×${left.sidearms[id]}</span>`
      return `
      <button class="action-btn interactive loadout-specced ${unit.sidearm === id ? 'active' : ''}"
              ${canEquipSidearm(this.loadout, this.selected, id) ? '' : 'disabled'}
              title="Accuracy ${spec.accuracy}% · parry ${spec.parry} · crit ${spec.critChance}% ×${spec.critMultiplier}"
              ${LoadoutScreen.actionAttr({ kind: 'sidearm', id })}>
        ${icon(`melee-${id}`)}<span class="loadout-pick-name">${spec.name}</span>${stock}
        <span class="loadout-pick-spec">
          ${spec.apCost} AP · ${spec.damage} dmg · ${Math.round(spec.armorPen * 100)}% pen<br />
          ${LoadoutScreen.sidearmCharacter(id)}
        </span>
      </button>`
    }

    // The in-match shot panel says only whether a round lands and what it
    // does, so this is where a weapon's character is read. Spread is shown as
    // centimetres of miss at ten metres because metres-per-metre is a number
    // nobody can picture; the tooltip keeps the raw table for whoever wants it.
    // The character word rides on the name row, where a sidearm shows its
    // stock: the spec lines are already as long as the panel is wide.
    const weapon = (id: WeaponId): string => {
      const spec = WEAPONS[id]
      const damage = spec.pellets > 1 ? `${spec.pellets}×${spec.damage}` : `${spec.damage}`
      const spread = Math.round(LoadoutScreen.errorAt10(id) * 100)
      const modes = spec.availableModes.map((mode) => SHOT_MODES[mode].name).join(', ')
      const bias = spec.critRangeBias > 0 ? 'far' : spec.critRangeBias < 0 ? 'close' : 'anywhere'
      return `
      <button class="action-btn interactive loadout-specced ${unit.weaponId === id ? 'active' : ''}"
              ${canEquipWeapon(this.loadout, this.selected, id) ? '' : 'disabled'}
              title="Sway ${spec.sway} m · spread ${spec.spread} m per m · ${Math.round(spec.armorPen * 100)}% pen · ${modes} · crits best ${bias}"
              ${LoadoutScreen.actionAttr({ kind: 'weapon', id })}>
        ${icon(`weapon-${id}`)}<span class="loadout-pick-name">${spec.name}</span>
        <span class="loadout-pick-tag">${LoadoutScreen.weaponCharacter(id)}</span>
        <span class="loadout-pick-spec">
          ${spec.apCost} AP · ${damage} dmg · ${spec.maxRange} m · clip ${spec.maxClip}<br />
          spread ${spread} cm @10m · crit ${spec.critChance}% ×${spec.critMultiplier}
        </span>
      </button>`
    }

    // Shown here as well as on the card because this is where the + goes
    // dead: a stepper that stops responding needs its reason in the same
    // panel. Same pips as the weapon rail — it is the same question about a
    // different container, and a second vocabulary for it would be one more
    // thing to learn.
    const { carrySlots } = derive(this.sheets[this.selected]!)
    const carried = itemsCarried(unit)
    const pouch = Array.from(
      { length: carrySlots },
      (_, at) => `<span class="loadout-slot ${at < carried ? 'filled' : ''}"></span>`,
    ).join('')

    // The Intelligence bar, printed on the row it stops. A + that will not
    // move is indistinguishable from an empty crate otherwise, and the bar is
    // worth reading even when it is met: it is the same INT the squad cards
    // carry, so the number beside the item says which members could take it.
    // Red on the ones who cannot, as a losing weapon proficiency is.
    const { intelligence } = this.sheets[this.selected]!.attributes
    const requirement = (id: ItemId): string => {
      const min = ITEMS[id].minIntelligence
      if (min === undefined) return ''
      const short = intelligence < min
      const why = short
        ? `${ITEMS[id].name} needs Intelligence ${min}; ${name} has ${intelligence}`
        : `${ITEMS[id].name} needs Intelligence ${min}`
      return `
        <span class="loadout-stat ${short ? 'penalty' : ''}" title="${why}">
          <span class="loadout-stat-name">INT</span>
          <span class="loadout-stat-value">${min}</span>
        </span>`
    }

    return `
      <div class="loadout-panel">
        <div class="loadout-panel-head">${name}</div>

        <div class="loadout-section">Weapon</div>
        ${Object.values(WeaponId).map(weapon).join('')}

        <div class="loadout-section">Ammo</div>
        ${Object.values(AmmoId)
          .map((id) =>
            pick(
              `ammo-${id}`,
              AMMO[id].name,
              unit.ammoId === id,
              canEquipAmmo(this.loadout, this.selected, id),
              { kind: 'ammo', id },
            ),
          )
          .join('')}

        <div class="loadout-section">Sidearm</div>
        ${Object.values(MeleeId).map(sidearm).join('')}

        <div class="loadout-section">Grenades</div>
        ${Object.values(GrenadeId)
          .filter((id) => GRENADES[id].issued === 0)
          .map((id) =>
            stepper(
              `grenade-${id}`,
              GRENADES[id].name,
              unit.grenades[id],
              canAddGrenade(this.loadout, this.selected, id),
              { kind: 'grenade', id, delta: -1 },
              { kind: 'grenade', id, delta: 1 },
            ),
          )
          .join('')}

        <div class="loadout-section loadout-section-cap">
          Items
          <span class="loadout-slots">${pouch}</span>
          <span class="loadout-cap-count">SLOTS ${carried}/${carrySlots}</span>
        </div>
        ${Object.values(ItemId)
          .map((id) =>
            stepper(
              `item-${id}`,
              ITEMS[id].name,
              unit.items[id],
              canAddItem(this.loadout, this.selected, id, carrySlots) &&
                this.meetsRequirement(id),
              { kind: 'item', id, delta: -1 },
              { kind: 'item', id, delta: 1 },
              requirement(id),
            ),
          )
          .join('')}

        <div class="loadout-section">Attachments</div>
        ${Object.values(AttachmentId)
          .map((id) =>
            stepper(
              `attachment-${id}`,
              ATTACHMENTS[id].name,
              unit.attachments.includes(id) ? 1 : 0,
              canFitAttachment(this.loadout, this.selected, id),
              { kind: 'attachment', id, delta: -1 },
              { kind: 'attachment', id, delta: 1 },
            ),
          )
          .join('')}
      </div>`
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
  private static sidearmCharacter(id: MeleeId): string {
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
  private static errorAt10(id: WeaponId): number {
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
  private static weaponCharacter(id: WeaponId): string {
    const spec = WEAPONS[id]
    const error = LoadoutScreen.errorAt10(id)
    const others = Object.values(WeaponId).map((other) => LoadoutScreen.errorAt10(other))
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
  private renderCards(): string {
    const cards: string[] = []
    for (let index = 0; index < SQUAD_SIZE; index++) {
      const unit = this.loadout[index]!
      const name = FACTION_INFO[this.faction].squadNames[index] ?? ''
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

      cards.push(`
        <div class="squad-card interactive ${index === this.selected ? 'selected' : ''}"
             ${LoadoutScreen.actionAttr({ kind: 'select', index })}>
          <img class="squad-portrait" src="${this.portraits.getPortrait(this.faction, index)}" alt="${name}" />
          <div class="squad-name">${name}</div>
          <div class="loadout-card-kit">
            ${icon(`weapon-${unit.weaponId}`, 'big')}
            ${icon(`ammo-${unit.ammoId}`, 'big')}
            ${
              // Only a carried blade or club earns a glyph: every card would
              // otherwise show the same fist, and the row is for telling the
              // four apart.
              unit.sidearm === MeleeId.Fists
                ? ''
                : `<span class="loadout-carried" title="${MELEE[unit.sidearm].name}">${icon(`melee-${unit.sidearm}`, 'big')}</span>`
            }
            ${carried
              .map(
                (entry) =>
                  `<span class="loadout-carried" title="${entry.name}">${icon(entry.file)}${entry.count}</span>`,
              )
              .join('')}
          </div>
          ${LoadoutScreen.railBlock(unit)}
          ${LoadoutScreen.sheetBlock(unit, this.sheets[index]!)}
        </div>`)
    }

    return `<div class="loadout-cards">${cards.join('')}</div>`
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
  private static sheetBlock(unit: UnitLoadout, sheet: CharacterSheet): string {
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

    // Every number here is what the unit will deploy with, traits folded in,
    // because the card is being used to decide kit: a Nimble soldier who reads
    // as their bare sheet would look like a worse pick than they are, and a
    // vest that costs evasion would look free. Same fold the soldier does, so
    // the same answer.
    const fielded = resolveTraits(traits.map((trait) => trait.id))
    const stats = derive(sheet)
    const proficiency = sheet.proficiency[unit.weaponId] + fielded.accuracy
    const evasion = Math.max(0, stats.evasion + fielded.evasion)

    const stat = (label: string, value: string, penalty = false): string => `
      <div class="loadout-stat ${penalty ? 'penalty' : ''}">
        <span class="loadout-stat-name">${label}</span>
        <span class="loadout-stat-value">${value}</span>
      </div>`

    const attr = (label: string, value: number): string => `
      <div class="loadout-attr">
        <span class="loadout-attr-name">${label}</span>
        <span class="loadout-attr-value">${value}</span>
      </div>`

    // Both halves of the sheet read as deltas, and a bare `3` beside a `-2`
    // would look like a different kind of number.
    const signed = (value: number): string => `${value > 0 ? '+' : ''}${value}`
    const { health, agility, strength, intelligence } = sheet.attributes

    return `
      <div class="loadout-sheet">
        <div class="loadout-attrs">
          ${attr('HEA', health)}
          ${attr('AGI', agility)}
          ${attr('STR', strength)}
          ${attr('INT', intelligence)}
        </div>
        <div class="loadout-stats">
          ${stat('HP', `${stats.maxHp + fielded.maxHp}`)}
          ${stat('AP', `${stats.maxAp + fielded.maxAp}`)}
          ${stat('Eva', `${evasion}%`)}
          ${stat('Skill', `${signed(proficiency)}%`, proficiency < 0)}
          ${stat('Throw', signed(stats.throwRange), stats.throwRange < 0)}
          ${stat('Item', `${signed(stats.itemApDelta)} AP`, stats.itemApDelta > 0)}
        </div>
        <div class="loadout-spec">${WEAPONS[sheet.specialism].name} specialist</div>
        <div class="loadout-spec" title="${TEMPERAMENTS[sheet.temperament].description}">${TEMPERAMENTS[sheet.temperament].name}</div>
        <div class="loadout-traits">
          ${
            traits.length === 0
              ? '<span class="loadout-trait none">No traits</span>'
              : traits
                  .map(
                    (trait) =>
                      `<span class="loadout-trait ${trait.worn ? 'worn' : ''}" title="${TRAITS[trait.id].description}">${TRAITS[trait.id].name}</span>`,
                  )
                  .join('')
          }
        </div>
      </div>`
  }

  /**
   * The weapon in this member's hands as a thing rather than a class: what it
   * is, how much rail it has, and what is bolted to it.
   *
   * The empty pips carry the row: a shotgun with its one slot and a rifle with
   * three read as different weapons before either count is read, which is what
   * makes handing the glass to the sniper an obvious move.
   */
  private static railBlock(unit: UnitLoadout): string {
    const { used, total } = railSpace(unit)
    const pips = Array.from(
      { length: total },
      (_, at) => `<span class="loadout-slot ${at < used ? 'filled' : ''}"></span>`,
    ).join('')

    return `
      <div class="loadout-rail">
        <span class="loadout-rail-name">${WEAPONS[unit.weaponId].name}</span>
        <span class="loadout-slots">${pips}</span>
        <span class="loadout-rail-count">SLOTS ${used}/${total}</span>
      </div>
      <div class="loadout-fitted">
        ${
          unit.attachments.length === 0
            ? '<span class="loadout-fit none">Bare rail</span>'
            : unit.attachments
                .map(
                  (id) =>
                    `<span class="loadout-fit" title="${ATTACHMENTS[id].description}">${icon(`attachment-${id}`)}${ATTACHMENTS[id].name}</span>`,
                )
                .join('')
        }
      </div>`
  }
}
