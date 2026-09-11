import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { Block, Grid, Side } from '../src/core/Grid'
import { WallKind } from '../src/core/Walls'
import { VisState } from '../src/core/Visibility'
import { Blocks } from '../src/render/Blocks'

/**
 * A two-storey scrap of map: an upper floor with a roof over it, a wall on that
 * floor, and a crate on the ground.
 */
function scene(): { grid: Grid; blocks: Blocks } {
  const grid = new Grid(8)
  for (let x = 2; x <= 4; x++) {
    for (let y = 2; y <= 4; y++) {
      grid.setLevel(x, y, 1)
      grid.setRoof(x, y, 2)
    }
  }
  grid.setWall(3, 3, Side.North, WallKind.Solid)
  grid.setBlock(6, 6, Block.Half)
  return { grid, blocks: new Blocks(grid) }
}

interface LayerProbe {
  mesh: { userData: { type?: string } }
  instances: { x: number; y: number; index: number }[]
  fade: { array: Float32Array }
}

/**
 * The layer list is private, and deliberately so — but `fade` is the channel
 * the shader reads, and asserting on anything else would not be the contract.
 */
function layers(blocks: Blocks): LayerProbe[] {
  const probe = blocks as unknown as { layers: LayerProbe[] }
  return probe.layers
}

function fadesOf(blocks: Blocks, type: string): number[] {
  return layers(blocks)
    .filter((layer) => layer.mesh.userData.type === type)
    .flatMap((layer) => layer.instances.map((inst) => Number(layer.fade.array[inst.index]!.toFixed(2))))
}

/** Distinct fade values, sorted, so a failure names what leaked. */
function distinctFades(blocks: Blocks, type: string): number[] {
  return [...new Set(fadesOf(blocks, type))].sort((a, b) => a - b)
}

/** One VisState byte per tile. */
function visibility(grid: Grid, state: VisState): Uint8Array {
  return new Uint8Array(grid.size * grid.size).fill(state)
}

/** Straight through the wall on the north face of (3,3), at body height. */
function throughTheWall(grid: Grid, blocks: Blocks, opacity: number): void {
  blocks.beginOcclusionFade()
  blocks.addOcclusionRay(
    new Vector3(grid.worldX(3), 1.8, grid.worldZ(1)),
    new Vector3(grid.worldX(3), 0.2, grid.worldZ(4)),
  )
  blocks.commitOcclusionFade(opacity)
}

describe('Block fade composition', () => {
  test('the level filter lifts the storey above out of the way', () => {
    const { grid, blocks } = scene()
    blocks.applyVisibility(visibility(grid, VisState.Visible))

    blocks.setLevelFilter(0)

    // Walls of the storey above stay as ghosts: they read as room layout.
    expect(distinctFades(blocks, 'wall')).toEqual([0.15, 1])
    // Its ceiling goes entirely — ghosted, it only hazes the room below, and
    // fog would bring it in a tile at a time as a patchwork.
    expect(distinctFades(blocks, 'roof')).toEqual([0])
  })

  /**
   * The regression this file exists for. Fog, the level filter and the x-ray
   * used to write the same per-instance channel directly, so whichever ran last
   * won: walking recomputes fog 30 times a second, and each pass turned the
   * storey above opaque again — a ceiling that flickered while a unit moved and
   * stayed patchy whenever the camera was too steep for the x-ray to run.
   */
  test('a visibility pass does not undo the level filter', () => {
    const { grid, blocks } = scene()
    blocks.setLevelFilter(0)

    blocks.applyVisibility(visibility(grid, VisState.Visible))

    expect(distinctFades(blocks, 'wall')).toEqual([0.15, 1])
    expect(distinctFades(blocks, 'roof')).toEqual([0])
  })

  test('an unexplored block stays hidden through filter and x-ray passes', () => {
    const { grid, blocks } = scene()
    blocks.setLevelFilter(0)
    blocks.applyVisibility(visibility(grid, VisState.Unknown))

    expect(distinctFades(blocks, 'wall')).toEqual([0])

    // An x-ray pass must not reveal what the player has never seen.
    throughTheWall(grid, blocks, 0.2)

    expect(distinctFades(blocks, 'wall')).toEqual([0])
  })

  test('the x-ray fades a marked wall, and gives it back once the pass clears', () => {
    const { grid, blocks } = scene()
    blocks.applyVisibility(visibility(grid, VisState.Visible))
    expect(distinctFades(blocks, 'wall')).toEqual([1])

    throughTheWall(grid, blocks, 0.2)
    expect(fadesOf(blocks, 'wall')).toContain(0.2)

    blocks.clearOcclusionFade()
    expect(distinctFades(blocks, 'wall')).toEqual([1])
  })

  test('fog outranks the x-ray on the same instance', () => {
    const { grid, blocks } = scene()
    const values = visibility(grid, VisState.Visible)
    // Hide the wall's own tile and the one beyond it, so the wall is unknown.
    values[grid.index(3, 3)] = VisState.Unknown
    values[grid.index(3, 2)] = VisState.Unknown
    blocks.applyVisibility(values)

    throughTheWall(grid, blocks, 0.2)

    const marked = layers(blocks)
      .filter((layer) => layer.mesh.userData.type === 'wall')
      .flatMap((layer) =>
        layer.instances
          .filter((inst) => inst.x === 3 && inst.y === 3)
          .map((inst) => layer.fade.array[inst.index]),
      )

    expect(marked.length).toBeGreaterThan(0)
    expect(marked.every((value) => value === 0)).toBe(true)
  })
})
