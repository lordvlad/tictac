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
let row: HTMLDivElement | null = null

export function bottomLeftStack(): HTMLDivElement {
  if (!column) {
    column = document.createElement('div')
    column.className = 'hud-corner-bl'
    document.body.appendChild(column)
  }
  return column
}

/**
 * The bottom line of that column, for the things that belong side by side: the
 * frame counter and the developer tools sit on one row rather than stacking.
 */
export function bottomLeftRow(): HTMLDivElement {
  if (!row) {
    row = document.createElement('div')
    row.className = 'hud-corner-row'
    bottomLeftStack().appendChild(row)
  }
  return row
}
