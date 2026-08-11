import { Faction, FACTION_INFO, MAX_AP, MAX_HP } from '../config'
import type { OrbitRig } from '../camera/OrbitRig'
import type { Soldier } from '../entities/Soldier'
import type { Squads } from '../game/Squads'
import type { TurnManager } from '../game/TurnManager'
import type { OffscreenPortraits } from '../render/Portraits'

export interface ContextMenuItem {
  label: string
  detail?: string
  danger?: boolean
  action: () => void
}

export class Hud {
  private readonly uiRoot: HTMLElement
  private readonly turnManager: TurnManager
  private readonly squads: Squads
  private readonly rig: OrbitRig
  private readonly portraits: OffscreenPortraits

  // Callbacks
  onShootRequested?: () => void
  onCancelShootRequested?: () => void
  onTurnSwitched?: () => void

  isShootModeActive = false
  private turnOverlayVisible = false

  // DOM elements
  private readonly topRightEl: HTMLElement
  private readonly squadBarEl: HTMLElement
  private readonly actionPanelEl: HTMLElement
  private readonly turnOverlayEl: HTMLElement
  private readonly contextMenuEl: HTMLElement

  constructor(
    turnManager: TurnManager,
    squads: Squads,
    rig: OrbitRig,
    portraits: OffscreenPortraits,
    seedLabel: string,
  ) {
    this.turnManager = turnManager
    this.squads = squads
    this.rig = rig
    this.portraits = portraits

    this.uiRoot = document.getElementById('ui') ?? document.body

    // Create container elements
    this.topRightEl = document.createElement('div')
    this.topRightEl.className = 'hud-top-right'

    this.squadBarEl = document.createElement('div')
    this.squadBarEl.className = 'hud-squad-bar'

    this.actionPanelEl = document.createElement('div')
    this.actionPanelEl.className = 'hud-action-panel'

    this.turnOverlayEl = document.createElement('div')
    this.turnOverlayEl.className = 'turn-overlay'

    this.contextMenuEl = document.createElement('div')
    this.contextMenuEl.className = 'hud-context-menu'
    this.contextMenuEl.style.display = 'none'

    this.uiRoot.append(
      this.topRightEl,
      this.squadBarEl,
      this.actionPanelEl,
      this.turnOverlayEl,
      this.contextMenuEl,
    )

    this.renderTopRight(seedLabel)
    this.renderTurnOverlay()
    this.update()
  }

  update(): void {
    this.renderSquadBar()
    this.renderActionPanel()
    this.updateTopRight()
  }

  // ---------------------------------------------------------------------------
  // Top Right
  // ---------------------------------------------------------------------------

  private renderTopRight(seedLabel: string): void {
    this.topRightEl.innerHTML = `
      <div class="hud-info-card">
        <span id="hudFactionBadge" class="hud-faction-badge blue">BLUE</span>
        <span id="hudTurnLabel" class="hud-turn-label">Turn 1</span>
        <span class="hud-turn-label" style="opacity: 0.6;">Seed ${seedLabel}</span>
      </div>
      <div class="hud-btn-row">
        <button id="hudFreelookBtn" class="hud-btn interactive" title="Toggle Orbit Freelook Mode">
          🎥 Freelook
        </button>

        <button id="hudUnitViewBtn" class="hud-btn interactive" disabled title="View from Selected Unit's Eyes">
          👁 Unit View
        </button>

        <button id="hudEndTurnBtn" class="hud-btn hud-btn-danger interactive">
          End Turn ⏭
        </button>
      </div>
    `

    const freelookBtn = this.topRightEl.querySelector('#hudFreelookBtn') as HTMLButtonElement
    freelookBtn.onclick = () => {
      if (this.rig.isCharacterViewActive) {
        this.rig.exitCharacterView()
      }
      const active = this.rig.toggleFreeLookMode()
      freelookBtn.classList.toggle('active', active)
    }

    const unitViewBtn = this.topRightEl.querySelector('#hudUnitViewBtn') as HTMLButtonElement
    unitViewBtn.onclick = () => {
      const selected = this.turnManager.selectedSoldier
      if (!selected) return

      if (this.rig.isCharacterViewActive) {
        this.rig.exitCharacterView()
      } else {
        this.rig.enterCharacterView(selected.position, selected.currentYaw)
      }
      this.updateTopRight()
    }

    const endTurnBtn = this.topRightEl.querySelector('#hudEndTurnBtn') as HTMLButtonElement
    endTurnBtn.onclick = () => {
      this.showTurnOverlay()
    }
  }

  private updateTopRight(): void {
    const badge = this.topRightEl.querySelector('#hudFactionBadge')
    if (badge) {
      const info = FACTION_INFO[this.turnManager.activeFaction]
      badge.textContent = info.name
      badge.className = `hud-faction-badge ${this.turnManager.activeFaction === Faction.Blue ? 'blue' : 'red'}`
    }

    const turnLabel = this.topRightEl.querySelector('#hudTurnLabel')
    if (turnLabel) {
      turnLabel.textContent = `Turn ${this.turnManager.turnNumber}`
    }

    const freelookBtn = this.topRightEl.querySelector('#hudFreelookBtn') as HTMLButtonElement
    if (freelookBtn) {
      freelookBtn.classList.toggle('active', this.rig.isFreeLookActive && !this.rig.isCharacterViewActive)
    }

    const unitViewBtn = this.topRightEl.querySelector('#hudUnitViewBtn') as HTMLButtonElement
    if (unitViewBtn) {
      const hasSelected = this.turnManager.selectedSoldier !== null
      unitViewBtn.disabled = !hasSelected
      unitViewBtn.classList.toggle('active', this.rig.isCharacterViewActive)
    }
  }

  // ---------------------------------------------------------------------------
  // Squad Bar
  // ---------------------------------------------------------------------------

  private renderSquadBar(): void {
    const activeFaction = this.turnManager.activeFaction
    const selected = this.turnManager.selectedSoldier

    let html = ''
    for (let index = 0; index < 4; index++) {
      const portraitSrc = this.portraits.getPortrait(activeFaction, index)
      // Find soldier for this index
      const soldier = this.findSoldier(activeFaction, index)
      if (!soldier) continue

      const isSelected = selected === soldier
      const isDead = soldier.isDead

      const hpPercent = Math.max(0, Math.min(100, (soldier.hp / MAX_HP) * 100))
      const apPercent = Math.max(0, Math.min(100, (soldier.ap / MAX_AP) * 100))

      html += `
        <div class="squad-card interactive ${isSelected ? 'selected' : ''} ${isDead ? 'dead' : ''}" data-index="${index}">
          <img class="squad-portrait" src="${portraitSrc}" alt="${soldier.name}" />
          <div class="squad-name">${soldier.name}</div>
          <div class="squad-bars">
            <div class="bar-container">
              <div class="bar-fill hp" style="width: ${hpPercent}%;"></div>
            </div>
            <div class="bar-label">
              <span>HP</span><span>${soldier.hp}/${MAX_HP}</span>
            </div>
            <div class="bar-container" style="margin-top: 3px;">
              <div class="bar-fill ap" style="width: ${apPercent}%;"></div>
            </div>
            <div class="bar-label">
              <span>AP</span><span>${soldier.ap}/${MAX_AP}</span>
            </div>
          </div>
        </div>
      `
    }

    this.squadBarEl.innerHTML = html

    // Attach click listeners
    const cards = this.squadBarEl.querySelectorAll('.squad-card')
    cards.forEach((card) => {
      const idx = Number((card as HTMLElement).dataset.index)
      card.addEventListener('click', () => {
        const soldier = this.findSoldier(activeFaction, idx)
        if (soldier && !soldier.isDead) {
          this.turnManager.selectSoldier(soldier)
          this.update()
        }
      })
    })
  }

  private findSoldier(faction: Faction, index: number): Soldier | undefined {
    return this.squads.byFaction[faction]?.[index]
  }

  // ---------------------------------------------------------------------------
  // Action Panel
  // ---------------------------------------------------------------------------

  private renderActionPanel(): void {
    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isDead) {
      this.actionPanelEl.innerHTML = ''
      return
    }

    const shootBtnText = this.isShootModeActive ? 'Cancel Shoot ✕' : 'Shoot'

    this.actionPanelEl.innerHTML = `
      <div class="action-header">${selected.name} Actions</div>
      <button id="actionShoot" class="action-btn interactive ${this.isShootModeActive ? 'active' : ''}" ${selected.ap < 4 ? 'disabled' : ''}>
        <span>${shootBtnText}</span>
        <span class="action-tag">4 AP</span>
      </button>
      <button class="action-btn interactive" disabled>
        <span>Take Cover</span>
        <span class="action-tag">Placeholder</span>
      </button>
      <button class="action-btn interactive" disabled>
        <span>Overwatch</span>
        <span class="action-tag">Placeholder</span>
      </button>
      <button class="action-btn interactive" disabled>
        <span>Items</span>
        <span class="action-tag">Placeholder</span>
      </button>
      <button id="actionFinishTurn" class="action-btn interactive" style="margin-top: 6px;">
        <span>End Unit Turn</span>
        <span class="action-tag">0 AP</span>
      </button>
    `

    const shootBtn = this.actionPanelEl.querySelector('#actionShoot') as HTMLButtonElement
    if (shootBtn) {
      shootBtn.onclick = () => {
        if (this.isShootModeActive) {
          this.onCancelShootRequested?.()
        } else {
          this.onShootRequested?.()
        }
      }
    }

    const finishBtn = this.actionPanelEl.querySelector('#actionFinishTurn') as HTMLButtonElement
    if (finishBtn) {
      finishBtn.onclick = () => {
        this.turnManager.finishSoldierTurn(selected)
        this.update()
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Turn Switch Overlay
  // ---------------------------------------------------------------------------

  private renderTurnOverlay(): void {
    this.turnOverlayEl.innerHTML = `
      <div id="turnOverlayTitle" class="turn-title blue">BLUE TEAM'S TURN</div>
      <div class="turn-subtitle">Pass control to the active faction</div>
      <button id="turnContinueBtn" class="turn-continue-btn interactive">
        CONTINUE ➔
      </button>
    `

    const continueBtn = this.turnOverlayEl.querySelector('#turnContinueBtn') as HTMLButtonElement
    continueBtn.onclick = () => {
      // Guard against activating a hidden overlay: swapping factions by
      // accident silently ruins a turn and is very hard to notice.
      if (!this.turnOverlayVisible) return
      this.hideTurnOverlay()
      this.turnManager.startNextTurn()
      this.onTurnSwitched?.()
      this.update()
    }
  }

  showTurnOverlay(): void {
    const nextFaction = this.turnManager.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
    const info = FACTION_INFO[nextFaction]

    const titleEl = this.turnOverlayEl.querySelector('#turnOverlayTitle')
    if (titleEl) {
      titleEl.textContent = `${info.name} TEAM'S TURN`
      titleEl.className = `turn-title ${nextFaction === Faction.Blue ? 'blue' : 'red'}`
    }

    this.turnOverlayVisible = true
    this.turnOverlayEl.classList.add('visible')
  }

  hideTurnOverlay(): void {
    this.turnOverlayVisible = false
    this.turnOverlayEl.classList.remove('visible')
  }

  // ---------------------------------------------------------------------------
  // Context Menu
  // ---------------------------------------------------------------------------

  showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    let html = ''
    items.forEach((item, idx) => {
      html += `
        <button class="hud-context-item interactive ${item.danger ? 'danger' : ''}" data-idx="${idx}">
          <span>${item.label}</span>
          ${item.detail ? `<span style="font-size: 10px; opacity: 0.6;">${item.detail}</span>` : ''}
        </button>
      `
    })

    this.contextMenuEl.innerHTML = html
    this.contextMenuEl.style.left = `${x}px`
    this.contextMenuEl.style.top = `${y}px`
    this.contextMenuEl.style.display = 'flex'

    const btns = this.contextMenuEl.querySelectorAll('.hud-context-item')
    btns.forEach((btn) => {
      const idx = Number((btn as HTMLElement).dataset.idx)
      btn.addEventListener('click', () => {
        this.hideContextMenu()
        items[idx]?.action()
      })
    })
  }

  hideContextMenu(): void {
    this.contextMenuEl.style.display = 'none'
  }
}
