---
title: "ADR-XXXX: Title in Imperative Mood"
id: "ADR-XXXX"
type: "adr"
status: "proposed" # draft | proposed | accepted | implemented | superseded | deprecated | rejected
owner: "Engineering"
lastReviewed: "YYYY-MM-DD"
appliesTo:
  - "src/module/..."
relatedDocs:
  - "docs/architecture/overview.md"
tags: ["architecture", "ecs", "networking", "rendering"]
---

# ADR-XXXX: Title in Imperative Mood

## Status
**Status:** Proposed | Accepted | Implemented | Superseded by ADR-YYYY | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** Team / Author

## Context & Problem Statement
*Describe the context, the architectural friction, and the specific problem needing resolution. Provide evidence from code or operational metrics.*

- **Problem:** What is breaking, slow, or poorly decoupled?
- **Evidence:** Concrete file references, line numbers, or test failure modes.
- **Constraints:** Performance, headless execution, deterministic sim, P2P network constraints, bundle size.

## Considered Options
1. **Option 1: [Title]** — Short description.
2. **Option 2: [Title]** — Short description.
3. **Option 3: [Title]** — Short description.

## Decision Outcome
**Chosen Option:** Option X because [primary rationale].

### Consequences & Trade-offs
- **Positive:**
  - What improves (decoupling, headless testing, performance, maintainability)?
- **Negative / Costs:**
  - What complexity is added? What migration work is created?
- **Risks & Mitigation:**
  - How do we prevent regressions (e.g., automated test suites, balance sweeps)?

## Architecture & Implementation Plan
*Concrete code structures, interfaces, and migration steps.*

```typescript
// Interface or structural example
export interface ExamplePort {
  readonly id: string
  execute(): void
}
```

### Affected Seams
| Seam / Module | Current Behavior | Target Behavior |
| --- | --- | --- |
| `src/...` | Description | Target state |

## Verification & Acceptance
- [ ] Headless test suite passes without DOM/GL dependencies (`bun test`)
- [ ] Balance simulation is unaffected or deterministically validated (`bun run balance`)
- [ ] Browser visual sanity verified for render changes
