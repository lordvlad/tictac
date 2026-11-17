import type { HandoverPeer, RegionPeers } from '../../src/server/Handover'

/** What the other end of a crossing is, in a test: the region's crossings, and the address a window dials. */
export interface PeerHost {
  crossings: HandoverPeer
  url: string
}

/** The regions of a test, reachable from one another the way Durable Objects are (`RegionPeers`), and open to being made to fail. */
export interface PeerRegistry extends RegionPeers {
  /** Make `region` reachable. */
  add(region: string, host: PeerHost): void
  /** Replace how `region` is reached, to watch the calls or to make them fail: `wrap` gets the real peer. */
  through(region: string, wrap: (peer: HandoverPeer) => HandoverPeer): void
}

/** What a Durable Object boundary does to a value: it arrives as a copy, as plain data. */
function across<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function inProcessPeers(): PeerRegistry {
  const hosts = new Map<string, PeerHost>()
  const wrappers = new Map<string, (peer: HandoverPeer) => HandoverPeer>()
  const host = (region: string): PeerHost => {
    const found = hosts.get(region)
    if (!found) throw new Error(`no region ${region} to reach`)
    return found
  }
  return {
    add: (region, peerHost) => void hosts.set(region, peerHost),
    through: (region, wrap) => void wrappers.set(region, wrap),
    urlOf: (region) => host(region).url,
    peer(region) {
      const { crossings } = host(region)
      const copying: HandoverPeer = {
        prepareHandover: async (request) => across(await crossings.prepareHandover(across(request))),
        confirmArrival: async (handoverId) => across(await crossings.confirmArrival(handoverId)),
        cancelHandover: async (handoverId) => across(await crossings.cancelHandover(handoverId)),
      }
      return wrappers.get(region)?.(copying) ?? copying
    },
  }
}
