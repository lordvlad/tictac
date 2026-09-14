---
title: "RFC-XXXX: Feature / Technical Design Name"
id: "RFC-XXXX"
type: "rfc"
status: "draft" # draft | in-review | approved | in-progress | implemented | withdrawn
owner: "Author Name"
lastReviewed: "YYYY-MM-DD"
appliesTo:
  - "src/game/..."
relatedDocs:
  - "docs/backlog/active-backlog.md"
tags: ["gameplay", "design", "rfc"]
---

# RFC-XXXX: Feature / Technical Design Name

## Executive Summary
*One-paragraph summary of the proposed capability, feature, or subsystem.*

## Motivation & Player/System Value
*Why do we need this? What player experience or architectural capability does this unlock?*

- **Problem / Gap:**
- **Value Proposition:**

## Detailed Design & Specification
*Detailed mechanics, state representation, algorithms, and data structures.*

### Data Structures & Components
```typescript
export interface ExampleData {
  id: string
  value: number
}
```

### Flow / State Machine / Sequences
1. **Trigger:** Event initiation.
2. **Resolution:** How calculations or checks are performed.
3. **Replication / Wire Impact:** How state updates travel over P2P network (`NetworkMessage` / component dirty diffs).
4. **Presentation / FX:** View representation and feedback.

## P2P & Determinism Impact
- **Sender vs Receiver:** Is this resolved on the active peer or re-simulated?
- **Wire Messages:** Added or modified `JsonRpc` methods or `NetworkMessage` payloads.
- **Sanitization:** Validation required against untrusted peer packets.

## Balance & Tuning Implications
- Parameters introduced in `src/ecs/tunables.ts` or `src/config.ts`.
- Expected impact on balance metrics (win rates, turn length, weapon efficiency).
- Headless simulation verification plan (`scripts/balance.ts`).

## Migration & Rollout
- Phase 1: Core logic & unit tests
- Phase 2: ECS integration & wire protocol
- Phase 3: UI & visual effects
- Phase 4: Balance sweep & verification

## Open Questions
- [ ] Question 1...
- [ ] Question 2...
