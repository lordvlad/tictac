import { Raycaster, Vector2, Vector3 } from 'three'
import { Faction, LEVEL_HEIGHT } from '../config'
import { clientToNdc } from '../camera/screen'
import { GroundPicker } from '../camera/GroundPicker'
import type { OrbitRig } from '../camera/OrbitRig'
import type { Tile } from '../core/Grid'
import { distance } from '../core/math'
import type { EngineContext } from '../engine'
import type { Soldier } from '../entities/Soldier'
import type { MatchSession } from '../game/MatchSession'
import type { Presenter } from './Presenter'

/** How far, in pixels, the right button may travel and still count as a click rather than an orbit drag. */
const FACING_CLICK_SLOP = 6

/**
 * The window's listeners: canvas and keyboard events in, intents out.
 *
 * Owns nothing about the match. It works out what is under the pointer — a tile,
 * a soldier of either side — and hands that to the session as a
 * {@link PointerIntent}, which decides what it means (select, aim, walk) and
 * whether it is allowed. The only thing that stays on this side is the pointer's
 * own bookkeeping: where the right button went down, and the picking scratch.
 */
export class Input {
  private readonly raycaster = new Raycaster()
  private readonly picker: GroundPicker
  private readonly ndc = new Vector2()
  /** Scratch for tile picking, to avoid a per-event allocation. */
  private readonly pickPoint = new Vector3()
  /** Where the right button went down, to tell a facing click from an orbit drag. */
  private readonly rightDownPos = new Vector2()

  constructor(
    private readonly engine: EngineContext,
    private readonly rig: OrbitRig,
    private readonly session: MatchSession,
    private readonly presenter: Presenter,
  ) {
    this.picker = new GroundPicker(engine.camera)
    const canvas = engine.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('click', this.onClick)
    window.addEventListener('keydown', this.onKeyDown)
  }

  dispose(): void {
    const canvas = this.engine.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('click', this.onClick)
    window.removeEventListener('keydown', this.onKeyDown)
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button === 2) this.rightDownPos.set(event.clientX, event.clientY)
  }

  /** Right-click (not right-drag) turns the selected unit to face the cursor. */
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 2) return
    const travel = distance(event.clientX - this.rightDownPos.x, event.clientY - this.rightDownPos.y)
    if (travel >= FACING_CLICK_SLOP) return

    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    const point = this.picker.fromNdc(this.ndc)
    if (!point) return
    this.session.handlePointer({ type: 'face', x: point.x, z: point.z })
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') this.session.standDown()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.rig.isDragging) return
    this.presenter.hover(this.tileFromEvent(event), this.soldierUnderCursor(event, this.enemyFaction))
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (this.rig.isDragging) return
    const friendly = this.soldierUnderCursor(event, this.session.turnManager.activeFaction)
    const enemy = this.soldierUnderCursor(event, this.enemyFaction)
    this.session.handlePointer({
      type: 'tap',
      tile: this.tileFromEvent(event),
      friendly: friendly?.squadIndex ?? null,
      enemy: enemy?.squadIndex ?? null,
      additive: event.shiftKey,
    })
  }

  private get enemyFaction(): Faction {
    return this.session.turnManager.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
  }

  /**
   * Tile under a click/tap, resolved from the event itself.
   *
   * The hover tile is mouse-only: `pointermove` never fires before a tap on
   * touch (and is suppressed mid-drag anyway), so a tap must project its own
   * coordinates or it hits nothing.
   *
   * Storeys are tried from the one being viewed downwards, and a hit only
   * counts when the tile it lands on really sits at that height. Projecting
   * everything onto the ground would put an upper-floor tap a tile or two from
   * where the player aimed, because a tilted camera sees a raised floor offset
   * from the ground beneath it.
   */
  private tileFromEvent(event: MouseEvent | PointerEvent): Tile | null {
    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    const grid = this.session.grid

    for (let level = this.presenter.level; level >= 0; level--) {
      const hit = this.picker.fromNdc(this.ndc, this.pickPoint, level * LEVEL_HEIGHT)
      if (hit === null) continue
      const tile = grid.worldToTile(hit.x, hit.z)
      if (!grid.inBounds(tile.x, tile.y)) continue
      if (grid.levelAt(tile.x, tile.y) === level) return tile
    }

    // Nothing at any storey lined up — fall back to the ground so a tap on a
    // roof or a wall still resolves to somewhere rather than nowhere.
    const ground = this.picker.fromNdc(this.ndc, this.pickPoint)
    if (ground === null) return null
    const tile = grid.worldToTile(ground.x, ground.z)
    return grid.inBounds(tile.x, tile.y) ? tile : null
  }

  /** The nearest living, visible soldier of `faction` under the pointer. */
  private soldierUnderCursor(event: MouseEvent | PointerEvent, faction: Faction): Soldier | null {
    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    this.raycaster.setFromCamera(this.ndc, this.engine.camera)
    const hits = this.raycaster.intersectObjects(this.engine.scene.children, true)

    for (const hit of hits) {
      let obj: typeof hit.object | null = hit.object
      while (obj) {
        const entityId = obj.userData.entityId as number | undefined
        if (obj.userData.type === 'soldier' && entityId !== undefined) {
          const soldier = this.session.squads.byEntityId(entityId)
          if (soldier && !soldier.isDead && soldier.faction === faction && soldier.seen) return soldier
        }
        obj = obj.parent
      }
    }

    return null
  }
}
