# TicTac / No Way Home — Documentation Portal

Welcome to the central documentation portal for **TicTac / No Way Home**. This repository uses a **living documentation** structure where architecture, game design, engineering backlog, and capability milestones evolve alongside code.

---

## Documentation Map

```
docs/
├── architecture/         # Living Technical Architecture
│   ├── overview.md       # System layers, boundaries, runtime topology
│   ├── ecs.md            # Entity Component System, World, replication
│   ├── combat-and-rules.md # Combat formulas, LOS DDA, cover, ballistics
│   ├── headless-sim.md   # Headless simulation & balance automation
│   ├── networking.md     # P2P mesh, PeerJS, JSON-RPC 2.0 wire protocol
│   └── rendering.md      # Three.js view pipeline, animations, FX
│
├── design/               # Game Design & Architectural Decisions
│   ├── rfc/              # Requests for Comments (open designs)
│   │   └── 0001-referee-and-transports.md # Referee, worker/process hosts, transports
│   ├── gdd/              # Game Design Document (GDD)
│   │   ├── README.md     # GDD Overview & index
│   │   ├── overview.md   # Lore, factions, world setting
│   │   ├── combat-mechanics.md # Turn-based tactical combat rules
│   │   ├── melee-combat.md   # Contact fighting (draft)
│   │   ├── noise-and-stealth.md # Loudness, awareness, sneaking (draft)
│   │   ├── interaction-and-environment.md # Item verbs on people, tiles, objects (draft)
│   │   ├── status-and-trait-catalog.md # Generated: every status, trait and worn item
│   │   ├── economy-and-bases.md# Base building, resource management
│   │   └── progression-and-meta.md# RPG progression, wounds, permadeath
│   └── adr/              # Architectural Decision Records (ADRs)
│       ├── README.md     # ADR lifecycle & index
│       ├── 0001-ecs-render-decoupling.md
│       ├── 0002-deterministic-headless-balance-harness.md
│       └── 0003-p2p-jsonrpc-replication.md
│
├── backlog/              # Prioritized Work & Task Tracking (Kanban)
│   ├── README.md         # Backlog taxonomy & workflow
│   ├── active-backlog.md # Specification of every open item (ITEM-xxx), unordered
│   └── completed.md      # Closed items: delivered, measured, rejected
│
├── plans/                # Roadmaps & Milestones
│   ├── README.md         # Planning framework
│   ├── roadmap.md        # Multi-milestone capability roadmap (M1–M4)
│   └── active-focus.md   # Pull order: in flight, next up, open threads (no specs)
│
├── guides/               # Developer Guides & Operational Manuals
│   ├── living-docs-maintenance.md # Living docs rules, metadata schemas, triggers
│   ├── getting-started.md# Setup, scripts, testing, balance sweeps
│   └── asset-pipeline.md # 3D models, Draco compression, SVG icon generator
│
└── schemas/              # Standards, JSON Schemas & Markdown Templates
    ├── doc-frontmatter.schema.json # Living doc metadata schema
    ├── backlog-item-schema.json    # Backlog item schema
    ├── adr-template.md   # ADR authoring template
    ├── rfc-template.md   # Technical RFC template
    ├── backlog-template.md # Backlog item template
    └── plan-template.md  # Milestone execution plan template
```

---

## Quick Reference Links

- 🛠️ **Getting Started**: [Developer Setup & Workflow Guide](guides/getting-started.md)
- 📐 **Architecture**: [System Architecture Overview](architecture/overview.md)
- 🎮 **Game Design**: [GDD: Tactical Combat Mechanics](design/gdd/combat-mechanics.md)
- 📋 **Reference**: [Status, Trait & Worn Kit Catalogue](design/gdd/status-and-trait-catalog.md) — generated from the code by `bun run docs:catalog`
- 🧪 **Designs**: [Noise & Stealth](design/gdd/noise-and-stealth.md) (built, ITEM-019), [Melee](design/gdd/melee-combat.md) (partly built, ITEM-018) and [Interaction & Environment](design/gdd/interaction-and-environment.md) (a draft apart from §2.4, fire and smoke, built in ITEM-034); each says what exists and what is still proposed
- 📋 **Open work, specified**: [Active Backlog](backlog/active-backlog.md)
- 🎯 **What is next, in order**: [Focus Board](plans/active-focus.md)
- 🚀 **Milestones**: [Capability Roadmap](plans/roadmap.md)
- 📖 **Doc Maintenance**: [Living Documentation Guide](guides/living-docs-maintenance.md)
