import { describe, expect, test } from 'bun:test'
import { NetworkManager, type NetworkMessage, type NetworkMode, type Resync } from '../src/game/NetworkManager'
import { CONNECTION_LOST, heldTokens, ServerConnection } from '../src/game/ServerConnection'
import { handClock, handServer, type HandClock, type HandServer, type HandSocket } from './support/handServer'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CHARACTER, Faction, RULES, SQUAD_SIZE } from '../src/config'
import { GrenadeId, ShotMode, StatusKind, WeaponId } from '../src/core/Arsenal'
import { derive, rollSquadSheets } from '../src/core/Characters'
import { defaultLoadout } from '../src/game/Loadout'
import { MeleeId } from '../src/core/Melee'
import { canMelee, type ShotResult } from '../src/game/Combat'
import type { Seated } from '../src/game/Lobby'
import { RECORDING_VERSION, type RecordingHeader } from '../src/game/Recording'
import { MatchHost } from '../src/sim/MatchHost'
import { TraitId } from '../src/core/Traits'
import { Rng } from '../src/core/rng'
import { HealthComponent, MatchRulesComponent } from '../src/ecs/components'
import { MY_VERSION, PROTOCOL_VERSION } from '../src/version'
import { loopback, type Transport } from '../src/game/Transport'
import { SocketTransport } from '../src/game/SocketTransport'
import {
  componentUpdateMethod,
  isJsonRpcFrame,
  type JsonRpcFrame,
  type JsonRpcNotification,
  type JsonRpcRequest,
  parseComponentUpdateMethod,
  RpcMethods,
} from '../src/game/JsonRpc'

/**
 * A manager on one end of a linked pair: everything it puts on the wire, and a
 * way to push frames back down as the other side would.
 *
 * The far end rather than a stubbed `sendRpc`: what a peer transmits is what
 * arrives at the other end of a transport, and stubbing the send method steps
 * over the channel that carries it — including the fact that a closed one
 * carries nothing.
 */
function peered(mode: NetworkMode = 'host') {
  const net = new NetworkManager()
  net.mode = mode
  const [ours, theirs] = loopback()
  net.attach(ours)
  const sent: JsonRpcNotification[] = []
  theirs.onFrame((frame) => sent.push(frame as JsonRpcNotification))
  return { net, sent, peer: theirs, send: (frame: JsonRpcFrame) => theirs.send(frame) }
}

describe('JSON-RPC framing', () => {
  test('recognises only 2.0 frames', () => {
    expect(isJsonRpcFrame({ jsonrpc: '2.0', method: 'x', params: {} })).toBe(true)
    expect(isJsonRpcFrame({ method: 'x' })).toBe(false)
    expect(isJsonRpcFrame(null)).toBe(false)
    expect(isJsonRpcFrame('2.0')).toBe(false)
  })

  test('component method names round-trip', () => {
    expect(componentUpdateMethod('health')).toBe('tictac/component/health/update')
    expect(parseComponentUpdateMethod('tictac/component/health/update')).toBe('health')
  })

  test('system commands are not mistaken for component updates', () => {
    for (const method of Object.values(RpcMethods)) {
      expect(parseComponentUpdateMethod(method)).toBeNull()
    }
  })

  test('every command type has a method', () => {
    const types: NetworkMessage['type'][] = [
      'init',
      'hello',
      'digest',
      'matchHeader',
      'log',
      'seated',
      'abort',
      'moveUnit',
      'fireShot',
      'throwGrenade',
      'reload',
      'toggleCover',
      'overwatch',
      'meleeAttack',
      'endUnitTurn',
      'endTurn',
      'retreat',
      'rightClickFacing',
      'useItem',
      'operateDoor',
      'ready',
    ]
    for (const type of types) expect(RpcMethods[type]).toBeTruthy()
    expect(new Set(Object.values(RpcMethods)).size).toBe(types.length)
  })
})

describe('A joiner that arrives after the host opened the match', () => {
  /**
   * The refereed case, which differs from peer-to-peer in one way that
   * matters: a data channel does not exist until a peer has joined it, so the
   * host's `init` always has a listener, while a socket to a referee exists
   * from the moment the host opens the match and the opponent connects
   * whenever they like. The referee relays live and keeps nothing for a
   * latecomer, so an opening announced into an empty room is gone — and both
   * sides then sit on their loadout screens waiting for each other. Modelled
   * with `loopback`, which drops a frame nobody is listening for, exactly as
   * the relay does.
   */
  test('is told the opening, and the squad the host already deployed', async () => {
    const [hostSide, joinerSide] = loopback()
    const host = new NetworkManager()
    host.attach(hostSide)
    host.hostMatch(4242, 'forty-two')

    const squad = rollSquadSheets().map((sheet, i) => ({ sheet, loadout: defaultLoadout(SQUAD_SIZE)[i]! }))
    host.send({ type: 'ready', squad })

    const joiner = new NetworkManager()
    joiner.attach(joinerSide)
    const opening = joiner.joinMatch()

    expect(await opening).toEqual({ seed: 4242, seedLabel: 'forty-two' })
    const brought = await joiner.waitForPeerReady()
    expect(brought?.squad.map((unit) => unit.sheet.attributes)).toEqual(squad.map((unit) => unit.sheet.attributes))
  })
})

describe('Command transport', () => {
  test('a command survives the round trip unchanged', () => {
    const { net, sent } = peered()
    const original: NetworkMessage = {
      type: 'fireShot',
      shooterFaction: Faction.Blue,
      shooterIndex: 0,
      targetFaction: Faction.Red,
      targetIndex: 2,
      mode: ShotMode.Aimed,
    }

    net.send(original)
    expect(sent[0]?.method).toBe(RpcMethods.fireShot)

    const receiver = peered('join')
    // Collected rather than assigned: a single `let` narrows to `null` here,
    // which silently picks the `toEqual(null)` overload and asserts nothing.
    const received: NetworkMessage[] = []
    receiver.net.onMessage = (msg) => {
      received.push(msg)
    }
    receiver.send(sent[0]!)

    expect(received[0]).toEqual(original)
  })

  test('local play transmits nothing', () => {
    const { net, sent } = peered('local')

    net.send({ type: 'endTurn', faction: Faction.Blue })

    expect(sent).toEqual([])
  })

  test('an unknown method is ignored rather than dispatched', () => {
    const { net, send } = peered()
    let received: NetworkMessage | null = null
    net.onMessage = (msg) => {
      received = msg
    }

    send({ jsonrpc: '2.0', method: 'tictac/system/nope', params: {} })

    expect(received).toBeNull()
  })

  test("a grenade's intent survives the round trip", () => {
    const { net, sent } = peered()
    const original: NetworkMessage = {
      type: 'throwGrenade',
      shooterFaction: Faction.Red,
      shooterIndex: 1,
      kind: GrenadeId.Frag,
      targetTile: { x: 4, y: 7 },
      targetLevel: 0,
    }

    net.send(original)
    expect(sent[0]?.method).toBe(RpcMethods.throwGrenade)

    const receiver = peered('join')
    const received: NetworkMessage[] = []
    receiver.net.onMessage = (msg) => {
      received.push(msg)
    }
    receiver.send(sent[0]!)

    expect(received[0]).toEqual(original)
  })

  test('a ready frame is recorded even before a match is listening', async () => {
    const { net, send } = peered('join')
    const received: NetworkMessage[] = []

    // No `onMessage` yet: this side is still on its own loadout screen.
    send({ jsonrpc: '2.0', method: RpcMethods.ready, params: {} })
    net.onMessage = (msg) => {
      received.push(msg)
    }

    await net.waitForPeerReady()
    expect(received).toEqual([])
  })

  test('local play never waits for a peer', async () => {
    const net = new NetworkManager()
    await net.waitForPeerReady()
  })
})

describe('Component replication', () => {
  /** Own everything unless a test says otherwise. */
  const ownAll = () => true

  test('a component mutation is transmitted without being announced', () => {
    const { net, sent } = peered()
    const world = new World()
    net.bindWorld(world, ownAll)

    const entity = world.createEntity()
    const health = world.addComponent(entity, new HealthComponent(100, 100))
    sent.length = 0

    health.hp = 55
    world.syncDirty()

    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'tictac/component/health/update',
        params: { entityId: entity, hp: 55, maxHp: 100, withdrawn: false },
      },
    ])
  })

  test('a global rules edit rides the same channel as unit state', () => {
    const { net, sent } = peered()
    const world = new World()
    createGlobalRules(world)
    net.bindWorld(world, ownAll)
    sent.length = 0

    const original = RULES.moveSpeed
    try {
      RULES.moveSpeed = 9
      world.syncDirty()
    } finally {
      RULES.moveSpeed = original
    }

    const frame = sent.find((f) => f.method === componentUpdateMethod(MatchRulesComponent.componentName))
    expect(frame).toBeDefined()
    expect((frame!.params as Record<string, unknown>).moveSpeed).toBe(9)
  })

  test('local play replicates nothing', () => {
    const { net, sent } = peered('local')
    const world = new World()
    net.bindWorld(world, ownAll)

    const entity = world.createEntity()
    world.addComponent(entity, new HealthComponent(100, 100))

    expect(sent).toEqual([])
  })

  test('state for an entity this peer does not own is never transmitted', () => {
    const { net, sent } = peered()
    const world = new World()
    const mine = world.createEntity()
    const theirs = world.createEntity()
    net.bindWorld(world, (entityId) => entityId === mine)

    const ours = world.addComponent(mine, new HealthComponent(100, 100))
    const foreign = world.addComponent(theirs, new HealthComponent(100, 100))
    sent.length = 0

    ours.hp = 50
    foreign.hp = 50
    world.syncDirty()

    expect(sent.map((f) => (f.params as Record<string, unknown>).entityId)).toEqual([mine])
  })

  test('a peer may not rewrite state this side is authoritative for', () => {
    const { net, send } = peered()
    const world = new World()
    const mine = world.createEntity()
    net.bindWorld(world, (entityId) => entityId === mine)
    world.addComponent(mine, new HealthComponent(100, 100))

    send({
      jsonrpc: '2.0',
      method: componentUpdateMethod('health'),
      params: { entityId: mine, hp: 1, maxHp: 100 },
    })

    expect(world.getComponent(mine, HealthComponent)?.hp).toBe(100)
  })

  test('an inbound component update lands in the world and is not echoed', () => {
    const { net, sent, send } = peered('join')
    const world = new World()
    const theirs = world.createEntity()
    net.bindWorld(world, () => false)
    world.addComponent(theirs, new HealthComponent(100, 100))
    sent.length = 0

    let notified = false
    net.onComponentUpdate = () => {
      notified = true
    }

    send({
      jsonrpc: '2.0',
      method: componentUpdateMethod('health'),
      params: { entityId: theirs, hp: 30, maxHp: 100 },
    })
    world.syncDirty()

    expect(world.getComponent(theirs, HealthComponent)?.hp).toBe(30)
    expect(notified).toBe(true)
    expect(sent).toEqual([])
  })

  test('an update for an unknown entity is dropped quietly', () => {
    const { net, send } = peered('join')
    const world = new World()
    net.bindWorld(world, () => false)

    let notified = false
    net.onComponentUpdate = () => {
      notified = true
    }

    send({
      jsonrpc: '2.0',
      method: componentUpdateMethod('health'),
      params: { entityId: 999, hp: 30, maxHp: 100 },
    })

    expect(notified).toBe(false)
  })
})

describe('The start handshake carries each peer its own squad', () => {
  test('a squad sent with `ready` arrives as the sheets and kit that were sent', async () => {
    const { net, sent } = peered()
    const mine = rollSquadSheets(new Rng(7))
    const kit = defaultLoadout()
    const squad = mine.map((sheet, i) => ({ sheet, loadout: kit[i]! }))
    net.send({ type: 'ready', squad })

    expect(sent[0]?.method).toBe(RpcMethods.ready)

    const receiver = peered('join')
    receiver.send(sent[0]!)

    // Locally rolled sheets are already inside the envelope, so sanitising at
    // the edge must leave them untouched — the barrier is for hostile input,
    // not a filter every honest squad has to survive.
    const peer = await receiver.net.waitForPeerReady()
    expect(peer?.squad.map((d) => d.sheet)).toEqual(mine)
    // And the kit arrives with them: a referee rebuilds the match from its
    // intents, and what a squad is carrying is not one of them.
    expect(peer?.squad.map((d) => d.loadout)).toEqual(kit)
  })

  test('kit this build cannot read is refused, and the squad still arrives', async () => {
    // Deliberately harsher than the sheet beside it: a wrong sheet costs
    // display accuracy, a wrong weapon changes what every shot does. So the
    // whole squad's kit is dropped rather than patched, and the other side
    // deploys on the stock spread it had already assumed.
    const { net, send } = peered('join')
    const sheets = rollSquadSheets(new Rng(5))
    send({
      jsonrpc: '2.0',
      method: RpcMethods.ready,
      params: {
        squad: sheets.map((sheet, i) => ({
          sheet,
          ...(i === 0 ? { loadout: { weaponId: 'railgun', ammoId: 'standard' } } : {}),
        })),
      },
    })

    const peer = await net.waitForPeerReady()
    expect(peer?.squad).toHaveLength(SQUAD_SIZE)
    expect(peer?.squad.every((d) => d.loadout === undefined)).toBe(true)
  })

  test('`ready` is never delivered as a command', async () => {
    // It can land while the peer is still on its loadout screen, where there
    // is no `onMessage` to receive it: the barrier has to resolve regardless.
    const { net, send } = peered('join')
    const commands: NetworkMessage[] = []
    net.onMessage = (msg) => {
      commands.push(msg)
    }

    send({
      jsonrpc: '2.0',
      method: RpcMethods.ready,
      params: { squad: rollSquadSheets(new Rng(11)).map((sheet) => ({ sheet })) },
    })

    expect((await net.waitForPeerReady())?.squad).toHaveLength(SQUAD_SIZE)
    expect(commands).toEqual([])
  })

  test('a squad of nonsense is taken apart before it can be played against', async () => {
    const { net, send } = peered('join')

    send({
      jsonrpc: '2.0',
      method: RpcMethods.ready,
      params: {
        squad: [
          {
            sheet: {
              attributes: { health: 1e9, agility: 999, strength: NaN, intelligence: -5 },
              maxHp: 1e9,
              traits: ['toString', 'stoic'],
              specialism: 'x',
            },
          },
          'not a deployment',
          null,
        ],
      },
    })

    const peer = await net.waitForPeerReady()
    expect(peer).not.toBeNull()
    const first = peer!.squad[0]!.sheet
    expect(first.attributes.health).toBe(CHARACTER.attribute.max)
    expect(first.attributes.agility).toBe(CHARACTER.attribute.max)
    expect(first.attributes.intelligence).toBe(CHARACTER.attribute.min)
    // The ceiling it tried to state is not a field, so it cannot arrive: what
    // this side plays against is derived from the attributes above.
    expect(first).not.toHaveProperty('maxHp')
    expect(derive(first).maxHp).toBe(CHARACTER.hp.max)
    // A key off the prototype is not a trait, and the real one beside it lives.
    expect(first.traits).toEqual([TraitId.Stoic])
    expect(Object.values(WeaponId)).toContain(first.specialism)
  })

  test('a missing squad still lifts the barrier', async () => {
    // A peer that sends `ready` with nothing in it must not hang the match
    // behind a promise that never resolves; the units keep the sheets this side
    // rolled for them.
    const { net, send } = peered('join')
    send({ jsonrpc: '2.0', method: RpcMethods.ready, params: {} })

    expect((await net.waitForPeerReady())?.squad).toEqual([])
  })

  test('local play has no peer to wait for', async () => {
    const net = new NetworkManager()
    net.mode = 'local'
    expect(await net.waitForPeerReady()).toBeNull()
  })
})

describe('A match over a linked pair, with no broker', () => {
  test('two managers exchange a handshake, a squad and a command', async () => {
    const [ours, theirs] = loopback()
    const host = new NetworkManager()
    const joiner = new NetworkManager()
    // Both attached before either speaks, which is what an open channel means:
    // each side's `open` fires before the other has said anything.
    host.attach(ours)
    joiner.attach(theirs)

    const seen: NetworkMessage[] = []
    joiner.onMessage = (msg) => seen.push(msg)
    const refusals: string[] = []
    host.onDisconnected = (reason) => refusals.push(reason ?? '')
    joiner.onDisconnected = (reason) => refusals.push(reason ?? '')

    const opening = joiner.joinMatch()
    host.hostMatch(42, 'forty-two')
    expect(await opening).toEqual({ seed: 42, seedLabel: 'forty-two' })
    // The roles come with the handshake, not with the channel: Blue moves
    // first and the host is Blue.
    expect([host.mode, host.myFaction]).toEqual(['host', Faction.Blue])
    expect([joiner.mode, joiner.myFaction]).toEqual(['join', Faction.Red])

    const sheets = rollSquadSheets(new Rng(3))
    const kit = defaultLoadout()
    host.send({ type: 'ready', squad: sheets.map((sheet, i) => ({ sheet, loadout: kit[i]! })) })
    expect((await joiner.waitForPeerReady())?.squad.map((d) => d.sheet)).toEqual(sheets)

    host.send({ type: 'endTurn', faction: Faction.Blue })

    expect(seen.map((m) => m.type)).toEqual(['init', 'endTurn'])
    expect(refusals).toEqual([])
  })

  test('a channel that goes away is reported once, and carries nothing after', () => {
    const { net, sent, peer } = peered('join')
    const reasons: string[] = []
    net.onDisconnected = (reason) => reasons.push(reason ?? '')

    peer.close()
    net.send({ type: 'endTurn', faction: Faction.Red })

    expect(reasons).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test('a blow sent as an intent lands the same on both sides', () => {
    // Two peers holding the same match, each resolving on its own world: the
    // wire carries who struck whom and nothing about how it went.
    const loadout = defaultLoadout()
    loadout[0]!.sidearm = MeleeId.Knife
    const header: RecordingHeader = {
      version: RECORDING_VERSION,
      seed: 7,
      seedLabel: 'seven',
      source: 'live',
      createdAt: '2026-01-01T00:00:00.000Z',
      turnCap: null,
      squads: {
        [Faction.Blue]: rollSquadSheets(new Rng(1)).map((sheet, i) => ({ sheet, loadout: loadout[i]! })),
        [Faction.Red]: rollSquadSheets(new Rng(2)).map((sheet, i) => ({ sheet, loadout: defaultLoadout()[i]! })),
      },
    }
    const ours = new MatchHost(header)
    const theirs = new MatchHost(header)

    // Walk-free setup, identical on both: put the knife beside an enemy. The
    // same seed makes the same map, so the tile found on one side is legal on
    // the other.
    const target = ours.squads.byFaction[Faction.Red][0]!
    const attacker = ours.squads.byFaction[Faction.Blue][0]!
    const beside = [-1, 0, 1]
      .flatMap((dx) => [-1, 0, 1].map((dy) => ({ x: target.tile.x + dx, y: target.tile.y + dy })))
      .find((tile) => {
        if (!ours.grid.isWalkable(tile.x, tile.y)) return false
        attacker.tile = tile
        return canMelee(ours.grid, attacker, target)
      })
    expect(beside).toBeDefined()
    theirs.squads.byFaction[Faction.Blue][0]!.tile = beside!

    const [a, b] = loopback()
    const sender = new NetworkManager()
    const receiver = new NetworkManager()
    sender.mode = 'host'
    receiver.mode = 'join'
    sender.attach(a)
    receiver.attach(b)
    const theirResults: (ShotResult | undefined)[] = []
    receiver.onMessage = (msg) => {
      const applied = theirs.apply(msg)
      theirResults.push(applied.applied ? applied.shot : undefined)
    }

    // Every blow the knife can afford, so the dice are exercised beyond one.
    const ourResults: (ShotResult | undefined)[] = []
    const intent: NetworkMessage = {
      type: 'meleeAttack',
      attackerFaction: Faction.Blue,
      attackerIndex: 0,
      targetFaction: Faction.Red,
      targetIndex: 0,
    }
    while (canMelee(ours.grid, attacker, target)) {
      const applied = ours.apply(intent)
      expect(applied.applied).toBe(true)
      ourResults.push(applied.applied ? applied.shot : undefined)
      sender.send(intent)
    }

    const theirTarget = theirs.squads.byFaction[Faction.Red][0]!
    // Otherwise "the same HP" could be two untouched units agreeing.
    expect(ourResults.some((shot) => shot?.hit)).toBe(true)
    expect(target.hp).toBeLessThan(target.maxHp)
    expect(theirResults).toEqual(ourResults)
    expect(theirTarget.hp).toBe(target.hp)
    expect(theirTarget.armor).toBe(target.armor)
    expect(theirs.squads.byFaction[Faction.Blue][0]!.ap).toBe(attacker.ap)
  })
})

/**
 * A socket server standing in for a referee.
 *
 * A real `Bun.serve`, not a fake socket: the codec, the queue in front of a
 * socket that has not opened yet and a close that carries a reason are only
 * worth asserting against something that genuinely needs a string and
 * genuinely takes a moment to connect.
 */
function refereeSocket(onOpen: (client: SocketClient) => void) {
  const heard: string[] = []
  const waiting: (() => void)[] = []
  const server = Bun.serve({
    port: 0,
    fetch: (request, self) =>
      self.upgrade(request) ? undefined : new Response('expected a websocket', { status: 400 }),
    websocket: {
      open: (ws) =>
        onOpen({
          send: (frame) => ws.send(JSON.stringify(frame)),
          sendRaw: (text) => ws.send(text),
          sendBytes: (bytes) => ws.send(bytes),
          close: (code, reason) => ws.close(code, reason),
        }),
      message(_ws, message) {
        // Kept as the exact text, never parsed here: one codec means a frame is
        // the same bytes on every transport, and that is only observable from
        // the far end of a real socket.
        heard.push(typeof message === 'string' ? message : '<not text>')
        for (const resume of waiting.splice(0)) resume()
      },
    },
  })
  return {
    heard,
    url: `ws://localhost:${server.port}`,
    /** Resolves on the next frame this server is told. */
    nextHeard: () => new Promise<void>((resolve) => waiting.push(resolve)),
    stop: () => server.stop(true),
  }
}

interface SocketClient {
  send(frame: JsonRpcFrame): void
  sendRaw(text: string): void
  sendBytes(bytes: Uint8Array): void
  close(code: number, reason: string): void
}

const openingFrame = (over: Record<string, unknown> = {}): JsonRpcFrame => ({
  jsonrpc: '2.0',
  method: RpcMethods.init,
  params: { seed: 21, seedLabel: '21', ...MY_VERSION, ...over },
})

describe('A match over a socket, as a referee would host one', () => {
  test('the handshake crosses as JSON text, including what was written before the socket opened', async () => {
    const server = refereeSocket((client) => client.send(openingFrame()))
    const net = new NetworkManager()
    try {
      const hello = server.nextHeard()
      net.attach(new SocketTransport(new WebSocket(server.url)))
      // `hello` goes out while the socket is still connecting: queued, because
      // a dropped opening word is a handshake that never completes.
      const opening = net.joinMatch()

      expect(await opening).toEqual({ seed: 21, seedLabel: '21' })
      await hello
      expect(server.heard).toEqual([
        JSON.stringify({ jsonrpc: '2.0', method: RpcMethods.hello, params: { ...MY_VERSION } }),
      ])
    } finally {
      net.dispose()
      server.stop()
    }
  })

  test('a mismatched build is refused over a socket exactly as over a data channel', async () => {
    const server = refereeSocket((client) => client.send(openingFrame({ build: 'c0ffee1' })))
    const net = new NetworkManager()
    const refused = Promise.withResolvers<string>()
    net.onDisconnected = (reason) => refused.resolve(reason ?? '')
    const seen: NetworkMessage[] = []
    net.onMessage = (msg) => seen.push(msg)
    try {
      net.attach(new SocketTransport(new WebSocket(server.url)))

      // The seed rode in that same frame and is not taken: a peer on another
      // build is not a peer whose numbers mean anything here.
      await expect(net.joinMatch()).rejects.toThrow('c0ffee1')
      expect(seen).toEqual([])

      // And the same frame over a linked pair, which is what "exactly as"
      // means: the gate belongs to the manager, so the medium does not get a
      // say in the verdict or in how it is worded for the player.
      const linked = peered('join')
      const overLinked: string[] = []
      linked.net.onDisconnected = (reason) => overLinked.push(reason ?? '')
      linked.send(openingFrame({ build: 'c0ffee1' }))
      expect(await refused.promise).toBe(overLinked[0]!)
    } finally {
      net.dispose()
      server.stop()
    }
  })

  test('a protocol this build cannot parse is refused too', async () => {
    const server = refereeSocket((client) =>
      client.send(openingFrame({ protocol: PROTOCOL_VERSION + 1 })),
    )
    const net = new NetworkManager()
    try {
      net.attach(new SocketTransport(new WebSocket(server.url)))
      await expect(net.joinMatch()).rejects.toThrow('Protocol')
    } finally {
      net.dispose()
      server.stop()
    }
  })

  test('junk on the socket is dropped and the match still opens', async () => {
    const server = refereeSocket((client) => {
      client.sendRaw('half a frame {')
      client.sendRaw(JSON.stringify({ not: 'a frame' }))
      client.sendBytes(new Uint8Array([1, 2, 3]))
      client.send(openingFrame())
    })
    const net = new NetworkManager()
    try {
      net.attach(new SocketTransport(new WebSocket(server.url)))

      expect(await net.joinMatch()).toEqual({ seed: 21, seedLabel: '21' })
    } finally {
      net.dispose()
      server.stop()
    }
  })

  test('a socket that closes mid-match reports the reason it was given', async () => {
    const clients: SocketClient[] = []
    const server = refereeSocket((client) => {
      clients.push(client)
      client.send(openingFrame())
    })
    const net = new NetworkManager()
    const dropped = Promise.withResolvers<string>()
    net.onDisconnected = (reason) => dropped.resolve(reason ?? '')
    try {
      net.attach(new SocketTransport(new WebSocket(server.url)))
      await net.joinMatch()

      clients[0]!.close(4001, 'the referee stopped')

      // The stated reason, not a code: a player told "disconnected" cannot act
      // on it, and an abort names a side and a cause.
      expect(await dropped.promise).toBe('the referee stopped')
    } finally {
      net.dispose()
      server.stop()
    }
  })
})

const notify = (method: string, params: Record<string, unknown>): JsonRpcFrame => ({ jsonrpc: '2.0', method, params })

const opening: RecordingHeader = {
  version: RECORDING_VERSION,
  seed: 77,
  seedLabel: '77',
  source: 'live',
  createdAt: '',
  turnCap: null,
  squads: {
    [Faction.Blue]: rollSquadSheets(new Rng(1)).map((sheet, i) => ({ sheet, loadout: defaultLoadout(SQUAD_SIZE)[i]! })),
    [Faction.Red]: rollSquadSheets(new Rng(2)).map((sheet, i) => ({ sheet, loadout: defaultLoadout(SQUAD_SIZE)[i]! })),
  },
}

/** A window's connection to a `handServer`, signed in as nobody. */
function windowOn(server: HandServer, clock: HandClock): ServerConnection {
  return new ServerConnection('ws://tictac.test/', { connect: server.connect, schedule: clock.schedule, tokens: heldTokens() })
}

describe('Entering a room on a match server', () => {
  const seat: Seated = { roomId: 'r00m', faction: Faction.Red, phase: 'playing', redirected: true, seatKey: 'k3y' }
  const logged = [{ seq: 0, turn: 1, faction: Faction.Blue, command: { type: 'endTurn', faction: Faction.Blue } }]

  test('asks for its place after hello, and is told its seat and then the match so far', async () => {
    const clock = handClock()
    const server = handServer(clock)
    server.answer = (socket, request) => {
      socket.reply(request.id as number, seat)
      socket.send(notify(RpcMethods.log, { matchId: 'r00m', header: opening, events: logged }))
    }
    const net = new NetworkManager()
    const seen: NetworkMessage[] = []
    net.onMessage = (msg) => seen.push(msg)

    expect(await net.enterRoom(windowOn(server, clock), { kind: 'watch', roomId: 'r00m' })).toEqual(seat)
    // Nothing about the room rides in the url; it is asked for.
    expect(server.last.url.search).toBe('')
    expect(server.last.heard).toEqual([
      notify(RpcMethods.hello, { ...MY_VERSION }),
      { jsonrpc: '2.0', id: 1, method: 'tictac/api/room/enter', params: { intent: { kind: 'watch', roomId: 'r00m' } } },
    ])

    // The seat decides who this side is; the answer that said so is never
    // mistaken for a move.
    expect([net.mode, net.myFaction]).toEqual(['join', Faction.Red])

    // Sent straight after the answer, and still there when asked for.
    const log = await net.waitForLog()
    expect(log.matchId).toBe('r00m')
    expect(log.header.seed).toBe(77)
    expect(log.events.map((event) => event.command)).toEqual([{ type: 'endTurn', faction: Faction.Blue }])
    expect(seen).toEqual([])
  })

  test('a refusal is the reason entering failed, the log will not come either, and the server stays', async () => {
    const clock = handClock()
    const server = handServer(clock)
    server.answer = (socket, request) => socket.refuse(request.id as number, 410, 'That match is gone.')
    const connection = windowOn(server, clock)
    const net = new NetworkManager()
    const log = net.waitForLog()

    await expect(net.enterRoom(connection, { kind: 'join', roomId: 'nowhere' })).rejects.toThrow('That match is gone.')
    await expect(log).rejects.toThrow('That match is gone.')
    expect(connection.state).toEqual({ kind: 'open' })
  })

  test('a socket that goes before the seat says so rather than waiting forever', async () => {
    const clock = handClock()
    const server = handServer(clock)
    server.answer = (socket) => socket.drop()
    const net = new NetworkManager()
    await expect(net.enterRoom(windowOn(server, clock), { kind: 'open' })).rejects.toThrow('dropped')
  })

  test('a log this build cannot read is refused, not built from', async () => {
    const { net, send } = peered('join')
    const refused: string[] = []
    net.onDisconnected = (reason) => refused.push(reason ?? '')
    const log = net.waitForLog()
    send(notify(RpcMethods.log, { matchId: 'r00m', header: { ...opening, version: -1 }, events: [] }))
    await expect(log).rejects.toThrow('cannot read')
    expect(refused).toHaveLength(1)
  })
})

describe('A side that arrives in the middle of a match', () => {
  test('keeps every intent relayed before it could listen, and hands them over in order', () => {
    const { net, send } = peered('join')
    const move = { type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 1, y: 2 }] }
    send(notify(RpcMethods.moveUnit, { faction: Faction.Blue, squadIndex: 0, path: [{ x: 1, y: 2 }] }))
    send(notify(RpcMethods.reload, { faction: Faction.Blue, squadIndex: 1 }))
    send(notify(RpcMethods.endTurn, { faction: Faction.Blue }))

    const heard: NetworkMessage[] = []
    net.onMessage = (msg) => heard.push(msg)
    expect(heard).toEqual([
      move as NetworkMessage,
      { type: 'reload', faction: Faction.Blue, squadIndex: 1 },
      { type: 'endTurn', faction: Faction.Blue },
    ])

    // Once is enough: a handler assigned again is not handed them twice.
    const again: NetworkMessage[] = []
    net.onMessage = (msg) => again.push(msg)
    expect(again).toEqual([])
  })

  test('a handler that steps aside after one leaves the rest for the next', () => {
    const { net, send } = peered('join')
    send(notify(RpcMethods.reload, { faction: Faction.Blue, squadIndex: 1 }))
    send(notify(RpcMethods.endTurn, { faction: Faction.Blue }))

    const first: NetworkMessage[] = []
    net.onMessage = (msg) => {
      first.push(msg)
      net.onMessage = null
    }
    expect(first.map((m) => m.type)).toEqual(['reload'])
    const rest: NetworkMessage[] = []
    net.onMessage = (msg) => rest.push(msg)
    expect(rest.map((m) => m.type)).toEqual(['endTurn'])
  })
})

describe('A spectator', () => {
  test('says nothing after entering: no commands, no digests, no replicated state', async () => {
    const clock = handClock()
    const server = handServer(clock)
    server.answer = (socket, request) =>
      socket.reply(request.id as number, { roomId: 'r00m', faction: null, phase: 'playing', redirected: false, seatKey: null })
    const net = new NetworkManager()
    await net.enterRoom(windowOn(server, clock), { kind: 'watch', roomId: 'r00m' })
    const socket = server.last
    const before = socket.heard.length
    expect(net.mode).toBe('spectate')
    expect(net.isMyTurn(Faction.Blue)).toBe(false)
    expect(net.isMyTurn(Faction.Red)).toBe(false)

    // Everything a seat would have put on the wire, through every door it has.
    const world = new World()
    net.bindWorld(world, () => true)
    const health = world.addComponent(world.createEntity(), new HealthComponent(100, 100))
    health.hp = 55
    world.syncDirty()
    net.send({ type: 'endTurn', faction: Faction.Blue })
    net.send({ type: 'ready', squad: [] })
    net.sendRpc(notify(RpcMethods.digest, { digest: {} }))
    // A hello relayed to it would make a seat restate its opening; a
    // spectator has none to restate, and would not say it if it had.
    socket.send(notify(RpcMethods.hello, { ...MY_VERSION }))

    expect(socket.heard.slice(before)).toEqual([])
  })
})

describe('A window that loses its socket to the match server', () => {
  const move: NetworkMessage = { type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 1, y: 2 }] }
  const blueEnds: NetworkMessage = { type: 'endTurn', faction: Faction.Blue }
  const cover: NetworkMessage = { type: 'toggleCover', faction: Faction.Red, squadIndex: 1 }
  const redEnds: NetworkMessage = { type: 'endTurn', faction: Faction.Red }
  const seatIn = (phase: 'waiting' | 'deploying' | 'playing', over: Partial<Seated> = {}): Seated => ({
    roomId: 'r00m',
    faction: Faction.Blue,
    phase,
    redirected: false,
    seatKey: 'k3y',
    ...over,
  })
  const logOf = (commands: NetworkMessage[]) =>
    notify(RpcMethods.log, {
      matchId: 'r00m',
      header: opening,
      events: commands.map((command, seq) => ({ seq, turn: 1, faction: command.type === 'toggleCover' ? Faction.Red : Faction.Blue, command })),
    })
  const wire = (command: NetworkMessage) => {
    const { type, ...params } = command
    return notify(RpcMethods[type], params)
  }
  /** A server that seats every `room/enter` at `seat`, and follows it with `then` (a match's log). */
  const seating = (seat: Seated, then?: JsonRpcFrame) => (socket: HandSocket, request: JsonRpcRequest) => {
    if (request.method !== 'tictac/api/room/enter') return
    socket.reply(request.id as number, seat)
    if (then) socket.send(then)
  }
  /** What each `room/enter` on `sockets` asked for. */
  const intentsOn = (sockets: HandSocket[]) =>
    sockets.flatMap((socket) =>
      socket.heard.flatMap((frame) =>
        'method' in frame && frame.method === 'tictac/api/room/enter' ? [(frame.params as { intent: unknown }).intent] : [],
      ),
    )

  /** Blue, seated in `phase`, and everything it was told. */
  async function seatedBlue(phase: 'waiting' | 'deploying' | 'playing') {
    const clock = handClock()
    const server = handServer(clock)
    server.answer = seating(seatIn(phase))
    const net = new NetworkManager()
    const told = { attempts: [] as number[], reconnected: [] as Seated[], resyncs: [] as Resync[], disconnects: [] as string[] }
    net.onReconnecting = (attempt) => told.attempts.push(attempt)
    net.onReconnected = (seat) => told.reconnected.push(seat)
    net.onResync = (resync) => told.resyncs.push(resync)
    net.onDisconnected = (reason) => told.disconnects.push(reason ?? '')
    const connection = windowOn(server, clock)
    await net.enterRoom(connection, { kind: 'open' })
    return { clock, server, net, connection, told }
  }

  test('tries again on a backoff, quick at first, and says which try it is on', async () => {
    const { clock, server, net, told } = await seatedBlue('playing')
    server.down = true
    server.last.drop()
    // Nothing is reported as over: the window is getting its seat back.
    expect(told.disconnects).toEqual([])
    expect(net.isMyTurn(Faction.Blue)).toBe(false)

    await clock.advance(30_000)
    const tries = server.sockets.slice(1).map((socket) => socket.at)
    // 250, +500, +1000, then every second: a try against a server that is
    // down costs nothing, and a longer wait is stall the player sees after
    // the server is already back.
    const gaps = tries.map((at, i) => at - (i === 0 ? 0 : tries[i - 1]!))
    expect(gaps.slice(0, 5)).toEqual([250, 500, 1000, 1000, 1000])
    expect(told.attempts).toEqual(told.attempts.map((_, i) => i + 1))
    expect(told.attempts.length).toBe(tries.length + 1)
    // Every try dials the server's own url and says hello first.
    expect(server.sockets.every((socket) => socket.url.href === 'ws://tictac.test/')).toBe(true)
    expect(server.last.methods[0]).toBe(RpcMethods.hello)
  })

  test('gives up once the seat would be gone, and says the connection was lost', async () => {
    const { clock, server, connection, told } = await seatedBlue('playing')
    server.down = true
    server.last.drop()
    await clock.advance(119_000)
    expect(told.disconnects).toEqual([])
    await clock.advance(1_000)
    expect(told.disconnects).toEqual([CONNECTION_LOST])
    expect(connection.state).toEqual({ kind: 'closed', reason: CONNECTION_LOST })
    const opened = server.sockets.length
    await clock.advance(60_000)
    expect(server.sockets.length).toBe(opened)
  })

  test('a try that is never answered is given up on for the next', async () => {
    const { clock, server } = await seatedBlue('playing')
    server.answer = null
    server.last.drop()
    await clock.advance(250)
    expect(server.sockets).toHaveLength(2)
    // A server still booting can hold a try open; it is let go after two
    // seconds, not left to add its whole wait to the stall.
    await clock.advance(1_999 + 500)
    expect(server.sockets).toHaveLength(2)
    await clock.advance(1)
    expect(server.sockets).toHaveLength(3)
  })

  test('a seat refused on the way back is the reason the match ended — and the window stays on the server', async () => {
    const { clock, server, connection, told } = await seatedBlue('playing')
    server.answer = (socket, request) => socket.refuse(request.id as number, 410, 'That match is gone.')
    server.last.drop()
    await clock.advance(250)
    expect(told.disconnects).toEqual(['That match is gone.'])
    expect(connection.state).toEqual({ kind: 'open' })
    await clock.advance(60_000)
    expect(server.sockets).toHaveLength(2)
    expect(told.disconnects).toHaveLength(1)
  })

  test('a window that let go of its match comes back to the server, not to the match', async () => {
    const { clock, server, net, told } = await seatedBlue('playing')
    net.dispose()
    expect(server.last.methods.at(-1)).toBe('tictac/api/room/leave')
    server.last.drop()
    await clock.advance(60_000)
    expect(server.sockets).toHaveLength(2)
    expect(intentsOn(server.sockets.slice(1))).toEqual([])
    expect(told.attempts).toEqual([])
  })

  test('back in a match, it is handed exactly what was relayed while it was away', async () => {
    const { clock, server, net, told } = await seatedBlue('playing')
    const heard: NetworkMessage[] = []
    net.onMessage = (msg) => heard.push(msg)
    net.send(move)
    net.send(blueEnds)
    server.last.send(wire(cover))
    server.last.drop()

    // Red played on while Blue was away; the server's log says so.
    server.answer = seating(seatIn('playing'), logOf([move, blueEnds, cover, redEnds]))
    await clock.advance(250)

    expect(told.reconnected).toEqual([seatIn('playing')])
    expect(told.resyncs).toEqual([{ kind: 'caughtUp', missed: 1 }])
    expect(heard).toEqual([cover, redEnds])
    expect([net.mode, net.isMyTurn(Faction.Blue)]).toEqual(['host', true])
    // Its own seat, by the key it came with; and nothing else on the way —
    // a match being played says nothing it has not played.
    expect(intentsOn([server.last])).toEqual([{ kind: 'resume', roomId: 'r00m', seatKey: 'k3y' }])
    expect(server.last.methods).toEqual([RpcMethods.hello, 'tictac/api/room/enter'])

    // And the stream goes on: the next drop compares against all of it.
    server.last.drop()
    await clock.advance(250)
    expect(told.resyncs[1]).toEqual({ kind: 'caughtUp', missed: 0 })
  })

  test('a command the server never got means the match is rebuilt from its log', async () => {
    const { clock, server, net, told } = await seatedBlue('playing')
    net.send(move)
    server.last.drop()
    // Played into a socket that was already gone.
    net.send(blueEnds)
    const heard: NetworkMessage[] = []
    server.answer = seating(seatIn('playing'), logOf([move]))
    await clock.advance(250)
    expect(told.resyncs).toHaveLength(1)
    const [resync] = told.resyncs
    expect(resync!.kind).toBe('rebuild')
    expect(resync!.kind === 'rebuild' && resync!.log.events.map((event) => event.command)).toEqual([move])
    net.onMessage = (msg) => heard.push(msg)
    expect(heard).toEqual([])
  })

  test('a log that disagrees anywhere, not just at the end, is a rebuild too', async () => {
    const { clock, server, net, told } = await seatedBlue('playing')
    net.send(move)
    net.send(blueEnds)
    server.last.drop()
    server.answer = seating(seatIn('playing'), logOf([{ ...move, path: [{ x: 9, y: 9 }] } as NetworkMessage, blueEnds, cover]))
    await clock.advance(250)
    expect(told.resyncs.map((r) => r.kind)).toEqual(['rebuild'])
  })

  test('back in a room being set up, it says again everything it had said', async () => {
    const { clock, server, net, told } = await seatedBlue('deploying')
    net.hostMatch(21, '21')
    const squad = rollSquadSheets(new Rng(3)).map((sheet) => ({ sheet }))
    server.last.drop()
    // Deployed while the socket was gone: kept, and said once it is back.
    net.send({ type: 'ready', squad })
    await clock.advance(250)
    expect(told.reconnected).toHaveLength(1)
    expect(server.last.methods).toEqual([
      RpcMethods.hello,
      'tictac/api/room/enter',
      RpcMethods.hello,
      RpcMethods.init,
      RpcMethods.ready,
    ])
    expect((server.last.heard[3] as JsonRpcNotification).params).toEqual({ seed: 21, seedLabel: '21', ...MY_VERSION })
  })

  test('a seat that comes back somewhere else is a lost match, said as one', async () => {
    const { clock, server, told } = await seatedBlue('playing')
    server.answer = seating(seatIn('playing', { faction: Faction.Red }))
    server.last.drop()
    await clock.advance(250)
    expect(told.disconnects).toHaveLength(1)
    expect(told.disconnects[0]).toContain('another seat')
  })

  test('a spectator watches again, and catches up on what it missed', async () => {
    const clock = handClock()
    const server = handServer(clock)
    const watching = seatIn('playing', { faction: null, seatKey: null })
    server.answer = seating(watching, logOf([move]))
    const net = new NetworkManager()
    const resyncs: Resync[] = []
    net.onResync = (resync) => resyncs.push(resync)
    await net.enterRoom(windowOn(server, clock), { kind: 'watch', roomId: 'r00m' })
    expect((await net.waitForLog()).events).toHaveLength(1)
    const heard: NetworkMessage[] = []
    net.onMessage = (msg) => heard.push(msg)
    server.last.send(wire(blueEnds))
    server.last.drop()

    server.answer = seating(watching, logOf([move, blueEnds, cover]))
    await clock.advance(250)
    expect(intentsOn([server.last])).toEqual([{ kind: 'watch', roomId: 'r00m' }])
    expect(resyncs).toEqual([{ kind: 'caughtUp', missed: 1 }])
    expect(heard).toEqual([blueEnds, cover])
  })
})
