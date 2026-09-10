import { AMMO, AmmoId, GRENADES, GrenadeId, WEAPONS, WeaponId } from '../core/Arsenal'
import { ITEMS, ItemId } from '../core/Items'
import { FACTION_INFO, Faction, SQUAD_SIZE } from '../config'
import type { EngineContext } from '../engine'
import {
  canAddGrenade,
  canAddItem,
  canEquipAmmo,
  canEquipWeapon,
  defaultLoadout,
  addGrenade,
  addItem,
  equipAmmo,
  equipWeapon,
  remaining,
  removeGrenade,
  removeItem,
  type SquadLoadout,
} from '../game/Loadout'
import { LoadoutScene } from '../render/LoadoutScene'
import type { OffscreenPortraits } from '../render/Portraits'

/** What a press on the screen asks for. Serialised into `data-action`. */
type LoadoutAction =
  | { kind: 'select'; index: number }
  | { kind: 'weapon'; id: WeaponId }
  | { kind: 'ammo'; id: AmmoId }
  | { kind: 'grenade'; id: GrenadeId; delta: number }
  | { kind: 'item'; id: ItemId; delta: number }
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
  private selected = 0
  private readonly deployed = Promise.withResolvers<SquadLoadout>()
  private disposed = false

  constructor(
    engine: EngineContext,
    private readonly portraits: OffscreenPortraits,
    seed: number,
  ) {
    this.scene = new LoadoutScene(engine, seed)

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
   * A game-icons glyph, masked so it takes the surrounding text colour.
   *
   * The URL is absolute on purpose: a relative one inside a custom property is
   * resolved against the stylesheet that substitutes it — game.css, which the
   * dev server serves from a different directory — not against this document.
   */
  private static icon(file: string, extra = ''): string {
    const href = new URL(`./icons/${file}.svg`, document.baseURI).href
    return `<span class="gi ${extra}" style="--gi: url('${href}');"></span>`
  }

  // ---------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------

  private render(): void {
    this.root.innerHTML = `
      <div class="loadout-title">
        <div class="loadout-heading">LOADOUT</div>
        <div class="loadout-sub">${FACTION_INFO[Faction.Blue].label} — share out the crate, then deploy</div>
        <div class="loadout-credit">Icons by game-icons.net (CC BY 3.0)</div>
      </div>
      ${this.renderPool()}
      ${this.renderPanel()}
      ${this.renderCards()}
      <button class="hud-btn hud-btn-danger loadout-deploy interactive" ${LoadoutScreen.actionAttr({ kind: 'deploy' })}>
        ${LoadoutScreen.icon('ui-deploy')} Deploy
      </button>
    `
  }

  private renderPool(): string {
    const left = remaining(this.loadout)
    const row = (file: string, name: string, count: number): string => `
      <div class="loadout-pool-row ${count === 0 ? 'depleted' : ''}">
        ${LoadoutScreen.icon(file)}
        <span class="loadout-pool-name">${name}</span>
        <span class="loadout-pool-count">${count}</span>
      </div>`

    return `
      <div class="loadout-pool">
        <div class="loadout-pool-head">${LoadoutScreen.icon('ui-pool')} Squad crate</div>
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
      </div>`
  }

  private renderPanel(): string {
    const unit = this.loadout[this.selected]!
    const name = FACTION_INFO[Faction.Blue].squadNames[this.selected] ?? ''

    const pick = (file: string, label: string, active: boolean, enabled: boolean, action: LoadoutAction): string => `
      <button class="action-btn interactive ${active ? 'active' : ''}" ${enabled ? '' : 'disabled'} ${LoadoutScreen.actionAttr(action)}>
        ${LoadoutScreen.icon(file)}<span class="loadout-pick-name">${label}</span>
      </button>`

    const stepper = (file: string, label: string, count: number, canAdd: boolean, minus: LoadoutAction, plus: LoadoutAction): string => `
      <div class="loadout-stepper">
        ${LoadoutScreen.icon(file)}
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
      </div>`
  }

  /**
   * The combat squad card, reused: same chrome and selection treatment, with
   * the HP/AP/AR bars — meaningless before a shot is fired — replaced by what
   * the member is carrying.
   */
  private renderCards(): string {
    const cards: string[] = []
    for (let index = 0; index < SQUAD_SIZE; index++) {
      const unit = this.loadout[index]!
      const name = FACTION_INFO[Faction.Blue].squadNames[index] ?? ''
      const carried = [
        ...Object.values(GrenadeId).map((id) => ({ file: `grenade-${id}`, count: unit.grenades[id] })),
        ...Object.values(ItemId).map((id) => ({ file: `item-${id}`, count: unit.items[id] })),
      ].filter((entry) => entry.count > 0)

      cards.push(`
        <div class="squad-card interactive ${index === this.selected ? 'selected' : ''}"
             ${LoadoutScreen.actionAttr({ kind: 'select', index })}>
          <img class="squad-portrait" src="${this.portraits.getPortrait(Faction.Blue, index)}" alt="${name}" />
          <div class="squad-name">${name}</div>
          <div class="loadout-card-kit">
            ${LoadoutScreen.icon(`weapon-${unit.weaponId}`, 'big')}
            ${LoadoutScreen.icon(`ammo-${unit.ammoId}`, 'big')}
            ${carried
              .map((entry) => `<span class="loadout-carried">${LoadoutScreen.icon(entry.file)}${entry.count}</span>`)
              .join('')}
          </div>
        </div>`)
    }

    return `<div class="loadout-cards">${cards.join('')}</div>`
  }
}
