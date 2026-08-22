# Vite → Bun Migration Guide

Concrete learnings from migrating this project (Three.js + `@mavonengine/core` +
`@dimforge/rapier3d-compat`) off Vite onto Bun's own bundler/server. Not every
Vite feature has a 1:1 Bun equivalent — this documents what actually mapped,
what needed a workaround, and what to check before you commit to dropping Vite.

## 1. Entry point: HTML lives next to the server, not at project root

Vite expects `index.html` at the project root (or configured `root`),
referencing the entry script with a root-relative path:

```html
<!-- Vite: /index.html -->
<script type="module" src="/src/main.ts"></script>
```

Bun has no dev-server-with-implicit-root model. Instead, your server code
imports the HTML file directly, and Bun's bundler resolves/bundles whatever
`<script type="module">` / `<link rel="stylesheet">` it references, relative
to the HTML file's own location:

```ts
// src/index.ts
import { serve } from "bun";
import index from "./index.html";

serve({ routes: { "/*": index } });
```

```html
<!-- src/index.html -->
<script type="module" src="./main.ts"></script>
```

Practical effect: colocate `index.html` with the entry script (we moved it
from repo root into `src/`) and switch the script `src` from root-relative to
relative.

## 2. No implicit `public/` folder serving — add routes yourself

Vite auto-serves anything under `public/` at the site root with zero config.
Bun's `Bun.serve({ routes })` has no equivalent — a catch-all `"/*": index`
route will swallow requests for runtime-loaded assets (anything not
statically `import`ed, e.g. a GLTF loaded via a hardcoded fetch path) and
return the HTML fallback instead of the file.

Fix: add an explicit route per such asset, ahead of the catch-all:

```ts
routes: {
  "/character.glb": () => new Response(Bun.file(new URL("../public/character.glb", import.meta.url))),
  "/*": index,
},
```

Assets that *are* statically imported by your bundled code (`import logo from
"./logo.svg"`) don't need this — Bun's bundler hashes and serves those
automatically as part of the HTML-import graph, same as Vite.

## 3. Custom loaders: `bunfig.toml [loader]` instead of a bundler plugin

We needed Vite's `vite-plugin-glsl` because `@mavonengine/core` imports raw
`.glsl` shader source as a string. Bun has this built in — map the extension
to one of Bun's built-in loader kinds (`js`, `jsx`, `ts`, `tsx`, `css`,
`json`, `toml`, `file`, `wasm`, `napi`, `base64`, `dataurl`, `text`):

```toml
# bunfig.toml
[loader]
".glsl" = "text"
```

This replaces the whole plugin (no `plugins: [glsl()]`, no esbuild
`onLoad` hook to write). Check what the library's own Vite config plugin
actually does before assuming you need a real Bun plugin (`Bun.plugin()` /
`[serve.static].plugins` in `bunfig.toml`) — often it's just a loader mapping.

## 4. Bare-specifier package resolution is the same — don't rebuild config, verify the package

A package with a broken `package.json` (missing `"."` in `exports`, `main`
pointing at a nonexistent file) fails to resolve identically under Vite and
Bun, since both follow Node's `exports`-field resolution algorithm. This is
**not** a Vite-vs-Bun difference — don't waste time re-deriving a bundler
workaround per tool. If the package documents subpath exports (e.g.
`"./*": { "default": "./dist/*.js" }`), import from those subpaths directly
(`@mavonengine/core/Game` instead of `@mavonengine/core`) and it works
unchanged in both.

## 5. WASM packages: check which entry file you actually resolve to

`@dimforge/rapier3d-compat`'s `package.json` `exports` map points `"import"`
at `rapier.mjs`, which embeds its WASM binary as an inline base64 string and
calls `WebAssembly.instantiate` directly — no `import.meta.url`-relative
`.wasm` fetch, so it needs zero bundler-specific asset handling under either
Vite or Bun.

Before assuming a WASM package needs bundler config (Vite's built-in
`new URL(..., import.meta.url)` asset handling, or a Bun equivalent), check
which file its `exports`/`main` field actually resolves to and whether *that*
file needs special handling — many "compat" builds specifically avoid it.

## 6. `process.env.NODE_ENV`

Bun's bundler (both `bun build` and the HTML-import dev path) inlines
`process.env.NODE_ENV` automatically, same as Vite/webpack `DefinePlugin`
behavior. Libraries that branch on it (`@mavonengine/core` picks its log
level this way) worked with no extra config. For an explicit production
value in a static build, pass it directly:

```bash
bun build ./src/index.html --outdir=dist --minify --define:process.env.NODE_ENV='"production"'
```

## 7. Scripts

| Purpose | Vite | Bun |
|---|---|---|
| Dev server | `vite` | `bun --hot src/index.ts` |
| Static production build | `vite build` | `bun build ./src/index.html --outdir=dist --sourcemap --target=browser --minify --define:process.env.NODE_ENV='"production"'` |
| Run production server | `vite preview` | `NODE_ENV=production bun src/index.ts` |

`bun --hot` gives you HMR-equivalent behavior (`development: { hmr: true }`
in `Bun.serve`) without a separate dev-server tool.

## 8. Housekeeping when dropping Vite

- Delete `vite.config.ts` (and any config it merged in from a library, e.g.
  `@mavonengine/core/vite.config`) — nothing replaces "merge base config",
  you just replicate the specific loader/behavior you actually need (§3).
- Remove `vite` and any `vite-plugin-*` from `devDependencies`; add back
  `@types/bun` and `"types": ["bun"]` in `tsconfig.json` if the project also
  has Bun-runtime server code.
- Bun auto-installs a package's `peerDependencies` even if you never list
  them yourself — don't be surprised to find extra packages in
  `node_modules` that aren't in your `package.json`. This is a Bun-package-manager
  behavior, not specific to this migration, but it's why things kept working
  even though we didn't explicitly declare every peer dep a library asked for.

## Verification checklist used here

- Dev server serves with zero console/page errors on load and reload.
- Runtime-loaded (non-imported) binary assets return `200` with the right
  `Content-Length`, not the HTML fallback.
- Feature behavior (physics simulation quality, camera controls) unchanged
  from the working Vite build.
- `bun run build` completes and produces a working bundle.
