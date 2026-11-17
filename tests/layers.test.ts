import { describe, expect, test } from 'bun:test'
import { dirname, join, normalize } from 'node:path'

/**
 * The layer DAG, enforced.
 *
 * AGENTS.md says `core`, `ecs` and `sim` are headless and that render/hud/camera
 * are client-only; until this test, that was convention. Every runtime import
 * under `src/` and `workers/` is resolved to a file, both ends are mapped to a
 * layer by top-level directory, and the edge must be one the layer may take.
 * Type-only imports count: a hud file that names a game type is the same coupling
 * as one that calls a game function, and an edge nobody can see cannot be ratcheted.
 *
 * `src/rules` (headless game logic), `src/wire` (the contract two sides share) and
 * `src/game` (client orchestration only) are separate layers. The edges that still
 * break the DAG are listed in {@link ALLOWED}, each under the ticket that removes
 * it. The list is a ratchet: a new violating edge fails, and so does a listed edge
 * that no longer exists — whoever deletes the import deletes its line. It can only
 * shrink.
 */

type Layer =
  | 'leaf'
  | 'core'
  | 'ecs'
  | 'entities'
  | 'rules'
  | 'sim'
  | 'wire'
  | 'server'
  | 'game'
  | 'engine'
  | 'render'
  | 'camera'
  | 'hud'
  | 'workers'

/**
 * What each layer may import, besides itself.
 *
 * The order, bottom to top: `core`, `rules`, `ecs`, `entities`, `wire`, `sim`,
 * then the hosts. `rules` is the pure game logic (combat, movement, the command
 * language) and sits *below* the ECS because the systems execute it. `wire` sits
 * *below* `sim` because the simulation is written in the wire's terms: the host
 * takes and emits `NetworkMessage`, and a match is recorded as a `Recording`.
 * `wire` itself imports only `core` and `rules` (the command language and kit
 * shapes it carries), never `ecs` or `sim`.
 */
const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  leaf: [],
  core: ['leaf'],
  rules: ['leaf', 'core'],
  ecs: ['leaf', 'core', 'rules'],
  entities: ['leaf', 'core', 'rules', 'ecs'],
  wire: ['leaf', 'core', 'rules'],
  sim: ['leaf', 'core', 'rules', 'ecs', 'entities', 'wire'],
  server: ['leaf', 'core', 'rules', 'ecs', 'entities', 'sim', 'wire'],
  // Client orchestration: the one layer that wires the match to the screen.
  game: ['leaf', 'core', 'rules', 'ecs', 'entities', 'sim', 'wire', 'render', 'camera', 'engine'],
  // The engine context (renderer, scene, clock) that client code is handed; it knows nothing of the game.
  engine: ['leaf'],
  render: ['leaf', 'core', 'rules', 'ecs', 'entities', 'engine'],
  camera: ['leaf', 'core'],
  // The HUD reads view models and rules tables; it does not reach into the ECS or the scene.
  hud: ['leaf', 'core', 'rules', 'wire'],
  workers: ['leaf', 'server'],
}

/** Files that wire the layers together are exempt as importers; nothing else may import `main.tsx` or `index.ts`. */
const COMPOSITION_ROOTS: Record<string, true> = {
  'src/main.tsx': true,
  'src/engine.ts': true,
  'src/index.ts': true,
  'workers/index.ts': true,
}
const LEAVES: Record<string, true> = { 'src/config.ts': true, 'src/version.ts': true }

/** Removing an edge removes its line. Keys are tickets; values are `from -> to`. */
const ALLOWED: Record<string, readonly string[]> = {
  // Systems operate on components, not on the Soldier wrapper that sits above them.
  'tictac-uqt.22': [
    'src/ecs/systems/CombatSystem.ts -> src/entities/Soldier.ts',
    'src/ecs/systems/CommandSystem.ts -> src/entities/Soldier.ts',
    'src/ecs/systems/ItemSystem.ts -> src/entities/Soldier.ts',
  ],
  // The HUD reads view models only; ServerConnection, planners and the scene are injected, never imported.
  'tictac-uqt.25': [
    'src/hud/DebugMap.tsx -> src/entities/Squads.ts',
    'src/hud/DebugPanel.tsx -> src/entities/Soldier.ts',
    'src/hud/EncounterFeed.tsx -> src/game/ServerConnection.ts',
    'src/hud/EncounterPrompt.tsx -> src/game/ServerConnection.ts',
    'src/hud/HudModel.ts -> src/camera/OrbitRig.ts',
    'src/hud/HudModel.ts -> src/entities/Soldier.ts',
    'src/hud/HudModel.ts -> src/entities/Squads.ts',
    'src/hud/HudModel.ts -> src/game/GrenadePlanner.ts',
    'src/hud/HudModel.ts -> src/game/ShootPlanner.ts',
    'src/hud/HudModel.ts -> src/render/Portraits.ts',
    'src/hud/HudModel.ts -> src/sim/TurnManager.ts',
    'src/hud/LoadoutScreen.tsx -> src/engine.ts',
    'src/hud/LoadoutScreen.tsx -> src/render/LoadoutScene.ts',
    'src/hud/LoadoutScreen.tsx -> src/render/Portraits.ts',
    'src/hud/MapScreen.tsx -> src/game/ServerConnection.ts',
    'src/hud/PlaybackControls.tsx -> src/game/Playback.ts',
    'src/hud/menu/ServerPanel.tsx -> src/game/Account.ts',
    'src/hud/menu/ServerPanel.tsx -> src/game/ServerConnection.ts',
    'src/hud/menu/StartMenu.tsx -> src/game/ServerConnection.ts',
  ],
  // InteractionController splits into input, presenter and a client-session port.
  'tictac-uqt.23': [
    'src/game/InteractionController.ts -> src/hud/DebugMap.tsx',
    'src/game/InteractionController.ts -> src/hud/DebugPanel.tsx',
    'src/game/InteractionController.ts -> src/hud/Hud.tsx',
    'src/game/InteractionController.ts -> src/hud/HudModel.ts',
    'src/game/InteractionController.ts -> src/hud/download.ts',
  ],
  // The Durable Object takes the same host ports as the Bun server, not core types of its own.
  'tictac-uqt.24': [
    'workers/MatchDurableObject.ts -> src/core/Travel.ts',
  ],
}

function layerOf(file: string): Layer | 'root' {
  if (file === 'src/engine.ts') return 'engine'
  if (file === 'workers/index.ts') return 'workers'
  if (file in COMPOSITION_ROOTS) return 'root'
  if (file in LEAVES) return 'leaf'
  const [top, second] = file.split('/')
  if (top === 'workers') return 'workers'
  if (top !== 'src') throw new Error(`${file}: outside src/ and workers/`)
  if (second && second in MAY_IMPORT) return second as Layer
  throw new Error(`${file}: no layer — add its directory to MAY_IMPORT`)
}

async function listFiles(): Promise<string[]> {
  const files: string[] = []
  for (const pattern of ['src/**/*.{ts,tsx}', 'workers/**/*.ts']) {
    for await (const file of new Bun.Glob(pattern).scan('.')) files.push(file)
  }
  return files.sort()
}

/**
 * `scanImports` follows what survives transpilation, so it drops `import type` and
 * `import { type X }`. Static `import|export … from` statements are therefore read
 * from the text (anchored to the line start so a comment quoting one is not an edge);
 * `scanImports` still supplies side-effect and dynamic imports.
 */
const FROM_STATEMENT = /^(?:import|export)\b[^'"]*?\bfrom\s+'(\.[^']+)'/gm

function relativeImports(transpiler: Bun.Transpiler, source: string): Set<string> {
  const specifiers = new Set<string>()
  for (const { path } of transpiler.scanImports(source)) specifiers.add(path)
  for (const match of source.matchAll(FROM_STATEMENT)) specifiers.add(match[1] as string)
  return new Set([...specifiers].filter(path => path.startsWith('.')))
}

/** Every `from -> to` edge between two files we own. */
async function scanEdges(): Promise<Set<string>> {
  const files = await listFiles()
  const known = new Set(files)
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })
  const edges = new Set<string>()
  await Promise.all(
    files.map(async from => {
      for (const path of relativeImports(transpiler, await Bun.file(from).text())) {
        const base = normalize(join(dirname(from), path))
        const to = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(candidate => known.has(candidate))
        if (to) edges.add(`${from} -> ${to}`)
        else if (!/\.(css|html|json|svg|png)$/.test(path)) throw new Error(`${from}: cannot resolve '${path}'`)
      }
    }),
  )
  return edges
}

const edges = await scanEdges()
const allowed = new Set(Object.values(ALLOWED).flat())

function breaksDag(edge: string): boolean {
  const [from, to] = edge.split(' -> ') as [string, string]
  if (from in COMPOSITION_ROOTS) return false
  const importer = layerOf(from)
  if (importer === 'root') return false
  const target = layerOf(to)
  if (target === 'root') return true
  return target !== importer && !MAY_IMPORT[importer].includes(target)
}

describe('layer DAG', () => {
  test('every import obeys the layers or is allowlisted', () => {
    const fresh = [...edges].filter(edge => breaksDag(edge) && !allowed.has(edge)).sort()
    expect(fresh, 'new import edges that break the layer DAG (fix the import, do not allowlist it)').toEqual([])
  })

  test('every allowlisted edge still breaks the DAG', () => {
    const stale = [...allowed].filter(edge => !edges.has(edge) || !breaksDag(edge)).sort()
    expect(stale, 'allowlisted edges that no longer exist: delete their lines').toEqual([])
  })

  test('every allowlist entry sits under a ticket and appears once', () => {
    const tickets = Object.keys(ALLOWED).filter(ticket => !/^tictac-uqt\.\d+$/.test(ticket))
    expect(tickets).toEqual([])
    const all = Object.values(ALLOWED).flat()
    expect(all.filter((edge, i) => all.indexOf(edge) !== i)).toEqual([])
  })
})
