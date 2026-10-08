// Side-effect CSS imports (e.g. `import './game.css'`) are bundled by Bun but
// need an ambient module declaration to satisfy `tsc --noEmit`.
declare module '*.css'

// MapLibre's tile worker, imported `with { type: 'file' }` for the url of the
// copy the bundle emits (`src/hud/map/WorldMap.ts`).
declare module 'maplibre-gl/dist/maplibre-gl-worker.mjs' {
  const url: string
  export default url
}
