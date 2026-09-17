/**
 * Bundle the app, stamping the commit it was built from into it.
 *
 * The id is what {@link versionRefusal} compares: two peers running different
 * commits are refused before a match starts, because under ADR-0004 both sides
 * recompute every outcome, and a stale cache would otherwise look exactly like
 * a cheat.
 *
 * Uses `Bun.build` rather than the `bun build` CLI for one measured reason: as
 * of Bun 1.4.2 the CLI's `--define` substitutes `process.env.X` but silently
 * ignores a bare identifier, so `--define:__BUILD_ID__='"abc"'` produces a
 * bundle with the placeholder still in it and no error. The programmatic API
 * honours it. Injecting through `process.env` instead would have left
 * `process.env.BUILD_ID` to be evaluated in a browser that may have no
 * `process` at all.
 */
import { rm } from 'node:fs/promises'
import { spawn } from 'bun'

/** The commit, or `dev` outside a checkout — a build nobody can identify. */
async function buildId(): Promise<string> {
  const git = spawn(['git', 'rev-parse', '--short', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
  const sha = (await new Response(git.stdout).text()).trim()
  return (await git.exited) === 0 && sha.length > 0 ? sha : 'dev'
}

// Emptied first: bundle names are content-addressed, so every build that ever
// ran left its output behind and the deploy shipped all of it — 49 stale
// bundles by the time anybody looked. It also made "is the id in the bundle?"
// unanswerable, because the directory held both answers.
await rm('dist', { recursive: true, force: true })

const id = await buildId()

const result = await Bun.build({
  entrypoints: ['./src/index.html'],
  outdir: 'dist',
  target: 'browser',
  sourcemap: 'linked',
  minify: true,
  publicPath: './',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __BUILD_ID__: JSON.stringify(id),
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.info(`[tictac] bundled build ${id} — ${result.outputs.length} outputs`)
