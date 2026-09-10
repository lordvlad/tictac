/**
 * The page-level bottom-left column.
 *
 * Chrome that lives outside the HUD — the fullscreen prompt, the frame counter —
 * shares one flex column, so not overlapping is the layout's job rather than a
 * set of hand-tuned offsets that go stale the moment one of them changes height.
 *
 * Mounted on <body> rather than #ui, which is `pointer-events: none` with only
 * buttons re-enabled.
 */
let column: HTMLDivElement | null = null

export function bottomLeftStack(): HTMLDivElement {
  if (!column) {
    column = document.createElement('div')
    column.className = 'hud-corner-bl'
    document.body.appendChild(column)
  }
  return column
}
