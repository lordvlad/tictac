import { Vector3 } from 'three'
import { WALL_XRAY } from '../config'
import { smoothstep } from '../core/math'
import type { OrbitRig } from '../camera/OrbitRig'
import type { Blocks } from '../render/Blocks'
import type { Squads } from './Squads'

/**
 * Fades the walls standing between the camera and any character — friend or foe
 * — once the camera tilts below `WALL_XRAY.fadeStart`. Opacity eases from 1 at
 * `fadeStart` down to `minOpacity` at `fadeEnd`, so zooming reads as a smooth
 * dissolve rather than a snap.
 *
 * Only rendered characters contribute. An enemy hidden by fog of war must never
 * fade the wall in front of it: that would betray a position the player has not
 * spotted.
 */
export class WallXray {
  /** Ray target: a character's feet, so a wall fades as soon as it hides ANY part of the body. */
  private readonly target = new Vector3()

  constructor(
    private readonly rig: OrbitRig,
    private readonly squads: Squads,
    private readonly blocks: Blocks,
  ) {}

  update(cameraPosition: Vector3): void {
    const eased = smoothstep(
      (this.rig.tilt - WALL_XRAY.fadeEnd) / (WALL_XRAY.fadeStart - WALL_XRAY.fadeEnd),
    )
    const opacity = WALL_XRAY.minOpacity + (1 - WALL_XRAY.minOpacity) * eased

    if (opacity >= 1) {
      this.blocks.clearOcclusionFade()
      return
    }

    this.blocks.beginOcclusionFade()
    for (const soldier of this.squads.soldiers) {
      if (soldier.isDead) continue
      if (soldier.instance && !soldier.instance.visible) continue
      this.target.copy(soldier.position)
      this.blocks.addOcclusionRay(cameraPosition, this.target)
    }
    this.blocks.commitOcclusionFade(opacity)
  }
}
