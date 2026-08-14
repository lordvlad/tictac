/**
 * Builds public/character.glb from the vendored Quaternius Universal Animation
 * Library source (CC0, see assets/UAL1_LICENSE.txt).
 *
 * The source ships 43 clips but the mesh is only ~13.7k triangles, so almost
 * all of the 7.27 MB is animation data. We keep a whitelist and drop the rest.
 *
 * Clips are renamed to the keys the game looks up, because the engine maps
 * animations by their verbatim glTF name:
 *   Entity3D.js: model.animations.forEach(a => animationsMap.set(a.name, ...))
 * A missing key returns undefined silently and leaves the soldier in bind pose,
 * so the names here must stay in sync with src/entities/Soldier.ts.
 */
import { NodeIO, PropertyType } from '@gltf-transform/core'
import { prune } from '@gltf-transform/functions'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { statSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(here, '../assets/UAL1_Standard.glb')
const DST = resolve(here, '../public/character.glb')

/** source clip name -> key used by the game */
const KEEP = {
  Idle_Loop: 'idle',
  Walk_Loop: 'walk',
  Jog_Fwd_Loop: 'run',
  Crouch_Idle_Loop: 'crouch',
  Crouch_Fwd_Loop: 'crouchWalk',
  Pistol_Idle_Loop: 'aim',
  Pistol_Shoot: 'shoot',
  Pistol_Reload: 'reload',
  Hit_Chest: 'hit',
  Death01: 'death',
}

const io = new NodeIO()
const doc = await io.read(SRC)
const root = doc.getRoot()

const seen = new Set()
for (const anim of root.listAnimations()) {
  const name = anim.getName()
  const key = KEEP[name]
  if (key) {
    seen.add(name)
    anim.setName(key)
  } else {
    // Disposing the Animation only detaches its channels/samplers; the orphaned
    // samplers keep referencing their input/output accessors, so prune() would
    // still consider that keyframe data live. Dispose the children explicitly.
    for (const channel of anim.listChannels()) channel.dispose()
    for (const sampler of anim.listSamplers()) sampler.dispose()
    anim.dispose()
  }
}

const missing = Object.keys(KEEP).filter((n) => !seen.has(n))
if (missing.length) {
  console.error(`error: clips not found in source: ${missing.join(', ')}`)
  process.exit(1)
}

// Only prune accessors. Pruning nodes/meshes risks dropping skeleton joints
// that are referenced by the skin but not otherwise "used".
await doc.transform(prune({ propertyTypes: [PropertyType.ACCESSOR] }))

await io.write(DST, doc)

const before = statSync(SRC).size
const after = statSync(DST).size
const mb = (n) => (n / 1024 / 1024).toFixed(2)
console.log(
  `character.glb: ${root.listAnimations().length} clips, ` +
    `${mb(before)} MB -> ${mb(after)} MB (${Math.round((1 - after / before) * 100)}% smaller)`,
)
console.log(`clips: ${root.listAnimations().map((a) => a.getName()).sort().join(', ')}`)
