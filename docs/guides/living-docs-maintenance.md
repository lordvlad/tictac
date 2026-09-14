---
title: "Living Documentation Guide & Maintenance Workflow"
id: "GUIDE-LIVING-DOCS"
type: "guide"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "docs/**"
relatedDocs:
  - "docs/README.md"
  - "docs/schemas/doc-frontmatter.schema.json"
tags: ["documentation", "process", "governance", "standards"]
---

# Living Documentation Guide & Maintenance Workflow

## 1. Philosophy: Documentation as Code

Documentation in this repository is **living**: it is maintained in the same repository as the code, evolves with every commit, and reflects the actual runtime architecture, data structures, game balance, and wire protocols.

### Core Principles
1. **Single Source of Truth**: Architecture docs describe how the system works *now*, not how it was originally envisioned. Outdated documentation is treated with the same severity as broken code.
2. **Co-located Updates**: Any PR or commit that alters architectural seams, wire formats, ECS components, balance equations, or build pipelines **must** update the corresponding document in `docs/` in the same change.
3. **Structured & Schematized**: Documents use standard YAML frontmatter validated against JSON schemas in `docs/schemas/` to ensure metadata integrity, traceability, and discoverability.
4. **Evidence-First**: Technical claims cite concrete source files (`src/...`), line numbers, or deterministic test/balance outputs rather than abstract assertions.

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
├── plans/                         # Strategic and execution planning
│   ├── roadmap.md                 # Multi-milestone roadmap
│   └── sprints/                   # Active and historical execution sprint plans
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
    └── plan-template.md           # Template for Sprint/Milestone plans
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
owner: "Engineering"
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

### Trigger 5: Backlog & Task Management
- Active work items are tracked in `docs/backlog/active-backlog.md` following `docs/schemas/backlog-template.md`.
- Completed work moves to `docs/backlog/completed.md` with verification notes and PR/commit references.
- Sprint plans in `docs/plans/sprints/` reference Backlog Item IDs (`ENG-XXX`, `GAME-XXX`).

---

## 5. Review & Verification Checklist

When submitting or reviewing changes to the repository:

- [ ] **Frontmatter Validity**: `lastReviewed` date is set to today's date if doc was updated.
- [ ] **File Path Accuracy**: All referenced file paths (e.g. `src/game/Combat.ts`) exist and line references are accurate.
- [ ] **Diagram Correctness**: Mermaid sequence/class/flow diagrams reflect actual code pathways.
- [ ] **Cross-link Integrity**: Relative Markdown links between documents are valid and resolve.
- [ ] **No Dead Code in Docs**: Removed or refactored functions/classes are purged from architecture guides.
