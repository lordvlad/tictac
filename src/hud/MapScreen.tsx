import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type LatLng, type Pace, positionAt, type TravelState } from '../core/Travel'
import type { Squad, SquadOrder } from '../game/Rpc'
import type { ServerConnection } from '../game/ServerConnection'
import type { WorldMap } from './map/WorldMap'

/**
 * The world map (`ITEM-065`, GDD-WORLD): the player's squad on the planet,
 * moving on the wall clock, and the orders that send it.
 *
 * Reached from the match server's panel by a signed-in player. Mounted on
 * `<body>`, like the loadout screen, because `#ui` lets nothing but buttons
 * take the pointer and a map is all drag and wheel. MapLibre itself
 * (`map/WorldMap.ts`) is fetched only when this opens.
 *
 * Nothing here asks the server where the squad is: the route comes from
 * `squad/get` and every `squad/changed` push, and the position is
 * `positionAt(route, Date.now())` each frame — the server's own function, so
 * a refresh mid-journey lands exactly where the squad was drawn before it.
 * That holds to the accuracy of this machine's clock.
 */

/** Redraws per second of a moving squad: a walking squad moves a few metres between them. */
const DRAWS_PER_SECOND = 10

const PACES: { pace: Pace; label: string; speed: string }[] = [
  { pace: 'cautious', label: 'Cautious', speed: '3 km/h' },
  { pace: 'normal', label: 'Normal', speed: '5 km/h' },
  { pace: 'flatOut', label: 'Flat out', speed: '7 km/h' },
]

/** Open the map over everything else; resolves once the player closes it. */
export function openMap(connection: ServerConnection, assetsUrl: string): Promise<void> {
  const container = document.createElement('div')
  container.className = 'map-root'
  document.body.appendChild(container)
  const root = createRoot(container)
  const closed = Promise.withResolvers<void>()
  const close = () => {
    root.unmount()
    container.remove()
    closed.resolve()
  }
  root.render(<MapView connection={connection} assetsUrl={assetsUrl} onClose={close} />)
  return closed.promise
}

interface Picked {
  at: LatLng
  screen: { x: number; y: number }
}

function MapView({
  connection,
  assetsUrl,
  onClose,
}: {
  connection: ServerConnection
  assetsUrl: string
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const map = useRef<WorldMap | null>(null)
  const [squad, setSquad] = useState<Squad | null>(null)
  const [pace, setPace] = useState<Pace>('normal')
  const [picked, setPicked] = useState<Picked | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** A clock tick for the status line; the map redraws on its own loop. */
  const [now, setNow] = useState(() => Date.now())

  // The route: asked for when the map opens and again whenever the socket
  // comes back, since an arrival recorded while it was away was pushed to
  // nobody; kept current by `squad/changed` in between.
  useEffect(() => {
    let wasOpen = connection.state.kind === 'open'
    const fetchSquad = () =>
      connection.request('tictac/api/squad/get', {}).then(
        ({ squad: read }) => setSquad(read),
        (error: unknown) => setProblem(error instanceof Error ? error.message : 'The squad could not be read.'),
      )
    void fetchSquad()
    const stopWatching = connection.watchSquad(({ squad: pushed }) => setSquad(pushed))
    const stopChanges = connection.onChange(() => {
      const open = connection.state.kind === 'open'
      if (open && !wasOpen) void fetchSquad()
      wasOpen = open
    })
    return () => {
      stopWatching()
      stopChanges()
    }
  }, [connection])

  // The map itself, once there is a squad to centre on: built once per
  // opening, centred where the squad was then; later routes are drawn on it.
  const latest = useRef<Squad | null>(null)
  latest.current = squad
  const started = squad !== null
  useEffect(() => {
    const first = latest.current
    if (!started || !host.current || !first) return
    let removed = false
    const element = host.current
    void import('./map/WorldMap').then(
      ({ WorldMap: Loaded }) => {
        if (removed) return
        map.current = new Loaded(element, {
          serverUrl: connection.url,
          assetsUrl,
          center: positionAt(first.waypoints, Date.now()).position,
          onPick: (at, screen) => setPicked({ at, screen }),
        })
      },
      () => setProblem('The map could not be loaded. Check the connection and open it again.'),
    )
    return () => {
      removed = true
      map.current?.remove()
      map.current = null
    }
  }, [started, connection, assetsUrl])

  // Draw the squad where the clock puts it, a few times a second.
  useEffect(() => {
    if (!squad) return
    const draw = () => map.current?.draw(squad.waypoints, Date.now())
    draw()
    const timer = window.setInterval(() => {
      draw()
      setNow(Date.now())
    }, 1000 / DRAWS_PER_SECOND)
    return () => window.clearInterval(timer)
  }, [squad])

  const give = async (order: SquadOrder) => {
    setPicked(null)
    setBusy(true)
    try {
      const answer = await connection.request('tictac/api/squad/order', { order })
      setSquad(answer.squad)
      setProblem(null)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That order did not reach the squad.')
    } finally {
      setBusy(false)
    }
  }

  const state = squad ? positionAt(squad.waypoints, now) : null
  const travelling = state?.travelling === true
  const verbs: { label: string; order: (to: LatLng) => SquadOrder }[] = travelling
    ? [
        { label: 'Go here now', order: (to) => ({ kind: 'goHereNow', to, pace }) },
        { label: 'Go here first', order: (to) => ({ kind: 'goHereFirst', to }) },
        { label: 'Go here next', order: (to) => ({ kind: 'goHereNext', to }) },
      ]
    : [{ label: 'Go here', order: (to) => ({ kind: 'goHere', to, pace }) }]

  return (
    <>
      <div ref={host} className="map-canvas" onClick={() => setPicked(null)} />
      <div className="map-panel">
        <div className="map-title">Your squad</div>
        <div className="map-status">{statusOf(state, now)}</div>
        <div className="map-paces" role="radiogroup" aria-label="Pace">
          {PACES.map((option) => (
            <button
              key={option.pace}
              type="button"
              role="radio"
              aria-checked={pace === option.pace}
              className={pace === option.pace ? 'map-pace chosen' : 'map-pace'}
              onClick={() => setPace(option.pace)}
              title={option.speed}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="map-hint">Right-click the map to send the squad there.</div>
        <div className="map-actions">
          {travelling && (
            <button type="button" disabled={busy} onClick={() => void give({ kind: 'stop' })}>
              Stop here
            </button>
          )}
          {state && (
            <button type="button" onClick={() => map.current?.centreOn(state.position)}>
              Find squad
            </button>
          )}
          <button type="button" onClick={onClose}>
            Back
          </button>
        </div>
        {problem && <div className="map-problem">{problem}</div>}
        {connection.state.kind === 'reconnecting' && (
          <div className="map-problem">Reconnecting to the match server…</div>
        )}
      </div>
      {picked && (
        <div className="map-orders" style={{ left: picked.screen.x, top: picked.screen.y }}>
          {verbs.map((verb) => (
            <button key={verb.label} type="button" disabled={busy} onClick={() => void give(verb.order(picked.at))}>
              {verb.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function statusOf(state: TravelState | null, now: number): string {
  if (!state) return 'Finding your squad…'
  if (!state.travelling) return 'Resting.'
  const pace = PACES.find((option) => option.pace === state.gait.pace)?.label.toLowerCase() ?? state.gait.pace
  return `On foot, ${pace}. Arrives ${clockTime(state.arrival)} (${untilThen(state.arrival - now)}).`
}

function clockTime(at: number): string {
  return new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

function untilThen(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `in ${hours} h ${minutes % 60} min`
}
