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

/** Spectator replay pacing. */
export const PLAYBACK = {
  /**
   * Scaled seconds held between consecutive recorded events.
   *
   * A move animates and so paces itself, but a shot, a stance change or a
   * handover is instantaneous — without a dwell a whole turn would resolve in
   * one frame and there would be nothing to watch.
   */
  eventDwell: 0.35,
} as const

/** Grid is GRID_SIZE x GRID_SIZE tiles. */
export const GRID_SIZE = 36

/** Block heights in metres. */
export const HALF_BLOCK_HEIGHT = 1.0
export const FULL_BLOCK_HEIGHT = 2.0
export const LEVEL_HEIGHT = 2.0

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
  /** Radians per pixel for the over-the-shoulder look drag. */
  shoulderLookSpeed: 0.006,
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

  // --- over-the-shoulder view (unit view, and shot aiming) -----------------
  /** Boom length: how far behind the unit the camera sits, in metres. */
  shoulderBack: 3.8,
  /** Boom length clamps while the wheel adjusts it in shoulder view. */
  shoulderBackMin: 1.6,
  shoulderBackMax: 6.0,
  /**
   * Height above the unit's feet of the point the boom orbits and looks at —
   * roughly the shoulders, so the unit's back fills the lower middle of frame.
   */
  shoulderPivotHeight: 1.55,
  /** Sideways offset of the boom, so the unit sits off-centre. */
  shoulderSide: 0.9,
  /** Resting downward tilt of the shoulder camera. */
  shoulderPitch: (10 * Math.PI) / 180,
  /** Tilt clamps in shoulder view: negative looks up, positive looks down. */
  shoulderPitchMin: (-45 * Math.PI) / 180,
  shoulderPitchMax: (75 * Math.PI) / 180,
  /**
   * Lowest the shoulder camera may sit above the unit's feet. Looking up
   * shortens the boom instead of burying the camera in the floor.
   */
  shoulderMinHeight: 0.45,
  /** Height above the target's feet the aim camera points at. */
  shoulderAimHeight: 1.2,
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
  /** AP to hunker down into cover (crouch stance) / reload. */
  /**
   * Consecutive turns of spending every action point before a unit is winded.
   * One hard turn is a commitment; two in a row is running it into the ground.
   */
  exhaustionTurns: 2,
  coverApCost: 2,
  reloadApCost: 2,
  /** Tiles a soldier can see. */
  sightRange: 14,
  /** AP per tile of movement. */
  stepOrthogonal: 1,
  stepDiagonal: 1.5,
  stairStepCost: 1.5,
  /** Climbing a ladder costs more AP than standard walking. */
  ladderStepCost: 3,
  /**
   * What every step costs a crouched unit, as a multiple of its standing
   * price. Moving low is slow; it is also the stance the unit arrives in,
   * where standing to move and crouching again would cost the cover price.
   */
  crouchStepCost: 1.5,
  /**
   * Metres per second while moving. Tuned to sit close to the natural pace of
   * the `run` (Jog_Fwd_Loop) clip so the feet do not visibly slide.
   */
  moveSpeed: 3.4,
  /** Metres per second while moving crouched; twice the crouch-walk clip's own pace. */
  crouchMoveSpeed: 1.5,
}

/**
 * Shares of a unit's own maximum health at which wounds set in.
 *
 * Read as "at or below": a unit is limping from half health and concussed from
 * a quarter, and a quarter-health unit is both.
 */
export const WOUNDS = {
  limping: 0.5,
  concussed: 0.25,
}

/**
 * How much the people differ from each other.
 *
 * Rolled per peer, not from the match seed: the seed is the host's map, and
 * each side brings its own squad and sends the sheets in the start handshake.
 * Everything here is a range around the baseline in {@link RULES}.
 */
export const CHARACTER = {
  /**
   * The scale every core attribute is rolled and read on.
   *
   * Attributes are the only thing a character is *dealt*; every number below
   * is a band that one of them is mapped onto, so a sheet is four rolls and a
   * specialism rather than a pile of independent draws. That is also what
   * makes a sheet safe to accept from a peer: the ceilings cannot be stated,
   * only derived from attributes this side has clamped.
   */
  attribute: { min: 1, max: 10 },
  /** Hit points, absolute. From Health. */
  hp: { min: 85, max: 120 },
  /** Action points, absolute. From Agility. */
  ap: { min: 10, max: 14 },
  /**
   * Percentage points off an attacker's hit chance. From Agility.
   *
   * Deliberately the same attribute as AP: a quick character is both harder to
   * line up and able to do more with a turn, so the two move together instead
   * of being two unrelated dice.
   */
  evasion: { min: 0, max: 12 },
  /** Tiles added to a grenade's throw range. From Strength. */
  throwRange: { min: -2, max: 2 },
  /** Consumables a character can carry into a match. From Strength. */
  carrySlots: { min: 1, max: 3 },
  /**
   * Action points added to the price of using an item. From Intelligence.
   *
   * Inverted on purpose: the clever end of the scale pays *less*. Floored at
   * one AP by {@link itemApCost}, so no character uses kit for free.
   */
  itemApDelta: { min: 1, max: -1 },
  /** Percent added to HP an item restores to them. From Health. */
  healBonus: { min: -20, max: 30 },
  /**
   * Percent of what *gear* does to a soldier's movement and action points that
   * their own Strength cancels. From Strength.
   *
   * Only the unfavourable share, and only gear's: a plate carrier's drag is
   * what shoulders are for, while a limp is not something being strong fixes.
   * At the top of the scale heavy kit is free to wear, which is the point the
   * GDD makes about gating heavy armour on Strength rather than forbidding it.
   */
  gearRelief: { min: 0, max: 100 },
  /** Percentage points on landing a blow. From Strength. */
  meleeSkill: { min: -10, max: 10 },
  /** Percent on the damage a blow does. From Strength: melee is where Strength first fights. */
  meleePower: { min: -25, max: 50 },
  /**
   * Percent a utility discipline adds to what it governs, per discipline.
   *
   * Training, not physique, so it is rolled rather than derived from an
   * attribute - and it is the channel organic growth will later write to.
   */
  utility: { min: -20, max: 35 },
  /**
   * Accuracy every weapon class gets, before the one the character actually
   * trained on.
   */
  proficiency: { min: -8, max: 6 },
  /**
   * Accuracy on top of that, for the single class they are a specialist in.
   *
   * Strictly greater than the span of `proficiency`, so a specialist's worst
   * possible draw still beats every other class's best: being labelled a
   * specialist has to mean being the best with it. At 12 it did not — a
   * specialist could roll -8+12 = 4 against another class's 6, and one
   * character in five was worse with the weapon they were named for.
   */
  specialistBonus: 15,
  /** Chance a character is born with a trait at all. */
  traitChance: 0.55,
}

/**
 * How a projectile is aimed and what it has to land on.
 *
 * Every shot is one or more straight lines with error ({@link Arsenal} gives a
 * weapon its `sway`, `spread` and `pellets`). A line lands on a target of
 * presented half-width `w` with probability `w² / (w² + e²)`, where `e` is the
 * line's error at that distance — so it lands half the time when its error is
 * as wide as the target, and more often closer in. Multiplication and division
 * only: both peers must compute the same number, and transcendental functions
 * are not guaranteed to agree across browsers.
 */
export const AIM = {
  /** Half-width of a standing body facing the shooter, in metres. */
  targetSize: 0.3,
  /** Share of the presented size one point of evasion (or of a status's defence) hides. */
  evasionShrink: 0.025,
  /** Share of a shooter's error one point of training (or of a status penalty) removes (adds). */
  trainingTighten: 0.02,
  /** Clamp on one projectile's chance, in percent. */
  min: 5,
  max: 95,
  /** A round that lands always does at least this much, however good the armour. */
  minDamage: 5,
}

/**
 * How a critical hit is earned. The weapon decides the odds it starts from and
 * what a crit is worth ({@link Arsenal}); this is only the scale of what the
 * shot's circumstances can do to those odds.
 */
export const CRIT = {
  /**
   * Percentage points the range swings a weapon's crit chance by at either
   * extreme of its reach — full penalty at the muzzle, full bonus at maximum
   * range, or the reverse, depending on the weapon's own bias.
   */
  rangeSwing: 12,
  /**
   * Percentage points taken off per point of the target's armour, before
   * penetration. Plate covers the vitals a crit needs, and a round that
   * punches through plate keeps its chance at them.
   */
  armorResist: 0.35,
  min: 0,
  max: 75,
}

/**
 * Share of the body still showing to a shooter, by the cover the line crosses
 * and the target's stance. Crouching always shows less than standing, and
 * hunkering behind real cover shows less than crouching in the open. Fitted to
 * the point penalties this replaced, so a rifleman's odds against cover stayed
 * where the game had them.
 */
export const COVER = {
  /** Crouching with nothing on the shot's side. */
  openCrouch: 0.55,
  /** Standing behind a low crate. */
  lowStand: 0.6,
  /** Crouching behind a low crate. */
  lowCrouch: 0.33,
  /** Standing behind a wall or an edge, leaning out to see. */
  tallStand: 0.27,
  /** Crouching behind a wall or an edge. */
  tallCrouch: 0.14,
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
  /** Height of the directional cover shields above the goal's own floor. */
  shieldHeight: 0.55,
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
  /** Call signs, one per squad index. */
  squadNames: readonly string[]
}> = {
  [Faction.Blue]: {
    name: 'BLUE',
    label: 'Blue Team',
    /** Body tint. */
    color: 0x4a7fd4,
    cssColor: '#5b95ef',
    squadNames: ['Cobalt', 'Azure', 'Sapphire', 'Indigo'],
  },
  [Faction.Red]: {
    name: 'RED',
    label: 'Red Team',
    color: 0xc4453a,
    cssColor: '#e05c4f',
    squadNames: ['Crimson', 'Scarlet', 'Ruby', 'Garnet'],
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
