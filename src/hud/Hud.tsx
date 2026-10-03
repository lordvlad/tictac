import { createRoot, type Root } from 'react-dom/client'
import { bottomLeftRow } from './CornerStack'
import type {
  EndScreen,
  EndScreenSurvivor,
  HudAction,
  HudIntent,
  HudItemPanel,
  HudModel,
  HudShotOption,
  HudShotPanel,
  HudStrikeOption,
  HudTargetIcon,
  HudThrowPanel,
  TileReadout,
} from './HudModel'
import { Icon } from './Icon'

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
          {model.networkMode !== 'local' && (
            <Icon file={model.isMyTurn ? 'ui-deploy' : 'ui-unit-turn'} className="tiny" />
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
  const isMyTurn = model.isMyTurn || model.networkMode === 'local'
  const ready = isMyTurn && !model.rulesActing
  const retreat = model.retreat
  const lost =
    retreat && retreat.leftBehind.length > 0 ? ` Leaves ${retreat.leftBehind.join(', ')} behind.` : ''

  const retreatTitle = retreat
    ? `Everyone on your way out leaves; ${retreat.chance}% chance of getting away. A failed attempt ends the turn.${lost}`
    : ''

  const endTurnTitle = !isMyTurn
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
  const canInteract = model.isMyTurn || model.networkMode === 'local'

  return (
    <>
      {model.squad.map((card) => (
        <div
          key={card.index}
          className={`squad-card ${canInteract ? 'interactive' : 'waiting'} ${card.selected ? 'selected' : ''} ${card.dead ? 'dead' : ''}`}
          onClick={canInteract ? () => onIntent({ type: 'selectUnit', index: card.index }) : undefined}
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
  if (!model.isMyTurn && model.networkMode !== 'local') {
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

function TileReadoutView({ readout }: { readout: TileReadout | null }) {
  if (!readout) return null
  return (
    <>
      {readout.lines.map((line, i) => (
        <div key={i} className={`hud-tile-line ${line.tone}`}>
          <b>{line.name}</b> {line.detail}
        </div>
      ))}
    </>
  )
}

function ContextMenuView({
  items,
  onClose,
}: {
  items: ContextMenuItem[]
  onClose: () => void
}) {
  return (
    <>
      {items.map((item, idx) => (
        <button
          key={idx}
          className={`hud-context-item interactive ${item.danger ? 'danger' : ''}`}
          onClick={() => {
            onClose()
            item.action()
          }}
        >
          <span>{item.label}</span>
          {item.detail && (
            <span style={{ fontSize: 10, opacity: 0.6 }}>{item.detail}</span>
          )}
        </button>
      ))}
    </>
  )
}

/**
 * The DOM HUD: squad bar, unit actions, turn banner, context menu.
 *
 * A pure view. It renders whatever {@link HudModel} it is handed and reports
 * presses as {@link HudIntent}s — it never touches the turn manager, a soldier
 * or the camera, so "what a button does" is answered in exactly one place.
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

  private readonly topCentreRoot: Root
  private readonly levelSelectorRoot: Root
  private readonly cornerActionsRoot: Root
  private readonly endTurnRoot: Root
  private readonly targetStripRoot: Root
  private readonly squadBarRoot: Root
  private readonly actionPanelRoot: Root
  private readonly turnOverlayRoot: Root
  private readonly endScreenRoot: Root
  private readonly contextMenuRoot: Root
  private readonly tileReadoutRoot: Root

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
    bottomLeftRow().appendChild(this.cornerActionsEl)

    this.topCentreRoot = createRoot(this.topCentreEl)
    this.levelSelectorRoot = createRoot(this.levelSelectorEl)
    this.cornerActionsRoot = createRoot(this.cornerActionsEl)
    this.endTurnRoot = createRoot(this.endTurnEl)
    this.targetStripRoot = createRoot(this.targetStripEl)
    this.squadBarRoot = createRoot(this.squadBarEl)
    this.actionPanelRoot = createRoot(this.actionPanelEl)
    this.turnOverlayRoot = createRoot(this.turnOverlayEl)
    this.endScreenRoot = createRoot(this.endScreenEl)
    this.contextMenuRoot = createRoot(this.contextMenuEl)
    this.tileReadoutRoot = createRoot(this.tileReadoutEl)
  }

  dispose(): void {
    this.topCentreRoot.unmount()
    this.levelSelectorRoot.unmount()
    this.cornerActionsRoot.unmount()
    this.endTurnRoot.unmount()
    this.targetStripRoot.unmount()
    this.squadBarRoot.unmount()
    this.actionPanelRoot.unmount()
    this.turnOverlayRoot.unmount()
    this.endScreenRoot.unmount()
    this.contextMenuRoot.unmount()
    this.tileReadoutRoot.unmount()

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
      this.tileReadoutRoot.render(null)
      return
    }
    this.tileReadoutEl.classList.add('visible')
    this.tileReadoutRoot.render(<TileReadoutView readout={readout} />)
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
   * Re-render the live panels.
   */
  render(model: HudModel): void {
    this.model = model
    this.topCentreRoot.render(<TopCentreView model={model} onIntent={this.onIntent} />)
    this.levelSelectorRoot.render(<LevelSelectorView model={model} onIntent={this.onIntent} />)
    this.cornerActionsRoot.render(<CornerActionsView model={model} onIntent={this.onIntent} />)
    this.endTurnRoot.render(<EndTurnView model={model} onIntent={this.onIntent} />)

    const showTargets =
      model.targets.length > 0 && (model.isMyTurn || model.networkMode === 'local')
    this.targetStripEl.classList.toggle('visible', showTargets)
    this.targetStripRoot.render(
      showTargets ? <TargetStripView targets={model.targets} onIntent={this.onIntent} /> : null,
    )

    this.squadBarRoot.render(<SquadBarView model={model} onIntent={this.onIntent} />)
    this.renderActionPanel(model)
  }

  private renderActionPanel(model: HudModel): void {
    this.actionPanelRoot.render(
      <ActionPanelView
        model={model}
        openGroup={this.openGroup}
        onToggleGroup={(group) => {
          this.openGroup = this.openGroup === group ? null : group
          if (this.model) this.renderActionPanel(this.model)
        }}
        onIntent={this.onIntent}
      />,
    )
  }

  // ---------------------------------------------------------------------------
  // Turn overlay & context menu
  // ---------------------------------------------------------------------------

  showTurnOverlay(): void {
    if (this.model) {
      this.turnOverlayRoot.render(
        <TurnOverlayView
          model={this.model}
          onIntent={(intent) => {
            if (intent.type === 'confirmTurnSwitch' && !this.turnOverlayVisible) return
            this.onIntent(intent)
          }}
        />,
      )
    }
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
    this.endScreenRoot.render(<EndScreenView screen={screen} onIntent={this.onIntent} />)
    this.endScreenEl.classList.add('visible')
  }

  showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
    this.contextMenuRoot.render(
      <ContextMenuView items={items} onClose={() => this.hideContextMenu()} />,
    )
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
  }

  hideContextMenu(): void {
    this.contextMenuEl.style.display = 'none'
  }
}
