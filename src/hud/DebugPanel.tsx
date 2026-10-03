import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { AIM, COVER, RULES } from '../config'
import { AMMO, AmmoId, GRENADES, GrenadeId, STATUSES, type StatusKind, WEAPONS, WeaponId } from '../core/Arsenal'
import { ITEMS, ItemId } from '../core/Items'
import type { Soldier } from '../entities/Soldier'
import { applyStatus } from '../game/Combat'
import { Icon } from './Icon'

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

interface DebugPanelViewProps {
  soldier: Soldier | null
  recording: RecordingControls | null
  groups: EditGroup[]
  onClose: () => void
  onChange: () => void
  onRefresh: () => void
}

function RecordingGroup({
  controls,
  onRefresh,
}: {
  controls: RecordingControls
  onRefresh: () => void
}) {
  const on = controls.isRecording()
  const events = controls.eventCount()
  const locked = !on && !controls.canArm()
  const note = locked
    ? 'this match has already moved — deploy a new one to record it'
    : 'every command is captured; export writes a file the start screen can load'

  return (
    <div className="debug-group">
      <div className="debug-group-title">Recording</div>
      <label className="debug-row">
        <span>record</span>
        <input
          type="checkbox"
          checked={on}
          disabled={locked}
          onChange={(e) => {
            controls.setRecording(e.target.checked)
            onRefresh()
          }}
        />
      </label>
      <div className="debug-note">{note}</div>
      <div className="debug-row">
        <span>events</span>
        <span>{events}</span>
      </div>
      <div className="debug-buttons">
        <button disabled={events === 0} onClick={() => controls.export()}>
          export .json
        </button>
      </div>
    </div>
  )
}

function LoadoutGroup({
  soldier,
  onChange,
  onRefresh,
}: {
  soldier: Soldier
  onChange: () => void
  onRefresh: () => void
}) {
  return (
    <div className="debug-group">
      <div className="debug-group-title">Loadout</div>
      <label className="debug-row">
        <span>weapon</span>
        <select
          value={soldier.weaponId}
          onChange={(e) => {
            soldier.equip(e.target.value as WeaponId, soldier.ammoId)
            onChange()
            onRefresh()
          }}
        >
          {Object.values(WeaponId).map((id) => (
            <option key={id} value={id}>
              {WEAPONS[id].name}
            </option>
          ))}
        </select>
      </label>
      <label className="debug-row">
        <span>ammo</span>
        <select
          value={soldier.ammoId}
          onChange={(e) => {
            soldier.equip(soldier.weaponId, e.target.value as AmmoId)
            onChange()
            onRefresh()
          }}
        >
          {Object.values(AmmoId).map((id) => (
            <option key={id} value={id}>
              {AMMO[id].name}
            </option>
          ))}
        </select>
      </label>

      <div className="debug-row">
        <span>grenades</span>
      </div>
      {Object.values(GrenadeId).map((kind) => {
        const count = soldier.grenades[kind] ?? 0
        return (
          <div key={kind} className="debug-row debug-stepper">
            <span>{GRENADES[kind].name}</span>
            <div className="debug-stepper-controls">
              <button
                type="button"
                onClick={() => {
                  soldier.grenades[kind] = Math.max(0, count - 1)
                  onChange()
                  onRefresh()
                }}
              >
                -
              </button>
              <span>{count}</span>
              <button
                type="button"
                onClick={() => {
                  soldier.grenades[kind] = count + 1
                  onChange()
                  onRefresh()
                }}
              >
                +
              </button>
            </div>
          </div>
        )
      })}

      <div className="debug-row">
        <span>items</span>
      </div>
      {Object.values(ItemId).map((id) => {
        const count = soldier.items[id] ?? 0
        return (
          <div key={id} className="debug-row debug-stepper">
            <span>{ITEMS[id].name}</span>
            <div className="debug-stepper-controls">
              <button
                type="button"
                onClick={() => {
                  soldier.items[id] = Math.max(0, count - 1)
                  onChange()
                  onRefresh()
                }}
              >
                -
              </button>
              <span>{count}</span>
              <button
                type="button"
                onClick={() => {
                  soldier.items[id] = count + 1
                  onChange()
                  onRefresh()
                }}
              >
                +
              </button>
            </div>
          </div>
        )
      })}

      <div className="debug-buttons">
        <button
          type="button"
          onClick={() => {
            soldier.hp = soldier.maxHp
            soldier.ap = soldier.maxAp
            soldier.armor = soldier.maxArmor
            onChange()
            onRefresh()
          }}
        >
          Heal &amp; Reset AP
        </button>
        <button
          type="button"
          onClick={() => {
            soldier.statuses = []
            onChange()
            onRefresh()
          }}
        >
          Clear statuses
        </button>
      </div>

      <div className="debug-buttons">
        {Object.keys(STATUSES).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              applyStatus(soldier, kind as StatusKind)
              onChange()
              onRefresh()
            }}
          >
            +{STATUSES[kind as StatusKind].name}
          </button>
        ))}
      </div>
    </div>
  )
}

function EditGroupView({
  group,
  onChange,
  onRefresh,
}: {
  group: EditGroup
  onChange: () => void
  onRefresh: () => void
}) {
  const keys = (group.keys ?? Object.keys(group.target)).filter((key) => {
    const value = group.target[key]
    return typeof value === 'number' || typeof value === 'boolean'
  })
  if (keys.length === 0) return null

  return (
    <div className="debug-group">
      <div className="debug-group-title">{group.title}</div>
      {group.note && <div className="debug-note">{group.note}</div>}
      {keys.map((key) => {
        const value = group.target[key]
        if (typeof value === 'boolean') {
          return (
            <label key={key} className="debug-row">
              <span>{key}</span>
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => {
                  group.target[key] = e.target.checked
                  onChange()
                  onRefresh()
                }}
              />
            </label>
          )
        }
        return (
          <label key={key} className="debug-row">
            <span>{key}</span>
            <input
              type="number"
              step="any"
              defaultValue={value as number}
              key={`${key}-${value}`}
              onChange={(e) => {
                const num = Number(e.target.value)
                if (Number.isFinite(num)) {
                  group.target[key] = num
                  onChange()
                }
              }}
            />
          </label>
        )
      })}
    </div>
  )
}

function DebugPanelView({
  soldier,
  recording,
  groups,
  onClose,
  onChange,
  onRefresh,
}: DebugPanelViewProps) {
  return (
    <>
      <div className="debug-head">
        <span>Debug</span>
        <button type="button" onClick={onClose}>
          <Icon file="ui-cancel" />
        </button>
      </div>
      <div className="debug-body">
        {recording && <RecordingGroup controls={recording} onRefresh={onRefresh} />}
        {soldier ? (
          <LoadoutGroup soldier={soldier} onChange={onChange} onRefresh={onRefresh} />
        ) : (
          <div className="debug-group">
            <em>No unit selected</em>
          </div>
        )}
        {groups.map((group, i) => (
          <EditGroupView key={i} group={group} onChange={onChange} onRefresh={onRefresh} />
        ))}
      </div>
    </>
  )
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
  private readonly reactRoot: Root
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
    this.reactRoot = createRoot(this.root)
  }

  dispose(): void {
    this.reactRoot.unmount()
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

    flushSync(() => {
      this.reactRoot.render(
        <DebugPanelView
          soldier={this.soldier}
          recording={this.recording}
          groups={groups}
          onClose={() => this.close()}
          onChange={this.onChange}
          onRefresh={() => this.render()}
        />,
      )
    })
  }
}
