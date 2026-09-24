import { AdditiveBlending, CanvasTexture, Group, Sprite, SpriteMaterial } from 'three'
import { LEVEL_HEIGHT } from '../config'
import type { Grid } from '../core/Grid'
import type { EngineContext } from '../engine'

/** Flame sprites per burning tile: enough to read as a fire, few enough to draw a burning room. */
const FLAMES_PER_TILE = 3

interface Flame {
  sprite: Sprite
  /** Where in its flicker this flame is, so a tile's flames do not pulse together. */
  phase: number
  baseY: number
  size: number
}

/**
 * Fire on the ground, as the grid says it is.
 *
 * Strictly a view: {@link sync} reads which tiles are burning off the grid
 * (`GroundSystem` keeps it) and adds or removes a tile's flames to match, and
 * {@link update} flickers them. Nothing here decides anything, and nothing
 * here keeps a clock of its own — a fire is on screen exactly while the rules
 * say the tile is burning.
 */
export class GroundFx {
  private readonly group = new Group()
  private readonly flames = new Map<number, Flame[]>()
  private flameTexture: CanvasTexture | null = null
  private time = 0

  constructor(
    private readonly engine: EngineContext,
    private readonly grid: Grid,
  ) {
    this.group.name = 'ground-fx'
    engine.scene.add(this.group)
  }

  /** Match the flames on screen to the tiles that are burning. */
  sync(): void {
    const { grid } = this
    for (const [index, flames] of this.flames) {
      if (grid.fire[index]! > 0) continue
      for (const flame of flames) this.drop(flame)
      this.flames.delete(index)
    }
    for (let index = 0; index < grid.fire.length; index++) {
      if (grid.fire[index]! === 0 || this.flames.has(index)) continue
      const x = index % grid.size
      const y = (index / grid.size) | 0
      const floor = grid.levelAt(x, y) * LEVEL_HEIGHT
      const flames: Flame[] = []
      for (let i = 0; i < FLAMES_PER_TILE; i++) {
        const sprite = new Sprite(
          new SpriteMaterial({
            map: this.texture(),
            transparent: true,
            blending: AdditiveBlending,
            depthWrite: false,
          }),
        )
        // Spread over the tile so a burning floor reads as a floor on fire.
        sprite.position.set(grid.worldX(x) + (i - 1) * 0.28, floor, grid.worldZ(y) + ((i * 37) % 3 - 1) * 0.22)
        const size = 0.7 + ((index + i * 13) % 5) * 0.08
        this.group.add(sprite)
        flames.push({ sprite, phase: (index * 7 + i * 3) % 11, baseY: floor + size * 0.45, size })
      }
      this.flames.set(index, flames)
    }
  }

  /** Flicker. Presentation only, so it may use its own clock. */
  update(delta: number): void {
    this.time += delta
    for (const flames of this.flames.values()) {
      for (const flame of flames) {
        const t = this.time * 7 + flame.phase
        const flicker = 0.85 + 0.15 * Math.sin(t) * Math.sin(t * 1.7)
        flame.sprite.scale.set(flame.size * flicker, flame.size * (1.2 + 0.25 * Math.sin(t * 1.3)), 1)
        flame.sprite.position.y = flame.baseY + 0.05 * Math.sin(t * 0.9)
        flame.sprite.material.opacity = 0.75 + 0.25 * flicker
      }
    }
  }

  private drop(flame: Flame): void {
    this.group.remove(flame.sprite)
    flame.sprite.material.dispose()
  }

  private texture(): CanvasTexture {
    if (this.flameTexture) return this.flameTexture
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size * 0.62, 0, size / 2, size * 0.62, size / 2)
    grad.addColorStop(0, 'rgba(255, 240, 170, 1)')
    grad.addColorStop(0.35, 'rgba(255, 150, 40, 0.85)')
    grad.addColorStop(0.7, 'rgba(210, 60, 10, 0.35)')
    grad.addColorStop(1, 'rgba(120, 20, 0, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    this.flameTexture = new CanvasTexture(canvas)
    return this.flameTexture
  }

  dispose(): void {
    for (const flames of this.flames.values()) for (const flame of flames) this.drop(flame)
    this.flames.clear()
    this.engine.scene.remove(this.group)
    this.flameTexture?.dispose()
  }
}
