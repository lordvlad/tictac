import type { Grid, Tile } from '../core/Grid'
import { Block, Side, StairDirection } from '../core/Grid'
import { WallKind } from '../core/Walls'
import type { Squads } from '../game/Squads'
import { Faction } from '../config'

const TILE_PX = 11
const WALL_PX = 3

/**
 * 2D Debug Minimap showing all map levels with crisp pixel-perfect rendering.
 *
 * Marks every terrain feature, room boundary, crate, roof, and squad unit,
 * and explicitly draws stair orientation arrows from lower to upper access.
 */
export class DebugMap {
  private readonly root: HTMLElement
  private visible = false
  private selectedLevelView: number | 'all' = 'all'
  private keyListenerAttached = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'debug-map-panel'
    this.root.style.display = 'none'
    document.body.appendChild(this.root)

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
    if (!this.visible) return

    const maxLevel = grid.maxLevel
    const size = grid.size
    const dpr = Math.max(1, (typeof globalThis.devicePixelRatio === 'number' && globalThis.devicePixelRatio) || 1)

    this.root.innerHTML = ''

    // --- Header -------------------------------------------------------------
    const header = document.createElement('div')
    header.className = 'debug-map-header'

    const levelTabs = [`<button class="debug-map-tab ${this.selectedLevelView === 'all' ? 'active' : ''}" data-view="all">ALL LEVELS</button>`]
    for (let l = 0; l <= maxLevel; l++) {
      levelTabs.push(
        `<button class="debug-map-tab ${this.selectedLevelView === l ? 'active' : ''}" data-view="${l}">L${l}</button>`,
      )
    }

    header.innerHTML = `
      <div class="debug-map-title">
        <span>DEBUG MINIMAP</span>
        <span class="debug-map-seed">Seed: ${seedLabel}</span>
      </div>
      <div class="debug-map-tabs">${levelTabs.join('')}</div>
      <button class="debug-map-close-btn" title="Close Minimap (Esc)">CLOSE &times;</button>
    `

    header.querySelector('.debug-map-close-btn')?.addEventListener('click', () => this.close())
    header.querySelectorAll('.debug-map-tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        const val = (e.currentTarget as HTMLElement).getAttribute('data-view')
        this.selectedLevelView = val === 'all' ? 'all' : Number(val)
        this.refresh(grid, squads, activeLevelFilter, seedLabel)
      })
    })
    this.root.appendChild(header)

    // --- Level Canvases Container -------------------------------------------
    const container = document.createElement('div')
    container.className = 'debug-map-levels'

    const levelsToDraw =
      this.selectedLevelView === 'all'
        ? Array.from({ length: maxLevel + 1 }, (_, i) => i)
        : [this.selectedLevelView as number]

    for (const level of levelsToDraw) {
      const card = document.createElement('div')
      card.className = `debug-map-card ${level === activeLevelFilter ? 'active' : ''}`

      const title = document.createElement('div')
      title.className = 'debug-map-card-title'
      title.innerHTML = `
        <span>LEVEL ${level} ${level === 0 ? '(Ground)' : level === maxLevel ? '(Top)' : ''}</span>
        ${level === activeLevelFilter ? '<span class="active-badge">VIEWING IN 3D</span>' : ''}
      `
      card.appendChild(title)

      const canvas = document.createElement('canvas')
      const cssPx = size * TILE_PX
      canvas.width = cssPx * dpr
      canvas.height = cssPx * dpr
      canvas.style.width = `${cssPx}px`
      canvas.style.height = `${cssPx}px`
      canvas.className = 'debug-map-canvas'
      card.appendChild(canvas)

      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(dpr, dpr)
        ctx.imageSmoothingEnabled = false
        this.drawLevel(ctx, grid, squads, level, size)
      }

      container.appendChild(card)
    }

    this.root.appendChild(container)

    // --- Legend -------------------------------------------------------------
    const legend = document.createElement('div')
    legend.className = 'debug-map-legend'
    legend.innerHTML = `
      <div class="legend-item"><span class="legend-box floor"></span>Floor</div>
      <div class="legend-item"><span class="legend-box wall-solid"></span>Solid Wall</div>
      <div class="legend-item"><span class="legend-box wall-parapet"></span>Parapet</div>
      <div class="legend-item"><span class="legend-box wall-glass"></span>Glass</div>
      <div class="legend-item"><span class="legend-box crate"></span>Crate</div>
      <div class="legend-item"><span class="legend-box stair"></span>Stair (L&rarr;U)</div>
      <div class="legend-item"><span class="legend-box ladder"></span>Ladder</div>
      <div class="legend-item"><span class="legend-box roof"></span>Roof</div>
      <div class="legend-item"><span class="legend-box blue-unit"></span>Blue Squad</div>
      <div class="legend-item"><span class="legend-box red-unit"></span>Red Squad</div>
    `
    this.root.appendChild(legend)
  }

  private drawLevel(
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

        // Faint tile grid lines
        ctx.strokeStyle = '#1e293b'
        ctx.lineWidth = 0.5
        ctx.strokeRect(px, py, TILE_PX, TILE_PX)

        // Crates (Block.Half)
        if (block === Block.Half && tileLevel === level) {
          ctx.fillStyle = '#d97706'
          ctx.fillRect(px + 2, py + 2, TILE_PX - 4, TILE_PX - 4)
        }

        // Roof overlay
        if (grid.roofAt(x, y) === level + 1) {
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(px, py + TILE_PX)
          ctx.lineTo(px + TILE_PX, py)
          ctx.stroke()
        }
      }
    }

    // 2. Stairs & Orientation Arrows
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (grid.blockAt(x, y) !== Block.Stair) continue
        const stairLevel = grid.levelAt(x, y)
        const dir = grid.stairDirectionAt(x, y)
        const access = grid.getStairAccessTiles(x, y)

        if (stairLevel === level) {
          ctx.fillStyle = '#0284c7'
          ctx.fillRect(x * TILE_PX + 1, y * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2)
        }

        if (stairLevel === level || grid.levelAt(access.upper.x, access.upper.y) === level) {
          this.drawStairArrow(ctx, grid, { x, y }, dir, access)
        }
      }
    }

    // 3. Walls (Edges)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = x * TILE_PX
        const py = y * TILE_PX

        const northWall = grid.wallAt(x, y, Side.North)
        if (northWall !== WallKind.None && this.wallTouchesLevel(grid, x, y, Side.North, level)) {
          this.drawWallLine(ctx, px, py, px + TILE_PX, py, northWall)
        }

        const westWall = grid.wallAt(x, y, Side.West)
        if (westWall !== WallKind.None && this.wallTouchesLevel(grid, x, y, Side.West, level)) {
          this.drawWallLine(ctx, px, py, px, py + TILE_PX, westWall)
        }
      }
    }

    // 4. Ladders
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const faces = grid.ladderFacesAt(x, y)
        if (faces === 0) continue
        if (grid.levelAt(x, y) !== level && grid.levelAt(x, y) - 1 !== level) continue

        const px = x * TILE_PX
        const py = y * TILE_PX

        if ((faces & Side.North) !== 0) this.drawLadderEdge(ctx, px, py, px + TILE_PX, py)
        if ((faces & Side.East) !== 0) this.drawLadderEdge(ctx, px + TILE_PX, py, px + TILE_PX, py + TILE_PX)
        if ((faces & Side.South) !== 0) this.drawLadderEdge(ctx, px, py + TILE_PX, px + TILE_PX, py + TILE_PX)
        if ((faces & Side.West) !== 0) this.drawLadderEdge(ctx, px, py, px, py + TILE_PX)
      }
    }

    // 5. Squad Units
    for (const soldier of squads.soldiers) {
      if (soldier.isDead) continue
      if (grid.levelAt(soldier.tile.x, soldier.tile.y) !== level) continue

      const cx = (soldier.tile.x + 0.5) * TILE_PX
      const cy = (soldier.tile.y + 0.5) * TILE_PX
      const isBlue = soldier.faction === Faction.Blue

      ctx.fillStyle = isBlue ? '#3b82f6' : '#ef4444'
      ctx.beginPath()
      ctx.arc(cx, cy, TILE_PX * 0.38, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 7px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(isBlue ? 'B' : 'R', cx, cy)
    }
  }

  private wallTouchesLevel(grid: Grid, x: number, y: number, side: Side, level: number): boolean {
    const l1 = grid.levelAt(x, y)
    let nx = x
    let ny = y
    if (side === Side.East) nx += 1
    else if (side === Side.West) nx -= 1
    else if (side === Side.South) ny += 1
    else if (side === Side.North) ny -= 1
    const l2 = grid.levelAt(nx, ny)
    return Math.max(l1, l2) >= level && Math.min(l1, l2) <= level
  }

  private drawWallLine(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    kind: WallKind,
  ): void {
    ctx.lineWidth = WALL_PX
    if (kind === WallKind.Solid) {
      ctx.strokeStyle = '#f8fafc'
      ctx.setLineDash([])
    } else if (kind === WallKind.Parapet) {
      ctx.strokeStyle = '#fbbf24'
      ctx.setLineDash([])
    } else if (kind === WallKind.Glass) {
      ctx.strokeStyle = '#38bdf8'
      ctx.setLineDash([3, 2])
    }
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  private drawLadderEdge(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void {
    ctx.lineWidth = WALL_PX + 1
    ctx.strokeStyle = '#f97316'
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  private drawStairArrow(
    ctx: CanvasRenderingContext2D,
    _grid: Grid,
    stair: Tile,
    dir: StairDirection,
    access: { lower: Tile; upper: Tile },
  ): void {
    const lowerCx = (access.lower.x + 0.5) * TILE_PX
    const lowerCy = (access.lower.y + 0.5) * TILE_PX
    const upperCx = (access.upper.x + 0.5) * TILE_PX
    const upperCy = (access.upper.y + 0.5) * TILE_PX

    // Arrow line from lower entrance (foot) to upper exit (head)
    ctx.strokeStyle = '#00d2ff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(lowerCx, lowerCy)
    ctx.lineTo(upperCx, upperCy)
    ctx.stroke()

    // Arrowhead at upper exit
    const angle = Math.atan2(upperCy - lowerCy, upperCx - lowerCx)
    const headLen = 5
    ctx.fillStyle = '#00d2ff'
    ctx.beginPath()
    ctx.moveTo(upperCx, upperCy)
    ctx.lineTo(
      upperCx - headLen * Math.cos(angle - Math.PI / 6),
      upperCy - headLen * Math.sin(angle - Math.PI / 6),
    )
    ctx.lineTo(
      upperCx - headLen * Math.cos(angle + Math.PI / 6),
      upperCy - headLen * Math.sin(angle + Math.PI / 6),
    )
    ctx.closePath()
    ctx.fill()

    // Badges: 'L' at lower, 'U' at upper
    ctx.font = 'bold 7px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    ctx.fillStyle = '#0369a1'
    ctx.beginPath()
    ctx.arc(lowerCx, lowerCy, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText('L', lowerCx, lowerCy)

    ctx.fillStyle = '#0ea5e9'
    ctx.beginPath()
    ctx.arc(upperCx, upperCy, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText('U', upperCx, upperCy)

    // Direction text on stair tile
    const dirStr =
      dir === StairDirection.North
        ? 'N'
        : dir === StairDirection.East
          ? 'E'
          : dir === StairDirection.South
            ? 'S'
            : 'W'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(dirStr, (stair.x + 0.5) * TILE_PX, (stair.y + 0.5) * TILE_PX)
  }
}
