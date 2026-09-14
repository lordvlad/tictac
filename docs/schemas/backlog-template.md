---
title: "Backlog Item Template"
id: "SCHEMA-BACKLOG"
type: "schema"
status: "active"
owner: "Engineering"
lastReviewed: "YYYY-MM-DD"
---

# Backlog Item Format

Every backlog item in `docs/backlog/` MUST follow this structured format:

```markdown
### [ITEM-ID] Title in Imperative Form
**Type:** Feature | Tech-Debt | Bug | Refactor | Balance | Infrastructure
**Priority:** P0 | P1 | P2 | P3
**Status:** Backlog | Ready | In-Progress | Blocked | Completed | Dropped
**Milestone:** Target Milestone / Sprint Name
**Owner:** Assignee / Unassigned

#### Why
A concise description of the problem, motivation, player impact, or technical debt. Include evidence from codebase or metrics.

#### Change
Step-by-step description of the architectural or implementation changes. Name concrete files, interfaces, and patterns.

#### Affected Files
- `src/path/to/FileA.ts`
- `src/path/to/FileB.ts`
- `tests/path/to/FileA.test.ts`

#### P2P / Simulation Impact
- Wire protocol changes (NetworkMessage / JsonRpc)
- Deterministic simulation impact
- Headless balance runner implications

#### Acceptance Criteria
- [ ] Verifiable requirement 1
- [ ] Verifiable requirement 2
- [ ] Automated regression tests added (`bun test`)
- [ ] Headless balance harness passes if applicable (`bun run balance`)
- [ ] Living documentation updated in `docs/`

#### Risks & Mitigations
- **Risk:** Known risk or failure mode.
- **Mitigation:** Verification or architectural constraint preventing it.
```
