import { describe, expect, test } from 'bun:test'
import { NetworkManager, type NetworkMessage, type NetworkMode } from '../src/game/NetworkManager'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CHARACTER, Faction, RULES, SQUAD_SIZE } from '../src/config'
import { GrenadeId, ShotMode, StatusKind, WeaponId } from '../src/core/Arsenal'
import { derive, rollSquadSheets } from '../src/core/Characters'
import { defaultLoadout } from '../src/game/Loadout'
import { MeleeId } from '../src/core/Melee'
import { canMelee, type ShotResult } from '../src/game/Combat'
import { RECORDING_VERSION, type RecordingHeader } from '../src/game/Recording'
import { MatchHost } from '../src/sim/MatchHost'
import { TraitId } from '../src/core/Traits'
import { Rng } from '../src/core/rng'
import { HealthComponent, MatchRulesComponent } from '../src/ecs/components'
import { MY_VERSION, PROTOCOL_VERSION } from '../src/version'
import { loopback } from '../src/game/Transport'
import { SocketTransport } from '../src/game/SocketTransport'
import {
  componentUpdateMethod,
  isJsonRpcFrame,
  type JsonRpcFrame,
  type JsonRpcNotification,
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
      'resume',
      'log',
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
      'rightClickFacing',
      'useItem',
      'ready',
    ]
    for (const type of types) expect(RpcMethods[type]).toBeTruthy()
    expect(new Set(Object.values(RpcMethods)).size).toBe(types.length)
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
        params: { entityId: entity, hp: 55, maxHp: 100 },
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
  test('a squad sent with `ready` arrives as the sheets that were rolled', async () => {
    const { net, sent } = peered()
    const mine = rollSquadSheets(new Rng(7))
    const kit = defaultLoadout()
    net.send({ type: 'ready', sheets: mine, loadout: kit })

    expect(sent[0]?.method).toBe(RpcMethods.ready)

    const receiver = peered('join')
    receiver.send(sent[0]!)

    // Locally rolled sheets are already inside the envelope, so sanitising at
    // the edge must leave them untouched — the barrier is for hostile input,
    // not a filter every honest squad has to survive.
    const peer = await receiver.net.waitForPeerReady()
    expect(peer?.sheets).toEqual(mine)
    // And the kit arrives with them: a referee rebuilds the match from its
    // intents, and what a squad is carrying is not one of them.
    expect(peer?.loadout).toEqual(kit)
  })

  test('kit this build cannot read is refused, and the squad still arrives', async () => {
    // Deliberately harsher than the sheets beside it: a wrong sheet costs
    // display accuracy, a wrong weapon changes what every shot does. So the
    // loadout is dropped rather than patched, and the other side deploys on the
    // stock spread it had already assumed.
    const { net, send } = peered('join')
    send({
      jsonrpc: '2.0',
      method: RpcMethods.ready,
      params: {
        sheets: rollSquadSheets(new Rng(5)),
        loadout: [{ weaponId: 'railgun', ammoId: 'standard' }],
      },
    })

    const peer = await net.waitForPeerReady()
    expect(peer?.sheets).toHaveLength(SQUAD_SIZE)
    expect(peer?.loadout).toBeNull()
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
      params: { sheets: rollSquadSheets(new Rng(11)) },
    })

    expect((await net.waitForPeerReady())?.sheets).toHaveLength(SQUAD_SIZE)
    expect(commands).toEqual([])
  })

  test('a squad of nonsense is taken apart before it can be played against', async () => {
    const { net, send } = peered('join')

    send({
      jsonrpc: '2.0',
      method: RpcMethods.ready,
      params: {
        sheets: [
          {
            attributes: { health: 1e9, agility: 999, strength: NaN, intelligence: -5 },
            maxHp: 1e9,
            traits: ['toString', 'stoic'],
            specialism: 'x',
          },
          'not a sheet',
          null,
        ],
      },
    })

    const peer = await net.waitForPeerReady()
    expect(peer).not.toBeNull()
    const first = peer!.sheets[0]!
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

    expect((await net.waitForPeerReady())?.sheets).toEqual([])
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

    const squad = rollSquadSheets(new Rng(3))
    host.send({ type: 'ready', sheets: squad, loadout: defaultLoadout() })
    expect((await joiner.waitForPeerReady())?.sheets).toEqual(squad)

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
      sheets: { [Faction.Blue]: rollSquadSheets(new Rng(1)), [Faction.Red]: rollSquadSheets(new Rng(2)) },
      loadouts: { [Faction.Blue]: loadout, [Faction.Red]: defaultLoadout() },
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
