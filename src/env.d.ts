/// <reference types="vite/client" />

/**
 * The engine ships a Vite config that we must spread (it registers the GLSL
 * plugin that `@mavonengine/core` relies on) but it has no type declaration.
 */
declare module '@mavonengine/core/vite.config' {
  import type { UserConfig } from 'vite'
  const config: UserConfig
  export default config
}
