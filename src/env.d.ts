// Side-effect CSS imports (e.g. `import './game.css'`) are bundled by Bun but
// need an ambient module declaration to satisfy `tsc --noEmit`.
declare module '*.css'
