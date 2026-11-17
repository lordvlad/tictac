/**
 * The speeds the replay bar offers, and the playback engine honours: one list,
 * so the bar cannot offer one the engine does not know. Lives with the UI
 * vocabulary because both the bar (`hud`) and the engine (`game`) speak it.
 */
export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]
