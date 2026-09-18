import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { rollSquadSheets } from '../src/core/Characters'
import { Rng } from '../src/core/rng'
import { isJsonRpcFrame, type JsonRpcFrame } from '../src/game/JsonRpc'
import { defaultLoadout } from '../src/game/Loadout'
import { NetworkManager, type NetworkMessage } from '../src/game/NetworkManager'
import { RECORDING_VERSION, type RecordingHeader } from '../src/game/Recording'
import type { Transport } from '../src/game/Transport'
import { MatchStore } from '../src/server/MatchStore'
import { Referee } from '../src/server/Referee'
import { replay } from '../src/sim/Replay'

/**
 * A referee on a real socket, in-process.
 *
 * The loopback tests cover what the referee decides; this covers the thing they
 * cannot — that two `NetworkManager`s reach each other *through* a server over
 * a real WebSocket, that the referee relays to the other side and not back to
 * the sender, and that what it wrote down refights.
 *
 * Port 0 so the test cannot collide with anything, including itself.
 */
function refereeOnASocket() {
  const store = new MatchStore()
  const referee = new Referee({ store, log: () => {} })
  const sockets = new WeakMap<object, { deliver: (raw: string) => void; closed: () => void }>()

  const server = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('no')),
    websocket: {
      open(ws) {
        const frames: ((frame: JsonRpcFrame) => void)[] = []
        const closers: ((reason: string) => void)[] = []
        const transport: Transport = {
          send: (frame) => ws.send(JSON.stringify(frame)),
          onFrame: (handler) => frames.push(handler),
          onClosed: (handler) => closers.push(handler),
          close: () => ws.close(),
        }
        sockets.set(ws, {
          deliver: (raw) => {
            const parsed = JSON.parse(raw)
            if (isJsonRpcFrame(parsed)) for (const handler of frames) handler(parsed)
          },
          closed: () => {
            for (const handler of closers) handler('closed')
          },
        })
        referee.attach(transport)
      },
      message(ws, message) {
        sockets.get(ws)?.deliver(String(message))
      },
      close(ws) {
        sockets.get(ws)?.closed()
      },
    },
  })

  return { referee, store, url: `ws://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

function header(seed: number, sheets: Record<Faction, ReturnType<typeof rollSquadSheets>>): RecordingHeader {
  return {
    version: RECORDING_VERSION,
    seed,
    seedLabel: String(seed),
    source: 'live',
    createdAt: new Date().toISOString(),
    turnCap: null,
    sheets,
    loadouts: { [Faction.Blue]: defaultLoadout(), [Faction.Red]: defaultLoadout() },
  }
}

describe('Two clients playing through a referee', () => {
  test('they reach each other over sockets, and the referee keeps the match', async () => {
    const { referee, store, url, stop } = refereeOnASocket()
    const host = new NetworkManager()
    const joiner = new NetworkManager()
    const hostSaw: NetworkMessage[] = []
    const joinerSaw: NetworkMessage[] = []
    host.onMessage = (m) => hostSaw.push(m)
    joiner.onMessage = (m) => joinerSaw.push(m)

    const seed = 777
    host.hostOnServer(url, seed, String(seed))
    const opening = await joiner.joinOnServer(url)

    // The seed came from the host, through the referee, over a socket.
    expect(opening.seed).toBe(seed)
    expect([host.myFaction, joiner.myFaction]).toEqual([Faction.Blue, Faction.Red])

    const sheets = {
      [Faction.Blue]: rollSquadSheets(new Rng(1)),
      [Faction.Red]: rollSquadSheets(new Rng(2)),
    }
    host.send({ type: 'ready', sheets: sheets[Faction.Blue], loadout: defaultLoadout() })
    joiner.send({ type: 'ready', sheets: sheets[Faction.Red], loadout: defaultLoadout() })

    // Both sides learn who the other brought *and* what they are carrying —
    // the kit is what a referee cannot derive from the intents.
    const seenByHost = await host.waitForPeerReady()
    const seenByJoiner = await joiner.waitForPeerReady()
    expect(seenByHost?.sheets).toEqual(sheets[Faction.Red])
    expect(seenByJoiner?.sheets).toEqual(sheets[Faction.Blue])
    expect(seenByHost?.loadout).not.toBeNull()

    host.send({ type: 'matchHeader', header: header(seed, sheets) })
    host.send({
      type: 'moveUnit',
      faction: Faction.Blue,
      squadIndex: 0,
      path: [{ x: 20, y: 5 }, { x: 20, y: 6 }],
    })
    host.send({ type: 'endTurn', faction: Faction.Blue })
    joiner.send({ type: 'toggleCover', faction: Faction.Red, squadIndex: 1 })
    await Bun.sleep(150)

    // Relayed to the other side, never back to the sender: a frame that echoed
    // would be applied twice by the client that sent it.
    expect(joinerSaw.map((m) => m.type)).toContain('moveUnit')
    expect(hostSaw.map((m) => m.type)).toContain('toggleCover')
    expect(hostSaw.map((m) => m.type)).not.toContain('moveUnit')

    // And the referee's own log refights: what it kept is a match, not a note
    // about one.
    const stored = store.match(referee.openMatchId!)!
    expect(stored.events).toHaveLength(3)
    const refought = replay(stored)
    expect(refought.skipped).toEqual([])
    expect(refought.digest.total).toBe(referee.digest()!.total)

    host.dispose()
    joiner.dispose()
    stop()
  })

  test('a client on another build is turned away at the socket', async () => {
    // The same gate as peer-to-peer play, over a different channel: the referee
    // refuses a build it cannot agree with rather than accusing it later.
    const { url, stop } = refereeOnASocket()
    // Spoken by hand rather than through a `NetworkManager`, because the point
    // is a client this build would never produce: one claiming another build.
    const socket = new WebSocket(url)
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()))
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tictac/system/session/hello',
        params: { protocol: 1, build: 'c0ffee1' },
      }),
    )

    const abort = await new Promise<Record<string, unknown> | null>((resolve) => {
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))))
      setTimeout(() => resolve(null), 1500)
    })

    expect(abort).not.toBeNull()
    expect(JSON.stringify(abort)).toContain('c0ffee1')
    socket.close()
    stop()
  })
})
