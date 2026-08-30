import { Vector2 } from 'three'

/**
 * Convert client (event) coordinates to normalised device coordinates against a
 * canvas: x and y in [-1, 1], y pointing up.
 *
 * Every picking path needs this and each hand-rolled copy is a chance to get a
 * sign or an offset wrong, which shows up as clicks landing on the wrong tile
 * only once the canvas is no longer full-bleed.
 */
export function clientToNdc(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  target = new Vector2(),
): Vector2 {
  const rect = canvas.getBoundingClientRect()
  return target.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -(((clientY - rect.top) / rect.height) * 2 - 1),
  )
}
