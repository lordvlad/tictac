import { createRoot, type Root } from 'react-dom/client'
import { ROSTER, SQUAD_SIZE } from '../config'
import { maxHpOf } from '../core/Characters'
import type { RosterEntry } from '../game/Account'
import { Icon } from './Icon'

interface RosterViewProps {
  roster: readonly RosterEntry[]
  selected: ReadonlySet<string>
  recruiting: boolean
  error: string | null
  onToggle: (id: string) => void
  onRecruit: () => void
  onContinue: () => void
}

function RosterView({ roster, selected, recruiting, error, onToggle, onRecruit, onContinue }: RosterViewProps) {
  const bySlot = new Map(roster.map((entry) => [entry.slot, entry]))
  const rows = []
  for (let slot = 0; slot < ROSTER.size; slot++) {
    const entry = bySlot.get(slot)
    rows.push(
      entry ? (
        <MemberRow
          key={slot}
          entry={entry}
          picked={selected.has(entry.characterId)}
          full={selected.size >= SQUAD_SIZE}
          onToggle={onToggle}
        />
      ) : (
        <EmptyRow key={slot} slot={slot} recruiting={recruiting} onRecruit={onRecruit} />
      ),
    )
  }

  return (
    <>
      <div className="roster-title">
        <div className="roster-heading">ROSTER</div>
        <div className="roster-sub">Pick up to {SQUAD_SIZE} to deploy — the rest rest</div>
      </div>
      <div className="roster-list">{rows}</div>
      {error ? <div className="roster-error">{error}</div> : null}
      <button
        className="hud-btn hud-btn-danger roster-continue interactive"
        disabled={selected.size === 0}
        onClick={onContinue}
      >
        <Icon file="ui-deploy" /> Continue ({selected.size}/{SQUAD_SIZE})
      </button>
    </>
  )
}

/**
 * Named by slot and sheet, never by callsign: `FACTION_INFO.squadNames` is
 * positional (whoever deploys first is always "Cobalt"), so a callsign here
 * would name the wrong person the moment a pick is not the first four.
 */
function MemberRow({
  entry,
  picked,
  full,
  onToggle,
}: {
  entry: RosterEntry
  picked: boolean
  full: boolean
  onToggle: (id: string) => void
}) {
  const maxHp = maxHpOf(entry.sheet)
  const benched = entry.downtime > 0
  const { health, agility, strength, intelligence } = entry.sheet.attributes
  const className = ['roster-row', 'interactive', picked && 'picked', benched && 'roster-medical']
    .filter(Boolean)
    .join(' ')
  return (
    <button className={className} disabled={benched || (!picked && full)} onClick={() => onToggle(entry.characterId)}>
      <span className="roster-slot">#{entry.slot + 1}</span>
      <span className="roster-hp">
        HP {entry.hp}/{maxHp}
      </span>
      {benched ? (
        <span className="roster-attrs">
          Medical bay — {entry.downtime} match{entry.downtime === 1 ? '' : 'es'} left
        </span>
      ) : (
        <span className="roster-attrs">
          HEA {health} · AGI {agility} · STR {strength} · INT {intelligence}
        </span>
      )}
      <span className="roster-check">{picked ? <Icon file="ui-deploy" /> : null}</span>
    </button>
  )
}

function EmptyRow({ slot, recruiting, onRecruit }: { slot: number; recruiting: boolean; onRecruit: () => void }) {
  return (
    <div className="roster-row roster-empty">
      <span className="roster-slot">#{slot + 1}</span>
      <span className="roster-empty-label">Empty</span>
      <button className="hud-btn roster-recruit interactive" disabled={recruiting} onClick={onRecruit}>
        Recruit
      </button>
    </div>
  )
}

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
  private readonly container: HTMLDivElement
  private readonly root: Root
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
    // Default pick: the first SQUAD_SIZE fit to fight, in slot order — the
    // same spread every match has always deployed, skipping anyone still in
    // the medical bay the way the referee would refuse them anyway
    // (`[ITEM-039]`).
    for (const entry of this.roster.filter((entry) => entry.downtime === 0).slice(0, SQUAD_SIZE)) {
      this.selected.add(entry.characterId)
    }

    this.container = document.createElement('div')
    this.container.className = 'roster-root'
    document.body.appendChild(this.container)
    this.root = createRoot(this.container)
    this.render()
  }

  /** Resolves with the picked members, in roster slot order, once Continue is pressed. */
  pick(): Promise<RosterEntry[]> {
    return this.picked.promise
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.root.unmount()
    this.container.remove()
  }

  private readonly toggle = (id: string): void => {
    const entry = this.roster.find((member) => member.characterId === id)
    if (entry?.downtime) return
    if (this.selected.has(id)) this.selected.delete(id)
    else if (this.selected.size < SQUAD_SIZE) this.selected.add(id)
    this.render()
  }

  private readonly recruit = (): void => {
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
  }

  private readonly continue = (): void => {
    this.picked.resolve(this.roster.filter((entry) => this.selected.has(entry.characterId)))
    this.dispose()
  }

  private render(): void {
    // A recruit can settle after Continue tore the screen down.
    if (this.disposed) return
    this.root.render(
      <RosterView
        roster={this.roster}
        selected={this.selected}
        recruiting={this.recruiting}
        error={this.error}
        onToggle={this.toggle}
        onRecruit={this.recruit}
        onContinue={this.continue}
      />,
    )
  }
}
