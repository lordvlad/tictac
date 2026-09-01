import { Peer, DataConnection } from 'peerjs'
import { Faction } from '../config'
import type { GrenadeId, ShotMode } from '../core/Arsenal'

export type NetworkMode = 'local' | 'host' | 'join'

export type NetworkMessage =
  | { type: 'init'; seed: number; seedLabel: string }
  | { type: 'moveUnit'; faction: Faction; squadIndex: number; path: { x: number; y: number }[] }
  | { type: 'fireShot'; shooterFaction: Faction; shooterIndex: number; targetFaction: Faction; targetIndex: number; mode: ShotMode; rolls: boolean[] }
  | { type: 'throwGrenade'; shooterFaction: Faction; shooterIndex: number; kind: GrenadeId; targetTile: { x: number; y: number } }
  | { type: 'reload'; faction: Faction; squadIndex: number }
  | { type: 'toggleCover'; faction: Faction; squadIndex: number }
  | { type: 'endUnitTurn'; faction: Faction; squadIndex: number }
  | { type: 'endTurn'; faction: Faction }
  | { type: 'rightClickFacing'; faction: Faction; squadIndex: number; x: number; z: number }

export class NetworkManager {
  peer: Peer | null = null
  conn: DataConnection | null = null
  mode: NetworkMode = 'local'
  myId: string = ''
  myFaction: Faction = Faction.Blue

  onMessage: ((msg: NetworkMessage) => void) | null = null
  onConnected: (() => void) | null = null
  onDisconnected: ((reason?: string) => void) | null = null

  private setupConn(conn: DataConnection): void {
    this.conn = conn
    conn.on('data', (data) => {
      const msg = data as NetworkMessage
      console.info(`%c[P2P 📥 IN: ${msg.type}]`, 'color: #a855f7; font-weight: bold;', msg)
      this.onMessage?.(msg)
    })
    conn.on('close', () => {
      console.warn('[p2p] Connection closed by remote peer')
      this.onDisconnected?.('Connection closed by remote peer')
    })
    conn.on('error', (err) => {
      console.warn('[p2p] Connection error:', err)
      this.onDisconnected?.(err.message || 'Connection error')
    })
  }

  private setupPeer(peer: Peer): void {
    peer.on('error', (err) => {
      console.warn('[p2p] Peer error:', err)
      if (this.mode !== 'local') {
        this.onDisconnected?.(err.message || 'Peer error')
      }
    })
    peer.on('close', () => {
      console.warn('[p2p] Peer closed')
      if (this.mode !== 'local') {
        this.onDisconnected?.('Peer closed')
      }
    })
  }
  isMyTurn(activeFaction: Faction): boolean {
    if (this.mode === 'local') return true
    return activeFaction === this.myFaction
  }

  async initHost(seed: number, seedLabel: string): Promise<string> {
    this.mode = 'host'
    this.myFaction = Faction.Blue
    this.peer = new Peer()
    this.setupPeer(this.peer)

    const { promise, resolve } = Promise.withResolvers<string>()

    this.peer.on('open', (id) => {
      this.myId = id
      resolve(id)
    })

    this.peer.on('connection', (conn) => {
      this.setupConn(conn)
      conn.on('open', () => {
        console.info('[p2p] Client connected, sending init seed')
        this.send({ type: 'init', seed, seedLabel })
        this.onConnected?.()
      })
    })

    return promise
  }

  async initJoin(hostId: string): Promise<{ seed: number; seedLabel: string }> {
    this.mode = 'join'
    this.myFaction = Faction.Red
    this.peer = new Peer()
    this.setupPeer(this.peer)

    const { promise, resolve } = Promise.withResolvers<{ seed: number; seedLabel: string }>()

    this.peer.on('open', (id) => {
      this.myId = id
      const conn = this.peer!.connect(hostId)
      this.setupConn(conn)

      conn.on('open', () => {
        console.info('[p2p] Connected to host')
        this.onConnected?.()
      })

      conn.on('data', (data) => {
        const msg = data as NetworkMessage
        if (msg.type === 'init') {
          resolve({ seed: msg.seed, seedLabel: msg.seedLabel })
        }
      })
    })

    return promise
  }


  send(msg: NetworkMessage): void {
    if (this.conn && this.conn.open) {
      console.info(`%c[P2P 📤 OUT: ${msg.type}]`, 'color: #38bdf8; font-weight: bold;', msg)
      this.conn.send(msg)
    } else {
      console.warn(`%c[P2P ⚠️ SEND-FAILED: ${msg.type}] Connection not open`, 'color: #ef4444;', msg)
    }
  }

  dispose(): void {
    this.conn?.close()
    this.peer?.destroy()
  }
}
