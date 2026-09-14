---
title: "Planning & Milestones Overview (Kanban)"
id: "PLAN-INDEX"
type: "plan"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "docs/plans/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/plans/roadmap.md"
  - "docs/plans/active-focus.md"
tags: ["planning", "roadmap", "kanban", "milestones"]
---

# Planning & Milestones Overview

## Planning Philosophy: Kanban & Architectural Milestones

As a hobby project, development is guided by **architectural dependency and player value** rather than arbitrary deadlines, sprint cycles, or time estimates. Work items are pulled continuously through Kanban stages:

```mermaid
graph LR
    Backlog[Backlog] --> Ready[Ready to Pull]
    Ready --> InProgress[In Progress / WIP]
    InProgress --> Verified[Verified & Completed]
```

---

## Planning Documents

- **[Milestone Roadmap](./roadmap.md)**: Sequential capability milestones (M1 to M4) ordered strictly by dependency.
- **[Active Focus Board](./active-focus.md)**: Current work-in-progress (WIP) and next items in the pull queue.
