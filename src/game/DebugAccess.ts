import type { NetworkMode } from './NetworkManager'

/**
 * Who may change the match from the debug panel.
 *
 * The panel writes straight to the soldiers and the rules tables — not a
 * command, so not recorded, not sent, not in the digest. On one screen that is
 * a developer's tool. In a shared match it is a desync: the peer never hears of
 * the edit and the referee's next digest compare names the editor's opponent
 * as the cheat. So the answer is a function of how the match is held, and
 * `null` — no network at all, as in a replay or a watched match — is the same
 * as being a guest in it.
 */
export function debugEditable(mode: NetworkMode | null): boolean {
  return mode === 'local'
}

/**
 * Whether `window.tictac` may hand the console the live match.
 *
 * It exposes the rules objects themselves, so a shipped bundle must not carry
 * it. A bundle that was built has an injected build id; only a development
 * server's has none, and that is also what the browser tests drive.
 */
export function consoleHandleAllowed(buildId: string): boolean {
  return buildId === 'dev'
}
