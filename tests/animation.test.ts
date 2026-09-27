import { describe, expect, test } from 'bun:test'
import { AnimationMixer, LoopOnce, LoopRepeat, type Object3D, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { additiveClips } from '../src/render/SoldierView'

/**
 * The body, without a scene to put it in.
 *
 * `GLTFLoader.parseAsync` needs no canvas for a mesh with no textures, so the
 * one thing that was previously only checkable by eye — whether a crouching
 * soldier stands up to fire — is checkable here: play the clips on a mixer and
 * ask the skeleton where its feet are.
 */
const gltf = await new GLTFLoader().parseAsync(await Bun.file('public/character.glb').arrayBuffer(), '')

/**
 * Every clip the view can ask for. A missing one is silent — `animationsMap`
 * returns undefined and the soldier holds whatever it was doing — so the asset
 * and `scripts/build-character.mjs` are pinned here rather than discovered in a
 * browser.
 */
const PLAYED = [
  'idle',
  'crouch',
  'run',
  'crouchWalk',
  'aim',
  'shoot',
  'hit',
  'reload',
  'punch',
  'swing',
  'throw',
  'interact',
  'death',
]

/** A crouching body on its own mixer, holding the crouch loop. */
function crouchingRig(): { root: Object3D; mixer: AnimationMixer } {
  const root = clone(gltf.scene)
  const mixer = new AnimationMixer(root)
  const crouch = mixer.clipAction(gltf.animations.find((c) => c.name === 'crouch')!)
  crouch.setLoop(LoopRepeat, Infinity)
  crouch.play()
  return { root, mixer }
}

function boneAt(root: Object3D, name: string): Vector3 {
  root.updateMatrixWorld(true)
  return new Vector3().setFromMatrixPosition(root.getObjectByName(name)!.matrixWorld)
}

describe('The shipped character asset', () => {
  test('carries every clip the view plays, and nothing it does not', () => {
    const shipped = gltf.animations.map((clip) => clip.name).sort()
    expect(shipped).toEqual([...PLAYED].sort())
  })
})

describe('Upper-body overlays', () => {
  test('touch no bone the stance owns', () => {
    const overlays = additiveClips(gltf)
    expect(overlays.size).toBeGreaterThan(0)
    for (const [key, clip] of overlays) {
      expect(clip.tracks.length).toBeGreaterThan(0)
      const stanceTracks = clip.tracks.filter((track) =>
        /^(root|pelvis|thigh_|calf_|foot_|ball_)/.test(track.name),
      )
      expect(`${key}: ${stanceTracks.map((t) => t.name).join(', ')}`).toBe(`${key}: `)
    }
  })

  test('firing from a crouch moves the gun hand and not the feet', () => {
    const firing = crouchingRig()
    const holding = crouchingRig()
    firing.mixer.update(0.4)
    holding.mixer.update(0.4)

    const shoot = firing.mixer.clipAction(additiveClips(gltf).get('shoot')!)
    shoot.setLoop(LoopOnce, 1)
    shoot.clampWhenFinished = true
    shoot.setEffectiveWeight(1).play()

    firing.mixer.update(0.3)
    holding.mixer.update(0.3)

    // The same crouch, at the same moment of it, in both bodies: any difference
    // in the legs is the overlay reaching where it must not.
    expect(boneAt(firing.root, 'foot_l').distanceTo(boneAt(holding.root, 'foot_l'))).toBeCloseTo(0, 9)
    expect(boneAt(firing.root, 'pelvis').distanceTo(boneAt(holding.root, 'pelvis'))).toBeCloseTo(0, 9)
    expect(boneAt(firing.root, 'hand_r').distanceTo(boneAt(holding.root, 'hand_r'))).toBeGreaterThan(0.1)
  })

  test('a crouched watch holds a pose without straightening the legs', () => {
    const watching = crouchingRig()
    const holding = crouchingRig()
    watching.mixer.update(0.2)
    holding.mixer.update(0.2)

    const aim = watching.mixer.clipAction(additiveClips(gltf).get('aim')!)
    aim.setLoop(LoopRepeat, Infinity)
    aim.setEffectiveWeight(1).play()

    watching.mixer.update(0.5)
    holding.mixer.update(0.5)

    expect(boneAt(watching.root, 'foot_r').distanceTo(boneAt(holding.root, 'foot_r'))).toBeCloseTo(0, 9)
    expect(boneAt(watching.root, 'hand_r').distanceTo(boneAt(holding.root, 'hand_r'))).toBeGreaterThan(0.1)
  })
})
