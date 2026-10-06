/**
 * A line over the top of the screen while a window gets its seat back
 * (`NetworkManager.onReconnecting`).
 *
 * Small and click-through on purpose: a dropped socket is usually a server
 * being redeployed, back within a second or two, and the player should see a
 * stall rather than a screen that has stopped being their match. Their input
 * is held by the manager meanwhile (`isMyTurn`), not by covering the canvas.
 */
export class ReconnectingBanner {
  private element: HTMLDivElement | null = null

  show(attempt: number): void {
    if (!this.element) {
      this.element = document.createElement('div')
      this.element.setAttribute('role', 'status')
      this.element.style.cssText = `
        position: absolute;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9999;
        padding: 8px 14px;
        border-radius: 6px;
        background: rgba(10, 14, 20, 0.92);
        border: 1px solid rgba(250, 204, 21, 0.5);
        color: #fde68a;
        font-size: 13px;
        pointer-events: none;
      `
      ;(document.getElementById('ui') ?? document.body).appendChild(this.element)
    }
    this.element.textContent = `Connection lost — reconnecting… (attempt ${attempt})`
  }

  hide(): void {
    this.element?.remove()
    this.element = null
  }
}
