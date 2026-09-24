import { AdditiveBlending, CanvasTexture, Group, NormalBlending, Sprite, SpriteMaterial } from 'three'
import { FX, LEVEL_HEIGHT } from '../config'
import type { Grid } from '../core/Grid'
import type { EngineContext } from '../engine'

/** Sprites per tile: enough to read as a fire or a cloud, few enough to draw a burning room. */
const PER_TILE = 3

interface Mote {
  sprite: Sprite
  /** Where in its motion this one is, so a tile's sprites do not move together. */
  phase: number
  baseY: number
  size: number
}

/** One kind of thing on the ground: which tiles have it, and how it is drawn. */
interface Layer {
  motes: Map<number, Mote[]>
  /** The grid's per-tile count for it: turns left burning, or of smoke. */
  of: (grid: Grid) => Uint8Array
  texture: () => CanvasTexture
  blending: typeof AdditiveBlending | typeof NormalBlending
  /** Height of a sprite's centre above the floor, per metre of its size. */
  rise: number
  size: (seed: number) => number
}

/**
 * Fire and smoke on the ground, as the grid says they are.
 *
 * Strictly a view: {@link sync} reads which tiles are burning and which are
 * smoky off the grid (`GroundSystem` keeps it) and adds or removes a tile's
 * sprites to match, and {@link update} moves them. Nothing here decides
 * anything, and nothing here keeps a clock of its own — a fire or a cloud is
 * on screen exactly while the rules say it is there.
 */
export class GroundFx {
  private readonly group = new Group()
  private flameTexture: CanvasTexture | null = null
  private smokeTexture: CanvasTexture | null = null
  private time = 0
  private readonly flames: Layer = {
    motes: new Map(),
    of: (grid) => grid.fire,
    texture: () => (this.flameTexture ??= gradient([[0, '255,240,170,1'], [0.35, '255,150,40,0.85'], [0.7, '210,60,10,0.35'], [1, '120,20,0,0']], 0.62)),
    blending: AdditiveBlending,
    rise: 0.45,
    size: (seed) => 0.7 + (seed % 5) * 0.08,
  }
  private readonly smoke: Layer = {
    motes: new Map(),
    of: (grid) => grid.smoke,
    texture: () => (this.smokeTexture ??= gradient([[0, '70,72,76,0.8'], [0.4, '66,68,72,0.55'], [0.75, '60,62,66,0.15'], [1, '60,62,66,0']], 0.5)),
    blending: NormalBlending,
    rise: 0.9,
    size: (seed) => FX.smokeSpriteSize * (1 + (seed % 4) * 0.15),
  }

  constructor(
    private readonly engine: EngineContext,
    private readonly grid: Grid,
  ) {
    this.group.name = 'ground-fx'
    engine.scene.add(this.group)
  }

  /** Match what is on screen to what the grid says is burning and smoky. */
  sync(): void {
    this.syncLayer(this.flames)
    this.syncLayer(this.smoke)
  }

  private syncLayer(layer: Layer): void {
    const { grid } = this
    const values = layer.of(grid)
    for (const [index, motes] of layer.motes) {
      if (values[index]! > 0) continue
      for (const mote of motes) this.drop(mote)
      layer.motes.delete(index)
    }
    for (let index = 0; index < values.length; index++) {
      if (values[index]! === 0 || layer.motes.has(index)) continue
      const x = index % grid.size
      const y = (index / grid.size) | 0
      const floor = grid.levelAt(x, y) * LEVEL_HEIGHT
      const motes: Mote[] = []
      for (let i = 0; i < PER_TILE; i++) {
        const sprite = new Sprite(
          new SpriteMaterial({ map: layer.texture(), transparent: true, blending: layer.blending, depthWrite: false }),
        )
        // Spread over the tile, so a burning floor reads as a floor on fire.
        sprite.position.set(grid.worldX(x) + (i - 1) * 0.28, floor, grid.worldZ(y) + (((i * 37) % 3) - 1) * 0.22)
        const size = layer.size(index + i * 13)
        this.group.add(sprite)
        motes.push({ sprite, phase: (index * 7 + i * 3) % 11, baseY: floor + size * layer.rise, size })
      }
      layer.motes.set(index, motes)
    }
  }

  /** Flicker the flames and roll the smoke. Presentation only, so it may use its own clock. */
  update(delta: number): void {
    this.time += delta
    for (const motes of this.flames.motes.values()) {
      for (const flame of motes) {
        const t = this.time * 7 + flame.phase
        const flicker = 0.85 + 0.15 * Math.sin(t) * Math.sin(t * 1.7)
        flame.sprite.scale.set(flame.size * flicker, flame.size * (1.2 + 0.25 * Math.sin(t * 1.3)), 1)
        flame.sprite.position.y = flame.baseY + 0.05 * Math.sin(t * 0.9)
        flame.sprite.material.opacity = 0.75 + 0.25 * flicker
      }
    }
    for (const motes of this.smoke.motes.values()) {
      for (const puff of motes) {
        const t = this.time * 0.6 + puff.phase
        puff.sprite.scale.set(puff.size * (1 + 0.08 * Math.sin(t)), puff.size * (1 + 0.08 * Math.cos(t)), 1)
        puff.sprite.position.y = puff.baseY + 0.12 * Math.sin(t * 0.7)
        puff.sprite.material.rotation = t * 0.2
      }
    }
  }

  private drop(mote: Mote): void {
    this.group.remove(mote.sprite)
    mote.sprite.material.dispose()
  }

  dispose(): void {
    for (const layer of [this.flames, this.smoke]) {
      for (const motes of layer.motes.values()) for (const mote of motes) this.drop(mote)
      layer.motes.clear()
    }
    this.engine.scene.remove(this.group)
    this.flameTexture?.dispose()
    this.smokeTexture?.dispose()
  }
}

/** A soft round sprite: colour stops as `r,g,b,a`, centred `centreY` of the way down. */
function gradient(stops: readonly [number, string][], centreY: number): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size / 2, size * centreY, 0, size / 2, size * centreY, size / 2)
  for (const [at, rgba] of stops) grad.addColorStop(at, `rgba(${rgba})`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}
