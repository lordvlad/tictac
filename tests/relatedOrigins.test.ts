import { describe, expect, test } from 'bun:test'
import { relatedOriginsHandler } from '../src/server/RelatedOrigins'

const handler = relatedOriginsHandler({
  id: 'referee.example',
  origins: ['https://referee.example', 'https://pages.example'],
})

const at = (path: string, method = 'GET') => handler(new Request(`https://referee.example${path}`, { method }))

describe('the related-origins file', () => {
  test('lists every origin the ceremony accepts, as JSON', async () => {
    const response = at('/.well-known/webauthn')
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('application/json')
    expect(await response?.json()).toEqual({ origins: ['https://referee.example', 'https://pages.example'] })
  })

  test('a HEAD carries the headers without the list', async () => {
    const response = at('/.well-known/webauthn', 'HEAD')
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toBe('application/json')
    expect((await response!.arrayBuffer()).byteLength).toBe(0)
  })

  test('anything else is left to the rest of the server', () => {
    expect(at('/')).toBeUndefined()
    expect(at('/.well-known/webauthn/')).toBeUndefined()
    expect(at('/.well-known/other')).toBeUndefined()
  })

  test('the file is read-only', () => {
    expect(at('/.well-known/webauthn', 'POST')?.status).toBe(405)
  })
})
