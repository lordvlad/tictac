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

const COMPONENT_METHOD_PREFIX = 'tictac/component/'

/** `health` -> `tictac/component/health/update` */
export function componentUpdateMethod(componentName: string): string {
  return `${COMPONENT_METHOD_PREFIX}${componentName}/update`
}

/** `tictac/component/health/update` -> `health`; null for anything else. */
export function parseComponentUpdateMethod(method: string): string | null {
  if (!method.startsWith(COMPONENT_METHOD_PREFIX) || !method.endsWith('/update')) return null
  const name = method.slice(COMPONENT_METHOD_PREFIX.length, -'/update'.length)
  return name.length > 0 && !name.includes('/') ? name : null
}

/**
 * System commands, keyed by {@link NetworkMessage} type so the mapping cannot
 * drift from the message union.
 */
export const RpcMethods = {
  init: 'tictac/system/session/init',
  moveUnit: 'tictac/system/movement/moveUnit',
  fireShot: 'tictac/system/combat/fireShot',
  throwGrenade: 'tictac/system/combat/throwGrenade',
  reload: 'tictac/system/combat/reload',
  toggleCover: 'tictac/system/combat/toggleCover',
  endUnitTurn: 'tictac/system/turn/endUnitTurn',
  endTurn: 'tictac/system/turn/endTurn',
  rightClickFacing: 'tictac/system/render/rightClickFacing',
} as const satisfies Record<NetworkMessage['type'], string>
