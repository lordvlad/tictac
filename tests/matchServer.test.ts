import { describe, expect, test } from 'bun:test'
import { MATCH_SERVER_URL, matchServerFor } from '../src/config'

/**
 * Which match server a page plays on (`src/config.ts`): the one address, unless
 * the page is on this machine and asks for another.
 */

const at = (page: string) => matchServerFor(new URL(page))

describe('The match server a page plays on', () => {
  test('is the production one for any page that does not ask', () => {
    expect(at('https://lordvlad.github.io/tictac/')).toBe(MATCH_SERVER_URL)
    expect(at('http://localhost:5173/')).toBe(MATCH_SERVER_URL)
  })

  test('is the one a page on this machine asks for', () => {
    expect(at('http://localhost:5173/?server=ws://localhost:8787/')).toBe('ws://localhost:8787/')
    expect(at('http://127.0.0.1:5173/?server=wss://example.org:9000/x')).toBe('wss://example.org:9000/x')
    expect(at('http://[::1]:5173/?server=ws://localhost:8787/')).toBe('ws://localhost:8787/')
  })

  test('is never the one a page elsewhere asks for — a link must not choose anybody\'s server', () => {
    expect(at('https://lordvlad.github.io/tictac/?server=wss://evil.example/')).toBe(MATCH_SERVER_URL)
    expect(at('https://localhost.evil.example/?server=wss://evil.example/')).toBe(MATCH_SERVER_URL)
  })

  test('ignores an address that is not a socket address', () => {
    for (const asked of ['http://localhost:8787/', 'javascript:alert(1)', 'localhost:8787', '%%', '']) {
      expect(at(`http://localhost:5173/?server=${encodeURIComponent(asked)}`)).toBe(MATCH_SERVER_URL)
    }
  })
})
