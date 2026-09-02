/**
 * Live tuning tables (weapon stats, ammo, grenade specs, global rules) are
 * plain objects of numbers and flags that the debug panel edits in place.
 *
 * Rather than restate every field in a component — and silently drop any field
 * added later — the wire format is derived from the object itself, exactly as
 * the debug panel derives its rows.
 */
export type TunableValue = number | boolean

export function snapshotTunables(source: object): Record<string, TunableValue> {
  const out: Record<string, TunableValue> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

export function applyTunables(target: object, data: unknown): void {
  if (!data || typeof data !== 'object') return
  const writable = target as Record<string, TunableValue>
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'number' || typeof value === 'boolean') writable[key] = value
  }
}
