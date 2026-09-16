import { AMMO, AmmoId, GRENADES, GrenadeId, WEAPONS, WeaponId } from '../core/Arsenal'
import { ATTACHMENTS, AttachmentId } from '../core/Attachments'
import { rollSquadSheets, type CharacterSheet } from '../core/Characters'
import { ITEMS, ItemId } from '../core/Items'
import { resolveTraits, TRAITS, type TraitId } from '../core/Traits'
import { FACTION_INFO, Faction, SQUAD_SIZE } from '../config'
import type { EngineContext } from '../engine'
import {
  canAddGrenade,
  canAddItem,
  canEquipAmmo,
  canEquipWeapon,
  canFitAttachment,
  defaultLoadout,
  addGrenade,
  addItem,
  equipAmmo,
  equipWeapon,
  fitAttachment,
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
      case 'grenade':
        if (action.delta > 0) addGrenade(this.loadout, this.selected, action.id)
        else removeGrenade(this.loadout, this.selected, action.id)
        break
      case 'item':
        if (action.delta > 0) addItem(this.loadout, this.selected, action.id)
        else removeItem(this.loadout, this.selected, action.id)
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
          .map((id) => row(`grenade-${id}`, GRENADES[id].name, left.grenades[id]))
          .join('')}
        ${Object.values(ItemId)
          .map((id) => row(`item-${id}`, ITEMS[id].name, left.items[id]))
          .join('')}
        ${Object.values(AttachmentId)
          .map((id) => row(`attachment-${id}`, ATTACHMENTS[id].name, left.attachments[id]))
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

    const stepper = (file: string, label: string, count: number, canAdd: boolean, minus: LoadoutAction, plus: LoadoutAction): string => `
      <div class="loadout-stepper">
        ${icon(file)}
        <span class="loadout-pick-name">${label}</span>
        <button class="loadout-step interactive" ${count > 0 ? '' : 'disabled'} ${LoadoutScreen.actionAttr(minus)}>−</button>
        <span class="loadout-count">${count}</span>
        <button class="loadout-step interactive" ${canAdd ? '' : 'disabled'} ${LoadoutScreen.actionAttr(plus)}>+</button>
      </div>`

    return `
      <div class="loadout-panel">
        <div class="loadout-panel-head">${name}</div>

        <div class="loadout-section">Weapon</div>
        ${Object.values(WeaponId)
          .map((id) =>
            pick(
              `weapon-${id}`,
              WEAPONS[id].name,
              unit.weaponId === id,
              canEquipWeapon(this.loadout, this.selected, id),
              { kind: 'weapon', id },
            ),
          )
          .join('')}

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

        <div class="loadout-section">Grenades</div>
        ${Object.values(GrenadeId)
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

        <div class="loadout-section">Items</div>
        ${Object.values(ItemId)
          .map((id) =>
            stepper(
              `item-${id}`,
              ITEMS[id].name,
              unit.items[id],
              canAddItem(this.loadout, this.selected, id),
              { kind: 'item', id, delta: -1 },
              { kind: 'item', id, delta: 1 },
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
    const proficiency = sheet.proficiency[unit.weaponId] + fielded.accuracy
    const evasion = Math.max(0, sheet.evasion + fielded.evasion)

    const stat = (label: string, value: string, penalty = false): string => `
      <div class="loadout-stat ${penalty ? 'penalty' : ''}">
        <span class="loadout-stat-name">${label}</span>
        <span class="loadout-stat-value">${value}</span>
      </div>`

    return `
      <div class="loadout-sheet">
        <div class="loadout-stats">
          ${stat('HP', `${sheet.maxHp + fielded.maxHp}`)}
          ${stat('AP', `${sheet.maxAp + fielded.maxAp}`)}
          ${stat('Eva', `${evasion}%`)}
          ${stat('Skill', `${proficiency > 0 ? '+' : ''}${proficiency}%`, proficiency < 0)}
        </div>
        <div class="loadout-spec">${WEAPONS[sheet.specialism].name} specialist</div>
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
