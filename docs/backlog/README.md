---
title: "Engineering & Product Backlog Overview"
id: "BACKLOG-INDEX"
type: "backlog"
status: "active"
lastReviewed: "2026-10-28"
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

### Document Map & Tooling
- **Beads (`bd`)**: Active issues are tracked in the Dolt-backed beads database (`.beads/`). Run `bd list` or `bd ready`.
- [Active Backlog](./active-backlog.md): detailed specifications of open roadmap items cross-referenced with beads IDs.
- [Focus Board](../plans/active-focus.md): what is in flight, pull queue priorities, and caveats left open by finished work.
- [Completed Archive](./completed.md): closed items — what was delivered, measured and left open, and rejected items with their reasoning.

### Item ID Convention
- Architectural & milestone feature items use sequential IDs (`ITEM-001`, `ITEM-002`, ...).
- Granular tasks and issues tracked in beads use the `tictac-<hash>` issue prefix (e.g. `tictac-dwq`, `tictac-0al`).
