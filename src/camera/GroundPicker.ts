import type { Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { Matrix4 as Mat4, Vector3 as Vec3 } from 'three'

/**
 * Projects screen positions onto a horizontal plane.
 *
 * Shared by the camera (drag panning) and gameplay picking (which tile did the
 * player tap), so the unprojection exists once instead of the camera rig
 * doubling as a picking service for the rest of the game.
 */
export class GroundPicker {
  private readonly unproject = new Mat4()
  private readonly direction = new Vec3()

  constructor(private readonly camera: PerspectiveCamera) {}

  /**
   * Project `ndc` onto the plane at `planeY` using the camera as it is right
   * now. Returns null when the ray points at or above the horizon.
   *
   * `planeY` matters as soon as the map has storeys: a tilted camera sees a
   * tile 2 m up at a different screen position from the ground beneath it, so
   * picking an upper floor against y = 0 lands a tile or two away.
   */
  fromNdc(ndc: Vector2, target: Vector3 = new Vec3(), planeY = 0): Vector3 | null {
    this.camera.updateMatrixWorld()
    this.unproject.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse)
    return this.throughBasis(ndc, this.camera.position, this.unproject, target, planeY)
  }

  /**
   * Project `ndc` through a basis captured earlier.
   *
   * Drag panning must use a frozen basis: unprojecting against the live camera
   * while the same drag is moving that camera is a feedback loop, and the map
   * slides away from the cursor.
   */
  throughBasis(
    ndc: Vector2,
    origin: Vector3,
    unproject: Matrix4,
    target: Vector3 = new Vec3(),
    planeY = 0
  ): Vector3 | null {
    this.direction.set(ndc.x, ndc.y, 0.5).applyMatrix4(unproject).sub(origin)
    if (this.direction.lengthSq() === 0) return null
    this.direction.normalize()
    // Reject rays that are parallel to or pointing away from the target plane.
    if (this.direction.y > -1e-4) return null
    const t = (planeY - origin.y) / this.direction.y
    return target.copy(origin).addScaledVector(this.direction, t)
  }
}
