import type { ReactNode } from 'react'

/**
 * A screen over the whole game: the start menu, a match that was interrupted.
 *
 * Presses and pointer-downs end here, as they did when the overlay was a
 * hand-built element: the canvas and the controller's own listeners sit
 * behind it and a click on a menu must not reach them.
 */
export function ScreenOverlay({ children }: { children: ReactNode }) {
  return (
    <div
      className="screen-overlay"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

/**
 * News the player did not ask for and cannot act on — being put back in a
 * match they already had — said briefly over whatever is on screen.
 */
export function ScreenNotice({ text }: { text: string }) {
  return (
    <div className="screen-notice" role="status">
      {text}
    </div>
  )
}

/**
 * A line over the top of the screen while a window gets its seat back
 * (`NetworkManager.onReconnecting`).
 *
 * Small and click-through on purpose: a dropped socket is usually a server
 * being redeployed, back within a second or two, and the player should see a
 * stall rather than a screen that has stopped being their match. Their input
 * is held by the session meanwhile (`MatchSession.canAct`), not by covering the canvas.
 */
export function ReconnectingNotice({ attempt }: { attempt: number }) {
  return (
    <div className="screen-reconnecting" role="status">
      Connection lost — reconnecting… (attempt {attempt})
    </div>
  )
}
