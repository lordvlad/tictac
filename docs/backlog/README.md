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
  - "docs/plans/active-focus.md"
tags: ["backlog", "tasks", "kanban"]
---

# Engineering & Product Backlog

## Backlog Taxonomy & Kanban Workflow

Items in the backlog follow a pull-based Kanban flow:

```mermaid
stateDiagram-v2
    [*] --> Backlog: Idea / Requirement Identified
    Backlog --> Ready: Requirements & Seams Defined
    Ready --> InProgress: Pulled into Active Focus
    InProgress --> Blocked: External / Technical Dependency
    Blocked --> InProgress: Dependency Resolved
    InProgress --> Completed: Acceptance Met & Verified
    Backlog --> Dropped: Deprecated or De-scoped
    Ready --> Dropped
```

### Document Map
- [Active Backlog](./active-backlog.md): Prioritized, actionable items ready for or currently in execution.
- [Active Focus Board](../plans/active-focus.md): Current work-in-progress and immediate pull queue.
- [Completed Archive](./completed.md): Historical record of delivered work, verification notes, and retrospective learnings.

### Item ID Convention
- `ARCH-xxx`: Architectural and core structural changes.
- `ENG-xxx`: Systems, ECS, networking, performance, rendering engine work.
- `GAME-xxx`: Gameplay mechanics, combat rules, items, RPG traits, balance.
- `UI-xxx`: HUD, screens, visual design, sound, controls.
