// Bun's HTML build only emits statically `import`ed assets. Runtime-loaded
// files under public/ (character.glb, the Draco decoder) are fetched by URL at
// runtime, so copy the whole public/ tree into dist/ after bundling — the
// equivalent of Vite's implicit public/ folder serving.
import { cp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
await cp(fileURLToPath(new URL('public/', root)), fileURLToPath(new URL('dist/', root)), {
  recursive: true,
})
console.info('[tictac] copied public/ → dist/')
