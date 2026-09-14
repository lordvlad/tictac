---
title: "Engineering & Product Backlog Overview"
id: "BACKLOG-INDEX"
type: "backlog"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "docs/backlog/**"
relatedDocs:
  - "docs/schemas/backlog-template.md"
  - "docs/plans/roadmap.md"
tags: ["backlog", "tasks", "planning"]
---

# Engineering & Product Backlog

## Backlog Taxonomy & Workflow

Items in the backlog follow a strict lifecycle and schema (`docs/schemas/backlog-item-schema.json`):

```mermaid
stateDiagram-v2
    [*] --> Backlog
    Backlog --> Ready: Requirements & Seams Defined
    Ready --> InProgress: Assigned in Active Sprint
    InProgress --> Blocked: Dependency or External Blocker
    Blocked --> InProgress: Blocker Resolved
    InProgress --> Completed: Acceptance Met & Verified
    Backlog --> Dropped: Deprecated or De-scoped
    Ready --> Dropped
```

### Document Map
- [Active Backlog](./active-backlog.md): Prioritized, actionable items ready for or currently in execution.
- [Completed Archive](./completed.md): Historical record of delivered work, verification notes, and retrospective learnings.

### Item ID Convention
- `ARCH-xxx`: Architectural and core structural changes.
- `ENG-xxx`: Systems, ECS, networking, performance, rendering engine work.
- `GAME-xxx`: Gameplay mechanics, combat rules, items, RPG traits, balance.
- `UI-xxx`: HUD, screens, visual design, sound, controls.
