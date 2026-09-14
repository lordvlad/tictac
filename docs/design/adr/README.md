---
title: "Architecture Decision Records (ADRs) Index"
id: "ADR-INDEX"
type: "adr"
status: "active"
lastReviewed: "2026-09-14"
appliesTo:
  - "docs/design/adr/**"
relatedDocs:
  - "docs/architecture/overview.md"
tags: ["adr", "architecture", "decisions"]
---

# Architecture Decision Records (ADRs)

This directory records high-stakes architectural decisions, their historical context, alternatives considered, trade-offs, and implementation status.

## Lifecycle Statuses
- **Proposed**: Under review and RFC discussion.
- **Accepted**: Decision approved, implementation pending or scheduled.
- **Implemented**: Change is active in the codebase and verified by tests.
- **Superseded**: Replaced by a subsequent ADR (linked).
- **Deprecated**: Abandoned or no longer applicable.

## Record Table

| ADR ID | Title | Status | Date | Area |
| --- | --- | --- | --- | --- |
| [ADR-0001](./0001-ecs-render-decoupling.md) | ECS Render Decoupling & View-Unit Separation | Implemented / Active | 2026-09-14 | Architecture / ECS |
| [ADR-0002](./0002-deterministic-headless-balance-harness.md) | Deterministic Headless Balance Harness | Implemented | 2026-09-14 | Simulation / Testing |
| [ADR-0003](./0003-p2p-jsonrpc-replication.md) | P2P JSON-RPC 2.0 State Replication & Sender-Resolved Combat | Implemented | 2026-09-14 | Networking / Wire |
