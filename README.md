# tictac (No Way Home)

A post-apocalyptic turn-based tactics game with dynamic squad combat, base building, resource management, and P2P online multiplayer. Built with TypeScript, Three.js, and Bun.

---

## Documentation Portal

Comprehensive living documentation is maintained under [`docs/`](./docs/README.md):

- 📐 **Architecture**: [`docs/architecture/`](./docs/architecture/overview.md) — System layers, ECS engine, combat ballistics, P2P JSON-RPC replication, and rendering pipeline.
- 🎮 **Game Design**: [`docs/design/gdd/`](./docs/design/gdd/README.md) — Game design documents covering lore, combat rules, economy, and character progression.
- 🏛️ **Decisions**: [`docs/design/adr/`](./docs/design/adr/README.md) — Architecture Decision Records (ADRs).
- 📋 **Backlog**: [`docs/backlog/active-backlog.md`](./docs/backlog/active-backlog.md) — Prioritized engineering and gameplay task tracking.
- 🚀 **Roadmap & Plans**: [`docs/plans/roadmap.md`](./docs/plans/roadmap.md) — Milestone roadmaps and active sprint plans.
- 📖 **Guides**: [`docs/guides/`](./docs/guides/living-docs-maintenance.md) — Living documentation guide, dev setup, and asset pipelines.
- 📑 **Schemas**: [`docs/schemas/`](./docs/schemas/doc-frontmatter.schema.json) — JSON schemas and authoring templates for living docs, backlog items, ADRs, and plans.

---

## Quick Start

### Dependencies
```bash
bun install
```

### Development Server
```bash
bun run dev
```
Boots local development server with Hot Module Reloading (HMR) at `http://localhost:5173`.

### Automated Testing & Balance Harness
```bash
# Run automated unit and headless integration test suite
bun test

# Run headless statistical balance sweep (500 seeded matches)
bun run balance

# Run type verification
bun run typecheck
```

---

## Icons

HUD and loadout glyphs come from [game-icons.net](https://game-icons.net), whose
collection is pinned as a submodule at `vendor/game-icons` (CC BY 3.0). The files
the game actually loads are generated into `public/icons/` and committed, so a
plain clone runs without fetching the submodule.

To add one: pick an icon from the collection, add a `"<app name>": "<author>/<icon>"`
line to `scripts/icons.json`, and regenerate.

```bash
git submodule update --init
bun run icons
```

`public/icons/CREDITS.txt` is generated alongside and names the author of every
icon in use.
