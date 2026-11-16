/**
 * The page's `#ui` layer, which every HUD piece is mounted on.
 *
 * Fails loudly when it is missing: a page without it is a broken `index.html`,
 * and falling back to `<body>` would put the HUD on a layer that is not
 * `pointer-events: none` and sits wherever the stylesheet did not expect it —
 * a game that looks half-working instead of one that says what is wrong.
 */
export function uiMount(): HTMLElement {
  const ui = document.getElementById('ui')
  if (!ui) throw new Error('index.html has no #ui element: the HUD has nowhere to mount')
  return ui
}
