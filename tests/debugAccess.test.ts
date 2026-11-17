import { describe, expect, test } from 'bun:test'
import { consoleHandleAllowed, debugEditable } from '../src/game/DebugAccess'

describe('the debug panel and the console handle', () => {
  test('only a match held on one screen can be edited', () => {
    expect(debugEditable('local')).toBe(true)
    expect(debugEditable('host')).toBe(false)
    expect(debugEditable('join')).toBe(false)
    expect(debugEditable('spectate')).toBe(false)
    expect(debugEditable('replay')).toBe(false)
  })

  test('window.tictac is for the development bundle only', () => {
    expect(consoleHandleAllowed('dev')).toBe(true)
    expect(consoleHandleAllowed('3f9c2ab')).toBe(false)
  })
})
