/**
 * Run wrangler with the Worker stamped with the build id of the client bundle
 * it will serve.
 *
 * The Worker is not a bystander to the version gate: `Referee` recomputes
 * every intent under ADR-0004, so it states its own build and refuses any
 * client whose build differs (`src/version.ts`). Wrangler builds
 * `workers/index.ts` with its own esbuild run, which knows nothing about
 * `scripts/build-bundle.ts` and its `--define`, so a plain `wrangler deploy`
 * ships a referee whose `BUILD_ID` fell back to `dev` while the bundle beside
 * it in `dist/` carries a commit. Every client then connects, states its
 * commit, and is turned away by the very server that served it — the host
 * drops straight back to the menu and the joiner never gets an opening frame.
 *
 * So the id travels through `dist/build-id.txt`, written by the bundler: it is
 * by construction the id of the client in `dist/`, which is the client this
 * deployment serves, rather than a second guess at `git rev-parse` that could
 * disagree if HEAD moved between the two steps.
 *
 * Everything after the script name is handed to wrangler untouched, so this is
 * a prefix (`bun scripts/wrangler.ts deploy`, `… dev --port 8787`) rather than
 * a command of its own.
 */
import { spawn } from 'bun'

const stamp = Bun.file('dist/build-id.txt')
if (!(await stamp.exists())) {
  console.error('[tictac] dist/build-id.txt is missing — run `bun run build` first.')
  process.exit(1)
}

const id = (await stamp.text()).trim()
if (id.length === 0) {
  console.error('[tictac] dist/build-id.txt is empty — run `bun run build` again.')
  process.exit(1)
}

const args = process.argv.slice(2)
console.info(`[tictac] wrangler ${args.join(' ')} — referee stamped build ${id}`)

// `JSON.stringify` because wrangler hands `--define` to esbuild verbatim: the
// value is JavaScript source, so the quotes are part of it.
//
// The installed binary rather than `bunx wrangler`: `wrangler dev` starts a
// `workerd` of its own and only shuts it down if it is signalled itself, so
// every process layer between here and it is a layer a `SIGTERM` can stop at
// — which is how `tests/cloudflare.test.ts` collected orphaned `workerd`
// processes that went on holding its port and answering nothing.
const wrangler = new URL('../node_modules/.bin/wrangler', import.meta.url).pathname
const child = spawn([wrangler, ...args, '--define', `__BUILD_ID__:${JSON.stringify(id)}`], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}

process.exit(await child.exited)
