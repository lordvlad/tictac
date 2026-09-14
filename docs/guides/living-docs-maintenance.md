---
title: "Living Documentation Guide & Maintenance Workflow"
id: "GUIDE-LIVING-DOCS"
type: "guide"
status: "active"
lastReviewed: "2026-09-14"
appliesTo:
  - "docs/**"
relatedDocs:
  - "docs/README.md"
  - "docs/schemas/doc-frontmatter.schema.json"
tags: ["documentation", "process", "governance", "standards", "kanban"]
---

# Living Documentation Guide & Maintenance Workflow

## 1. Philosophy: Documentation as Code in a Hobby Project

Documentation in this repository is **living**: it is maintained in the same repository as the code, evolves with every commit, and reflects the actual runtime architecture, data structures, game balance, and wire protocols.

### Core Principles
1. **Single Source of Truth**: Architecture docs describe how the system works *now*, not how it was originally envisioned. Outdated documentation is treated with the same severity as broken code.
2. **Co-located Updates**: Any PR or commit that alters architectural seams, wire formats, ECS components, balance equations, or build pipelines **must** update the corresponding document in `docs/` in the same change.
3. **Continuous, Event-Driven Maintenance**: Because this is an open-ended hobby project, docs are kept fresh through code-change triggers and automated CI linting rather than calendar-based review schedules or time-bound sprint rituals.
4. **Kanban & Architectural Milestones**: Planning follows pull-based Kanban flow (`Backlog` → `Ready` → `In Progress` → `Completed`) grouped by capability milestones, without arbitrary time estimates or sprint deadlines.
5. **Evidence-First**: Technical claims cite concrete source files (`src/...`), line numbers, or deterministic test/balance outputs rather than abstract assertions.

---

## 2. Directory Structure & Document Taxonomy

```
docs/
├── README.md                      # Central hub, navigation index, and repository map
├── architecture/                  # Living system architecture (current state)
│   ├── overview.md                # System layers, boundaries, and runtime topology
│   ├── ecs.md                     # World, Components, Systems, and dirty state replication
│   ├── combat-and-rules.md        # Combat resolution, LOS DDA, cover, ballistics, statuses
│   ├── headless-sim.md            # Headless execution, determinism, balance runner
│   ├── networking.md              # P2P mesh, PeerJS, JSON-RPC 2.0 wire protocol
│   └── rendering.md               # MavonEngine/Three.js, RenderSystem, view unit separation
├── design/                        # Game & Technical Design
│   ├── gdd/                       # Game Design Document (high-level vision, economy, story)
│   └── adr/                       # Architectural Decision Records (permanent historical decisions)
├── backlog/                       # Granular, prioritized engineering & gameplay tasks
│   ├── active-backlog.md          # Active backlog items with IDs, priority, and acceptance
│   └── completed.md               # Archived historical tasks
├── plans/                         # Strategic and execution planning (Kanban & Milestones)
│   ├── roadmap.md                 # Multi-milestone capability roadmap (M1–M4)
│   └── active-focus.md            # Active Kanban focus and WIP items
├── guides/                        # Operational guides and developer workflows
│   ├── living-docs-maintenance.md # This guide: maintenance standards and workflows
│   ├── getting-started.md         # Dev environment, scripts, test execution
│   └── asset-pipeline.md          # GLB character pipeline, Draco, Game-Icons compiler
└── schemas/                       # JSON schemas and markdown templates
    ├── doc-frontmatter.schema.json# Schema for living document frontmatter
    ├── backlog-item-schema.json   # Schema for backlog items
    ├── adr-template.md            # Template for new ADRs
    ├── rfc-template.md            # Template for Technical RFCs
    ├── backlog-template.md        # Template for Backlog entries
    └── plan-template.md           # Template for Milestone/Feature execution plans
```

---

## 3. Frontmatter Standard

Every markdown document in `docs/` (except brief README indexes) must begin with standard YAML frontmatter matching `docs/schemas/doc-frontmatter.schema.json`:

```yaml
---
title: "Document Title"
id: "UNIQUE-ID"              # e.g., ARCH-ECS, ADR-0001, GDD-COMBAT, GUIDE-ASSETS
type: "architecture"         # architecture | adr | rfc | gdd | guide | backlog | plan | schema
status: "active"             # draft | proposed | accepted | active | implemented | superseded | deprecated
lastReviewed: "YYYY-MM-DD"   # Updated whenever content is verified against source code
appliesTo:
  - "src/ecs/**"
relatedDocs:
  - "docs/architecture/overview.md"
tags: ["ecs", "networking"]
---
```

---

## 4. Maintenance Triggers & Workflows

### Trigger 1: Adding or Modifying ECS Components / Systems
- **Document to update**: `docs/architecture/ecs.md`
- **What to check**:
  - Update component tables and serializable payload shapes.
  - Verify dirty-state sync behaviors and whether the component replicates over P2P.
  - Note any systems that process the component.

### Trigger 2: Modifying Combat, Ballistics, or Game Rules
- **Document to update**: `docs/architecture/combat-and-rules.md`
- **What to check**:
  - Formulas for hit probability, evasion, damage absorption, critical hits, line-of-sight DDA.
  - New traits, statuses, or weapons added to `src/core/Arsenal.ts` or `src/core/Traits.ts`.
  - Impact on balance metrics and headless simulations (`scripts/balance.ts`).

### Trigger 3: Changing Network Messages or Replication
- **Document to update**: `docs/architecture/networking.md`
- **What to check**:
  - Update `NetworkMessage` union and `JsonRpc` notification signatures.
  - Ensure sender-resolution vs receiver-replay rules are documented.
  - Update packet sanitization contracts (`sanitizeSheet`, etc.).

### Trigger 4: Deciding Architectural Shifts (ADR Process)
1. Copy `docs/schemas/adr-template.md` to `docs/design/adr/NNNN-kebab-case-title.md`.
2. Document context, evidence from code, alternatives evaluated, decision rationale, and consequences.
3. Once accepted and implemented, mark status as `implemented` and update `docs/design/adr/README.md`.

### Trigger 5: Backlog & Kanban Task Management
- Active work items are tracked in `docs/backlog/active-backlog.md` following `docs/schemas/backlog-template.md`.
- Active WIP and pull-queue priorities are highlighted in `docs/plans/active-focus.md`.
- Completed work moves to `docs/backlog/completed.md` with verification notes and PR/commit references.

---

## 5. Automated Verification Checklist

Automated verification runs via `bun run lint` (which executes `tsc --noEmit` and `scripts/lint-docs.ts` concurrently):

- [ ] **Frontmatter Validity**: `lastReviewed` date is set to today's date if doc was updated.
- [ ] **File Path Accuracy**: All referenced file paths (e.g. `src/game/Combat.ts`) exist.
- [ ] **Cross-link Integrity**: Relative Markdown links between documents are valid and resolve.
- [ ] **JSON Schema Syntax**: All schemas in `docs/schemas/` parse without error.
