---
title: "Current Execution Plan: Sprint Active"
id: "PLAN-SPRINT-CURRENT"
type: "plan"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/**"
relatedDocs:
  - "docs/backlog/active-backlog.md"
  - "docs/plans/roadmap.md"
tags: ["sprint", "execution", "active"]
---

# Current Execution Plan: Sprint Active

## Sprint Metadata
- **Theme:** Complete ECS Data/View Decoupling & Enable Headless Squad Construction
- **Status:** In Progress
- **Primary Milestone:** Milestone 1 (Headless Core & Decoupling)

---

## Sprint Objectives & Definition of Done
1. Deliver `SoldierView` / `Soldier` separation (`ENG-001`).
2. Verify all test suites pass without canvas stubs (`bun test`).
3. Ensure no visual or animation regressions during interactive browser sessions (`bun run dev`).
4. Execute balance test harness to prove zero rule regressions (`bun run balance`).

---

## Work Breakdown

| Task ID | Item Summary | Owner | Dependencies | Status |
| --- | --- | --- | --- | --- |
| `ENG-001.1` | Create `SoldierView.ts` and `SquadViews.ts` render abstractions | Eng | Narrow Ports (`ARCH-001`) | In Progress |
| `ENG-001.2` | Refactor `Soldier.ts` to pure component data wrapper | Eng | `ENG-001.1` | In Progress |
| `ENG-001.3` | Update `RenderSystem.ts` to synchronize component transforms to views | Eng | `ENG-001.2` | Ready |
| `ENG-001.4` | Remove `installCanvasStub` from test suites (`tests/movement.test.ts`, etc.) | Eng | `ENG-001.3` | Ready |
| `VERIF-001` | Validate browser visual animations, turns, and balance sweep | Eng | `ENG-001.4` | Ready |
