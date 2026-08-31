import { Color, SRGBColorSpace } from 'three'
import { FACTION_INFO, type Faction, SQUAD_SIZE } from '../config'

/**
 * How far a squadmate's tint may drift from the faction colour.
 *
 * Small on purpose: teammates must still read as one team at a glance, so the
 * hue fans out by a few degrees either side and the lighter/darker steps stay
 * subtle. Red sits near hue 0, so anything wider starts turning the far end of
 * the squad orange.
 */
const HUE_SPREAD = 0.035
const LIGHTNESS_SPREAD = 0.07

const cache = new Map<string, Color>()

/**
 * Body tint for one soldier: the faction colour, nudged per squad index.
 *
 * The character owns this — its mesh, its portrait and anything else showing
 * the unit all ask here, so a unit looks the same everywhere.
 *
 * The HSL round-trip is pinned to sRGB. Three's colour management keeps
 * `Color` in linear space, and fanning hues there spreads them unevenly once
 * converted back for display: the red squad came out from pink to orange.
 */
export function soldierColor(faction: Faction, squadIndex: number): Color {
  const key = `${faction}_${squadIndex}`
  const hit = cache.get(key)
  if (hit) return hit

  const color = new Color(FACTION_INFO[faction].color)
  const hsl = { h: 0, s: 0, l: 0 }
  color.getHSL(hsl, SRGBColorSpace)

  // Centre the fan on the faction colour: the first and last squad member sit
  // an equal distance either side of it rather than all drifting one way.
  const centred = SQUAD_SIZE > 1 ? squadIndex / (SQUAD_SIZE - 1) - 0.5 : 0
  const hue = (hsl.h + centred * HUE_SPREAD + 1) % 1
  const lightness = Math.min(0.85, Math.max(0.15, hsl.l + centred * LIGHTNESS_SPREAD))

  const shaded = new Color().setHSL(hue, hsl.s, lightness, SRGBColorSpace)
  cache.set(key, shaded)
  return shaded
}
