import type { NetworkMessage } from './NetworkManager'

export interface JsonRpcNotification<T = Record<string, unknown>> {
  jsonrpc: '2.0'
  method: string
  params: T
}

export interface JsonRpcRequest<T = Record<string, unknown>> {
  jsonrpc: '2.0'
  method: string
  params: T
  id: number | string
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0'
  result: T
  id: number | string
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  error: { code: number; message: string; data?: unknown }
  id: number | string | null
}

export type JsonRpcFrame =
  | JsonRpcNotification
  | JsonRpcRequest
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse

export function isJsonRpcFrame(data: unknown): data is JsonRpcFrame {
  return typeof data === 'object' && data !== null && (data as JsonRpcFrame).jsonrpc === '2.0'
}


/**
 * System commands, keyed by {@link NetworkMessage} type so the mapping cannot
 * drift from the message union.
 */
export const RpcMethods = {
  init: 'tictac/system/session/init',
  hello: 'tictac/system/session/hello',
  digest: 'tictac/system/session/digest',
  matchHeader: 'tictac/system/session/matchHeader',
  log: 'tictac/system/session/log',
  seated: 'tictac/system/session/seated',
  abort: 'tictac/system/session/abort',
  moveUnit: 'tictac/system/movement/moveUnit',
  fireShot: 'tictac/system/combat/fireShot',
  throwGrenade: 'tictac/system/combat/throwGrenade',
  reload: 'tictac/system/combat/reload',
  toggleCover: 'tictac/system/combat/toggleCover',
  overwatch: 'tictac/system/combat/overwatch',
  meleeAttack: 'tictac/system/combat/meleeAttack',
  endUnitTurn: 'tictac/system/turn/endUnitTurn',
  endTurn: 'tictac/system/turn/endTurn',
  retreat: 'tictac/system/turn/retreat',
  useItem: 'tictac/system/items/useItem',
  operateDoor: 'tictac/system/terrain/operateDoor',
  rightClickFacing: 'tictac/system/render/rightClickFacing',
  ready: 'tictac/system/session/ready',
} as const satisfies Record<NetworkMessage['type'], string>

/** A match message as the notification that carries it. */
export function frameOf(message: NetworkMessage): JsonRpcNotification {
  const params = { ...message } as Record<string, unknown>
  delete params.type
  return { jsonrpc: '2.0', method: RpcMethods[message.type], params }
}

/** The match message a notification's method and params carry, or null for a method that is not one. */
export function messageOf(method: string, params: Record<string, unknown>): NetworkMessage | null {
  for (const [type, name] of Object.entries(RpcMethods)) {
    if (name === method) return { ...params, type } as NetworkMessage
  }
  return null
}
