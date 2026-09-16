---
title: "GDD: Status, Trait & Worn Kit Catalogue"
id: "GDD-CATALOG"
type: "gdd"
status: "active"
lastReviewed: "2026-09-16"
appliesTo:
  - "src/core/Arsenal.ts"
  - "src/core/Traits.ts"
  - "src/core/Attachments.ts"
  - "src/core/Items.ts"
  - "src/config.ts"
relatedDocs:
  - "docs/architecture/combat-and-rules.md"
  - "docs/design/gdd/combat-mechanics.md"
tags: ["statuses", "traits", "equipment", "attachments", "reference", "generated"]
---

# GDD: Status, Trait & Worn Kit Catalogue

> **Generated** by `bun run docs:catalog` from `STATUSES`, `TRAITS`, `ITEMS` and the
> tunables in `src/config.ts`. Do not edit by hand — `bun test tests/catalog.test.ts`
> fails when this file and the code disagree.

---

## 1. Statuses

Temporary, and they tick down. One tick happens per handover, so a status lasting
two covers roughly one full round. Every number is **per stack**, and a status that
is not meant to pile up says `1`.

| Id | Name | Per stack | Turns | Max stacks |
| --- | --- | --- | --- | --- |
| `flashed` | Flashed | -40 to hit | 2 | 1 |
| `smoked` | Smoked | -35 to be hit | 2 | 1 |
| `shredded` | Shredded | +25% damage taken | 3 | 1 |
| `stimmed` | Stimmed | +20% AP | 4 | 1 |
| `suppressed` | Suppressed | -12 to hit, -10% AP | 2 | 3 |
| `winded` | Winded | -25% AP | 3 | 1 |

---

## 2. Traits

Lasting, and additive: numbers from every source add, flags are true if any source
sets them. A trait never records where it came from, which is what lets a character
be born with the same property a piece of kit grants.

| Id | Name | Effects | Source |
| --- | --- | --- | --- |
| `deadeye` | Deadeye | +8 accuracy, +6 crit chance | born with |
| `nimble` | Nimble | +10 evasion | born with |
| `juggernaut` | Juggernaut | -5 evasion, +25 max HP | born with |
| `fleet` | Fleet | +2 max AP | born with |
| `stoic` | Stoic | cannot be crit | born with |
| `nullweave` | Nullweave | -3 evasion, cannot be crit | worn (Nullweave Vest) |
| `limping` | Limping | -2 max AP, +50% step cost | wound |
| `concussed` | Concussed | -8 accuracy, -4 evasion | wound |
| `scoped` | Scoped | -5 accuracy, -35% range falloff | fitted (Scope) |
| `braced` | Braced | +10 accuracy crouched, +6 evasion crouched | fitted (Bipod) |
| `silenced` | Silenced | -0.3 crit multiplier, firing does not reveal | fitted (Suppressor) |
| `plated` | Plated | -4 evasion, +6 armour, -15% damage taken, +15% step cost | worn (Plate Carrier) |

### 2.1 Conditional effects

The `crouched` effects apply only while the unit is crouching, and are added by the
unit's own accessors rather than folded into the replicated numbers, because stance
changes constantly and already replicates.

---

## 3. Weapon rails and fitted kit

A rail belongs to a weapon, not to a soldier: hand the rifle over and its glass goes
with it. Rail space is a property of the weapon class - a service rifle is built as a
platform, a hunting shotgun has a bead and a barrel.

| Weapon | Slots |
| --- | --- |
| Rifle | 3 |
| Shotgun | 1 |
| Sniper Rifle | 3 |
| Gatling | 2 |

| Attachment | Slots | Grants | Net effect |
| --- | --- | --- | --- |
| Scope | 1 | Scoped | -5 accuracy, -35% range falloff |
| Bipod | 1 | Braced | +10 accuracy crouched, +6 evasion crouched |
| Suppressor | 1 | Silenced | -0.3 crit multiplier, firing does not reveal |

A weapon refuses a duplicate as well as an overflow: two scopes is not twice the
glass, and the additive fold would count it twice.

---

## 4. Body-worn kit

Marked `passive`: no action of its own, never listed in the action panel, and it
earns its pouch slot by what carrying it does. Nothing worn or fitted is
unconditionally free — each piece either costs something outright or pays only in one
stance.

| Item | Grants | Net effect |
| --- | --- | --- |
| Nullweave Vest | Nullweave | -3 evasion, cannot be crit |
| Plate Carrier | Plated | -4 evasion, +6 armour, -15% damage taken, +15% step cost |

### 4.1 Consumables, for contrast

| Item | AP | Effects |
| --- | --- | --- |
| Stim Pack | 1 | applyStatus, refillAp |
| First Aid Kit | 2 | restoreHp |

---

## 5. Where the numbers come from

| Rule | Value | Source |
| --- | --- | --- |
| Wound: limping at or below | 50% of max HP | `WOUNDS.limping` |
| Wound: concussed at or below | 25% of max HP | `WOUNDS.concussed` |
| Exhaustion after | 2 consecutive turns spending every point | `RULES.exhaustionTurns` |
| Hit points rolled | 85 to 120 | `CHARACTER.hp` |
| Action points rolled | 10 to 14 | `CHARACTER.ap` |
| Evasion rolled | 0 to 12 | `CHARACTER.evasion` |
| Weapon-class accuracy rolled | -8 to +6, +15 for the trained class | `CHARACTER.proficiency` |
| Chance of an innate trait | 55% | `CHARACTER.traitChance` |
| Crit chance clamp | 0 to 75% | `CRIT` |
| Crit range swing | +12 at either end of a weapon's reach | `CRIT.rangeSwing` |
