import { Euler, MathUtils, Object3D, Quaternion, Vector3, type Group } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { WeaponId } from '../core/Arsenal'

/**
 * Models are authored with the stock down +X and the muzzle down -X, roughly
 * 5.5 units long, so one scale (-> ~1 m) serves all of them.
 */
const WEAPON_SCALE = 0.18

/**
 * Where the palm sits on the model, in the model's own frame (metres), found
 * by tuning against the `aim` clip: the model's origin is not at the grip, and
 * the shotgun's origin sits lower than the others'.
 */
const GRIP_ROTATION = new Quaternion().setFromEuler(new Euler(0.4354, 1.5192, 0.9491))
const GRIP_POSITION: Partial<Record<WeaponId, [number, number, number]>> & {
  default: [number, number, number]
} = {
  default: [0.0085, 0.1522, -0.1099],
  shotgun: [0.0059, 0.1633, -0.051],
}
/**
 * How far the weapon sits back in the hand, in metres along it: the tuned
 * point lands the palm at the wrist of the stock on these guns, behind the
 * pistol grip, so the hand has to close further toward the muzzle.
 */
const PALM_FORWARD: Partial<Record<WeaponId, number>> = {
  rifle: 0.08,
  shotgun: 0.12,
  gatling: 0.08,
}
const PALM_IN_MODEL = new Map<WeaponId, Vector3>()
function palmInModel(id: WeaponId): Vector3 {
  let palm = PALM_IN_MODEL.get(id)
  if (!palm) {
    const [x, y, z] = GRIP_POSITION[id] ?? GRIP_POSITION.default
    palm = new Vector3(-x, -y, -z).applyQuaternion(GRIP_ROTATION.clone().invert())
    palm.x += PALM_FORWARD[id] ?? 0
    PALM_IN_MODEL.set(id, palm)
  }
  return palm
}

/** The model's muzzle (-X) onto the soldier's front (+Z), top staying up. */
const MUZZLE_FORWARD = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2)
/** How far the muzzle drops at low ready, when the arms hang. */
const LOW_READY = MathUtils.degToRad(40)
/**
 * The hand's height against the shoulder spans from about 0 with the weapon
 * raised to about -0.5 m with the arm hanging; this much below the shoulder
 * and the weapon is fully lowered.
 */
const RAISE_RANGE = 0.3

const handPosition = new Vector3()
const shoulderPosition = new Vector3()
const handQuaternion = new Quaternion()
const wanted = new Quaternion()
const pitch = new Quaternion()
const xAxis = new Vector3(1, 0, 0)
const origin = new Vector3()

/**
 * A weapon in a soldier's right hand.
 *
 * Parented to the hand bone so it moves with the arm, but its *orientation*
 * is not the hand's: the clips only agree on where the hand is, not which way
 * it faces, and a gun fixed to the palm points at the ground whenever the arm
 * hangs. So each frame the muzzle is turned to the soldier's front, level
 * when the hand is up at the shoulder and dropped to low ready as it falls,
 * and the grip is kept in the palm.
 */
export class HeldWeapon {
  private constructor(
    private readonly model: Group,
    private readonly id: WeaponId,
    private readonly root: Object3D,
    private readonly hand: Object3D,
    private readonly shoulder: Object3D,
  ) {
    model.scale.setScalar(WEAPON_SCALE)
    hand.add(model)
    this.update()
  }

  /**
   * Put `id`'s model in the right hand of the rig under `root`; undefined
   * when the rig has no arm or the model did not load.
   */
  static attach(root: Object3D, assets: Record<string, unknown>, id: WeaponId): HeldWeapon | undefined {
    const gltf = assets[`weapon-${id}`] as GLTF | undefined
    const hand = root.getObjectByName('hand_r')
    const shoulder = root.getObjectByName('upperarm_r')
    if (!gltf || !hand || !shoulder) return undefined
    return new HeldWeapon(gltf.scene.clone(true), id, root, hand, shoulder)
  }

  /** Re-pose against the arm as it now is. Call after the mixer has run. */
  update(): void {
    const { hand, shoulder, root, model } = this
    hand.updateWorldMatrix(true, false)
    shoulder.updateWorldMatrix(true, false)
    hand.getWorldPosition(handPosition)
    shoulder.getWorldPosition(shoulderPosition)
    const raised = MathUtils.clamp(1 + (handPosition.y - shoulderPosition.y) / RAISE_RANGE, 0, 1)

    root.getWorldQuaternion(wanted)
    wanted.multiply(pitch.setFromAxisAngle(xAxis, (1 - raised) * LOW_READY)).multiply(MUZZLE_FORWARD)

    // The palm, in the model's frame, rotated into the world, is where the
    // model's origin must sit relative to the hand.
    origin.copy(palmInModel(this.id)).multiplyScalar(-1)
    origin.applyQuaternion(wanted).add(handPosition)
    model.position.copy(hand.worldToLocal(origin))

    hand.getWorldQuaternion(handQuaternion)
    model.quaternion.copy(handQuaternion.invert().multiply(wanted))

    // Counter whatever girth the proportions put on the hand.
    const handScale = hand.getWorldScale(origin).x
    model.scale.setScalar(WEAPON_SCALE / (handScale || 1))
  }

  remove(): void {
    this.model.removeFromParent()
  }
}
