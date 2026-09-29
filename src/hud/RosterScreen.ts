import { ROSTER, SQUAD_SIZE } from '../config'
import { maxHpOf } from '../core/Characters'
import type { RosterEntry } from '../game/Account'
import { icon } from './icons'

/** What a press on the screen asks for. Serialised into `data-action`. */
type RosterAction =
  | { kind: 'toggle'; id: string }
  | { kind: 'recruit' }
  | { kind: 'continue' }

/**
 * Before the loadout screen, for a signed-in player only: the whole roster
 * (`ROSTER.size`, bigger than a squad), a toggle on every living member, and
 * a Recruit button on every slot nobody holds.
 *
 * Exists because a roster stopped being exactly a squad (`[ITEM-042]`): who
 * fights is now a decision, and this is where it gets made. `defaultLoadout`
 * and every stat this screen shows are read straight off the sheet the
 * server sent — nothing here is guessed or rolled locally, the same
 * never-trust-the-client rule the referee holds the deployed squad to.
 */
export class RosterScreen {
  private readonly root: HTMLDivElement
  private roster: RosterEntry[]
  private readonly selected = new Set<string>()
  private recruiting = false
  private error: string | null = null
  private readonly picked = Promise.withResolvers<RosterEntry[]>()
  private disposed = false

  constructor(
    roster: readonly RosterEntry[],
    /** Provided by the caller so this screen knows nothing about HTTP. */
    private readonly recruitMember: () => Promise<RosterEntry>,
  ) {
    this.roster = [...roster].sort((a, b) => a.slot - b.slot)
    // Default pick: the first SQUAD_SIZE in slot order, the same spread every
    // match has always deployed — a signed-in player who never opens this
    // screen's toggles gets exactly what an unsigned-in one always has.
    for (const entry of this.roster.slice(0, SQUAD_SIZE)) this.selected.add(entry.characterId)

    this.root = document.createElement('div')
    this.root.className = 'roster-root'
    this.root.addEventListener('click', this.onClick)
    document.body.appendChild(this.root)
    this.render()
  }

  /** Resolves with the picked members, in roster slot order, once Continue is pressed. */
  pick(): Promise<RosterEntry[]> {
    return this.picked.promise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.root.removeEventListener('click', this.onClick)
    this.root.remove()
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest('[data-action]')
    if (!(target instanceof HTMLElement)) return
    if (target instanceof HTMLButtonElement && target.disabled) return

    const action = JSON.parse(target.dataset.action ?? 'null') as RosterAction | null
    if (!action) return

    switch (action.kind) {
      case 'toggle':
        if (this.selected.has(action.id)) this.selected.delete(action.id)
        else if (this.selected.size < SQUAD_SIZE) this.selected.add(action.id)
        break
      case 'recruit':
        this.recruiting = true
        this.error = null
        this.render()
        void this.recruitMember()
          .then((member) => {
            this.roster = [...this.roster, member].sort((a, b) => a.slot - b.slot)
            this.recruiting = false
            this.render()
          })
          .catch((err: unknown) => {
            this.recruiting = false
            this.error = err instanceof Error ? err.message : 'Could not recruit.'
            this.render()
          })
        return
      case 'continue':
        this.picked.resolve(this.roster.filter((entry) => this.selected.has(entry.characterId)))
        this.dispose()
        return
    }

    this.render()
  }

  private static actionAttr(action: RosterAction): string {
    return `data-action='${JSON.stringify(action)}'`
  }

  private render(): void {
    const bySlot = new Map(this.roster.map((entry) => [entry.slot, entry]))
    const rows: string[] = []
    for (let slot = 0; slot < ROSTER.size; slot++) {
      const entry = bySlot.get(slot)
      rows.push(entry ? this.memberRow(entry) : this.emptyRow(slot))
    }

    this.root.innerHTML = `
      <div class="roster-title">
        <div class="roster-heading">ROSTER</div>
        <div class="roster-sub">Pick up to ${SQUAD_SIZE} to deploy — the rest rest</div>
      </div>
      <div class="roster-list">${rows.join('')}</div>
      ${this.error ? `<div class="roster-error">${this.error}</div>` : ''}
      <button class="hud-btn hud-btn-danger roster-continue interactive"
              ${this.selected.size === 0 ? 'disabled' : ''}
              ${RosterScreen.actionAttr({ kind: 'continue' })}>
        ${icon('ui-deploy')} Continue (${this.selected.size}/${SQUAD_SIZE})
      </button>
    `
  }

  /**
   * Named by slot and sheet, never by callsign: `FACTION_INFO.squadNames` is
   * positional (whoever deploys first is always "Cobalt"), so a callsign here
   * would name the wrong person the moment a pick is not the first four.
   */
  private memberRow(entry: RosterEntry): string {
    const maxHp = maxHpOf(entry.sheet)
    const picked = this.selected.has(entry.characterId)
    const disabled = !picked && this.selected.size >= SQUAD_SIZE
    const { health, agility, strength, intelligence } = entry.sheet.attributes
    return `
      <button class="roster-row interactive ${picked ? 'picked' : ''}" ${disabled ? 'disabled' : ''}
              ${RosterScreen.actionAttr({ kind: 'toggle', id: entry.characterId })}>
        <span class="roster-slot">#${entry.slot + 1}</span>
        <span class="roster-hp">HP ${entry.hp}/${maxHp}</span>
        <span class="roster-attrs">HEA ${health} · AGI ${agility} · STR ${strength} · INT ${intelligence}</span>
        <span class="roster-check">${picked ? icon('ui-deploy') : ''}</span>
      </button>`
  }

  private emptyRow(slot: number): string {
    return `
      <div class="roster-row roster-empty">
        <span class="roster-slot">#${slot + 1}</span>
        <span class="roster-empty-label">Empty</span>
        <button class="hud-btn roster-recruit interactive" ${this.recruiting ? 'disabled' : ''}
                ${RosterScreen.actionAttr({ kind: 'recruit' })}>
          Recruit
        </button>
      </div>`
  }
}
