import { RULES, AIM, COVER } from '../config'
import { AMMO, AmmoId, GrenadeId, STATUSES, type StatusKind, WEAPONS, WeaponId } from '../core/Arsenal'
import { ITEMS, ItemId } from '../core/Items'
import { applyStatus } from '../game/Combat'
import type { Soldier } from '../entities/Soldier'
import { icon } from './icons'

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
 * The recorder, as the panel is allowed to touch it.
 *
 * A port rather than the {@link Recorder} itself: whether a recording may start
 * is a question about the *match*, not about the buffer, and the controller is
 * the only thing that can answer it.
 */
export interface RecordingControls {
  /** True while a recorder is attached. */
  isRecording(): boolean
  /** True while starting one is still valid — no command has been issued yet. */
  canArm(): boolean
  eventCount(): number
  setRecording(on: boolean): void
  /** Serialise and download. Does nothing with an empty buffer. */
  export(): void
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
    private readonly recording: RecordingControls | null = null,
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
        keys: ['hp', 'maxHp', 'ap', 'maxAp', 'armor', 'maxArmor', 'peek'],
        note: 'peek: also see from the free tiles beside the wall it hugs',
      })
      groups.push({
        title: `${soldier.name} — weapon: ${soldier.weapon.name}`,
        target: soldier.weapon as unknown as Record<string, unknown>,
        note: 'AP per shot, base hit chance, range falloff, armour penetration',
      })
      groups.push({
        title: `${soldier.name} — ammo: ${soldier.ammo.name}`,
        target: soldier.ammo as unknown as Record<string, unknown>,
      })
      for (const kind of Object.values(GrenadeId)) {
        groups.push({
          title: `${soldier.name} — ${soldier.grenadeSpecs[kind].name}`,
          target: soldier.grenadeSpecs[kind] as unknown as Record<string, unknown>,
          note: 'throwRange is the maximum throwing distance, in metres',
        })
      }
    }

    groups.push({
      title: 'Rules (global)',
      target: RULES as unknown as Record<string, unknown>,
      note: 'AP per tile, sight range, caps, move speed',
    })
    groups.push({ title: 'Aim (global)', target: AIM as unknown as Record<string, unknown> })
    groups.push({
      title: 'Cover penalties (global)',
      target: COVER as unknown as Record<string, unknown>,
    })

    for (const [kind, spec] of Object.entries(STATUSES)) {
      groups.push({
        title: `Status (global): ${spec.name}`,
        target: STATUSES[kind as keyof typeof STATUSES] as unknown as Record<string, unknown>,
      })
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
        <div class="debug-group-title" style="margin-top: 6px;">Grenades carried</div>
        ${Object.values(GrenadeId)
          .map(
            (kind) => `
        <label class="debug-row">
          <span>${this.soldier?.grenadeSpecs[kind].name ?? kind}</span>
          <span class="debug-stepper">
            <button data-grenade-minus="${kind}">-</button>
            <input type="number" step="1" min="0" value="${this.soldier?.grenades[kind] ?? 0}"
                   data-path="grenades" data-key="${kind}" />
            <button data-grenade-plus="${kind}">+</button>
          </span>
        </label>`,
          )
          .join('')}
        <div class="debug-group-title" style="margin-top: 6px;">Items carried</div>
        ${Object.values(ItemId)
          .map(
            (id) => `
        <label class="debug-row">
          <span>${ITEMS[id].name}</span>
          <span class="debug-stepper">
            <button data-item-minus="${id}">-</button>
            <input type="number" step="1" min="0" value="${this.soldier?.items[id] ?? 0}"
                   data-path="items" data-key="${id}" />
            <button data-item-plus="${id}">+</button>
          </span>
        </label>`,
          )
          .join('')}
        <div class="debug-row">
          <span>statuses</span>
          <span class="debug-statuses">
            ${
              this.soldier.statuses.length === 0
                ? '<em>none</em>'
                : this.soldier.statuses.map((s: { kind: string; turnsLeft: number }) => `${s.kind}:${s.turnsLeft}`).join(', ')
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
        <button data-close="1">${icon('ui-cancel')}</button>
      </div>
      <div class="debug-body">
        ${this.renderRecording()}
        ${loadout}
        ${groups.map((group) => this.renderGroup(group)).join('')}
      </div>
    `
  }

  /**
   * Arm and export the combat recorder.
   *
   * The switch closes once the match has issued its first command, and says so.
   * A stream that does not begin at the opening position is not a shorter
   * recording — it is an unplayable one, because playback rebuilds state by
   * re-running the rules over the commands from the start.
   */
  private renderRecording(): string {
    const controls = this.recording
    if (!controls) return ''

    const on = controls.isRecording()
    const events = controls.eventCount()
    const locked = !on && !controls.canArm()
    const note = locked
      ? 'this match has already moved — deploy a new one to record it'
      : 'every command is captured; export writes a file the start screen can load'

    return `
      <div class="debug-group">
        <div class="debug-group-title">Recording</div>
        <label class="debug-row">
          <span>record</span>
          <input type="checkbox" data-record="toggle"
                 ${on ? 'checked' : ''} ${locked ? 'disabled' : ''} />
        </label>
        <div class="debug-note">${note}</div>
        <div class="debug-row"><span>events</span><span>${events}</span></div>
        <div class="debug-buttons">
          <button data-record="export" ${events === 0 ? 'disabled' : ''}>export .json</button>
        </div>
      </div>
    `
  }

  private renderGroup(group: EditGroup): string {
    const keys = (group.keys ?? Object.keys(group.target)).filter((key) => {
      const value = group.target[key]
      return typeof value === 'number' || typeof value === 'boolean'
    })
    if (keys.length === 0) return ''

    const path = this.pathFor(group)
    return `
      <div class="debug-group">
        <div class="debug-group-title">${group.title}</div>
        ${group.note ? `<div class="debug-note">${group.note}</div>` : ''}
        ${keys
          .map((key) =>
            typeof group.target[key] === 'boolean'
              ? `
          <label class="debug-row">
            <span>${key}</span>
            <input type="checkbox" ${group.target[key] ? 'checked' : ''}
                   data-path="${path}" data-key="${key}" />
          </label>`
              : `
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
      if (group.target === (this.soldier.weapon as unknown as Record<string, unknown>)) {
        return 'weapon'
      }
      if (group.target === (this.soldier.ammo as unknown as Record<string, unknown>)) return 'ammo'
      for (const kind of Object.values(GrenadeId)) {
        const spec = this.soldier.grenadeSpecs[kind] as unknown as Record<string, unknown>
        if (group.target === spec) return `grenade:${kind}`
      }
    }
    if (group.target === (RULES as unknown as Record<string, unknown>)) return 'rules'
    if (group.target === (AIM as unknown as Record<string, unknown>)) return 'aim'
    if (group.target === (COVER as unknown as Record<string, unknown>)) return 'cover'
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
      case 'items':
        return (this.soldier?.items as unknown as Record<string, unknown>) ?? null
      case 'weapon':
        return (this.soldier?.weapon as unknown as Record<string, unknown>) ?? null
      case 'ammo':
        return (this.soldier?.ammo as unknown as Record<string, unknown>) ?? null
      case 'grenade':
        return (
          (this.soldier?.grenadeSpecs[arg as GrenadeId] as unknown as Record<string, unknown>) ??
          null
        )
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
      if (el.dataset.loadout === 'weaponId') {
        this.soldier.equip(el.value as WeaponId, this.soldier.ammoId)
      } else {
        this.soldier.equip(this.soldier.weaponId, el.value as AmmoId)
      }
      this.onChange()
      this.render()
      return
    }

    if (!(el instanceof HTMLInputElement) || !el.dataset.path || !el.dataset.key) return
    const target = this.resolve(el.dataset.path)
    if (!target) return

    const key = el.dataset.key
    const value: number | boolean = el.type === 'checkbox' ? el.checked : Number(el.value)
    if (el.type !== 'checkbox' && !Number.isFinite(value as number)) return

    target[key] = value
    this.onChange()
  }

  private readonly onClick = (event: MouseEvent): void => {
    const el = event.target
    if (!(el instanceof HTMLElement)) return

    if (el.dataset.close) {
      this.close()
      return
    }
    // Above the selection guard: recording is about the match, not about
    // whichever unit happens to be under the cursor.
    if (el.dataset.record === 'toggle') {
      this.recording?.setRecording(el instanceof HTMLInputElement && el.checked)
      this.render()
      return
    }
    if (el.dataset.record === 'export') {
      this.recording?.export()
      return
    }

    if (!this.soldier) return

    if (el.dataset.grenadePlus || el.dataset.grenadeMinus) {
      const kind = (el.dataset.grenadePlus ?? el.dataset.grenadeMinus) as GrenadeId
      const delta = el.dataset.grenadePlus ? 1 : -1
      const next = Math.max(0, (this.soldier.grenades[kind] ?? 0) + delta)
      this.soldier.grenades[kind] = next
      const field = this.root.querySelector<HTMLInputElement>(
        `input[data-path="grenades"][data-key="${kind}"]`,
      )
      if (field) field.value = String(next)
      this.onChange()
      return
    }

    if (el.dataset.itemPlus || el.dataset.itemMinus) {
      const id = (el.dataset.itemPlus ?? el.dataset.itemMinus) as ItemId
      const next = Math.max(0, (this.soldier.items[id] ?? 0) + (el.dataset.itemPlus ? 1 : -1))
      this.soldier.items[id] = next
      const field = this.root.querySelector<HTMLInputElement>(
        `input[data-path="items"][data-key="${id}"]`,
      )
      if (field) field.value = String(next)
      this.onChange()
      return
    }

    if (el.dataset.applyStatus) {
      // The shared rule, so the debug button stacks exactly as a grenade does
      // and cannot drift into being its own little status system.
      applyStatus(this.soldier, el.dataset.applyStatus as StatusKind)
      // fallthrough
    } else if (el.dataset.clearStatuses) {
      this.soldier.statuses = []
      // fallthrough
    } else if (el.dataset.heal) {
      this.soldier.hp = this.soldier.maxHp
      this.soldier.ap = this.soldier.maxAp
      this.soldier.armor = this.soldier.maxArmor
      // fallthrough
    } else {
      return
    }

    this.onChange()
    this.render()
  }
}
