import { AmbientLight, Color, DirectionalLight, Fog, HemisphereLight } from 'three'
import type { EngineContext } from '../engine'
import type { Faction } from '../config'
import type { Grid, Tile } from '../core/Grid'
import type { GeneratedMap } from '../core/MapGenerator'
import { Blocks } from '../render/Blocks'
import { Ground } from '../render/Ground'

/**
 * The terrain, as drawn: floor, obstacles, sky and lighting.
 *
 * Takes the map rather than generating one. The terrain itself is
 * {@link GeneratedMap} - a grid and two sets of spawns, no meshes - and a
 * simulation or a replay uses exactly that without ever reaching this far. What
 * lives here is only the part that needs a scene, which is why it is the view
 * of a map and not the map.
 */
export class Battlefield {
  readonly grid: Grid
  readonly ground: Ground
  readonly blocks: Blocks
  readonly spawns: Record<Faction, Tile[]>

  private readonly sun: DirectionalLight
  private readonly ambient: AmbientLight
  private readonly hemisphere: HemisphereLight
  /** What the scene had before this drew over it, put back on dispose. */
  private readonly previousBackground: EngineContext['scene']['background']
  private readonly previousFog: EngineContext['scene']['fog']

  constructor(
    map: GeneratedMap,
    private readonly engine: EngineContext,
  ) {
    this.grid = map.grid
    this.spawns = map.spawns

    this.ground = new Ground(this.grid)
    this.blocks = new Blocks(this.grid)

    const scene = this.engine.scene
    scene.add(this.ground.mesh)
    scene.add(this.blocks.group)

    this.previousBackground = scene.background
    this.previousFog = scene.fog
    const sky = new Color(0x05070a)
    scene.background = sky
    scene.fog = new Fog(sky.getHex(), 50, 110)

    this.ambient = new AmbientLight(0xffffff, 0.5)
    this.hemisphere = new HemisphereLight(0x9fc4ff, 0x30281f, 0.55)
    scene.add(this.ambient)
    scene.add(this.hemisphere)

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
    scene.remove(this.sun, this.sun.target, this.ambient, this.hemisphere)
    this.sun.shadow.dispose()
    // Lights add up and the sky is whatever was set last, so a rebuild that
    // left these behind would be brighter every time.
    scene.background = this.previousBackground
    scene.fog = this.previousFog
    this.ground.dispose()
    this.blocks.dispose()
  }
}
