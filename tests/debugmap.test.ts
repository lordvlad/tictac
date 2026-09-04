import { describe, expect, test } from 'bun:test'
import { Grid, Side } from '../src/core/Grid'
import { WallKind } from '../src/core/Walls'
import type { Squads } from '../src/game/Squads'
import { installCanvasStub } from './support/dom'

import { DebugMap } from '../src/hud/DebugMap'

installCanvasStub()

interface PrivateMap {
  root: HTMLElement
}

function getPrivateRoot(map: DebugMap): HTMLElement {
  const p = map as unknown as PrivateMap
  return p.root
}

function setup(): { map: DebugMap; grid: Grid; squads: Squads } {
  const grid = new Grid(12)
  grid.setLevel(5, 5, 1)
  grid.setWall(5, 5, Side.North, WallKind.Solid)

  const squads = {
    soldiers: [
      { isDead: false, faction: 0, tile: { x: 2, y: 2 } },
      { isDead: false, faction: 1, tile: { x: 8, y: 8 } },
    ],
  } as unknown as Squads

  const map = new DebugMap()
  return { map, grid, squads }
}

describe('DebugMap panel', () => {
  test('toggles open and closed state', () => {
    const { map } = setup()

    expect(map.isOpen).toBe(false)
    map.open()
    expect(map.isOpen).toBe(true)
    map.close()
    expect(map.isOpen).toBe(false)
    map.toggle()
    expect(map.isOpen).toBe(true)

    map.dispose()
  })

  test('renders header, level cards, tabs, and legend when refreshed', () => {
    const { map, grid, squads } = setup()
    map.open()
    map.refresh(grid, squads, 0, '1234')

    const root = getPrivateRoot(map)
    const header = root.querySelector('.debug-map-header')
    expect(header).not.toBeNull()

    const title = root.querySelector('.debug-map-title')
    expect(title?.textContent).toContain('DEBUG MINIMAP')
    expect(title?.textContent).toContain('Seed: 1234')

    const closeBtn = root.querySelector('.debug-map-close-btn')
    expect(closeBtn).not.toBeNull()

    const cards = root.querySelectorAll('.debug-map-card')
    // Max level is 1 in setup, so 2 cards (Level 0 and Level 1) in ALL mode.
    expect(cards.length).toBe(2)

    const tabs = root.querySelectorAll('.debug-map-tab')
    // Tabs: ALL, L0, L1
    expect(tabs.length).toBe(3)

    const legend = root.querySelector('.debug-map-legend')
    expect(legend).not.toBeNull()

    map.dispose()
  })

  test('switching level tab filters displayed cards', () => {
    const { map, grid, squads } = setup()
    map.open()
    map.refresh(grid, squads, 0, '1234')

    const root = getPrivateRoot(map)

    // Click L1 tab
    const l1Tab = root.querySelector('.debug-map-tab[data-view="1"]') as HTMLButtonElement
    expect(l1Tab).not.toBeNull()
    l1Tab.click()

    // Now only 1 card (Level 1) is displayed
    const cards = root.querySelectorAll('.debug-map-card')
    expect(cards.length).toBe(1)
    expect(cards[0]?.textContent).toContain('LEVEL 1')

    map.dispose()
  })

  test('escape key closes the minimap', () => {
    const { map, grid, squads } = setup()
    map.open()
    map.refresh(grid, squads, 0, '1234')
    expect(map.isOpen).toBe(true)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    window.dispatchEvent(event)

    expect(map.isOpen).toBe(false)
    map.dispose()
  })

  test('clicking backdrop closes the minimap', () => {
    const { map, grid, squads } = setup()
    map.open()
    map.refresh(grid, squads, 0, '1234')
    expect(map.isOpen).toBe(true)

    const root = getPrivateRoot(map)
    const event = new MouseEvent('click', { bubbles: true })
    root.dispatchEvent(event)

    expect(map.isOpen).toBe(false)
    map.dispose()
  })
})
