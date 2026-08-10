import { defineConfig } from 'vite'
// The engine ships its own Vite config (glsl plugin + esbuild glsl shim for
// optimizeDeps). We must spread it, because @mavonengine/core imports `.glsl`
// files directly.
import engineConfig from '@mavonengine/core/vite.config'

export default defineConfig(({ mode }) => ({
  ...engineConfig,
  plugins: [...(engineConfig.plugins ?? [])],
  resolve: {
    ...engineConfig.resolve,
    // Duplicate three copies break every `instanceof` check inside the engine.
    dedupe: ['three', '@mavonengine/core', '@dimforge/rapier3d-compat'],
  },
  define: {
    ...engineConfig.define,
    // BaseGame.js / Game.js read `process.env.NODE_ENV` in *browser* code.
    // Vite does not reliably polyfill `process` for linked source deps.
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
  server: {
    ...engineConfig.server,
    port: 5173,
  },
}))
