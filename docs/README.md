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
│   ├── gdd/              # Game Design Document (GDD)
│   │   ├── README.md     # GDD Overview & index
│   │   ├── overview.md   # Lore, factions, world setting
│   │   ├── combat-mechanics.md # Turn-based tactical combat rules
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
│   ├── active-backlog.md # Active items (ENG-xxx, GAME-xxx, ARCH-xxx)
│   └── completed.md      # Historical completed archive & findings
│
├── plans/                # Roadmaps & Milestones
│   ├── README.md         # Planning framework
│   ├── roadmap.md        # Multi-milestone capability roadmap (M1–M4)
│   └── active-focus.md   # Current Kanban focus and WIP items
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
- 📋 **Active Tasks**: [Active Backlog](backlog/active-backlog.md)
- 🎯 **Active Focus**: [Current Kanban Focus](plans/active-focus.md)
- 🚀 **Milestones**: [Capability Roadmap](plans/roadmap.md)
- 📖 **Doc Maintenance**: [Living Documentation Guide](guides/living-docs-maintenance.md)
