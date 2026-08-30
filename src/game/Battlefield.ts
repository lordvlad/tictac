import { AmbientLight, Color, DirectionalLight, Fog, HemisphereLight } from 'three'
import type { EngineContext } from '../engine'
import type { Faction } from '../config'
import type { Grid, Tile } from '../core/Grid'
import { generateMap } from '../core/MapGenerator'
import { Blocks } from '../render/Blocks'
import { Ground } from '../render/Ground'

/**
 * Static battlefield: terrain grid plus its rendering (floor, obstacles,
 * lighting). Owns nothing that changes between turns except the fog textures.
 */
export class Battlefield {
  readonly grid: Grid
  readonly ground: Ground
  readonly blocks: Blocks
  readonly spawns: Record<Faction, Tile[]>

  private readonly sun: DirectionalLight

  constructor(
    seed: number,
    private readonly engine: EngineContext,
  ) {
    const generated = generateMap(seed)
    this.grid = generated.grid
    this.spawns = generated.spawns

    this.ground = new Ground(this.grid)
    this.blocks = new Blocks(this.grid)

    const scene = this.engine.scene
    scene.add(this.ground.mesh)
    scene.add(this.blocks.group)

    const sky = new Color(0x05070a)
    scene.background = sky
    scene.fog = new Fog(sky.getHex(), 50, 110)

    scene.add(new AmbientLight(0xffffff, 0.5))
    scene.add(new HemisphereLight(0x9fc4ff, 0x30281f, 0.55))

    const sun = new DirectionalLight(0xfff1d8, 1.6)
    sun.position.set(24, 38, 18)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 120
    const extent = this.grid.halfExtent + 4
    sun.shadow.camera.left = -extent
    sun.shadow.camera.right = extent
    sun.shadow.camera.top = extent
    sun.shadow.camera.bottom = -extent
    sun.shadow.normalBias = 0.04
    sun.shadow.bias = -0.0005
    scene.add(sun)
    scene.add(sun.target)
    this.sun = sun

    // Start fully revealed; the visibility system takes over on the first pass.
    this.ground.revealAll()
    this.blocks.revealAll()
  }

  /** Push any dirty overlay/fog textures to the GPU. Call once per frame. */
  flush(): void {
    this.ground.flush()
  }

  dispose(): void {
    const scene = this.engine.scene
    scene.remove(this.ground.mesh)
    scene.remove(this.blocks.group)
    scene.remove(this.sun)
    this.ground.dispose()
    this.blocks.dispose()
  }
}
