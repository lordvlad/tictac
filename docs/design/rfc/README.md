---
title: "Request for Comments (RFCs) Index"
id: "RFC-INDEX"
type: "rfc"
status: "active"
lastReviewed: "2026-09-17"
appliesTo:
  - "docs/design/rfc/**"
relatedDocs:
  - "docs/design/adr/README.md"
  - "docs/architecture/overview.md"
tags: ["rfc", "design", "proposals"]
---

# Requests for Comments (RFCs)

Where a design is worked out *before* it is decided. An [ADR](../adr/README.md) records a
decision that has been taken and its consequences; an RFC is the argument that precedes one,
and it is allowed to end in open questions.

An RFC that gets built graduates into an ADR, and the RFC stays as the reasoning behind it.

## Lifecycle Statuses
- **Proposed**: Open for discussion; open questions are expected.
- **Accepted**: The design is agreed; an ADR and backlog items carry it forward.
- **Rejected**: Not being built. Kept, because the reasoning is worth more than the outcome.
- **Superseded**: Replaced by a later RFC or ADR (linked).

## Record Table

| RFC ID | Title | Status | Date | Area |
| --- | --- | --- | --- | --- |
| [RFC-0001](./0001-referee-and-transports.md) | Full-Knowledge Lockstep, With an Optional Referee | Accepted → [ADR-0004](../adr/0004-full-knowledge-lockstep.md) | 2026-09-17 | Network / Authority |
