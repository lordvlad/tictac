/**
 * Central tuning constants.
 *
 * World scale: 1 unit = 1 metre. 1 grid tile = 1 metre.
 */

export const TILE = 1

/** Grid is GRID_SIZE x GRID_SIZE tiles. */
export const GRID_SIZE = 28

/** Block heights in metres. */
export const HALF_BLOCK_HEIGHT = 1.0
export const FULL_BLOCK_HEIGHT = 2.0

/** A soldier is "just shy of 2 units" tall. Models are rescaled to this at load. */
export const SOLDIER_HEIGHT = 1.85

/** Eye height used as the LOS ray origin / target. */
export const EYE_HEIGHT = 1.6

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export const CAM = {
  distMin: 6,
  distMax: 48,
  distStart: 22,
  /** Tilt at distMin — flat, almost side-on. */
  pitchMin: (18 * Math.PI) / 180,
  /** Tilt at distMax — steep, near top-down. */
  pitchMax: (62 * Math.PI) / 180,
  azimuthStart: (35 * Math.PI) / 180,
  /** Wheel sensitivity (exponential). */
  zoomSpeed: 0.0012,
  /** Radians per pixel for right-drag orbit. */
  rotateSpeed: 0.006,
  /** Radians per pixel for middle-drag free look. */
  freeLookSpeed: 0.004,
  /** Free-look pitch clamp. */
  freePitchLimit: (60 * Math.PI) / 180,
  /** Free-look yaw clamp. */
  freeYawLimit: (100 * Math.PI) / 180,
  /** Exponential smoothing rate (higher = snappier). */
  smoothing: 14,
  /** Smoothing used when snapping free-look back onto the zoom-tilt path. */
  resetSmoothing: 9,
} as const

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

export const MAX_HP = 100
export const BULLET_DAMAGE = 55 // 2 bullets kill
export const MAX_AP = 12
export const SHOOT_AP_COST = 4

/** Tiles a soldier can see. */
export const SIGHT_RANGE = 14

/** Metres per second while moving. Tuned to sit close to the natural pace of
 *  the `run` (Jog_Fwd_Loop) clip so the feet do not visibly slide. */
export const MOVE_SPEED = 3.4

export const AIM = {
  base: 85,
  /** Accuracy lost per metre of range. */
  perMetre: 3,
  halfCoverPenalty: 20,
  fullCoverPenalty: 40,
  min: 5,
  max: 95,
} as const

// ---------------------------------------------------------------------------
// Movement cost, in "steps" (action points)
// ---------------------------------------------------------------------------

export const STEP_ORTHOGONAL = 1
export const STEP_DIAGONAL = 1.5

// ---------------------------------------------------------------------------
// Movement path overlay (planner visualisation)
// ---------------------------------------------------------------------------

export const PATH = {
  /** Height of the floating path line and marker circles above the floor, in metres (~25 cm). */
  hover: 0.25,
  /** Goal beacon rises to roughly eye height (~185 cm). */
  goalHeight: 1.85,
  /** Waypoint beacon is a bit shorter. */
  waypointHeight: 1.0,
  /** Radii of the two concentric goal circles. */
  goalInnerRadius: 0.28,
  goalOuterRadius: 0.42,
  /** Radius of the single waypoint circle. */
  waypointRadius: 0.35,
  colorValid: 0x66ff99,
  colorInvalid: 0xff5a4a,
  colorWaypoint: 0xe0b64f,
} as const

// ---------------------------------------------------------------------------
// Factions
// ---------------------------------------------------------------------------

export const Faction = {
  Blue: 0,
  Red: 1,
} as const
export type Faction = (typeof Faction)[keyof typeof Faction]

export const FACTIONS: readonly Faction[] = [Faction.Blue, Faction.Red]

export const FACTION_INFO: Record<Faction, {
  name: string
  label: string
  color: number
  cssColor: string
}> = {
  [Faction.Blue]: {
    name: 'BLUE',
    label: 'Blue Team',
    /** Body tint. */
    color: 0x4a7fd4,
    cssColor: '#5b95ef',
  },
  [Faction.Red]: {
    name: 'RED',
    label: 'Red Team',
    color: 0xc4453a,
    cssColor: '#e05c4f',
  },
} as const

export const SQUAD_SIZE = 4
