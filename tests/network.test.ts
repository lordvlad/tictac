import { describe, expect, test } from 'bun:test'
import { NetworkManager, type NetworkMessage } from '../src/game/NetworkManager'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { CHARACTER, Faction, RULES, SQUAD_SIZE } from '../src/config'
import { GrenadeId, ShotMode, StatusKind, WeaponId } from '../src/core/Arsenal'
import { derive, rollSquadSheets } from '../src/core/Characters'
import { TraitId } from '../src/core/Traits'
import { Rng } from '../src/core/rng'
import { HealthComponent, MatchRulesComponent } from '../src/ecs/components'
import {
  componentUpdateMethod,
  isJsonRpcFrame,
  type JsonRpcNotification,
  parseComponentUpdateMethod,
  RpcMethods,
} from '../src/game/JsonRpc'

/** A manager wired to a fake channel, capturing everything it would transmit. */
function harness(mode: 'host' | 'join' = 'host') {
  const net = new NetworkManager()
  net.mode = mode
  const sent: JsonRpcNotification[] = []
  net.sendRpc = (frame) => {
    sent.push(frame as JsonRpcNotification)
  }
  return { net, sent }
}

/** Feed a frame in as though it arrived on the data channel. */
function receive(net: NetworkManager, frame: unknown): void {
  let onData: ((data: unknown) => void) | undefined
  const conn = {
    on: (event: string, cb: (data: unknown) => void) => {
      if (event === 'data') onData = cb
    },
  }
  ;(net as unknown as { setupConn: (c: typeof conn) => void }).setupConn(conn)
  onData?.(frame)
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
      'moveUnit',
      'fireShot',
      'throwGrenade',
      'reload',
      'toggleCover',
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
    const { net, sent } = harness()
    const original: NetworkMessage = {
      type: 'fireShot',
      shooterFaction: Faction.Blue,
      shooterIndex: 0,
      targetFaction: Faction.Red,
      targetIndex: 2,
      mode: ShotMode.Aimed,
      rolls: [true, false],
      // The number the receiver checks its own state against. A shot that
      // missed carries no damage to disagree about, so without this a whole
      // class of divergence is unobservable.
      chance: 64,
      hits: [
        { faction: Faction.Red, index: 2, damage: 34, armorShred: 5, status: null, crit: true },
        {
          faction: Faction.Red,
          index: 3,
          damage: 12,
          armorShred: 0,
          status: StatusKind.Shredded,
          crit: false,
        },
      ],
    }

    net.send(original)
    expect(sent[0]?.method).toBe(RpcMethods.fireShot)

    const receiver = new NetworkManager()
    receiver.mode = 'join'
    // Collected rather than assigned: a single `let` narrows to `null` here,
    // which silently picks the `toEqual(null)` overload and asserts nothing.
    const received: NetworkMessage[] = []
    receiver.onMessage = (msg) => {
      received.push(msg)
    }
    receive(receiver, sent[0])

    expect(received[0]).toEqual(original)
  })

  test('local play transmits nothing', () => {
    const { net, sent } = harness()
    net.mode = 'local'

    net.send({ type: 'endTurn', faction: Faction.Blue })

    expect(sent).toEqual([])
  })

  test('an unknown method is ignored rather than dispatched', () => {
    const net = new NetworkManager()
    let received: NetworkMessage | null = null
    net.onMessage = (msg) => {
      received = msg
    }

    receive(net, { jsonrpc: '2.0', method: 'tictac/system/nope', params: {} })

    expect(received).toBeNull()
  })

  test("a grenade's resolved effects survive the round trip", () => {
    const { net, sent } = harness()
    const original: NetworkMessage = {
      type: 'throwGrenade',
      shooterFaction: Faction.Red,
      shooterIndex: 1,
      kind: GrenadeId.Frag,
      targetTile: { x: 4, y: 7 },
      areaRadius: 2.5,
      hits: [
        {
          faction: Faction.Blue,
          index: 0,
          damage: 40,
          armorShred: 10,
          status: StatusKind.Shredded,
          crit: false,
        },
        { faction: Faction.Red, index: 1, damage: 0, armorShred: 0, status: null, crit: false },
      ],
    }

    net.send(original)
    expect(sent[0]?.method).toBe(RpcMethods.throwGrenade)

    const receiver = new NetworkManager()
    receiver.mode = 'join'
    const received: NetworkMessage[] = []
    receiver.onMessage = (msg) => {
      received.push(msg)
    }
    receive(receiver, sent[0])

    expect(received[0]).toEqual(original)
  })

  test('a ready frame is recorded even before a match is listening', async () => {
    const net = new NetworkManager()
    net.mode = 'join'
    const received: NetworkMessage[] = []

    // No `onMessage` yet: this side is still on its own loadout screen.
    receive(net, { jsonrpc: '2.0', method: RpcMethods.ready, params: {} })
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
    const { net, sent } = harness()
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
    const { net, sent } = harness()
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
    const { net, sent } = harness()
    net.mode = 'local'
    const world = new World()
    net.bindWorld(world, ownAll)

    const entity = world.createEntity()
    world.addComponent(entity, new HealthComponent(100, 100))

    expect(sent).toEqual([])
  })

  test('state for an entity this peer does not own is never transmitted', () => {
    const { net, sent } = harness()
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
    const { net } = harness()
    const world = new World()
    const mine = world.createEntity()
    net.bindWorld(world, (entityId) => entityId === mine)
    world.addComponent(mine, new HealthComponent(100, 100))

    receive(net, {
      jsonrpc: '2.0',
      method: componentUpdateMethod('health'),
      params: { entityId: mine, hp: 1, maxHp: 100 },
    })

    expect(world.getComponent(mine, HealthComponent)?.hp).toBe(100)
  })

  test('an inbound component update lands in the world and is not echoed', () => {
    const { net, sent } = harness('join')
    const world = new World()
    const theirs = world.createEntity()
    net.bindWorld(world, () => false)
    world.addComponent(theirs, new HealthComponent(100, 100))
    sent.length = 0

    let notified = false
    net.onComponentUpdate = () => {
      notified = true
    }

    receive(net, {
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
    const { net } = harness('join')
    const world = new World()
    net.bindWorld(world, () => false)

    let notified = false
    net.onComponentUpdate = () => {
      notified = true
    }

    receive(net, {
      jsonrpc: '2.0',
      method: componentUpdateMethod('health'),
      params: { entityId: 999, hp: 30, maxHp: 100 },
    })

    expect(notified).toBe(false)
  })
})

describe('The start handshake carries each peer its own squad', () => {
  test('a squad sent with `ready` arrives as the sheets that were rolled', async () => {
    const { net, sent } = harness()
    const mine = rollSquadSheets(new Rng(7))
    net.send({ type: 'ready', sheets: mine })

    expect(sent[0]?.method).toBe(RpcMethods.ready)

    const receiver = new NetworkManager()
    receiver.mode = 'join'
    receive(receiver, sent[0])

    // Locally rolled sheets are already inside the envelope, so sanitising at
    // the edge must leave them untouched — the barrier is for hostile input,
    // not a filter every honest squad has to survive.
    expect(await receiver.waitForPeerReady()).toEqual(mine)
  })

  test('`ready` is never delivered as a command', async () => {
    // It can land while the peer is still on its loadout screen, where there
    // is no `onMessage` to receive it: the barrier has to resolve regardless.
    const receiver = new NetworkManager()
    receiver.mode = 'join'
    const commands: NetworkMessage[] = []
    receiver.onMessage = (msg) => {
      commands.push(msg)
    }

    receive(receiver, {
      jsonrpc: '2.0',
      method: RpcMethods.ready,
      params: { sheets: rollSquadSheets(new Rng(11)) },
    })

    expect(await receiver.waitForPeerReady()).toHaveLength(SQUAD_SIZE)
    expect(commands).toEqual([])
  })

  test('a squad of nonsense is taken apart before it can be played against', async () => {
    const receiver = new NetworkManager()
    receiver.mode = 'join'

    receive(receiver, {
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

    const peer = await receiver.waitForPeerReady()
    expect(peer).not.toBeNull()
    const first = peer![0]!
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
    const receiver = new NetworkManager()
    receiver.mode = 'join'
    receive(receiver, { jsonrpc: '2.0', method: RpcMethods.ready, params: {} })

    expect(await receiver.waitForPeerReady()).toEqual([])
  })

  test('local play has no peer to wait for', async () => {
    const net = new NetworkManager()
    net.mode = 'local'
    expect(await net.waitForPeerReady()).toBeNull()
  })
})
