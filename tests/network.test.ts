import { describe, expect, test } from 'bun:test'
import { NetworkManager, type NetworkMessage } from '../src/game/NetworkManager'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { Faction, RULES } from '../src/config'
import { ShotMode } from '../src/core/Arsenal'
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
      'moveUnit',
      'fireShot',
      'throwGrenade',
      'reload',
      'toggleCover',
      'endUnitTurn',
      'endTurn',
      'rightClickFacing',
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
    }

    net.send(original)
    expect(sent[0]?.method).toBe(RpcMethods.fireShot)

    const receiver = new NetworkManager()
    receiver.mode = 'join'
    let received: NetworkMessage | null = null
    receiver.onMessage = (msg) => {
      received = msg
    }
    receive(receiver, sent[0])

    expect(received).toEqual(original)
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
