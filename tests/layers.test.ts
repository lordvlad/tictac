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
 * Today `src/game` still holds rules and the wire contract next to client
 * orchestration, so lower layers reach up into it. Those edges are listed in
 * {@link ALLOWED}, each under the ticket that removes it. The list is a
 * ratchet: a new violating edge fails, and so does a listed edge that no longer
 * exists — whoever deletes the import deletes its line. It can only shrink.
 *
 * `rules` and `wire` are the destinations named by tictac-uqt.15; they are in
 * the table so the extraction lands against an enforced contract.
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

/** What each layer may import, besides itself. */
const MAY_IMPORT: Record<Layer, readonly Layer[]> = {
  leaf: [],
  core: ['leaf'],
  ecs: ['leaf', 'core'],
  entities: ['leaf', 'core', 'ecs'],
  rules: ['leaf', 'core', 'ecs', 'entities'],
  sim: ['leaf', 'core', 'ecs', 'entities', 'rules'],
  wire: ['leaf', 'core', 'ecs', 'entities', 'rules', 'sim'],
  server: ['leaf', 'core', 'ecs', 'entities', 'rules', 'sim', 'wire'],
  // Client orchestration: the one layer that wires the match to the screen.
  game: ['leaf', 'core', 'ecs', 'entities', 'rules', 'sim', 'wire', 'render', 'camera', 'engine'],
  // The engine context (renderer, scene, clock) that client code is handed; it knows nothing of the game.
  engine: ['leaf'],
  render: ['leaf', 'core', 'ecs', 'entities', 'rules', 'engine'],
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
  // ecs, sim, server and hud reach rules and the wire contract through src/game;
  // they move to src/rules and src/wire.
  'tictac-uqt.15': [
    'src/ecs/systems/CombatSystem.ts -> src/game/Combat.ts',
    'src/ecs/systems/CombatSystem.ts -> src/game/Overwatch.ts',
    'src/ecs/systems/CombatSystem.ts -> src/game/Squads.ts',
    'src/ecs/systems/CommandSystem.ts -> src/game/Breakdown.ts',
    'src/ecs/systems/CommandSystem.ts -> src/game/Combat.ts',
    'src/ecs/systems/CommandSystem.ts -> src/game/NetworkManager.ts',
    'src/ecs/systems/CommandSystem.ts -> src/game/Squads.ts',
    'src/ecs/systems/CommandSystem.ts -> src/game/TurnManager.ts',
    'src/ecs/systems/ItemSystem.ts -> src/game/Combat.ts',
    'src/ecs/systems/MovementSystem.ts -> src/game/Movement.ts',
    'src/hud/DebugMap.tsx -> src/game/Squads.ts',
    'src/hud/DebugPanel.tsx -> src/game/Combat.ts',
    'src/hud/EncounterFeed.tsx -> src/game/Encounter.ts',
    'src/hud/EncounterFeed.tsx -> src/game/Recording.ts',
    'src/hud/EncounterPrompt.tsx -> src/game/Encounter.ts',
    'src/hud/EncounterPrompt.tsx -> src/game/Lobby.ts',
    'src/hud/EncounterView.ts -> src/game/Encounter.ts',
    'src/hud/EncounterView.ts -> src/game/Lobby.ts',
    'src/hud/HudModel.ts -> src/game/MatchEnd.ts',
    'src/hud/HudModel.ts -> src/game/Overwatch.ts',
    'src/hud/HudModel.ts -> src/game/Squads.ts',
    'src/hud/HudModel.ts -> src/game/TurnManager.ts',
    'src/hud/LoadoutScreen.tsx -> src/game/Loadout.ts',
    'src/hud/MapScreen.tsx -> src/game/Recording.ts',
    'src/hud/MapScreen.tsx -> src/game/Rpc.ts',
    'src/hud/RosterScreen.tsx -> src/game/Rpc.ts',
    'src/hud/menu/LobbyList.tsx -> src/game/Lobby.ts',
    'src/hud/menu/ServerPanel.tsx -> src/game/Lobby.ts',
    'src/hud/menu/StartMenu.tsx -> src/game/Lobby.ts',
    'src/render/SquadViews.ts -> src/game/Squads.ts',
    'src/server/Accounts.ts -> src/game/Base64Url.ts',
    'src/server/Accounts.ts -> src/game/Rpc.ts',
    'src/server/AiSeat.ts -> src/game/JsonRpc.ts',
    'src/server/AiSeat.ts -> src/game/NetworkManager.ts',
    'src/server/AiSeat.ts -> src/game/Transport.ts',
    'src/server/EncounterPort.ts -> src/game/Encounter.ts',
    'src/server/EncounterPort.ts -> src/game/Rpc.ts',
    'src/server/Encounters.ts -> src/game/Encounter.ts',
    'src/server/Handover.ts -> src/game/Rpc.ts',
    'src/server/Journeys.ts -> src/game/Rpc.ts',
    'src/server/Lobby.ts -> src/game/Base64Url.ts',
    'src/server/Lobby.ts -> src/game/JsonRpc.ts',
    'src/server/Lobby.ts -> src/game/Lobby.ts',
    'src/server/Lobby.ts -> src/game/Recording.ts',
    'src/server/Lobby.ts -> src/game/Rpc.ts',
    'src/server/MatchStore.ts -> src/game/NetworkManager.ts',
    'src/server/MatchStore.ts -> src/game/Recording.ts',
    'src/server/Owner.ts -> src/game/Rpc.ts',
    'src/server/Room.ts -> src/game/Base64Url.ts',
    'src/server/Room.ts -> src/game/Encounter.ts',
    'src/server/Room.ts -> src/game/JsonRpc.ts',
    'src/server/Room.ts -> src/game/Lobby.ts',
    'src/server/Room.ts -> src/game/MatchEnd.ts',
    'src/server/Room.ts -> src/game/NetworkManager.ts',
    'src/server/Room.ts -> src/game/Recording.ts',
    'src/server/Room.ts -> src/game/Rpc.ts',
    'src/server/Room.ts -> src/game/StateDigest.ts',
    'src/server/Room.ts -> src/game/Transport.ts',
    'src/server/RoomStore.ts -> src/game/Encounter.ts',
    'src/server/RoomStore.ts -> src/game/Lobby.ts',
    'src/server/Rosters.ts -> src/game/MatchEnd.ts',
    'src/server/Session.ts -> src/game/JsonRpc.ts',
    'src/server/Session.ts -> src/game/Lobby.ts',
    'src/server/Session.ts -> src/game/Rpc.ts',
    'src/server/Session.ts -> src/game/Transport.ts',
    'src/server/SocketTransport.ts -> src/game/JsonRpc.ts',
    'src/server/SocketTransport.ts -> src/game/Transport.ts',
    'src/server/Squads.ts -> src/game/Rpc.ts',
    'src/sim/AiPlayer.ts -> src/game/NetworkManager.ts',
    'src/sim/AiPlayer.ts -> src/game/StateDigest.ts',
    'src/sim/Balance.ts -> src/game/Recording.ts',
    'src/sim/MatchHost.ts -> src/game/NetworkManager.ts',
    'src/sim/MatchHost.ts -> src/game/Recording.ts',
    'src/sim/MatchHost.ts -> src/game/Rewind.ts',
    'src/sim/MatchHost.ts -> src/game/Squads.ts',
    'src/sim/MatchHost.ts -> src/game/StateDigest.ts',
    'src/sim/MatchHost.ts -> src/game/TurnManager.ts',
    'src/sim/Policy.ts -> src/game/Combat.ts',
    'src/sim/Policy.ts -> src/game/Movement.ts',
    'src/sim/Policy.ts -> src/game/NetworkManager.ts',
    'src/sim/Policy.ts -> src/game/Overwatch.ts',
    'src/sim/Replay.ts -> src/game/Recording.ts',
    'src/sim/Replay.ts -> src/game/StateDigest.ts',
    'src/sim/SimMatch.ts -> src/game/MatchEnd.ts',
    'src/sim/SimMatch.ts -> src/game/Recording.ts',
    'src/sim/Tactics.ts -> src/game/Combat.ts',
  ],
  // Systems operate on components, not on the Soldier wrapper that sits above them.
  'tictac-uqt.22': [
    'src/ecs/systems/CombatSystem.ts -> src/entities/Soldier.ts',
    'src/ecs/systems/CommandSystem.ts -> src/entities/Soldier.ts',
    'src/ecs/systems/ItemSystem.ts -> src/entities/Soldier.ts',
  ],
  // The HUD reads view models only; ServerConnection, planners and the scene are injected, never imported.
  'tictac-uqt.25': [
    'src/hud/DebugPanel.tsx -> src/entities/Soldier.ts',
    'src/hud/EncounterFeed.tsx -> src/game/ServerConnection.ts',
    'src/hud/EncounterPrompt.tsx -> src/game/ServerConnection.ts',
    'src/hud/EncounterView.ts -> src/sim/Policy.ts',
    'src/hud/HudModel.ts -> src/camera/OrbitRig.ts',
    'src/hud/HudModel.ts -> src/entities/Soldier.ts',
    'src/hud/HudModel.ts -> src/game/GrenadePlanner.ts',
    'src/hud/HudModel.ts -> src/game/ShootPlanner.ts',
    'src/hud/HudModel.ts -> src/render/Portraits.ts',
    'src/hud/LoadoutScreen.tsx -> src/engine.ts',
    'src/hud/LoadoutScreen.tsx -> src/render/LoadoutScene.ts',
    'src/hud/LoadoutScreen.tsx -> src/render/Portraits.ts',
    'src/hud/MapScreen.tsx -> src/game/ServerConnection.ts',
    'src/hud/MapScreen.tsx -> src/sim/Policy.ts',
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
