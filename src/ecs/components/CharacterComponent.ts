import { Component } from '../Component'
import { type CharacterSheet, derive, type DerivedStats, sanitizeSheet } from '../../core/Characters'
import { ROLES, RoleId } from '../../core/Roles'

/**
 * Who a unit is: the sheet it was rolled or kept as, what it trained for, and
 * how worn it deployed.
 *
 * A component rather than fields on the soldier object so that these take part
 * in everything else a unit's state does — the digest (two peers that disagree
 * about a sheet disagree about every number derived from it), a replay's
 * snapshot, and the refold that follows a restore, which reads them to rebuild
 * the unit's traits. They do not change during a match; they are written when
 * a squad is built (and when a peer's sheet arrives, before the first turn).
 */
export class CharacterComponent extends Component {
  static readonly componentName = 'character'
  get name(): string {
    return CharacterComponent.componentName
  }

  private current: CharacterSheet
  private fold: DerivedStats

  constructor(
    sheet: CharacterSheet,
    /** What this soldier trained for; a role can grant a trait, so changing it needs a refold. */
    public role: RoleId = RoleId.Rifleman,
    /**
     * Consecutive deployments without rest, as the roster stored it
     * (`[ITEM-039]`) — 0 outside a server that keeps one.
     */
    public fatigue: number = 0,
  ) {
    super()
    this.current = sheet
    this.fold = derive(sheet)
  }

  get sheet(): CharacterSheet {
    return this.current
  }
  set sheet(value: CharacterSheet) {
    this.current = value
    this.fold = derive(value)
  }

  /**
   * What the sheet's attributes work out to. A pure function of the sheet,
   * recomputed only when the sheet is replaced; trait bonuses are not in it.
   */
  get derived(): DerivedStats {
    return this.fold
  }

  serialize(): Record<string, unknown> {
    // The sheet itself, not a copy: it is never mutated while a match runs and
    // a replay takes one of these at every event.
    return { sheet: this.current, role: this.role, fatigue: this.fatigue }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.sheet === 'object' && data.sheet !== null && data.sheet !== this.current) {
      this.sheet = sanitizeSheet(data.sheet)
    }
    if (typeof data.role === 'string' && Object.hasOwn(ROLES, data.role)) this.role = data.role as RoleId
    if (typeof data.fatigue === 'number') this.fatigue = data.fatigue
  }
}
