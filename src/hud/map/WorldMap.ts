import { layers, namedFlavor } from '@protomaps/basemaps'
import type { FeatureCollection } from 'geojson'
import { type GeoJSONSource, type LngLatLike, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl'
// As a file, not a stylesheet: Bun hoists a lazy chunk's stylesheet into the
// first load's, which would ship MapLibre's CSS to every player.
import stylesheet from 'maplibre-gl/dist/maplibre-gl.css' with { type: 'file' }
// MapLibre parses tiles in a worker it loads from beside its own script by
// default — a file no bundle emits. Emitted here, and pointed at.
import worker from 'maplibre-gl/dist/maplibre-gl-worker.mjs' with { type: 'file' }
import { type LatLng, positionAt, type Waypoint } from '../../core/Travel'

/**
 * The planet, and one squad on it (`ITEM-065`).
 *
 * Everything that needs MapLibre lives in this file, and nothing imports it
 * but `MapScreen`'s dynamic `import()`: the library is the size of the rest
 * of the game, and most players never open the map.
 *
 * The basemap is Protomaps' dark flavour over the match server's own tiles
 * (`/tiles/{z}/{x}/{y}.mvt`, z0–8, overzoomed past that), with glyphs and
 * sprites served beside the client, so the map contacts no third party
 * (`docs/architecture/deployment.md` §6).
 */

/** The deepest zoom the tiles have; MapLibre stretches them past it. */
const TILE_MAX_ZOOM = 8

/** How close a player may look: past this, z8 tiles are too stretched to read. */
const MAX_ZOOM = 12

const SQUAD_COLOUR = '#79d98b'
const ROUTE_COLOUR = '#f5c451'

export interface WorldMapOptions {
  /** The match server's socket url; its tiles are on the same host over HTTP. */
  serverUrl: string
  /** Where the client's own static files are (`map/fonts`, `map/sprites`). */
  assetsUrl: string
  /** Where to look first. */
  center: LatLng
  /** A right-click (a long press on touch) at a point on the map. */
  onPick: (at: LatLng, screen: { x: number; y: number }) => void
}

/** MapLibre's own stylesheet, linked the first time a map is built. */
function linkStylesheet(): void {
  if (document.querySelector('link[data-maplibre]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = stylesheet
  link.dataset.maplibre = ''
  document.head.appendChild(link)
}

export class WorldMap {
  private readonly map: MapLibreMap
  private ready = false

  constructor(container: HTMLElement, options: WorldMapOptions) {
    linkStylesheet()
    setWorkerUrl(worker)
    this.map = new MapLibreMap({
      container,
      style: {
        version: 8,
        glyphs: `${options.assetsUrl}map/fonts/{fontstack}/{range}.pbf`,
        sprite: `${options.assetsUrl}map/sprites/dark`,
        sources: {
          protomaps: {
            type: 'vector',
            tiles: [tileUrl(options.serverUrl)],
            maxzoom: TILE_MAX_ZOOM,
            attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>, Protomaps',
          },
        },
        layers: layers('protomaps', namedFlavor('dark'), { lang: 'en' }),
      },
      center: toLngLat(options.center),
      zoom: TILE_MAX_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: { compact: true },
    })
    this.map.on('contextmenu', (event) => {
      event.preventDefault()
      options.onPick({ lat: event.lngLat.lat, lng: event.lngLat.lng }, { x: event.point.x, y: event.point.y })
    })
    this.map.on('load', () => {
      this.addSquadLayers()
      this.ready = true
    })
  }

  /**
   * Draw `waypoints` as they stand at `now`: where the squad has been, the
   * route ahead from where it is, its stops, and the squad itself. Computed
   * with the same function the server uses (`positionAt`), so it moves
   * without asking anybody.
   */
  draw(waypoints: readonly Waypoint[], now: number): void {
    if (!this.ready) return
    const state = positionAt(waypoints, now)
    const here = toLngLat(state.position)
    const past = waypoints.filter((waypoint) => waypoint.kind === 'past').map(toLngLat)
    const ahead = state.travelling ? waypoints.slice(past.length + state.leg.index).map(toLngLat) : []
    this.set('trail', line([...past, here]))
    this.set('route', line(state.travelling ? [here, ...ahead] : []))
    this.set('stops', points(ahead))
    this.set('squad', points([here]))
  }

  /** Look at `at`, at the zoom the tiles were made for. */
  centreOn(at: LatLng): void {
    this.map.easeTo({ center: toLngLat(at), zoom: Math.max(this.map.getZoom(), 6) })
  }

  remove(): void {
    this.map.remove()
  }

  private set(source: string, data: FeatureCollection): void {
    this.map.getSource<GeoJSONSource>(source)?.setData(data)
  }

  private addSquadLayers(): void {
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }
    for (const id of ['trail', 'route', 'stops', 'squad']) this.map.addSource(id, { type: 'geojson', data: empty })
    this.map.addLayer({
      id: 'trail',
      type: 'line',
      source: 'trail',
      paint: { 'line-color': SQUAD_COLOUR, 'line-width': 2, 'line-opacity': 0.45 },
    })
    this.map.addLayer({
      id: 'route',
      type: 'line',
      source: 'route',
      paint: { 'line-color': ROUTE_COLOUR, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
    })
    this.map.addLayer({
      id: 'stops',
      type: 'circle',
      source: 'stops',
      paint: { 'circle-radius': 4, 'circle-color': ROUTE_COLOUR, 'circle-stroke-width': 1, 'circle-stroke-color': '#0e1218' },
    })
    this.map.addLayer({
      id: 'squad',
      type: 'circle',
      source: 'squad',
      paint: { 'circle-radius': 7, 'circle-color': SQUAD_COLOUR, 'circle-stroke-width': 2, 'circle-stroke-color': '#0e1218' },
    })
  }
}

/** The tiles' url template on the match server at `serverUrl`: the same host, over HTTP. */
function tileUrl(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return `${url.origin}/tiles/{z}/{x}/{y}.mvt`
}

function toLngLat(at: LatLng): [number, number] & LngLatLike {
  return [at.lng, at.lat]
}

function line(coordinates: [number, number][]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      coordinates.length < 2 ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }],
  }
}

function points(coordinates: [number, number][]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: coordinates.map((coordinate) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: coordinate },
    })),
  }
}
