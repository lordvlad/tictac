import type {
  EndScreen,
  HudAction,
  HudIntent,
  HudItemPanel,
  HudModel,
  HudShotOption,
  HudShotPanel,
  HudStrikeOption,
  HudThrowPanel,
  TileReadout,
} from './HudModel'
import { bottomLeftRow } from './CornerStack'
import { icon } from './icons'

export interface ContextMenuItem {
  label: string
  detail?: string
  danger?: boolean
  action: () => void
}

/**
 * The DOM HUD: squad bar, unit actions, turn banner, context menu.
 *
 * A pure view. It renders whatever {@link HudModel} it is handed and reports
 * presses as {@link HudIntent}s — it never touches the turn manager, a soldier
 * or the camera, so "what a button does" is answered in exactly one place.
 *
 * Repeated elements (action buttons, squad cards, menu items) are rendered from
 * data by a single template each; they used to be near-identical copies that
 * differed only in a label.
 */
export class Hud {
  private readonly uiRoot: HTMLElement
  private readonly topCentreEl: HTMLElement
  private readonly levelSelectorEl: HTMLElement
  private readonly bottomCentreEl: HTMLElement
  private readonly targetStripEl: HTMLElement
  private readonly squadBarEl: HTMLElement
  private readonly actionPanelEl: HTMLElement
  private readonly endTurnEl: HTMLElement
  private readonly cornerActionsEl: HTMLElement
  private readonly turnOverlayEl: HTMLElement
  private readonly endScreenEl: HTMLElement
  private readonly contextMenuEl: HTMLElement
  /** What the tile under the pointer is; see {@link showTile}. */
  private readonly tileReadoutEl: HTMLElement

  private turnOverlayVisible = false
  private panelsHidden = false
  /**
   * Which group's submenu is open, if any. View state: which rows are folded
   * away is a property of this panel, not of the match. One at a time, because
   * two flyouts open beside the same panel would sit on top of each other.
   */
  private openGroup: 'items' | 'grenades' | null = null
  private model: HudModel | null = null

  constructor(private readonly onIntent: (intent: HudIntent) => void) {
    this.uiRoot = document.getElementById('ui') ?? document.body

    this.levelSelectorEl = document.createElement('div')
    this.levelSelectorEl.className = 'hud-level-selector'
    this.topCentreEl = document.createElement('div')
    this.topCentreEl.className = 'hud-top-centre'
    // Strip and squad bar share one bottom-centred column: stacking them in the
    // layout means they cannot overlap, whatever height the cards grow to.
    this.bottomCentreEl = document.createElement('div')
    this.bottomCentreEl.className = 'hud-bottom-centre'

    this.targetStripEl = document.createElement('div')
    this.targetStripEl.className = 'hud-target-strip'

    this.squadBarEl = document.createElement('div')
    this.squadBarEl.className = 'hud-squad-bar'

    this.bottomCentreEl.append(this.targetStripEl, this.squadBarEl)

    this.actionPanelEl = document.createElement('div')
    this.actionPanelEl.className = 'hud-action-panel'

    this.endTurnEl = document.createElement('div')
    this.endTurnEl.className = 'hud-end-turn'

    this.turnOverlayEl = document.createElement('div')
    this.turnOverlayEl.className = 'turn-overlay'

    this.endScreenEl = document.createElement('div')
    this.endScreenEl.className = 'turn-overlay end-screen'
    this.contextMenuEl = document.createElement('div')
    this.contextMenuEl.className = 'hud-context-menu'
    this.contextMenuEl.style.display = 'none'

    this.tileReadoutEl = document.createElement('div')
    this.tileReadoutEl.className = 'hud-tile-readout'

    this.uiRoot.append(
      this.topCentreEl,
      this.levelSelectorEl,
      this.bottomCentreEl,
      this.actionPanelEl,
      this.endTurnEl,
      this.turnOverlayEl,
      this.endScreenEl,
      this.contextMenuEl,
      this.tileReadoutEl,
    )

    // The developer tools live in the bottom-left corner beside the frame
    // counter, which is outside #ui — so they carry their own listener.
    this.cornerActionsEl = document.createElement('div')
    this.cornerActionsEl.className = 'hud-corner-actions'
    this.cornerActionsEl.addEventListener('click', this.onUiClick)
    bottomLeftRow().appendChild(this.cornerActionsEl)

    // Delegated: the panels are re-rendered wholesale, so per-element handlers
    // would have to be re-bound on every update.
    this.uiRoot.addEventListener('click', this.onUiClick)
  }

  dispose(): void {
    this.uiRoot.removeEventListener('click', this.onUiClick)
    this.cornerActionsEl.removeEventListener('click', this.onUiClick)
    for (const el of [
      this.topCentreEl,
      this.levelSelectorEl,
      this.bottomCentreEl,
      this.actionPanelEl,
      this.endTurnEl,
      this.cornerActionsEl,
      this.turnOverlayEl,
      this.endScreenEl,
      this.contextMenuEl,
      this.tileReadoutEl,
    ]) {
      el.remove()
    }
  }

  /**
   * What the pointer is over: the tile's surface, and whatever is on it.
   * Written straight into its element rather than through the model, because
   * it changes on every pointer move and nothing else on the HUD does.
   */
  showTile(readout: TileReadout | null): void {
    if (!readout) {
      this.tileReadoutEl.classList.remove('visible')
      return
    }
    this.tileReadoutEl.classList.add('visible')
    this.tileReadoutEl.innerHTML = readout.lines
      .map((line) => `<div class="hud-tile-line ${line.tone}"><b>${line.name}</b> ${line.detail}</div>`)
      .join('')
  }

  /**
   * Hide the in-match panels.
   *
   * For a replay, where there is nothing to command: a squad bar whose buttons
   * do nothing is worse than no squad bar. The bottom-left corner tools stay —
   * reading a unit's state turn by turn is the reason to watch a replay at all.
   */
  setHidden(hidden: boolean): void {
    for (const el of [
      this.topCentreEl,
      this.levelSelectorEl,
      this.bottomCentreEl,
      this.actionPanelEl,
      this.endTurnEl,
      this.turnOverlayEl,
      this.contextMenuEl,
    ]) {
      el.classList.toggle('hud-hidden', hidden)
    }
    this.panelsHidden = hidden
  }

  /**
   * Re-render the live panels. Deliberately excludes the turn overlay: this
   * runs on every state change (30 Hz while a unit walks), and replacing the
   * overlay's markup under the player's finger loses the press — the click
   * target degrades to the container once the button is swapped mid-click.
   */
  render(model: HudModel): void {
    this.model = model
    this.renderTopCentre(model)
    this.renderLevelSelector(model)
    this.renderCornerActions(model)
    this.renderEndTurn(model)
    this.renderTargetStrip(model)
    this.renderSquadBar(model)
    this.renderActionPanel(model)
  }

  // ---------------------------------------------------------------------------
  // Intent plumbing
  // ---------------------------------------------------------------------------

  private readonly onUiClick = (event: MouseEvent): void => {
    const clicked = event.target as HTMLElement | null

    // Folding the consumables away changes nothing in the match, so it never
    // becomes an intent: the panel redraws itself from the model it holds.
    const fold = clicked?.closest('[data-ui]')
    if (fold instanceof HTMLElement) {
      const group = fold.dataset.ui === 'items' ? 'items' : 'grenades'
      this.openGroup = this.openGroup === group ? null : group
      if (this.model) this.renderActionPanel(this.model)
      return
    }

    const target = clicked?.closest('[data-intent]')
    if (!(target instanceof HTMLElement)) return
    if (target instanceof HTMLButtonElement && target.disabled) return

    const intent = JSON.parse(target.dataset.intent ?? 'null') as HudIntent | null
    if (!intent) return

    // The overlay fades out rather than unmounting: a press must not switch
    // factions while it is invisible.
    if (intent.type === 'confirmTurnSwitch' && !this.turnOverlayVisible) return
    this.onIntent(intent)
  }

  private static intentAttr(intent: HudIntent): string {
    return `data-intent='${JSON.stringify(intent)}'`
  }

  // ---------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------

  /** Camera and planning toggles, above the match's own state. */
  private renderTopCentre(model: HudModel): void {
    const buttons: { label: string; icon: string; title: string; classes: string; disabled: boolean; intent: HudIntent }[] = [
      {
        label: 'Freelook',
        icon: 'ui-freelook',
        title: 'Toggle Orbit Freelook Mode',
        classes: model.freelookActive ? 'active' : '',
        disabled: false,
        intent: { type: 'toggleFreelook' },
      },
      {
        label: 'Unit View',
        icon: 'ui-unit-view',
        title: "View from Selected Unit's Eyes",
        classes: model.unitViewActive ? 'active' : '',
        disabled: !model.unitViewEnabled,
        intent: { type: 'toggleUnitView' },
      },
      {
        label: 'Waypoints',
        icon: 'ui-waypoints',
        title: 'Plan a multi-leg route, one tap per leg',
        classes: model.waypointActive ? 'active' : '',
        disabled: false,
        intent: { type: 'toggleWaypoints' },
      },
    ]

    this.topCentreEl.innerHTML = `
      <div class="hud-btn-row">
        ${buttons
          .map(
            (b) => `
          <button class="hud-btn interactive ${b.classes}" title="${b.title}" ${b.disabled ? 'disabled' : ''} ${Hud.intentAttr(b.intent)}>
            ${icon(b.icon)} ${b.label}
          </button>`,
          )
          .join('')}
      </div>
      <div class="hud-info-card">
        <span class="hud-faction-badge ${model.factionIsBlue ? 'blue' : 'red'}">${model.networkMode === 'local' ? '' : icon(model.isMyTurn ? 'ui-deploy' : 'ui-unit-turn', 'tiny')}${model.networkBadge}</span>
        <span class="hud-turn-label">Turn ${model.turnNumber}</span>
      </div>
    `
  }

  /** Handing over is the last thing you do, so it sits on its own. */
  private renderEndTurn(model: HudModel): void {
    const isMyTurn = model.isMyTurn || model.networkMode === 'local'
    // A handover while the rules are still running a broken unit would be
    // refused, so it is not offered.
    const ready = isMyTurn && !model.rulesActing
    this.endTurnEl.innerHTML = `
      <button class="hud-btn interactive ${ready ? 'hud-btn-danger' : ''}"
              title="${!isMyTurn ? "Opponent's Turn" : ready ? 'Hand over to the other faction' : 'Waiting for the units that broke'}"
              ${ready ? '' : 'disabled'} ${Hud.intentAttr({ type: 'requestTurnSwitch' })}>
        ${icon('ui-end-turn')} End Turn
      </button>
    `
  }

  /** Developer tools: glyph only, out of the way beside the frame counter. */
  private renderCornerActions(model: HudModel): void {
    this.cornerActionsEl.innerHTML = `
      <button class="hud-btn hud-btn-glyph interactive" title="Unit debug panel"
              ${Hud.intentAttr({ type: 'openDebug' })}>${icon('ui-debug')}</button>
      <button class="hud-btn hud-btn-glyph interactive ${model.debugMapOpen ? 'active' : ''}"
              title="Toggle 2D debug minimap"
              ${Hud.intentAttr({ type: 'toggleDebugMap' })}>${icon('ui-map')}</button>
    `
  }

  /**
   * One button per storey the map actually has, highest first.
   *
   * Derived rather than listed: a map that generates three floors has to offer
   * three, or the top one is unreachable from the UI.
   */
  private renderLevelSelector(model: HudModel): void {
    const buttons: string[] = []
    for (let level = model.topLevel; level >= 0; level--) {
      buttons.push(`
        <button class="hud-btn interactive ${model.selectedLevelFilter === level ? 'active' : ''}"
                title="View Floor ${level}"
                ${Hud.intentAttr({ type: 'selectLevel', level })}>
          L${level}
        </button>`)
    }

    this.levelSelectorEl.innerHTML = `
      <div class="hud-level-title">LEVEL</div>
      <div class="hud-level-buttons">${buttons.join('')}</div>
    `
  }

  private renderSquadBar(model: HudModel): void {
    this.squadBarEl.innerHTML = model.squad
      .map(
        (card) => `
      <div class="squad-card ${model.isMyTurn || model.networkMode === 'local' ? 'interactive' : 'waiting'} ${card.selected ? 'selected' : ''} ${card.dead ? 'dead' : ''}"
           ${model.isMyTurn || model.networkMode === 'local' ? Hud.intentAttr({ type: 'selectUnit', index: card.index }) : ''}>
        <img class="squad-portrait" src="${card.portrait}" alt="${card.name}" />
        <div class="squad-name">${card.name}</div>
        <div class="squad-bars">
          ${this.bar('hp', card.hp, card.maxHp, 'HP')}
          ${this.bar('ap', card.ap, card.maxAp, 'AP')}
          ${this.bar('armor', card.armor, card.maxArmor, 'AR')}
        </div>
        ${
          card.statuses.length === 0
            ? ''
            : `<div class="squad-statuses">${card.statuses
                .map(
                  (status) =>
                    `<span class="squad-status ${status.good ? 'good' : 'bad'}" title="${status.detail}">${status.name}</span>`,
                )
                .join('')}</div>`
        }
      </div>`,
      )
      .join('')
  }

  private bar(kind: 'hp' | 'ap' | 'armor', value: number, max: number, label: string): string {
    const percent = Math.max(0, Math.min(100, (value / max) * 100))
    return `
      <div class="bar-container"${kind === 'ap' || kind === 'armor' ? ' style="margin-top: 3px;"' : ''}>
        <div class="bar-fill ${kind}" style="width: ${percent}%;"></div>
      </div>
      <div class="bar-label"><span>${label}</span><span>${value}/${max}</span></div>
    `
  }

  /**
   * The units worth tapping, as a centred row of small portraits above the
   * squad bar: enemies that can be shot, or — while an item is aimed —
   * squadmates within reach of it. Picking one only previews; the panel
   * confirms.
   */
  private renderTargetStrip(model: HudModel): void {
    if (model.targets.length === 0 || (!model.isMyTurn && model.networkMode !== 'local')) {
      this.targetStripEl.innerHTML = ''
      this.targetStripEl.classList.remove('visible')
      return
    }

    this.targetStripEl.classList.add('visible')
    this.targetStripEl.innerHTML = model.targets
      .map((t) => {
        const patient = t.hitChance === null
        const figure = patient ? `${Math.round(t.hpFraction * 100)}%` : `${t.hitChance}%`
        const title = patient
          ? `${t.name} — ${figure} HP`
          : `${t.name} — ${figure} to hit${t.known ? '' : ' · unread'}${t.awareness ? ` · ${t.awareness}` : ''}${t.broken ? ` · ${t.broken}` : ''}`
        return `
      <button class="target-icon interactive ${patient ? 'patient' : ''} ${t.selected ? 'selected' : ''} ${t.known ? '' : 'unread'}"
              title="${title}"
              ${Hud.intentAttr({ type: 'selectTarget', index: t.index })}>
        <img class="target-portrait" src="${t.portrait}" alt="${t.name}" />
        ${t.known ? '' : '<span class="target-unread">?</span>'}
        ${t.awareness ? `<span class="target-awareness ${t.awareness}">${t.awareness === 'unaware' ? 'z' : '!'}</span>` : ''}
        ${t.broken ? `<span class="target-broken ${t.broken}">${t.broken}</span>` : ''}
        <span class="target-chance">${figure}</span>
        <span class="target-hp"><span class="target-hp-fill" style="width: ${Math.round(t.hpFraction * 100)}%;"></span></span>
        <span class="target-ar"><span class="target-ar-fill" style="width: ${Math.round(t.armorFraction * 100)}%;"></span></span>
      </button>`
      })
      .join('')
  }

  /**
   * The right-hand panel. A lined-up shot takes the whole panel over: while
   * aiming, confirming or cancelling the shot is the only thing the player
   * should be able to reach there.
   */
  private renderActionPanel(model: HudModel): void {
    if (!model.isMyTurn && model.networkMode !== 'local') {
      this.actionPanelEl.innerHTML = `
        <div class="action-header" style="color: #cbd5e1;">Opponent's Turn</div>
        <div style="background: rgba(15, 23, 42, 0.85); border: 1px solid #334155; border-radius: 8px; padding: 24px 16px; text-align: center; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5);">
          <div class="hud-waiting-glyph">${icon('ui-unit-turn', 'huge')}</div>
          <div style="font-size: 14px; font-weight: 600; color: #38bdf8; margin-bottom: 6px; letter-spacing: 0.5px;">OPPONENT'S TURN</div>
          <div style="font-size: 12px; color: #94a3b8; line-height: 1.4;">Waiting for opponent to complete their actions...</div>
        </div>
      `
      return
    }

    if (model.throwPanel) {
      this.actionPanelEl.innerHTML = this.throwCard(model.throwPanel)
      return
    }

    if (model.shotPanel) {
      this.actionPanelEl.innerHTML = this.shotCard(model.shotPanel)
      return
    }

    if (model.itemPanel) {
      this.actionPanelEl.innerHTML = this.itemCard(model.itemPanel)
      return
    }

    if (model.selectedName === null) {
      this.actionPanelEl.innerHTML = ''
      return
    }

    // No title: the squad card already says who is selected, and the panel is
    // the only thing on that side of the screen.
    const rows: string[] = []
    const done = new Set<string>()

    for (const action of model.actions) {
      if (action.group === undefined) {
        rows.push(this.actionButton(action))
        continue
      }
      if (done.has(action.group)) continue
      done.add(action.group)

      // Folded where its first row would have been, so the panel keeps its
      // order: what the unit does most sits nearest the top.
      const members = model.actions.filter((other) => other.group === action.group)
      rows.push(
        action.group === 'grenades' && members.length < 2
          ? this.actionButton(action)
          : this.submenu(action.group, members),
      )
    }

    this.actionPanelEl.innerHTML = rows.join('')
  }

  /**
   * A group behind one row, opening to the left.
   *
   * Leftwards because the panel is already against the right edge: opening
   * downwards pushed every row under it around, and on a phone ran the list
   * off the bottom of the screen.
   */
  private submenu(group: 'items' | 'grenades', members: readonly HudAction[]): string {
    const open = this.openGroup === group
    const spec =
      group === 'items'
        ? { label: 'Items', icon: 'item-stim' }
        : { label: 'Grenades', icon: 'grenade-frag' }
    const carried = members.reduce((total, row) => total + Number(row.tag.split('x')[1] ?? 0), 0)

    return `
      <div class="action-group">
        <button class="action-btn interactive ${open ? 'active' : ''}" data-ui="${group}">
          <span class="action-label">${icon(spec.icon)} ${spec.label}</span>
          <span class="action-tag">${carried > 0 ? `x${carried}` : ''} ${open ? '◂' : '▸'}</span>
        </button>
        ${open ? `<div class="action-submenu">${members.map((row) => this.actionButton(row)).join('')}</div>` : ''}
      </div>
    `
  }

  /**
   * The shared picture once, then a row per way of shooting.
   *
   * Every option used to be a full card: the same weapon, range, cover and
   * damage restated three times over, with one line between them that actually
   * differed. What stays put is stated once and is not clickable; what a mode
   * changes is all its own row shows.
   *
   * The crit line stays one row whether or not the target can be crit at all,
   * so the outcome block does not change height as the aim moves between
   * targets; an immune one states that instead of a 0% beside a multiplier
   * that will never be applied.
   */
  private shotCard(shot: HudShotPanel): string {
    return `
      <div class="action-header">
        Firing at ${shot.targetName}${shot.targetKnown ? '' : ' <span class="shot-unknown" title="Unread: shoot at it, or be shot at by it, to learn what it is">UNREAD</span>'}${
          shot.targetAwareness === 'unaware'
            ? ' <span class="shot-awareness unaware" title="Has seen and heard nothing: it faces where it last turned, and only a watcher in the fight reacts all round">UNAWARE</span>'
            : shot.targetAwareness === 'alerted'
              ? ' <span class="shot-awareness alerted" title="Heard something and turned toward it, but has seen nobody">ALERTED</span>'
              : ''
        }
      </div>
      <div class="shot-card">
        <div class="shot-target">${shot.weaponName} (${shot.currentClip}/${shot.maxClip} ammo) · ${shot.ammoName} — target ${shot.targetHp} HP · ${shot.targetArmor} AR</div>
        <div class="shot-option-chance ${shot.base.chance >= 50 ? 'good' : 'poor'}">
          ${shot.base.chance}<span>%</span>
        </div>
        <div class="shot-rows shot-outcome">
          <div class="shot-row"><span>${icon('shot-damage', 'tiny')}Damage a hit</span><span>${shot.base.damage}</span></div>
        </div>
      </div>
      ${shot.options.map((option) => this.shotOptionRow(option)).join('')}
      ${shot.strike ? this.strikeRow(shot.strike) : ''}
      <button class="action-btn interactive" ${Hud.intentAttr({ type: 'cancelShoot' })}>
        <span class="action-label">${icon('ui-cancel')} Cancel</span>
        <span class="action-tag">Esc</span>
      </button>
    `
  }

  /** One mode: its odds, its cost, its rounds and what they do. */
  private shotOptionRow(option: HudShotOption): string {
    return `
      <button class="shot-option interactive ${option.available ? '' : 'unavailable'}"
              ${option.available ? '' : 'disabled'} ${Hud.intentAttr({ type: 'fireShot', mode: option.mode })}>
        <span class="shot-option-name">${icon(`mode-${option.mode}`)} ${option.name}</span>
        <span class="shot-option-diff">
          <span class="shot-option-odds">
            ${
              option.outOfRange
                ? '<span class="shot-option-hit poor">OUT OF RANGE</span>'
                : `<span class="shot-option-hit ${option.hitChance >= 50 ? 'good' : 'poor'}">${option.hitChance}%</span>`
            }
          </span>
          <span class="shot-option-ap">${option.apCost} AP · ${option.bullets}x · ${option.damageAtBest} dmg</span>
        </span>
      </button>
    `
  }

  /**
   * The sidearm blow, laid out as one more shot mode so the choice between
   * shooting and striking reads as one list. It says what it is fought with
   * because the card above it describes the gun; and it has no delta, because
   * the base it would be measured from is a rifle's.
   */
  private strikeRow(strike: HudStrikeOption): string {
    return `
      <button class="shot-option interactive" ${Hud.intentAttr({ type: 'meleeAttack' })}>
        <span class="shot-option-name">${icon(`melee-${strike.sidearm}`)} Strike · ${strike.name}</span>
        <span class="shot-option-diff">
          <span class="shot-option-odds">
            <span class="shot-option-hit ${strike.hitChance >= 50 ? 'good' : 'poor'}">${strike.hitChance}%</span>
          </span>
          <span class="shot-option-ap">${strike.apCost} AP · ${strike.damage} dmg</span>
        </span>
      </button>
    `
  }

  /** The armed grenade: who is in the blast, and whether that includes us. */
  private throwCard(shot: HudThrowPanel): string {
    const blocked = !shot.affordable || !shot.inRange
    const friendlies = shot.caught.filter((c) => c.friendly).length
    return `
      <div class="action-header">${shot.name}</div>
      <div class="shot-card">
        <div class="shot-weapon">Radius ${shot.radius} · x${shot.remaining} left${shot.statusName ? ` · ${shot.statusName}` : ''}</div>
        ${
          shot.caught.length === 0
            ? `<div class="shot-row"><span>${shot.inRange ? 'Nobody in blast' : 'Out of throwing range'}</span></div>`
            : `<div class="shot-rows">${shot.caught
                .map(
                  (c) => `
              <div class="shot-row ${c.friendly ? 'penalty' : ''}">
                <span>${c.friendly ? icon('ui-hazard') : ''}${c.name}${c.lethal ? icon('ui-lethal') : ''}</span>
                <span>${c.damage > 0 ? `-${c.damage} HP` : ''}${c.armorShred > 0 ? ` -${c.armorShred} AR` : ''}${c.damage === 0 && c.armorShred === 0 ? 'effect only' : ''}</span>
              </div>`,
                )
                .join('')}</div>`
        }
        ${friendlies > 0 ? `<div class="shot-row penalty"><span>Friendly fire</span><span>${friendlies} caught</span></div>` : ''}
      </div>
      <button class="action-btn action-fire interactive" ${blocked ? 'disabled' : ''}
              ${Hud.intentAttr({ type: 'confirmThrow' })}>
        <span class="action-label">${icon(`grenade-${shot.kind}`)} ${shot.inRange ? 'THROW' : 'Too far'}</span>
        <span class="action-tag">${shot.apCost} AP</span>
      </button>
      <button class="action-btn interactive" ${Hud.intentAttr({ type: 'cancelGrenade' })}>
        <span class="action-label">${icon('ui-cancel')} Cancel</span>
        <span class="action-tag">Esc</span>
      </button>
    `
  }

  /**
   * An item aimed at a squadmate: who it is going to, and what it does.
   *
   * The strip above the squad bar is where the patient is chosen, so this
   * panel only reports the choice and takes the commitment — the same split
   * shoot mode uses, and for the same reason: a mis-tap on a portrait must
   * not spend the kit.
   */
  private itemCard(item: HudItemPanel): string {
    return `
      <div class="action-header">${item.name}</div>
      <div class="shot-card">
        <div class="shot-weapon">x${item.remaining} left · ${item.apCost} AP</div>
        <div class="item-patient ${item.targetName ? '' : 'pending'}">
          ${item.targetName ? `${icon('ui-deploy', 'tiny')}Treating ${item.targetName}` : 'Pick a squadmate in reach'}
        </div>
        <div class="shot-rows">
          ${item.effects.map((line) => `<div class="shot-row"><span>${line}</span></div>`).join('')}
        </div>
      </div>
      <button class="action-btn action-fire interactive" ${item.targetName && item.affordable ? '' : 'disabled'}
              ${Hud.intentAttr({ type: 'confirmItem' })}>
        <span class="action-label">${icon(`item-${item.itemId}`)} ${item.affordable ? 'USE' : 'Not enough AP'}</span>
        <span class="action-tag">${item.apCost} AP</span>
      </button>
      <button class="action-btn interactive" ${Hud.intentAttr({ type: 'cancelItem' })}>
        <span class="action-label">${icon('ui-cancel')} Cancel</span>
        <span class="action-tag">Esc</span>
      </button>
    `
  }

  private actionButton(action: HudAction): string {
    return `
      <button class="action-btn interactive ${action.active ? 'active' : ''}"
              ${action.disabled ? 'disabled' : ''} ${Hud.intentAttr(action.intent)}>
        <span class="action-label">${icon(action.icon)} ${action.label}${action.targeted ? '<span class="action-on-ally" title="Can be used on a squadmate in reach">ALLY</span>' : ''}</span>
        <span class="action-tag">${action.tag}</span>
      </button>
    `
  }

  private renderTurnOverlay(model: HudModel): void {
    this.turnOverlayEl.innerHTML = `
      <div class="turn-title ${model.factionIsBlue ? 'red' : 'blue'}">${model.nextFactionName} TEAM'S TURN</div>
      <div class="turn-subtitle">Pass control to the active faction</div>
      <button class="turn-continue-btn interactive" ${Hud.intentAttr({ type: 'confirmTurnSwitch' })}>
        CONTINUE ${icon('ui-continue')}
      </button>
    `
  }

  // ---------------------------------------------------------------------------
  // Turn overlay & context menu
  // ---------------------------------------------------------------------------

  showTurnOverlay(): void {
    if (this.model) this.renderTurnOverlay(this.model)
    this.turnOverlayVisible = true
    this.turnOverlayEl.classList.add('visible')
  }

  hideTurnOverlay(): void {
    this.turnOverlayVisible = false
    this.turnOverlayEl.classList.remove('visible')
  }

  /** Whether the in-match panels are hidden, as they are for a replay. */
  get hidden(): boolean {
    return this.panelsHidden
  }

  /**
   * The end of the match: one page of it. Over everything else and it stays:
   * the match is over, and the only way on is the page's own button.
   */
  showEndScreen(screen: EndScreen): void {
    const side = screen.blue ? 'blue' : 'red'
    const next = Hud.intentAttr(screen.next)
    if (screen.stage === 'lost') {
      const carried = screen.carried
        ? `<div class="end-survivors"><div class="end-survivor"><img class="end-portrait" src="${screen.carried.portrait}" alt="" /><div><div class="end-name">${screen.carried.name}</div><div class="end-line">Carried out alive, on 1 HP. The rest of the squad is gone.</div></div></div></div>`
        : ''
      this.endScreenEl.innerHTML = `
        <div class="turn-title ${side}">${screen.factionName} — you lost</div>
        <div class="turn-subtitle">Nobody left standing.</div>
        ${carried}
        <button class="turn-continue-btn interactive" ${next}>CONTINUE ${icon('ui-continue')}</button>`
    } else {
      const survivors = screen.survivors
        .map((survivor) => {
          const lines =
            survivor.lines.length === 0
              ? '<div class="end-line quiet">Nothing new this time.</div>'
              : survivor.lines
                  .map(
                    (line) =>
                      `<div class="end-line"><b>${line.label}</b> <span class="end-change">${line.from} → ${line.to}</span> <span class="end-because">${line.because}</span></div>`,
                  )
                  .join('')
          return `<div class="end-survivor"><img class="end-portrait" src="${survivor.portrait}" alt="" /><div><div class="end-name">${survivor.name}</div>${lines}</div></div>`
        })
        .join('')
      this.endScreenEl.innerHTML = `
        <div class="turn-title ${side}">${screen.factionName} wins</div>
        <div class="turn-subtitle">What the survivors learned</div>
        <div class="end-survivors">${survivors}</div>
        <button class="turn-continue-btn interactive" ${next}>BACK TO THE MENU ${icon('ui-continue')}</button>`
    }
    this.endScreenEl.classList.add('visible')
  }

  showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    this.contextMenuEl.innerHTML = items
      .map(
        (item, idx) => `
      <button class="hud-context-item interactive ${item.danger ? 'danger' : ''}" data-idx="${idx}">
        <span>${item.label}</span>
        ${item.detail ? `<span style="font-size: 10px; opacity: 0.6;">${item.detail}</span>` : ''}
      </button>`,
      )
      .join('')
    this.contextMenuEl.style.left = `${x}px`
    this.contextMenuEl.style.top = `${y}px`
    this.contextMenuEl.style.display = 'flex'

    // Keep the menu fully on screen: a tap near the right or bottom edge of a
    // phone would otherwise open it mostly outside the viewport.
    const margin = 8
    const rect = this.contextMenuEl.getBoundingClientRect()
    const maxLeft = window.innerWidth - rect.width - margin
    const maxTop = window.innerHeight - rect.height - margin
    this.contextMenuEl.style.left = `${Math.max(margin, Math.min(x, maxLeft))}px`
    this.contextMenuEl.style.top = `${Math.max(margin, Math.min(y, maxTop))}px`

    for (const btn of this.contextMenuEl.querySelectorAll('.hud-context-item')) {
      btn.addEventListener('click', () => {
        this.hideContextMenu()
        items[Number((btn as HTMLElement).dataset.idx)]?.action()
      })
    }
  }

  hideContextMenu(): void {
    this.contextMenuEl.style.display = 'none'
  }
}
