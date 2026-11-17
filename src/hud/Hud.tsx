import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { bottomLeftRow } from './CornerStack'
import type {
  EndScreen,
  EndScreenSurvivor,
  HudAction,
  HudItemPanel,
  HudModel,
  HudShotOption,
  HudShotPanel,
  HudStrikeOption,
  HudTargetIcon,
  HudThrowPanel,
  HudVisibility,
  TileReadout,
} from './HudModel'
import type { HudIntent } from '../ui/Intent'
import { Icon } from './Icon'
import { uiMount } from './uiMount'

export interface ContextMenuItem {
  label: string
  detail?: string
  danger?: boolean
  action: () => void
}

function TopCentreView({
  model,
  onIntent,
}: {
  model: HudModel
  onIntent: (intent: HudIntent) => void
}) {
  const buttons: {
    label: string
    icon: string
    title: string
    classes: string
    disabled: boolean
    intent: HudIntent
  }[] = [
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

  return (
    <>
      <div className="hud-btn-row">
        {buttons.map((b) => (
          <button
            key={b.label}
            className={`hud-btn interactive ${b.classes}`}
            title={b.title}
            disabled={b.disabled}
            onClick={() => onIntent(b.intent)}
          >
            <Icon file={b.icon} /> {b.label}
          </button>
        ))}
      </div>
      <div className="hud-info-card">
        <span className={`hud-faction-badge ${model.factionIsBlue ? 'blue' : 'red'}`}>
          {model.turnMarker !== null && (
            <Icon file={model.turnMarker === 'mine' ? 'ui-deploy' : 'ui-unit-turn'} className="tiny" />
          )}
          {model.networkBadge}
        </span>
        <span className="hud-turn-label">Turn {model.turnNumber}</span>
      </div>
    </>
  )
}

function LevelSelectorView({
  model,
  onIntent,
}: {
  model: HudModel
  onIntent: (intent: HudIntent) => void
}) {
  const levels: number[] = []
  for (let level = model.topLevel; level >= 0; level--) {
    levels.push(level)
  }

  return (
    <>
      <div className="hud-level-title">LEVEL</div>
      <div className="hud-level-buttons">
        {levels.map((level) => (
          <button
            key={level}
            className={`hud-btn interactive ${model.selectedLevelFilter === level ? 'active' : ''}`}
            title={`View Floor ${level}`}
            onClick={() => onIntent({ type: 'selectLevel', level })}
          >
            L{level}
          </button>
        ))}
      </div>
    </>
  )
}

function CornerActionsView({
  model,
  onIntent,
}: {
  model: HudModel
  onIntent: (intent: HudIntent) => void
}) {
  return (
    <>
      <button
        className="hud-btn hud-btn-glyph interactive"
        title="Unit debug panel"
        onClick={() => onIntent({ type: 'openDebug' })}
      >
        <Icon file="ui-debug" />
      </button>
      <button
        className={`hud-btn hud-btn-glyph interactive ${model.debugMapOpen ? 'active' : ''}`}
        title="Toggle 2D debug minimap"
        onClick={() => onIntent({ type: 'toggleDebugMap' })}
      >
        <Icon file="ui-map" />
      </button>
    </>
  )
}

function EndTurnView({
  model,
  onIntent,
}: {
  model: HudModel
  onIntent: (intent: HudIntent) => void
}) {
  const ready = model.canAct && !model.rulesActing
  const retreat = model.retreat
  const lost =
    retreat && retreat.leftBehind.length > 0 ? ` Leaves ${retreat.leftBehind.join(', ')} behind.` : ''

  const retreatTitle = retreat
    ? `Everyone on your way out leaves; ${retreat.chance}% chance of getting away. A failed attempt ends the turn.${lost}`
    : ''

  const endTurnTitle = !model.canAct
    ? "Opponent's Turn"
    : ready
      ? 'Hand over to the other faction'
      : 'Waiting for the units that broke'

  return (
    <>
      {retreat && (
        <button
          className={`hud-btn interactive ${retreat.armed ? 'hud-btn-danger' : ''}`}
          title={retreatTitle}
          onClick={() =>
            onIntent({ type: retreat.armed ? 'confirmRetreat' : 'requestRetreat' })
          }
        >
          <Icon file="ui-cancel" />{' '}
          {retreat.armed ? `Confirm retreat · ${retreat.chance}%` : `Retreat · ${retreat.chance}%`}
        </button>
      )}
      <button
        className={`hud-btn interactive ${ready ? 'hud-btn-danger' : ''}`}
        title={endTurnTitle}
        disabled={!ready}
        onClick={() => onIntent({ type: 'requestTurnSwitch' })}
      >
        <Icon file="ui-end-turn" /> End Turn
      </button>
      {retreat?.armed && retreat.leftBehind.length > 0 && (
        <div className="hud-turn-note">Left behind and lost: {retreat.leftBehind.join(', ')}</div>
      )}
      {model.retreatNote && <div className="hud-turn-note">{model.retreatNote}</div>}
    </>
  )
}

function BarView({
  kind,
  value,
  max,
  label,
}: {
  kind: 'hp' | 'ap' | 'armor'
  value: number
  max: number
  label: string
}) {
  const percent = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <>
      <div
        className="bar-container"
        style={kind === 'ap' || kind === 'armor' ? { marginTop: 3 } : undefined}
      >
        <div className={`bar-fill ${kind}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="bar-label">
        <span>{label}</span>
        <span>
          {value}/{max}
        </span>
      </div>
    </>
  )
}

function SquadBarView({
  model,
  onIntent,
}: {
  model: HudModel
  onIntent: (intent: HudIntent) => void
}) {
  return (
    <>
      {model.squad.map((card) => (
        <div
          key={card.index}
          className={`squad-card ${model.canAct ? 'interactive' : 'waiting'} ${card.selected ? 'selected' : ''} ${card.dead ? 'dead' : ''}`}
          onClick={model.canAct ? () => onIntent({ type: 'selectUnit', index: card.index }) : undefined}
        >
          <img className="squad-portrait" src={card.portrait} alt={card.name} />
          <div className="squad-name">{card.name}</div>
          <div className="squad-bars">
            <BarView kind="hp" value={card.hp} max={card.maxHp} label="HP" />
            <BarView kind="ap" value={card.ap} max={card.maxAp} label="AP" />
            <BarView kind="armor" value={card.armor} max={card.maxArmor} label="AR" />
          </div>
          {card.statuses.length > 0 && (
            <div className="squad-statuses">
              {card.statuses.map((status, i) => (
                <span
                  key={i}
                  className={`squad-status ${status.good ? 'good' : 'bad'}`}
                  title={status.detail}
                >
                  {status.name}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  )
}

function TargetStripView({
  targets,
  onIntent,
}: {
  targets: readonly HudTargetIcon[]
  onIntent: (intent: HudIntent) => void
}) {
  return (
    <>
      {targets.map((t) => {
        const patient = t.hitChance === null
        const figure = patient ? `${Math.round(t.hpFraction * 100)}%` : `${t.hitChance}%`
        const title = patient
          ? `${t.name} — ${figure} HP`
          : `${t.name} — ${figure} to hit${t.known ? '' : ' · unread'}${t.awareness ? ` · ${t.awareness}` : ''}${t.broken ? ` · ${t.broken}` : ''}`

        return (
          <button
            key={t.index}
            className={`target-icon interactive ${patient ? 'patient' : ''} ${t.selected ? 'selected' : ''} ${t.known ? '' : 'unread'}`}
            title={title}
            onClick={() => onIntent({ type: 'selectTarget', index: t.index })}
          >
            <img className="target-portrait" src={t.portrait} alt={t.name} />
            {!t.known && <span className="target-unread">?</span>}
            {t.awareness && (
              <span className={`target-awareness ${t.awareness}`}>
                {t.awareness === 'unaware' ? 'z' : '!'}
              </span>
            )}
            {t.broken && <span className={`target-broken ${t.broken}`}>{t.broken}</span>}
            <span className="target-chance">{figure}</span>
            <span className="target-hp">
              <span
                className="target-hp-fill"
                style={{ width: `${Math.round(t.hpFraction * 100)}%` }}
              />
            </span>
            <span className="target-ar">
              <span
                className="target-ar-fill"
                style={{ width: `${Math.round(t.armorFraction * 100)}%` }}
              />
            </span>
          </button>
        )
      })}
    </>
  )
}

function ActionButtonView({
  action,
  onIntent,
}: {
  action: HudAction
  onIntent: (intent: HudIntent) => void
}) {
  return (
    <button
      className={`action-btn interactive ${action.active ? 'active' : ''}`}
      disabled={action.disabled}
      onClick={() => onIntent(action.intent)}
    >
      <span className="action-label">
        <Icon file={action.icon} /> {action.label}
        {action.targeted && (
          <span className="action-on-ally" title="Can be used on a squadmate in reach">
            ALLY
          </span>
        )}
      </span>
      <span className="action-tag">{action.tag}</span>
    </button>
  )
}

function SubmenuView({
  group,
  members,
  open,
  onToggle,
  onIntent,
}: {
  group: 'items' | 'grenades'
  members: readonly HudAction[]
  open: boolean
  onToggle: () => void
  onIntent: (intent: HudIntent) => void
}) {
  const spec =
    group === 'items'
      ? { label: 'Items', icon: 'item-stim' }
      : { label: 'Grenades', icon: 'grenade-frag' }
  const carried = members.reduce((total, row) => total + Number(row.tag.split('x')[1] ?? 0), 0)

  return (
    <div className="action-group">
      <button className={`action-btn interactive ${open ? 'active' : ''}`} onClick={onToggle}>
        <span className="action-label">
          <Icon file={spec.icon} /> {spec.label}
        </span>
        <span className="action-tag">
          {carried > 0 ? `x${carried}` : ''} {open ? '◂' : '▸'}
        </span>
      </button>
      {open && (
        <div className="action-submenu">
          {members.map((row, i) => (
            <ActionButtonView key={i} action={row} onIntent={onIntent} />
          ))}
        </div>
      )}
    </div>
  )
}

function ShotCardView({
  shot,
  onIntent,
}: {
  shot: HudShotPanel
  onIntent: (intent: HudIntent) => void
}) {
  return (
    <>
      <div className="action-header">
        Firing at {shot.targetName}
        {!shot.targetKnown && (
          <span
            className="shot-unknown"
            title="Unread: shoot at it, or be shot at by it, to learn what it is"
          >
            UNREAD
          </span>
        )}
        {shot.targetAwareness === 'unaware' && (
          <span
            className="shot-awareness unaware"
            title="Has seen and heard nothing: it faces where it last turned, and only a watcher in the fight reacts all round"
          >
            UNAWARE
          </span>
        )}
        {shot.targetAwareness === 'alerted' && (
          <span
            className="shot-awareness alerted"
            title="Heard something and turned toward it, but has seen nobody"
          >
            ALERTED
          </span>
        )}
      </div>
      <div className="shot-card">
        <div className="shot-target">
          {shot.weaponName} ({shot.currentClip}/{shot.maxClip} ammo) · {shot.ammoName} — target{' '}
          {shot.targetHp} HP · {shot.targetArmor} AR
        </div>
        <div className={`shot-option-chance ${shot.base.chance >= 50 ? 'good' : 'poor'}`}>
          {shot.base.chance}
          <span>%</span>
        </div>
        <div className="shot-rows shot-outcome">
          <div className="shot-row">
            <span>
              <Icon file="shot-damage" className="tiny" />
              Damage a hit
            </span>
            <span>{shot.base.damage}</span>
          </div>
        </div>
      </div>
      {shot.options.map((option, i) => (
        <button
          key={i}
          className={`shot-option interactive ${option.available ? '' : 'unavailable'}`}
          disabled={!option.available}
          onClick={() => onIntent({ type: 'fireShot', mode: option.mode })}
        >
          <span className="shot-option-name">
            <Icon file={`mode-${option.mode}`} /> {option.name}
          </span>
          <span className="shot-option-diff">
            <span className="shot-option-odds">
              {option.outOfRange ? (
                <span className="shot-option-hit poor">OUT OF RANGE</span>
              ) : (
                <span className={`shot-option-hit ${option.hitChance >= 50 ? 'good' : 'poor'}`}>
                  {option.hitChance}%
                </span>
              )}
            </span>
            <span className="shot-option-ap">
              {option.apCost} AP · {option.bullets}x · {option.damageAtBest} dmg
            </span>
          </span>
        </button>
      ))}
      {shot.strike && (
        <button
          className="shot-option interactive"
          onClick={() => onIntent({ type: 'meleeAttack' })}
        >
          <span className="shot-option-name">
            <Icon file={`melee-${shot.strike.sidearm}`} /> Strike · {shot.strike.name}
          </span>
          <span className="shot-option-diff">
            <span className="shot-option-odds">
              <span className={`shot-option-hit ${shot.strike.hitChance >= 50 ? 'good' : 'poor'}`}>
                {shot.strike.hitChance}%
              </span>
            </span>
            <span className="shot-option-ap">
              {shot.strike.apCost} AP · {shot.strike.damage} dmg
            </span>
          </span>
        </button>
      )}
      <button className="action-btn interactive" onClick={() => onIntent({ type: 'cancelShoot' })}>
        <span className="action-label">
          <Icon file="ui-cancel" /> Cancel
        </span>
        <span className="action-tag">Esc</span>
      </button>
    </>
  )
}

function ThrowCardView({
  shot,
  onIntent,
}: {
  shot: HudThrowPanel
  onIntent: (intent: HudIntent) => void
}) {
  const blocked = !shot.affordable || !shot.inRange
  const friendlies = shot.caught.filter((c) => c.friendly).length

  return (
    <>
      <div className="action-header">{shot.name}</div>
      <div className="shot-card">
        <div className="shot-weapon">
          Radius {shot.radius} · x{shot.remaining} left{shot.statusName ? ` · ${shot.statusName}` : ''}
        </div>
        {shot.caught.length === 0 ? (
          <div className="shot-row">
            <span>{shot.inRange ? 'Nobody in blast' : 'Out of throwing range'}</span>
          </div>
        ) : (
          <div className="shot-rows">
            {shot.caught.map((c, i) => (
              <div key={i} className={`shot-row ${c.friendly ? 'penalty' : ''}`}>
                <span>
                  {c.friendly && <Icon file="ui-hazard" />}
                  {c.name}
                  {c.lethal && <Icon file="ui-lethal" />}
                </span>
                <span>
                  {c.damage > 0 ? `-${c.damage} HP` : ''}
                  {c.armorShred > 0 ? ` -${c.armorShred} AR` : ''}
                  {c.damage === 0 && c.armorShred === 0 ? 'effect only' : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        {friendlies > 0 && (
          <div className="shot-row penalty">
            <span>Friendly fire</span>
            <span>{friendlies} caught</span>
          </div>
        )}
      </div>
      <button
        className="action-btn action-fire interactive"
        disabled={blocked}
        onClick={() => onIntent({ type: 'confirmThrow' })}
      >
        <span className="action-label">
          <Icon file={`grenade-${shot.kind}`} /> {shot.inRange ? 'THROW' : 'Too far'}
        </span>
        <span className="action-tag">{shot.apCost} AP</span>
      </button>
      <button
        className="action-btn interactive"
        onClick={() => onIntent({ type: 'cancelGrenade' })}
      >
        <span className="action-label">
          <Icon file="ui-cancel" /> Cancel
        </span>
        <span className="action-tag">Esc</span>
      </button>
    </>
  )
}

function ItemCardView({
  item,
  onIntent,
}: {
  item: HudItemPanel
  onIntent: (intent: HudIntent) => void
}) {
  return (
    <>
      <div className="action-header">{item.name}</div>
      <div className="shot-card">
        <div className="shot-weapon">
          x{item.remaining} left · {item.apCost} AP
        </div>
        <div className={`item-patient ${item.targetName ? '' : 'pending'}`}>
          {item.targetName ? (
            <>
              <Icon file="ui-deploy" className="tiny" />
              Treating {item.targetName}
            </>
          ) : (
            'Pick a squadmate in reach'
          )}
        </div>
        <div className="shot-rows">
          {item.effects.map((line, i) => (
            <div key={i} className="shot-row">
              <span>{line}</span>
            </div>
          ))}
        </div>
      </div>
      <button
        className="action-btn action-fire interactive"
        disabled={!item.targetName || !item.affordable}
        onClick={() => onIntent({ type: 'confirmItem' })}
      >
        <span className="action-label">
          <Icon file={`item-${item.itemId}`} /> {item.affordable ? 'USE' : 'Not enough AP'}
        </span>
        <span className="action-tag">{item.apCost} AP</span>
      </button>
      <button className="action-btn interactive" onClick={() => onIntent({ type: 'cancelItem' })}>
        <span className="action-label">
          <Icon file="ui-cancel" /> Cancel
        </span>
        <span className="action-tag">Esc</span>
      </button>
    </>
  )
}

function ActionPanelView({
  model,
  openGroup,
  onToggleGroup,
  onIntent,
}: {
  model: HudModel
  openGroup: 'items' | 'grenades' | null
  onToggleGroup: (group: 'items' | 'grenades') => void
  onIntent: (intent: HudIntent) => void
}) {
  if (!model.canAct) {
    return (
      <>
        <div className="action-header" style={{ color: '#cbd5e1' }}>
          Opponent's Turn
        </div>
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid #334155',
            borderRadius: 8,
            padding: '24px 16px',
            textAlign: 'center',
            boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)',
          }}
        >
          <div className="hud-waiting-glyph">
            <Icon file="ui-unit-turn" className="huge" />
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#38bdf8',
              marginBottom: 6,
              letterSpacing: 0.5,
            }}
          >
            OPPONENT'S TURN
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>
            Waiting for opponent to complete their actions...
          </div>
        </div>
      </>
    )
  }

  if (model.throwPanel) {
    return <ThrowCardView shot={model.throwPanel} onIntent={onIntent} />
  }

  if (model.shotPanel) {
    return <ShotCardView shot={model.shotPanel} onIntent={onIntent} />
  }

  if (model.itemPanel) {
    return <ItemCardView item={model.itemPanel} onIntent={onIntent} />
  }

  if (model.selectedName === null) {
    return null
  }

  const rows: React.ReactNode[] = []
  const done = new Set<string>()

  for (let i = 0; i < model.actions.length; i++) {
    const action = model.actions[i]!
    if (action.group === undefined) {
      rows.push(<ActionButtonView key={`action-${i}`} action={action} onIntent={onIntent} />)
      continue
    }
    if (done.has(action.group)) continue
    done.add(action.group)

    const members = model.actions.filter((other) => other.group === action.group)
    if (action.group === 'grenades' && members.length < 2) {
      rows.push(<ActionButtonView key={`action-${i}`} action={action} onIntent={onIntent} />)
    } else {
      const grp = action.group
      rows.push(
        <SubmenuView
          key={`group-${grp}`}
          group={grp}
          members={members}
          open={openGroup === grp}
          onToggle={() => onToggleGroup(grp)}
          onIntent={onIntent}
        />,
      )
    }
  }

  return <>{rows}</>
}

function TurnOverlayView({
  model,
  onIntent,
}: {
  model: HudModel
  onIntent: (intent: HudIntent) => void
}) {
  return (
    <>
      <div className={`turn-title ${model.factionIsBlue ? 'red' : 'blue'}`}>
        {model.nextFactionName} TEAM'S TURN
      </div>
      <div className="turn-subtitle">Pass control to the active faction</div>
      <button
        className="turn-continue-btn interactive"
        onClick={() => onIntent({ type: 'confirmTurnSwitch' })}
      >
        CONTINUE <Icon file="ui-continue" />
      </button>
    </>
  )
}

function EndScreenView({
  screen,
  onIntent,
}: {
  screen: EndScreen
  onIntent: (intent: HudIntent) => void
}) {
  const side = screen.blue ? 'blue' : 'red'

  const renderSurvivors = (survivors: readonly EndScreenSurvivor[]) =>
    survivors.map((survivor, i) => (
      <div key={i} className="end-survivor">
        <img className="end-portrait" src={survivor.portrait} alt="" />
        <div>
          <div className="end-name">{survivor.name}</div>
          {survivor.lines.length === 0 ? (
            <div className="end-line quiet">Nothing new this time.</div>
          ) : (
            survivor.lines.map((line, j) => (
              <div key={j} className="end-line">
                <b>{line.label}</b>{' '}
                <span className="end-change">
                  {line.from} → {line.to}
                </span>{' '}
                <span className="end-because">{line.because}</span>
              </div>
            ))
          )}
        </div>
      </div>
    ))

  if (screen.stage === 'lost') {
    const got = screen.escaped.length > 0
    return (
      <>
        <div className={`turn-title ${side}`}>
          {screen.factionName} — {got ? 'you got out' : 'you lost'}
        </div>
        <div className="turn-subtitle">
          {got
            ? 'They live, and keep what they learned. The field is the enemy’s.'
            : 'Nobody left standing.'}
        </div>
        {got ? (
          <div className="end-survivors">{renderSurvivors(screen.escaped)}</div>
        ) : (
          screen.carried && (
            <div className="end-survivors">
              <div className="end-survivor">
                <img className="end-portrait" src={screen.carried.portrait} alt="" />
                <div>
                  <div className="end-name">{screen.carried.name}</div>
                  <div className="end-line">
                    Carried out alive, on 1 HP. The rest of the squad is gone.
                  </div>
                </div>
              </div>
            </div>
          )
        )}
        <button className="turn-continue-btn interactive" onClick={() => onIntent(screen.next)}>
          CONTINUE <Icon file="ui-continue" />
        </button>
      </>
    )
  }

  return (
    <>
      <div className={`turn-title ${side}`}>{screen.factionName} wins</div>
      <div className="turn-subtitle">What the survivors learned</div>
      <div className="end-survivors">{renderSurvivors(screen.survivors)}</div>
      <button className="turn-continue-btn interactive" onClick={() => onIntent(screen.next)}>
        BACK TO THE MENU <Icon file="ui-continue" />
      </button>
    </>
  )
}

function TileReadoutView({ readout }: { readout: TileReadout }) {
  return (
    <div className="hud-tile-readout">
      {readout.lines.map((line, i) => (
        <div key={i} className={`hud-tile-line ${line.tone}`}>
          <b>{line.name}</b> {line.detail}
        </div>
      ))}
    </div>
  )
}

interface ContextMenuState {
  x: number
  y: number
  items: ContextMenuItem[]
}

function ContextMenuView({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const element = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: menu.x, top: menu.y })

  // Keep the menu fully on screen: a tap near the right or bottom edge of a
  // phone would otherwise open it mostly outside the viewport. Measured once
  // it has a size, before the browser paints it.
  useLayoutEffect(() => {
    const margin = 8
    const rect = element.current?.getBoundingClientRect()
    if (!rect) return
    const maxLeft = window.innerWidth - rect.width - margin
    const maxTop = window.innerHeight - rect.height - margin
    setAt({ left: Math.max(margin, Math.min(menu.x, maxLeft)), top: Math.max(margin, Math.min(menu.y, maxTop)) })
  }, [menu])

  return (
    <div ref={element} className="hud-context-menu" style={at}>
      {menu.items.map((item, idx) => (
        <button
          key={idx}
          className={`hud-context-item interactive ${item.danger ? 'danger' : ''}`}
          onClick={() => {
            onClose()
            item.action()
          }}
        >
          <span>{item.label}</span>
          {item.detail && <span style={{ fontSize: 10, opacity: 0.6 }}>{item.detail}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * The DOM HUD: squad bar, unit actions, turn banner, context menu.
 *
 * A pure view. It renders whatever {@link HudModel} it is handed and reports
 * presses as {@link HudIntent}s — it never touches the turn manager, a soldier
 * or the camera, so "what a button does" is answered in exactly one place.
 *
 * Every piece is rendered by React from the state held here, and a piece that
 * is not showing is not rendered: nothing toggles a class on an element
 * from outside.
 */
export class Hud {
  /** The elements the roots draw into, each laid out as if it were not there (`.hud-mount`). */
  private readonly mounts: HTMLElement[] = []
  private readonly topCentreRoot: Root
  private readonly levelSelectorRoot: Root
  private readonly bottomCentreRoot: Root
  private readonly actionPanelRoot: Root
  private readonly endTurnRoot: Root
  private readonly turnOverlayRoot: Root
  private readonly endScreenRoot: Root
  private readonly contextMenuRoot: Root
  /** What the tile under the pointer is; see {@link showTile}. */
  private readonly tileReadoutRoot: Root
  private readonly cornerActionsRoot: Root

  private visible: HudVisibility = { panelsHidden: false, turnOverlay: false }
  /**
   * Which group's submenu is open, if any. View state: which rows are folded
   * away is a property of this panel, not of the match. One at a time, because
   * two flyouts open beside the same panel would sit on top of each other.
   */
  private openGroup: 'items' | 'grenades' | null = null
  private model: HudModel | null = null
  /**
   * What the turn cover says, held from the moment it went up: it fades out
   * after the turn has changed hands, and must not change its words while it does.
   */
  private turnCover: HudModel | null = null
  private contextMenu: ContextMenuState | null = null

  constructor(private readonly onIntent: (intent: HudIntent) => void) {
    const ui = uiMount()
    const mountOn = (parent: HTMLElement): Root => {
      const element = document.createElement('div')
      element.className = 'hud-mount'
      parent.appendChild(element)
      this.mounts.push(element)
      return createRoot(element)
    }

    this.topCentreRoot = mountOn(ui)
    this.levelSelectorRoot = mountOn(ui)
    this.bottomCentreRoot = mountOn(ui)
    this.actionPanelRoot = mountOn(ui)
    this.endTurnRoot = mountOn(ui)
    this.turnOverlayRoot = mountOn(ui)
    this.endScreenRoot = mountOn(ui)
    this.contextMenuRoot = mountOn(ui)
    this.tileReadoutRoot = mountOn(ui)
    // The developer tools live in the bottom-left corner beside the frame
    // counter, which is outside #ui — so they carry their own listener.
    this.cornerActionsRoot = mountOn(bottomLeftRow())
  }

  dispose(): void {
    for (const root of [
      this.topCentreRoot,
      this.levelSelectorRoot,
      this.bottomCentreRoot,
      this.actionPanelRoot,
      this.endTurnRoot,
      this.turnOverlayRoot,
      this.endScreenRoot,
      this.contextMenuRoot,
      this.tileReadoutRoot,
      this.cornerActionsRoot,
    ]) {
      root.unmount()
    }
    for (const element of this.mounts) element.remove()
    this.mounts.length = 0
  }

  /**
   * What the pointer is over: the tile's surface, and whatever is on it.
   * Drawn on its own, outside the model, because it changes on every pointer
   * move and nothing else on the HUD does.
   */
  showTile(readout: TileReadout | null): void {
    this.tileReadoutRoot.render(readout ? <TileReadoutView readout={readout} /> : null)
  }

  /**
   * Hide the in-match panels.
   *
   * For a replay, where there is nothing to command: a squad bar whose buttons
   * do nothing is worse than no squad bar. The bottom-left corner tools stay —
   * reading a unit's state turn by turn is the reason to watch a replay at all.
   */
  setHidden(hidden: boolean): void {
    this.visible = { ...this.visible, panelsHidden: hidden }
    this.drawPanels()
    this.drawTurnOverlay()
    this.drawContextMenu()
  }

  /**
   * Re-render the live panels.
   */
  render(model: HudModel): void {
    this.model = model
    this.cornerActionsRoot.render(
      <div className="hud-corner-actions">
        <CornerActionsView model={model} onIntent={this.onIntent} />
      </div>,
    )
    this.drawPanels()
    // Until a cover has gone up it follows the model, so it is already in the
    // page — hidden — when it first has to fade in.
    if (this.turnCover === null) this.drawTurnOverlay()
  }

  private drawPanels(): void {
    const model = this.visible.panelsHidden ? null : this.model
    if (!model) {
      for (const root of [
        this.topCentreRoot,
        this.levelSelectorRoot,
        this.bottomCentreRoot,
        this.actionPanelRoot,
        this.endTurnRoot,
      ]) {
        root.render(null)
      }
      return
    }
    const onIntent = this.onIntent
    this.topCentreRoot.render(
      <div className="hud-top-centre">
        <TopCentreView model={model} onIntent={onIntent} />
      </div>,
    )
    this.levelSelectorRoot.render(
      <div className="hud-level-selector">
        <LevelSelectorView model={model} onIntent={onIntent} />
      </div>,
    )
    this.endTurnRoot.render(
      <div className="hud-end-turn">
        <EndTurnView model={model} onIntent={onIntent} />
      </div>,
    )
    // Strip and squad bar share one bottom-centred column: stacking them in the
    // layout means they cannot overlap, whatever height the cards grow to.
    const showTargets = model.targets.length > 0 && model.canAct
    this.bottomCentreRoot.render(
      <div className="hud-bottom-centre">
        {showTargets && (
          <div className="hud-target-strip">
            <TargetStripView targets={model.targets} onIntent={onIntent} />
          </div>
        )}
        <div className="hud-squad-bar">
          <SquadBarView model={model} onIntent={onIntent} />
        </div>
      </div>,
    )
    this.drawActionPanel()
  }

  private drawActionPanel(): void {
    const model = this.visible.panelsHidden ? null : this.model
    this.actionPanelRoot.render(
      model && (
        <div className="hud-action-panel">
          <ActionPanelView
            model={model}
            openGroup={this.openGroup}
            onToggleGroup={(group) => {
              this.openGroup = this.openGroup === group ? null : group
              this.drawActionPanel()
            }}
            onIntent={this.onIntent}
          />
        </div>
      ),
    )
  }

  // ---------------------------------------------------------------------------
  // Turn overlay, end screen & context menu
  // ---------------------------------------------------------------------------

  showTurnOverlay(): void {
    this.turnCover = this.model
    this.visible = { ...this.visible, turnOverlay: true }
    this.drawTurnOverlay()
  }

  hideTurnOverlay(): void {
    this.visible = { ...this.visible, turnOverlay: false }
    this.drawTurnOverlay()
  }

  private drawTurnOverlay(): void {
    const model = this.visible.panelsHidden ? null : (this.turnCover ?? this.model)
    this.turnOverlayRoot.render(
      model && (
        <div className={this.visible.turnOverlay ? 'turn-overlay visible' : 'turn-overlay'}>
          <TurnOverlayView
            model={model}
            onIntent={(intent) => {
              if (intent.type === 'confirmTurnSwitch' && !this.visible.turnOverlay) return
              this.onIntent(intent)
            }}
          />
        </div>
      ),
    )
  }

  /** Whether the in-match panels are hidden, as they are for a replay. */
  get hidden(): boolean {
    return this.visible.panelsHidden
  }

  /**
   * The end of the match: one page of it. Over everything else and it stays:
   * the match is over, and the only way on is the page's own button.
   */
  showEndScreen(screen: EndScreen): void {
    this.endScreenRoot.render(
      <div className="turn-overlay end-screen visible">
        <EndScreenView screen={screen} onIntent={this.onIntent} />
      </div>,
    )
  }

  showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    this.contextMenu = { x, y, items }
    this.drawContextMenu()
  }

  hideContextMenu(): void {
    this.contextMenu = null
    this.drawContextMenu()
  }

  private drawContextMenu(): void {
    const menu = this.visible.panelsHidden ? null : this.contextMenu
    this.contextMenuRoot.render(menu && <ContextMenuView menu={menu} onClose={() => this.hideContextMenu()} />)
  }
}
