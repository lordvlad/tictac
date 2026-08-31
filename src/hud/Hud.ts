import { ShotMode } from '../core/Arsenal'
import type { HudAction, HudIntent, HudModel, HudShotPanel, HudThrowPanel } from './HudModel'

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
  private readonly topRightEl: HTMLElement
  private readonly bottomCentreEl: HTMLElement
  private readonly targetStripEl: HTMLElement
  private readonly squadBarEl: HTMLElement
  private readonly actionPanelEl: HTMLElement
  private readonly turnOverlayEl: HTMLElement
  private readonly contextMenuEl: HTMLElement

  private turnOverlayVisible = false
  private model: HudModel | null = null

  constructor(private readonly onIntent: (intent: HudIntent) => void) {
    this.uiRoot = document.getElementById('ui') ?? document.body

    this.topRightEl = document.createElement('div')
    this.topRightEl.className = 'hud-top-right'
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

    this.turnOverlayEl = document.createElement('div')
    this.turnOverlayEl.className = 'turn-overlay'

    this.contextMenuEl = document.createElement('div')
    this.contextMenuEl.className = 'hud-context-menu'
    this.contextMenuEl.style.display = 'none'

    this.uiRoot.append(
      this.topRightEl,
      this.bottomCentreEl,
      this.actionPanelEl,
      this.turnOverlayEl,
      this.contextMenuEl,
    )

    // Delegated: the panels are re-rendered wholesale, so per-element handlers
    // would have to be re-bound on every update.
    this.uiRoot.addEventListener('click', this.onUiClick)
  }

  dispose(): void {
    this.uiRoot.removeEventListener('click', this.onUiClick)
    for (const el of [
      this.topRightEl,
      this.bottomCentreEl,
      this.actionPanelEl,
      this.turnOverlayEl,
      this.contextMenuEl,
    ]) {
      el.remove()
    }
  }

  /**
   * Re-render the live panels. Deliberately excludes the turn overlay: this
   * runs on every state change (30 Hz while a unit walks), and replacing the
   * overlay's markup under the player's finger loses the press — the click
   * target degrades to the container once the button is swapped mid-click.
   */
  render(model: HudModel): void {
    this.model = model
    this.renderTopRight(model)
    this.renderTargetStrip(model)
    this.renderSquadBar(model)
    this.renderActionPanel(model)
  }

  // ---------------------------------------------------------------------------
  // Intent plumbing
  // ---------------------------------------------------------------------------

  private readonly onUiClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest('[data-intent]')
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

  private renderTopRight(model: HudModel): void {
    const buttons: { label: string; title: string; classes: string; disabled: boolean; intent: HudIntent }[] = [
      {
        label: '🎥 Freelook',
        title: 'Toggle Orbit Freelook Mode',
        classes: model.freelookActive ? 'active' : '',
        disabled: false,
        intent: { type: 'toggleFreelook' },
      },
      {
        label: '👁 Unit View',
        title: "View from Selected Unit's Eyes",
        classes: model.unitViewActive ? 'active' : '',
        disabled: !model.unitViewEnabled,
        intent: { type: 'toggleUnitView' },
      },
      {
        label: 'End Turn ⏭',
        title: 'Hand over to the other faction',
        classes: 'hud-btn-danger',
        disabled: false,
        intent: { type: 'requestTurnSwitch' },
      },
    ]

    this.topRightEl.innerHTML = `
      <div class="hud-info-card">
        <span class="hud-faction-badge ${model.factionIsBlue ? 'blue' : 'red'}">${model.factionName}</span>
        <span class="hud-turn-label">Turn ${model.turnNumber}</span>
        <span class="hud-turn-label" style="opacity: 0.6;">Seed ${model.seedLabel}</span>
      </div>
      <div class="hud-btn-row">
        ${buttons
          .map(
            (b) => `
          <button class="hud-btn interactive ${b.classes}" title="${b.title}" ${b.disabled ? 'disabled' : ''} ${Hud.intentAttr(b.intent)}>
            ${b.label}
          </button>`,
          )
          .join('')}
      </div>
    `
  }

  private renderSquadBar(model: HudModel): void {
    this.squadBarEl.innerHTML = model.squad
      .map(
        (card) => `
      <div class="squad-card interactive ${card.selected ? 'selected' : ''} ${card.dead ? 'dead' : ''}"
           ${Hud.intentAttr({ type: 'selectUnit', index: card.index })}>
        <img class="squad-portrait" src="${card.portrait}" alt="${card.name}" />
        <div class="squad-name">${card.name}</div>
        <div class="squad-bars">
          ${this.bar('hp', card.hp, model.maxHp, 'HP')}
          ${this.bar('ap', card.ap, model.maxAp, 'AP')}
        </div>
      </div>`,
      )
      .join('')
  }

  private bar(kind: 'hp' | 'ap', value: number, max: number, label: string): string {
    const percent = Math.max(0, Math.min(100, (value / max) * 100))
    return `
      <div class="bar-container"${kind === 'ap' ? ' style="margin-top: 3px;"' : ''}>
        <div class="bar-fill ${kind}" style="width: ${percent}%;"></div>
      </div>
      <div class="bar-label"><span>${label}</span><span>${value}/${max}</span></div>
    `
  }

  /**
   * Enemies that can be shot, as a centred row of small portraits above the
   * squad bar. Picking one only previews the shot; the panel confirms it.
   */
  private renderTargetStrip(model: HudModel): void {
    if (model.targets.length === 0) {
      this.targetStripEl.innerHTML = ''
      this.targetStripEl.classList.remove('visible')
      return
    }

    this.targetStripEl.classList.add('visible')
    this.targetStripEl.innerHTML = model.targets
      .map(
        (t) => `
      <button class="target-icon interactive ${t.selected ? 'selected' : ''}"
              title="${t.name} — ${t.hitChance}% to hit"
              ${Hud.intentAttr({ type: 'selectTarget', index: t.index })}>
        <img class="target-portrait" src="${t.portrait}" alt="${t.name}" />
        <span class="target-chance">${t.hitChance}%</span>
        <span class="target-hp"><span class="target-hp-fill" style="width: ${Math.round(t.hpFraction * 100)}%;"></span></span>
      </button>`,
      )
      .join('')
  }

  /**
   * The right-hand panel. A lined-up shot takes the whole panel over: while
   * aiming, confirming or cancelling the shot is the only thing the player
   * should be able to reach there.
   */
  private renderActionPanel(model: HudModel): void {
    if (model.throwPanel) {
      this.actionPanelEl.innerHTML = this.throwCard(model.throwPanel)
      return
    }

    if (model.shotPanel) {
      this.actionPanelEl.innerHTML = this.shotCard(model.shotPanel)
      return
    }

    if (model.selectedName === null) {
      this.actionPanelEl.innerHTML = ''
      return
    }

    this.actionPanelEl.innerHTML = `
      <div class="action-header">${model.selectedName} Actions</div>
      ${model.actions.map((action) => this.actionButton(action)).join('')}
    `
  }

  private shotCard(shot: HudShotPanel): string {
    const blocked = shot.outOfRange || !shot.affordable
    return `
      <div class="action-header">Firing at ${shot.targetName}</div>
      <div class="shot-card">
        <div class="shot-chance ${shot.hitChance >= 50 ? 'good' : 'poor'}">${shot.hitChance}<span>%</span></div>
        <div class="shot-weapon">${shot.weaponName} · ${shot.ammoName}</div>
        <div class="shot-rows">
          ${shot.terms
            .map(
              (t) => `
            <div class="shot-row ${t.penalty ? 'penalty' : ''}">
              <span>${t.label}</span><span>${t.value}</span>
            </div>`,
            )
            .join('')}
        </div>
        <div class="shot-rows shot-outcome">
          <div class="shot-row"><span>Damage</span><span>${shot.damage}</span></div>
          ${shot.armorShred > 0 ? `<div class="shot-row"><span>Armor shred</span><span>-${shot.armorShred}</span></div>` : ''}
          <div class="shot-row"><span>Target</span><span>${shot.targetHp} HP · ${shot.targetArmor} AR</span></div>
        </div>
      </div>
      <button class="action-btn interactive ${shot.mode === ShotMode.Aimed ? 'active' : ''}"
              ${Hud.intentAttr({ type: 'setShotMode', mode: shot.mode === ShotMode.Aimed ? ShotMode.Snap : ShotMode.Aimed })}>
        <span>${shot.mode === ShotMode.Aimed ? 'Aimed Shot' : 'Snap Shot'}</span>
        <span class="action-tag">${shot.mode === ShotMode.Aimed ? 'x2 odds' : 'tap to aim'}</span>
      </button>
      <button class="action-btn action-fire interactive" ${blocked ? 'disabled' : ''}
              ${Hud.intentAttr({ type: 'confirmShot' })}>
        <span>${shot.outOfRange ? 'Out of range' : 'FIRE'}</span>
        <span class="action-tag">${shot.apCost} AP</span>
      </button>
      <button class="action-btn interactive" ${Hud.intentAttr({ type: 'cancelShoot' })}>
        <span>Cancel</span>
        <span class="action-tag">Esc</span>
      </button>
    `
  }

  /** The armed grenade: who is in the blast, and whether that includes us. */
  private throwCard(shot: HudThrowPanel): string {
    const blocked = !shot.affordable || !shot.inRange || shot.caught.length === 0
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
                <span>${c.friendly ? '⚠ ' : ''}${c.name}${c.lethal ? ' ☠' : ''}</span>
                <span>${c.damage > 0 ? `-${c.damage} HP` : ''}${c.armorShred > 0 ? ` -${c.armorShred} AR` : ''}${c.damage === 0 && c.armorShred === 0 ? 'effect only' : ''}</span>
              </div>`,
                )
                .join('')}</div>`
        }
        ${friendlies > 0 ? `<div class="shot-row penalty"><span>Friendly fire</span><span>${friendlies} caught</span></div>` : ''}
      </div>
      <button class="action-btn action-fire interactive" ${blocked ? 'disabled' : ''}
              ${Hud.intentAttr({ type: 'confirmThrow' })}>
        <span>${shot.inRange ? 'THROW' : 'Too far'}</span>
        <span class="action-tag">${shot.apCost} AP</span>
      </button>
      <button class="action-btn interactive" ${Hud.intentAttr({ type: 'cancelGrenade' })}>
        <span>Cancel</span>
        <span class="action-tag">Esc</span>
      </button>
    `
  }

  private actionButton(action: HudAction): string {
    return `
      <button class="action-btn interactive ${action.active ? 'active' : ''}"
              ${action.disabled ? 'disabled' : ''} ${Hud.intentAttr(action.intent)}>
        <span>${action.label}</span>
        <span class="action-tag">${action.tag}</span>
      </button>
    `
  }

  private renderTurnOverlay(model: HudModel): void {
    this.turnOverlayEl.innerHTML = `
      <div class="turn-title ${model.factionIsBlue ? 'red' : 'blue'}">${model.nextFactionName} TEAM'S TURN</div>
      <div class="turn-subtitle">Pass control to the active faction</div>
      <button class="turn-continue-btn interactive" ${Hud.intentAttr({ type: 'confirmTurnSwitch' })}>
        CONTINUE ➔
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
