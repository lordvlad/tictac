---
title: "Engineering & Product Backlog Overview"
id: "BACKLOG-INDEX"
type: "backlog"
status: "active"
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
- [Active Backlog](./active-backlog.md): the specification of every open item — why, change, acceptance. Unordered.
- [Focus Board](../plans/active-focus.md): what is in flight and the order the Ready items are pulled in. No specifications.
- [Completed Archive](./completed.md): closed items — what was delivered, measured and left open, and rejected items with their reasoning.

### Item ID Convention
All work items follow a single, unified sequential key:
- `ITEM-001`, `ITEM-002`, `ITEM-003`, ... across all categories (architecture, features, balance, refactoring, UI).
