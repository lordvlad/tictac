import type { Object3D } from 'three'
import type { CharacterAppearance } from '../core/Characters'

/**
 * Apply anatomical proportions (height, shoulder width, gut / waist circumference,
 * chest girth, and limb thickness) directly to a character model skeletal hierarchy.
 */
export function applyCharacterProportions(model: Object3D, appearance?: CharacterAppearance): void {
  if (!appearance) return

  // Stature (height) and overall lateral width
  model.scale.set(appearance.width, appearance.height, 1)

  const s1 = model.getObjectByName('spine_01')
  const s3 = model.getObjectByName('spine_03')
  const head = model.getObjectByName('Head')

  const armL = model.getObjectByName('upperarm_l')
  const armR = model.getObjectByName('upperarm_r')
  const foreL = model.getObjectByName('lowerarm_l')
  const foreR = model.getObjectByName('lowerarm_r')
  const handL = model.getObjectByName('hand_l')
  const handR = model.getObjectByName('hand_r')

  const thighL = model.getObjectByName('thigh_l')
  const thighR = model.getObjectByName('thigh_r')
  const calfL = model.getObjectByName('calf_l')
  const calfR = model.getObjectByName('calf_r')
  const footL = model.getObjectByName('foot_l')
  const footR = model.getObjectByName('foot_r')

  const gut = appearance.gut ?? appearance.bulkiness
  const bulk = appearance.bulkiness

  // Gut & Belly: spine_01 (X width, Z depth)
  if (s1) {
    s1.scale.set(gut, 1.0, gut * 1.08)
  }

  // Chest & Upper Torso: spine_03 (normalized relative to spine_01 parent)
  if (s3 && s1) {
    const relChestX = bulk / gut
    const relChestZ = (bulk * 0.95) / (gut * 1.08)
    s3.scale.set(relChestX, 1.0, relChestZ)
  }

  // Head: counter-scale so head stays natural size rather than ballooning with torso
  if (head && s3 && s1) {
    head.scale.set(1 / bulk, 1.0, 1 / (bulk * 0.95))
  }

  // Arms: muscular girth on upper and lower arms, counter-scaled on hands
  if (armL) armL.scale.set(bulk, 1.0, bulk)
  if (armR) armR.scale.set(bulk, 1.0, bulk)
  if (foreL) foreL.scale.set(bulk, 1.0, bulk)
  if (foreR) foreR.scale.set(bulk, 1.0, bulk)
  if (handL) handL.scale.set(1 / bulk, 1.0, 1 / bulk)
  if (handR) handR.scale.set(1 / bulk, 1.0, 1 / bulk)

  // Legs: limb circumference proportional to bulk + heaviness
  const legScale = (bulk + gut * 0.5) / 1.5
  if (thighL) thighL.scale.set(legScale, 1.0, legScale)
  if (thighR) thighR.scale.set(legScale, 1.0, legScale)
  if (calfL) calfL.scale.set(legScale, 1.0, legScale)
  if (calfR) calfR.scale.set(legScale, 1.0, legScale)
  if (footL) footL.scale.set(1 / legScale, 1.0, 1 / legScale)
  if (footR) footR.scale.set(1 / legScale, 1.0, 1 / legScale)
}
