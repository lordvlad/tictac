import { RULES, AIM, COVER } from '../config'
import { AMMO, AmmoId, GRENADES, GrenadeId, STATUSES, WEAPONS, WeaponId } from '../core/Arsenal'
import type { Soldier } from '../entities/Soldier'

/** A group of live values the panel can edit. */
interface EditGroup {
  title: string
  /** Object whose numeric keys become inputs. */
  target: Record<string, unknown>
  /** Restrict to these keys; omitted means every numeric key. */
  keys?: string[]
  note?: string
}

/**
 * Developer panel: edit any live gameplay value.
 *
 * Deliberately outside the HUD's model/intent discipline — it writes straight to
 * the objects the systems read. That is the point of a debug tool, and keeping it
 * separate means the production HUD stays a pure view.
 *
 * Rows are generated from the objects themselves, so a weapon stat or status
 * effect added later shows up here without touching this file.
 */
export class DebugPanel {
  private readonly root: HTMLElement
  private visible = false
  private soldier: Soldier | null = null

  constructor(
    private readonly onChange: () => void,
    private readonly getSelected: () => Soldier | null,
  ) {
    this.root = document.createElement('div')
    this.root.className = 'debug-panel'
    this.root.style.display = 'none'
    document.body.appendChild(this.root)

    this.root.addEventListener('input', this.onInput)
    this.root.addEventListener('change', this.onInput)
    this.root.addEventListener('click', this.onClick)
  }

  dispose(): void {
    this.root.removeEventListener('input', this.onInput)
    this.root.removeEventListener('change', this.onInput)
    this.root.removeEventListener('click', this.onClick)
    this.root.remove()
  }

  get isOpen(): boolean {
    return this.visible
  }

  toggle(): void {
    this.visible = !this.visible
    this.root.style.display = this.visible ? 'flex' : 'none'
    if (this.visible) this.render()
  }

  close(): void {
    this.visible = false
    this.root.style.display = 'none'
  }

  /** Re-render if open — call after anything changes the unit under edit. */
  refresh(): void {
    if (this.visible) this.render()
  }

  private groups(): EditGroup[] {
    const soldier = this.soldier
    const groups: EditGroup[] = []

    if (soldier) {
      groups.push({
        title: `${soldier.name} — state`,
        target: soldier as unknown as Record<string, unknown>,
        keys: ['hp', 'maxHp', 'ap', 'maxAp', 'armor', 'maxArmor'],
      })
      groups.push({
        title: `${soldier.name} — grenades`,
        target: soldier.grenades as unknown as Record<string, unknown>,
      })
      groups.push({
        title: `Weapon: ${WEAPONS[soldier.weaponId].name}`,
        target: WEAPONS[soldier.weaponId] as unknown as Record<string, unknown>,
        note: 'AP per shot, base hit chance, range falloff, armour penetration',
      })
      groups.push({
        title: `Ammo: ${AMMO[soldier.ammoId].name}`,
        target: AMMO[soldier.ammoId] as unknown as Record<string, unknown>,
      })
    }

    groups.push({
      title: 'Rules',
      target: RULES as unknown as Record<string, unknown>,
      note: 'AP per tile, sight range, caps, move speed',
    })
    groups.push({ title: 'Aim', target: AIM as unknown as Record<string, unknown> })
    groups.push({
      title: 'Cover penalties',
      target: COVER as unknown as Record<string, unknown>,
    })

    for (const kind of Object.values(GrenadeId)) {
      groups.push({
        title: `Grenade: ${GRENADES[kind].name}`,
        target: GRENADES[kind] as unknown as Record<string, unknown>,
      })
    }
    for (const [kind, spec] of Object.entries(STATUSES)) {
      groups.push({ title: `Status: ${spec.name}`, target: STATUSES[kind as keyof typeof STATUSES] as unknown as Record<string, unknown> })
    }

    return groups
  }

  private render(): void {
    this.soldier = this.getSelected()
    const groups = this.groups()

    const loadout = this.soldier
      ? `
      <div class="debug-group">
        <div class="debug-group-title">Loadout</div>
        <label class="debug-row">
          <span>weapon</span>
          <select data-loadout="weaponId">
            ${Object.values(WeaponId)
              .map(
                (id) =>
                  `<option value="${id}" ${this.soldier?.weaponId === id ? 'selected' : ''}>${WEAPONS[id].name}</option>`,
              )
              .join('')}
          </select>
        </label>
        <label class="debug-row">
          <span>ammo</span>
          <select data-loadout="ammoId">
            ${Object.values(AmmoId)
              .map(
                (id) =>
                  `<option value="${id}" ${this.soldier?.ammoId === id ? 'selected' : ''}>${AMMO[id].name}</option>`,
              )
              .join('')}
          </select>
        </label>
        <div class="debug-row">
          <span>statuses</span>
          <span class="debug-statuses">
            ${
              this.soldier.statuses.length === 0
                ? '<em>none</em>'
                : this.soldier.statuses.map((s) => `${s.kind}:${s.turnsLeft}`).join(', ')
            }
          </span>
        </div>
        <div class="debug-buttons">
          ${Object.keys(STATUSES)
            .map((kind) => `<button data-apply-status="${kind}">+${kind}</button>`)
            .join('')}
          <button data-clear-statuses="1">clear</button>
          <button data-heal="1">heal &amp; refill</button>
        </div>
      </div>`
      : '<div class="debug-group"><em>No unit selected</em></div>'

    this.root.innerHTML = `
      <div class="debug-head">
        <span>Debug</span>
        <button data-close="1">✕</button>
      </div>
      <div class="debug-body">
        ${loadout}
        ${groups.map((group) => this.renderGroup(group)).join('')}
      </div>
    `
  }

  private renderGroup(group: EditGroup): string {
    const keys = (group.keys ?? Object.keys(group.target)).filter(
      (key) => typeof group.target[key] === 'number',
    )
    if (keys.length === 0) return ''

    const path = this.pathFor(group)
    return `
      <div class="debug-group">
        <div class="debug-group-title">${group.title}</div>
        ${group.note ? `<div class="debug-note">${group.note}</div>` : ''}
        ${keys
          .map(
            (key) => `
          <label class="debug-row">
            <span>${key}</span>
            <input type="number" step="any" value="${group.target[key] as number}"
                   data-path="${path}" data-key="${key}" />
          </label>`,
          )
          .join('')}
      </div>
    `
  }

  /** Stable identifier for a group's target object, resolved back on input. */
  private pathFor(group: EditGroup): string {
    if (this.soldier) {
      if (group.target === (this.soldier as unknown as Record<string, unknown>)) return 'soldier'
      if (group.target === (this.soldier.grenades as unknown as Record<string, unknown>)) {
        return 'grenades'
      }
      if (group.target === (WEAPONS[this.soldier.weaponId] as unknown as Record<string, unknown>)) {
        return `weapon:${this.soldier.weaponId}`
      }
      if (group.target === (AMMO[this.soldier.ammoId] as unknown as Record<string, unknown>)) {
        return `ammo:${this.soldier.ammoId}`
      }
    }
    if (group.target === (RULES as unknown as Record<string, unknown>)) return 'rules'
    if (group.target === (AIM as unknown as Record<string, unknown>)) return 'aim'
    if (group.target === (COVER as unknown as Record<string, unknown>)) return 'cover'
    for (const kind of Object.values(GrenadeId)) {
      if (group.target === (GRENADES[kind] as unknown as Record<string, unknown>)) {
        return `grenade:${kind}`
      }
    }
    for (const kind of Object.keys(STATUSES)) {
      const spec = STATUSES[kind as keyof typeof STATUSES] as unknown as Record<string, unknown>
      if (group.target === spec) return `status:${kind}`
    }
    return 'unknown'
  }

  private resolve(path: string): Record<string, unknown> | null {
    const [head, arg] = path.split(':')
    switch (head) {
      case 'soldier':
        return this.soldier as unknown as Record<string, unknown> | null
      case 'grenades':
        return (this.soldier?.grenades as unknown as Record<string, unknown>) ?? null
      case 'weapon':
        return (WEAPONS[arg as WeaponId] as unknown as Record<string, unknown>) ?? null
      case 'ammo':
        return (AMMO[arg as AmmoId] as unknown as Record<string, unknown>) ?? null
      case 'grenade':
        return (GRENADES[arg as GrenadeId] as unknown as Record<string, unknown>) ?? null
      case 'status':
        return (STATUSES[arg as keyof typeof STATUSES] as unknown as Record<string, unknown>) ?? null
      case 'rules':
        return RULES as unknown as Record<string, unknown>
      case 'aim':
        return AIM as unknown as Record<string, unknown>
      case 'cover':
        return COVER as unknown as Record<string, unknown>
      default:
        return null
    }
  }

  private readonly onInput = (event: Event): void => {
    const el = event.target
    if (el instanceof HTMLSelectElement && el.dataset.loadout && this.soldier) {
      if (el.dataset.loadout === 'weaponId') this.soldier.weaponId = el.value as WeaponId
      else this.soldier.ammoId = el.value as AmmoId
      this.onChange()
      this.render()
      return
    }

    if (!(el instanceof HTMLInputElement) || !el.dataset.path || !el.dataset.key) return
    const target = this.resolve(el.dataset.path)
    if (!target) return
    const value = Number(el.value)
    if (!Number.isFinite(value)) return
    target[el.dataset.key] = value
    this.onChange()
  }

  private readonly onClick = (event: MouseEvent): void => {
    const el = event.target
    if (!(el instanceof HTMLElement)) return

    if (el.dataset.close) {
      this.close()
      return
    }
    if (!this.soldier) return

    if (el.dataset.applyStatus) {
      const kind = el.dataset.applyStatus as keyof typeof STATUSES
      const spec = STATUSES[kind]
      const existing = this.soldier.statuses.find((s) => s.kind === spec.kind)
      if (existing) existing.turnsLeft = spec.turns
      else this.soldier.statuses.push({ kind: spec.kind, turnsLeft: spec.turns })
    } else if (el.dataset.clearStatuses) {
      this.soldier.statuses = []
    } else if (el.dataset.heal) {
      this.soldier.hp = this.soldier.maxHp
      this.soldier.ap = this.soldier.maxAp
      this.soldier.armor = this.soldier.maxArmor
    } else {
      return
    }

    this.onChange()
    this.render()
  }
}
