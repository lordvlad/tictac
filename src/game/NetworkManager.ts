import { Peer, DataConnection } from 'peerjs'
import { Faction } from '../config'
import type { HudIntent } from '../hud/HudModel'

export type NetworkMode = 'local' | 'host' | 'join'

export type NetworkMessage =
  | { type: 'init'; seed: number; seedLabel: string }
  | { type: 'hudIntent'; intent: HudIntent }
  | { type: 'clickTile'; tile: { x: number; y: number }; shiftKey: boolean }
  | { type: 'clickSoldier'; soldierIndex: number; faction: Faction }
  | { type: 'rightClickFacing'; x: number; z: number }

export class NetworkManager {
  peer: Peer | null = null
  conn: DataConnection | null = null
  mode: NetworkMode = 'local'
  myId: string = ''
  myFaction: Faction = Faction.Blue

  onMessage: ((msg: NetworkMessage) => void) | null = null
  onConnected: (() => void) | null = null

  isMyTurn(activeFaction: Faction): boolean {
    if (this.mode === 'local') return true
    return activeFaction === this.myFaction
  }

  async initHost(seed: number, seedLabel: string): Promise<string> {
    this.mode = 'host'
    this.myFaction = Faction.Blue
    this.peer = new Peer()

    const { promise, resolve } = Promise.withResolvers<string>()

    this.peer.on('open', (id) => {
      this.myId = id
      resolve(id)
    })

    this.peer.on('connection', (conn) => {
      this.conn = conn
      this.conn.on('open', () => {
        console.info('[p2p] Client connected, sending init seed')
        this.send({ type: 'init', seed, seedLabel })
        this.onConnected?.()
      })
      this.conn.on('data', (data) => {
        this.onMessage?.(data as NetworkMessage)
      })
    })

    return promise
  }

  async initJoin(hostId: string): Promise<{ seed: number; seedLabel: string }> {
    this.mode = 'join'
    this.myFaction = Faction.Red
    this.peer = new Peer()

    const { promise, resolve } = Promise.withResolvers<{ seed: number; seedLabel: string }>()

    this.peer.on('open', (id) => {
      this.myId = id
      this.conn = this.peer!.connect(hostId)

      this.conn.on('open', () => {
        console.info('[p2p] Connected to host')
        this.onConnected?.()
      })

      this.conn.on('data', (data) => {
        const msg = data as NetworkMessage
        if (msg.type === 'init') {
          resolve({ seed: msg.seed, seedLabel: msg.seedLabel })
        } else {
          this.onMessage?.(msg)
        }
      })
    })

    return promise
  }

  send(msg: NetworkMessage): void {
    if (this.conn && this.conn.open) {
      this.conn.send(msg)
    }
  }

  dispose(): void {
    this.conn?.close()
    this.peer?.destroy()
  }
}
