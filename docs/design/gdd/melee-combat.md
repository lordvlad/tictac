---
title: "GDD: Melee — Fists, Blades and Blunt Instruments"
id: "GDD-MELEE"
type: "gdd"
status: "draft"
lastReviewed: "2026-09-17"
appliesTo:
  - "src/core/Arsenal.ts"
  - "src/core/Ballistics.ts"
  - "src/game/Combat.ts"
relatedDocs:
  - "docs/design/gdd/combat-mechanics.md"
  - "docs/design/gdd/noise-and-stealth.md"
  - "docs/design/gdd/progression-and-meta.md"
tags: ["melee", "combat", "design"]
---

# GDD: Melee — Fists, Blades and Blunt Instruments

**Status: draft.** A design proposal. Every number here is a proposal; shipped numbers live in
the code and surface in the [generated catalogue](status-and-trait-catalog.md).

## 1. Why melee earns its place

The game currently has one answer to an enemy: shoot them. Distance is the only axis, and
every weapon class is a different opinion about it. Melee adds the axis the shooting model
cannot express — **contact** — and with it three things the game wants and does not have:

1. A use for Strength in a fight. The GDD already says Strength dictates melee damage; today
   it carries kit and throws grenades and that is all.
2. A reason to close distance, rather than the current incentive to find the longest sightline
   and never leave it.
3. A **quiet** kill. This is the real prize, and it is why this document and
   [Noise & Stealth](noise-and-stealth.md) are two halves of one idea: a knife is the only
   weapon that can end a sentry without telling the building.

## 2. How a melee attack differs from a shot

Not a weapon with a very short range. A different resolution, because most of what a shot
computes is about the space between two people, and in melee there is none.

| Term | In a shot | In melee |
| --- | --- | --- |
| Range | Falloff over distance, per weapon | Adjacency, or nothing |
| Cover | The wall between you | **Irrelevant** — you are past it |
| Concealment | Smoke, distance, being unseen | Irrelevant to the swing; decisive *before* it |
| Evasion | Target's Agility | Still the target's Agility — but see contest, below |
| Armour | Subtracted flat, penetration per round | Subtracted flat; blunt weapons should care less |
| Ammunition | A clip, a reload | None. A knife never clicks empty |
| The roll | One chance, then damage | A **contest**: the defender gets a say |

Two consequences worth making explicit, because they are what make melee feel different
rather than merely close:

- **Cover being irrelevant is the point.** A soldier in heavy cover is nearly unshootable and
  completely reachable. Melee is the answer to a stalemate the shooting model produces.
- **A contest, not a chance.** A shot asks "did it land". A melee exchange should ask "who
  was better", comparing the attacker's skill and strength against the defender's agility and
  whatever they are holding. A defender with a blade in hand should be a different problem
  from one holding a sniper rifle at arm's length — which is also the honest reason a scoped
  rifle is a liability in a doorway.

## 3. The three families

Deliberately three, because they should answer three different questions rather than be a
damage ladder.

### 3.1 Bare hands
- Always available, costs no slot, needs no kit. Every soldier can do it.
- Least damage, and the only family that can be **non-lethal** — which is what makes a
  prisoner, and ties to the campaign roster.
- Scales hardest with Strength, because it is nothing but Strength.
- Worst against armour: a fist finds nothing a plate does not cover.

### 3.2 Blades — knife, bayonet, sword
- The precision family. Best chance at a **critical**, best at finding a gap in armour, and
  the only weapon that should be able to kill **silently** from behind an unaware target.
- Lightest, cheapest in action points, and the natural sidearm for somebody carrying a rifle.
- A sword over a knife is reach and damage at the cost of concealment — a thing you are
  visibly carrying, which matters to any future "who looks armed" rule.

### 3.3 Bludgeons — club, hammer, rifle butt
- The armour family: blunt force does not care what the plate is made of, so a bludgeon
  should keep most of its damage against armour that blunts a blade, and **shred** armour
  outright.
- Slowest and loudest. A hammer blow on a plate carrier is not a quiet way to kill anybody.
- The *rifle butt* deserves a mention as the free option: a soldier with no melee kit at all
  should be able to swing what they are holding, better than a fist and worse than a club.

## 4. Positioning, and the thing that should be in the game already

- **From behind is different.** An attack on a target that cannot see the attacker should be
  the best thing melee does — and the game already knows who can see whom, per side, and
  already knows which way every unit is facing.
- **A silent kill** is the union of three facts the code already tracks: the target has not
  seen this unit, nobody else has, and the weapon is quiet. See
  [Noise & Stealth](noise-and-stealth.md) for what "nobody else" has to mean.
- **Reach and the doorway.** Melee at one tile makes doorways and stairs into real tactical
  features rather than pathing details, because they are where a squad cannot avoid contact.

## 5. Where it interacts with what already exists

| Existing rule | What melee does to it |
| --- | --- |
| Weapon classes and proficiency | Melee wants its own class(es), so a soldier can be trained in a knife the way they are in a rifle |
| Strength | Gets its first combat consumer: damage, and probably the contest |
| Crit model | Blades should sit at the high end of it; blasts already never crit, and a hammer probably should not either |
| Armour and penetration | The one place a *material* argument belongs: blunt versus edged against plate |
| Suppression | A unit in contact should not be suppressible by fire it is standing inside |
| Overwatch (unbuilt) | Closing on somebody watching a lane is precisely what overwatch exists to punish; the two features want designing together |
| Wounds | Melee is the likeliest source of the "hurt but alive" states wounds already model |

## 6. What exists today, precisely

| Hook | Where | Note |
| --- | --- | --- |
| Weapon table with modes and AP costs | `WEAPONS`, `ShotMode` in `src/core/Arsenal.ts` | Every entry assumes a clip and a range band |
| Damage resolution with armour and crits | `resolveDamage` in `src/core/Ballistics.ts` | Reusable as-is; melee changes the terms feeding it, not the arithmetic |
| Hit chance with cover and range terms | `hitChance` | The terms melee needs to *drop*, which is why it is a sibling path rather than a mode |
| Facing | `PositionComponent.targetYaw` | Already replicated; "from behind" is computable today |
| Per-side visibility | `SightedComponent.seen` | Already answers "can this unit see me" |
| Quiet weapons | `silenced` trait, `firedThisTurn` on stance | The existing model of a weapon that does not announce its user |
| Adjacency | `Grid.distance` | Used by treatment reach already |

## 7. What it needs

1. **A melee resolution path** beside `executeShot`: a contest, no range or cover terms, no
   ammunition. It must be sender-resolved and put its numbers on the wire like every other
   attack, so the two peers cannot roll different fights.
2. **Melee kit**, which is either a weapon class or a new equipment slot. A sidearm slot is
   the more honest shape — a soldier carries a rifle *and* a knife — but it is also a loadout
   screen change and a replication change, so it should be a decision taken deliberately.
3. **A non-lethal outcome**, if bare hands are to make prisoners. Nothing in the game today
   can put a unit out of a fight without killing it.
4. **Strength in the damage path.** Currently derived stats reach movement, carrying and
   throwing; none of them touch damage.

## 8. Risks and open questions

- **It can trivialise the shooting game.** If closing is cheap and a knife kills, cover stops
  mattering. The counter has to be that crossing open ground is expensive and visible —
  which is overwatch's job, and overwatch does not exist yet. Melee shipping *first* should be
  measured hard with the sweep.
- **The AI has to know how to do it.** The headless policy currently picks the best available
  shot. A policy that cannot close will make melee look worthless in every sweep, exactly as
  it once made the shotgun look worthless by never entering its range band.
- **Contest or chance** is the one design decision that cannot be deferred: it decides whether
  melee feels like a duel or like a very short-ranged gun.
- **Facing needs to be trustworthy.** It is replicated, but it is currently cosmetic in most
  situations; making it decide damage makes it worth desynchronising.
