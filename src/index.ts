import { serve } from 'bun'
import index from './index.html'

// Runtime-loaded (non-imported) assets live under ../public. Bun's bundler only
// serves statically `import`ed assets, so the catch-all `"/*": index` route would
// otherwise swallow these requests and return the HTML fallback. Serve them
// explicitly, ahead of the catch-all.
const publicDir = new URL('../public/', import.meta.url)

const server = serve({
  port: 5173,
  // `bun --hot src/index.ts` drives HMR; disabled for the production preview.
  development: process.env.NODE_ENV !== 'production' && { hmr: true },
  routes: {
    '/character.glb': () => new Response(Bun.file(new URL('character.glb', publicDir))),
    '/draco/:file': (req) => new Response(Bun.file(new URL(`draco/${req.params.file}`, publicDir))),
    '/*': index,
  },
})

console.info(`[tictac] serving on ${server.url}`)
