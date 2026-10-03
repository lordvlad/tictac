import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Faction } from '../config'
import type { Grid, Tile } from '../core/Grid'
import { Block, Side, StairDirection } from '../core/Grid'
import { WallKind } from '../core/Walls'
import type { Squads } from '../game/Squads'

const TILE_PX = 11
const WALL_PX = 3

interface DebugMapViewProps {
  grid: Grid
  squads: Squads
  activeLevelFilter: number
  seedLabel: string
  selectedLevelView: number | 'all'
  onSelectLevelView: (view: number | 'all') => void
  onClose: () => void
}

function LevelCanvas({
  grid,
  squads,
  level,
  size,
  dpr,
  drawLevel,
}: {
  grid: Grid
  squads: Squads
  level: number
  size: number
  dpr: number
  drawLevel: (ctx: CanvasRenderingContext2D, grid: Grid, squads: Squads, level: number, size: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cssPx = size * TILE_PX

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = cssPx * dpr
    canvas.height = cssPx * dpr
    canvas.style.width = `${cssPx}px`
    canvas.style.height = `${cssPx}px`
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.scale(dpr, dpr)
      ctx.imageSmoothingEnabled = false
      drawLevel(ctx, grid, squads, level, size)
    }
  }, [grid, squads, level, size, dpr, drawLevel, cssPx])

  return <canvas ref={canvasRef} className="debug-map-canvas" />
}

function DebugMapView({
  grid,
  squads,
  activeLevelFilter,
  seedLabel,
  selectedLevelView,
  onSelectLevelView,
  onClose,
}: DebugMapViewProps) {
  const maxLevel = grid.maxLevel
  const size = grid.size
  const dpr = Math.max(1, (typeof globalThis.devicePixelRatio === 'number' && globalThis.devicePixelRatio) || 1)

  const levelsToDraw =
    selectedLevelView === 'all'
      ? Array.from({ length: maxLevel + 1 }, (_, i) => i)
      : [selectedLevelView as number]

  return (
    <>
      <div className="debug-map-header">
        <div className="debug-map-title">
          <span>DEBUG MINIMAP</span>
          <span className="debug-map-seed">Seed: {seedLabel}</span>
        </div>
        <div className="debug-map-tabs">
          <button
            className={`debug-map-tab ${selectedLevelView === 'all' ? 'active' : ''}`}
            data-view="all"
            onClick={() => onSelectLevelView('all')}
          >
            ALL LEVELS
          </button>
          {Array.from({ length: maxLevel + 1 }, (_, l) => (
            <button
              key={l}
              className={`debug-map-tab ${selectedLevelView === l ? 'active' : ''}`}
              data-view={String(l)}
              onClick={() => onSelectLevelView(l)}
            >
              L{l}
            </button>
          ))}
        </div>
        <button className="debug-map-close-btn" title="Close Minimap (Esc)" onClick={onClose}>
          CLOSE &times;
        </button>
      </div>

      <div className="debug-map-levels">
        {levelsToDraw.map((level) => (
          <div
            key={level}
            className={`debug-map-card ${level === activeLevelFilter ? 'active' : ''}`}
          >
            <div className="debug-map-card-title">
              <span>
                LEVEL {level} {level === 0 ? '(Ground)' : level === maxLevel ? '(Top)' : ''}
              </span>
              {level === activeLevelFilter && <span className="active-badge">VIEWING IN 3D</span>}
            </div>
            <LevelCanvas
              grid={grid}
              squads={squads}
              level={level}
              size={size}
              dpr={dpr}
              drawLevel={DebugMap.drawLevel}
            />
          </div>
        ))}
      </div>

      <div className="debug-map-legend">
        <div className="legend-item"><span className="legend-box floor" />Floor</div>
        <div className="legend-item"><span className="legend-box wall-solid" />Solid Wall</div>
        <div className="legend-item"><span className="legend-box wall-parapet" />Parapet</div>
        <div className="legend-item"><span className="legend-box wall-glass" />Glass</div>
        <div className="legend-item"><span className="legend-box wall-door" />Door (dashed: open)</div>
        <div className="legend-item"><span className="legend-box wall-locked" />Locked Door</div>
        <div className="legend-item"><span className="legend-box crate" />Crate</div>
        <div className="legend-item"><span className="legend-box stair" />Stair (L&rarr;U)</div>
        <div className="legend-item"><span className="legend-box ladder" />Ladder</div>
        <div className="legend-item"><span className="legend-box roof" />Roof</div>
        <div className="legend-item"><span className="legend-box blue-unit" />Blue Squad</div>
        <div className="legend-item"><span className="legend-box red-unit" />Red Squad</div>
      </div>
    </>
  )
}

/**
 * 2D Debug Minimap showing all map levels with crisp pixel-perfect rendering.
 *
 * Marks every terrain feature, room boundary, crate, roof, and squad unit,
 * and explicitly draws stair orientation arrows from lower to upper access.
 */
export class DebugMap {
  private readonly root: HTMLElement
  private readonly reactRoot: Root
  private visible = false
  private selectedLevelView: number | 'all' = 'all'
  private keyListenerAttached = false
  private lastArgs: {
    grid: Grid
    squads: Squads
    activeLevelFilter: number
    seedLabel: string
  } | null = null

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'debug-map-panel'
    this.root.style.display = 'none'
    document.body.appendChild(this.root)
    this.reactRoot = createRoot(this.root)

    // Close on backdrop click (outside cards)
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close()
    })
  }

  get isOpen(): boolean {
    return this.visible
  }

  toggle(): boolean {
    if (this.visible) {
      this.close()
    } else {
      this.open()
    }
    return this.visible
  }

  open(): void {
    this.visible = true
    this.root.style.display = 'flex'
    this.attachKeyListener()
  }

  close(): void {
    this.visible = false
    this.root.style.display = 'none'
  }

  dispose(): void {
    this.detachKeyListener()
    this.reactRoot.unmount()
    this.root.remove()
  }

  private attachKeyListener(): void {
    if (this.keyListenerAttached) return
    globalThis.addEventListener('keydown', this.onKeyDown as EventListener)
    this.keyListenerAttached = true
  }

  private detachKeyListener(): void {
    if (!this.keyListenerAttached) return
    globalThis.removeEventListener('keydown', this.onKeyDown as EventListener)
    this.keyListenerAttached = false
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.visible) {
      e.preventDefault()
      e.stopPropagation()
      this.close()
    }
  }

  refresh(grid: Grid, squads: Squads, activeLevelFilter: number, seedLabel: string): void {
    this.lastArgs = { grid, squads, activeLevelFilter, seedLabel }
    if (!this.visible) return

    flushSync(() => {
      this.reactRoot.render(
        <DebugMapView
          grid={grid}
          squads={squads}
          activeLevelFilter={activeLevelFilter}
          seedLabel={seedLabel}
          selectedLevelView={this.selectedLevelView}
          onSelectLevelView={(view) => {
            this.selectedLevelView = view
            if (this.lastArgs) {
              this.refresh(
                this.lastArgs.grid,
                this.lastArgs.squads,
                this.lastArgs.activeLevelFilter,
                this.lastArgs.seedLabel,
              )
            }
          }}
          onClose={() => this.close()}
        />,
      )
    })
  }

  static drawLevel(
    ctx: CanvasRenderingContext2D,
    grid: Grid,
    squads: Squads,
    level: number,
    size: number,
  ): void {
    // 1. Background & Floor Tiles
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = x * TILE_PX
        const py = y * TILE_PX
        const tileLevel = grid.levelAt(x, y)
        const block = grid.blockAt(x, y)
        const walkable = grid.isWalkable(x, y)

        if (!walkable && block !== Block.Stair) {
          ctx.fillStyle = '#0f172a'
        } else if (tileLevel === level) {
          ctx.fillStyle = '#334155'
        } else if (tileLevel < level) {
          ctx.fillStyle = '#1e293b'
        } else {
          ctx.fillStyle = '#475569'
        }
        ctx.fillRect(px, py, TILE_PX, TILE_PX)

        // Grid lines for this level's walkable tiles
        if (tileLevel === level && walkable) {
          ctx.strokeStyle = '#475569'
          ctx.lineWidth = 1
          ctx.strokeRect(px + 0.5, py + 0.5, TILE_PX - 1, TILE_PX - 1)
        }

        // Crates
        if (block === Block.Half && tileLevel === level) {
          ctx.fillStyle = '#d97706'
          ctx.fillRect(px + 2, py + 2, TILE_PX - 4, TILE_PX - 4)
        }

        // Roof indicators
        if (grid.roofAt(x, y) === level) {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.25)'
          ctx.fillRect(px, py, TILE_PX, TILE_PX)
        }

        // Stairs (Lower floor access point)
        if (block === Block.Stair && tileLevel === level) {
          ctx.fillStyle = '#8b5cf6'
          ctx.fillRect(px + 1, py + 1, TILE_PX - 2, TILE_PX - 2)

          // Arrow indicating direction towards upper landing
          ctx.fillStyle = '#ffffff'
          ctx.beginPath()
          const dir = grid.stairDirectionAt(x, y)
          const cx = px + TILE_PX / 2
          const cy = py + TILE_PX / 2
          if (dir === StairDirection.North) {
            ctx.moveTo(cx, cy - 3)
            ctx.lineTo(cx - 2.5, cy + 2)
            ctx.lineTo(cx + 2.5, cy + 2)
          } else if (dir === StairDirection.South) {
            ctx.moveTo(cx, cy + 3)
            ctx.lineTo(cx - 2.5, cy - 2)
            ctx.lineTo(cx + 2.5, cy - 2)
          } else if (dir === StairDirection.East) {
            ctx.moveTo(cx + 3, cy)
            ctx.lineTo(cx - 2, cy - 2.5)
            ctx.lineTo(cx - 2, cy + 2.5)
          } else if (dir === StairDirection.West) {
            ctx.moveTo(cx - 3, cy)
            ctx.lineTo(cx + 2, cy - 2.5)
            ctx.lineTo(cx + 2, cy + 2.5)
          }
          ctx.fill()
        }
      }
    }

    // 2. Walls on this level
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = x * TILE_PX
        const py = y * TILE_PX
        const tileLevel = grid.levelAt(x, y)
        if (tileLevel !== level) continue

        // North wall
        const nWall = grid.wallAt(x, y, Side.North)
        if (nWall !== WallKind.None) {
          DebugMap.drawWallSegment(ctx, px, py, px + TILE_PX, py, nWall)
        }

        // West wall
        const wWall = grid.wallAt(x, y, Side.West)
        if (wWall !== WallKind.None) {
          DebugMap.drawWallSegment(ctx, px, py, px, py + TILE_PX, wWall)
        }

        // South boundary
        if (y === size - 1) {
          const sWall = grid.wallAt(x, y, Side.South)
          if (sWall !== WallKind.None) {
            DebugMap.drawWallSegment(ctx, px, py + TILE_PX, px + TILE_PX, py + TILE_PX, sWall)
          }
        }

        // East boundary
        if (x === size - 1) {
          const eWall = grid.wallAt(x, y, Side.East)
          if (eWall !== WallKind.None) {
            DebugMap.drawWallSegment(ctx, px + TILE_PX, py, px + TILE_PX, py + TILE_PX, eWall)
          }
        }
      }
    }

    // 3. Units on this level
    if (squads && squads.soldiers) {
      for (const soldier of squads.soldiers) {
        if (soldier.isDead) continue
        const tile = soldier.tile as Tile
        if (!tile) continue
        if (grid.levelAt(tile.x, tile.y) !== level) continue

        const cx = tile.x * TILE_PX + TILE_PX / 2
        const cy = tile.y * TILE_PX + TILE_PX / 2

        ctx.fillStyle = soldier.faction === Faction.Blue ? '#38bdf8' : '#f87171'
        ctx.beginPath()
        ctx.arc(cx, cy, TILE_PX / 2 - 1.5, 0, Math.PI * 2)
        ctx.fill()

        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
  }

  private static drawWallSegment(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    kind: WallKind,
  ): void {
    ctx.save()
    ctx.lineWidth = WALL_PX

    if (kind === WallKind.Solid) {
      ctx.strokeStyle = '#94a3b8'
      ctx.setLineDash([])
    } else if (kind === WallKind.Parapet) {
      ctx.strokeStyle = '#10b981'
      ctx.setLineDash([])
    } else if (kind === WallKind.Glass) {
      ctx.strokeStyle = '#06b6d4'
      ctx.setLineDash([])
    } else if (kind === WallKind.Door) {
      ctx.strokeStyle = '#f59e0b'
      ctx.setLineDash([3, 2])
    } else if (kind === WallKind.Locked) {
      ctx.strokeStyle = '#ef4444'
      ctx.setLineDash([])
    }

    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.restore()
  }
}
