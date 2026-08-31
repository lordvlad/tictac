/**
 * Central tuning constants.
 *
 * World scale: 1 unit = 1 metre. 1 grid tile = 1 metre.
 */

export const TILE = 1

export const SIM = {
  /** Fixed simulation step, in seconds (30 Hz). */
  step: 1 / 30,
  /**
   * Most wall time one delivery may catch up on. Browsers clamp the engine's
   * `setInterval` hard in a hidden or busy tab, so a single delivery can carry
   * seconds; without a ceiling that becomes a visible lurch.
   */
  maxCatchUp: 0.5,
} as const

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
  /**
   * Pinch-to-zoom amplification: the finger-distance ratio is raised to this
   * power before it drives distance. 1 is a literal 1:1 pinch, which barely
   * crosses the distMin..distMax range in a single gesture on a phone.
   */
  pinchZoomPower: 2,
  /** Two-finger twist amplification (1 = camera turns exactly with the fingers). */
  pinchRotateSpeed: 2.5,
  /** Suppress taps for this long (ms) after a camera gesture ends. */
  gestureClickGrace: 200,
  /**
   * Pointer travel (px) below which a press still counts as a tap/click. Above
   * it the press was a camera drag and must not also order a move.
   */
  tapSlop: 8,
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
  /** Cursor band (px) at the viewport border that triggers edge panning. */
  edgePanMargin: 24,
  /** Edge-pan speed as a fraction of the zoom distance travelled per second at full push. */
  edgePanSpeed: 0.5,
} as const

// ---------------------------------------------------------------------------
// Wall x-ray (occluding walls vs. selected character)
// ---------------------------------------------------------------------------

export const WALL_XRAY = {
  /** Camera tilt at or above which occluding walls stay fully opaque. */
  fadeStart: (45 * Math.PI) / 180,
  /** Camera tilt at or below which occluding walls reach `minOpacity`. */
  fadeEnd: (30 * Math.PI) / 180,
  /** Wall opacity at `fadeEnd` — "very translucent". */
  minOpacity: 0.15,
} as const

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/**
 * Live gameplay rules.
 *
 * Mutable on purpose: the debug panel edits these at runtime, so every system
 * must read `RULES.x` at the point of use rather than capturing a copy at
 * import time. Weapon, ammo, grenade and status numbers live in
 * {@link Arsenal} for the same reason.
 */
export const RULES = {
  /** Starting/among-caps for a fresh soldier. */
  maxHp: 100,
  maxAp: 12,
  maxArmor: 20,
  /** AP to hunker down into cover (crouch stance). */
  coverApCost: 2,
  /** Tiles a soldier can see. */
  sightRange: 14,
  /** AP per tile of movement. */
  stepOrthogonal: 1,
  stepDiagonal: 1.5,
  /**
   * Metres per second while moving. Tuned to sit close to the natural pace of
   * the `run` (Jog_Fwd_Loop) clip so the feet do not visibly slide.
   */
  moveSpeed: 3.4,
}

/**
 * Global aim clamps and tuning offsets. Per-weapon accuracy and range falloff
 * live in {@link Arsenal}: what separates a shotgun from a sniper rifle is the
 * weapon, not a single global constant.
 */
export const AIM = {
  /** Flat hit-chance offset applied to every shot. A tuning/debug knob. */
  globalBonus: 0,
  min: 5,
  max: 95,
  /** A hit always does at least this much, however good the armour. */
  minDamage: 5,
}

/**
 * Accuracy the shooter loses against a target, by the cover the bullet crosses
 * and the target's stance. Crouching ("taking cover") always beats standing,
 * and hunkering behind real cover beats crouching in the open.
 */
export const COVER = {
  /** Crouching with no cover on the shot's side. */
  openCrouch: 25,
  /** Standing behind a low crate. */
  lowStand: 20,
  /** Crouching behind a low crate (> openCrouch and > lowStand). */
  lowCrouch: 40,
  /** Standing behind a wall/edge — strong, but a peek can still be hit. */
  tallStand: 45,
  /** Crouching behind a wall/edge. */
  tallCrouch: 60,
}

// ---------------------------------------------------------------------------
// Movement cost, in "steps" (action points)
// ---------------------------------------------------------------------------

export const STEP_ORTHOGONAL = 1
export const STEP_DIAGONAL = 1.5

// ---------------------------------------------------------------------------
// Movement path overlay (planner visualisation)
// ---------------------------------------------------------------------------

export const PATH = {
  /** Height of the floating path line and marker circles above the floor (~5 cm). */
  hover: 0.05,
  /** Goal beacon rises to roughly eye height (~185 cm). */
  goalHeight: 1.85,
  /** Waypoint beacon is a bit shorter. */
  waypointHeight: 1.0,
  /** Radii of the two concentric goal circles. */
  goalInnerRadius: 0.28,
  goalOuterRadius: 0.42,
  /** Radius of the single waypoint circle. */
  waypointRadius: 0.35,
  /** Radius of the selected-unit foot circle. */
  selectionRadius: 0.42,
  /** How far above the goal pole the AP cost plate floats. */
  labelRise: 0.42,
  /** World height of the AP cost plate. */
  labelScale: 0.46,
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

// ---------------------------------------------------------------------------
// Grenade Visual Effects (FX)
// ---------------------------------------------------------------------------

export const FX = {
  /** Flash durations in seconds. */
  flashDurationFrag: 0.15,
  flashDurationFlashbang: 0.55,
  /** Screen shake constants. */
  shakeDurationFrag: 0.45,
  shakeIntensityFrag: 0.18,
  /** Smoke cloud heights and sizes. */
  smokeHeight: 0.45,
  smokeSpriteSize: 1.5,
} as const
