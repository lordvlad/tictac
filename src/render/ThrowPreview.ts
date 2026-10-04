import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  DoubleSide,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  type Scene,
  type Vector3,
} from 'three'

/** Lifts the blast disc off what it lies on, so it does not z-fight the floor or roof. */
const DISC_LIFT = 0.08

/**
 * The aiming preview of a throw: the flight as a line in the air, and the
 * blast as a disc on whatever it lands on — a floor, or a roof.
 *
 * Built once and updated in place: the planner repaints it on every hover.
 */
export class ThrowPreview {
  private readonly line: Line
  private readonly disc: Mesh
  private positions = new BufferAttribute(new Float32Array(3 * 128), 3)

  constructor(private readonly scene: Scene) {
    const lineGeometry = new BufferGeometry()
    lineGeometry.setAttribute('position', this.positions)
    this.line = new Line(lineGeometry, new LineBasicMaterial({ color: 0xffaa55, transparent: true, opacity: 0.85 }))
    // Its bounds change with every throw; culling against stale ones would hide it.
    this.line.frustumCulled = false

    const discGeometry = new CircleGeometry(1, 32)
    discGeometry.rotateX(-Math.PI / 2)
    this.disc = new Mesh(
      discGeometry,
      new MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.45, side: DoubleSide, depthWrite: false }),
    )

    this.hide()
    scene.add(this.line, this.disc)
  }

  /** Draw `flight` (world points, in order) and a blast of `radius` metres centred on `landing`. */
  show(flight: readonly Vector3[], landing: Vector3, radius: number): void {
    if (flight.length > this.positions.count) {
      this.positions = new BufferAttribute(new Float32Array(3 * flight.length), 3)
      this.line.geometry.setAttribute('position', this.positions)
    }
    flight.forEach((point, i) => this.positions.setXYZ(i, point.x, point.y, point.z))
    this.positions.needsUpdate = true
    this.line.geometry.setDrawRange(0, flight.length)
    this.line.visible = true

    this.disc.position.set(landing.x, landing.y + DISC_LIFT, landing.z)
    this.disc.scale.setScalar(radius)
    this.disc.visible = true
  }

  hide(): void {
    this.line.visible = false
    this.disc.visible = false
  }

  dispose(): void {
    this.scene.remove(this.line, this.disc)
    this.line.geometry.dispose()
    ;(this.line.material as LineBasicMaterial).dispose()
    this.disc.geometry.dispose()
    ;(this.disc.material as MeshBasicMaterial).dispose()
  }
}
