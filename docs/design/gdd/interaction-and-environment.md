---
title: "GDD: Interaction — Using Things On People, Places and Objects"
id: "GDD-INTERACTION"
type: "gdd"
status: "draft"
lastReviewed: "2026-09-17"
appliesTo:
  - "src/core/Items.ts"
  - "src/ecs/systems/ItemSystem.ts"
  - "src/core/Walls.ts"
  - "src/ecs/components/WallComponent.ts"
relatedDocs:
  - "docs/design/gdd/combat-mechanics.md"
  - "docs/design/gdd/noise-and-stealth.md"
  - "docs/design/gdd/melee-combat.md"
  - "docs/architecture/combat-and-rules.md"
tags: ["interaction", "items", "environment", "design"]
---

# GDD: Interaction — Using Things On People, Places and Objects

**Status: draft.** This is a design proposal. Numbers in it are proposals, not current
values; anything that ships gets its numbers from the code and appears in the
[generated catalogue](status-and-trait-catalog.md).

## 1. The idea in one line

A soldier's pouch should point outwards. Right now every item is something you do to
yourself or, since targeted use landed, to a squadmate within reach. The next step is that
the same verb — *use this, on that* — reaches **places and objects** as well as people: a key
in a lock, a crowbar on a shutter, a torch against a curtain.

This is deliberately one mechanic, not three. An item already carries a list of effects and
the system that applies them is the only thing that knows what an effect *does*. Extending
that to "what you can point an item at" keeps every new verb as data.

## 2. What a target can be

Three kinds, in order of how much new machinery each needs.

### 2.1 A person (shipped)
A medic treats a squadmate within arm's reach; a mechanic patches their plate. Two taps —
pick the kit, pick who gets it — and the cost and the item come out of the user's pouch.
Described in [Combat Mechanics §2.6](combat-mechanics.md); this document does not restate it.

The one gap worth naming: **an enemy is not a legal patient, and should be.** Treating a
downed opponent is how a prisoner happens, and poisoning somebody else's water is the same
verb pointed the wrong way. The rules already refuse a dead target; whether a *living enemy*
can be reached is a design decision nobody has made rather than a limitation.

### 2.2 A place — the tile a unit is standing next to
Some uses have no object at all. They happen at a spot on the ground.

- **A flare or chemlight** dropped on a tile: lights it, and — see
  [Noise & Stealth](noise-and-stealth.md) — advertises it.
- **A charge** placed rather than thrown, going off on a later turn.
- **A fire** started on something that burns.

A tile target needs nothing about objects to exist. It needs a hazard that *lives on the
grid and ticks*, which the game does not have: every effect today is a status on a unit,
counted down per unit by the turn system. Fire that sits in a doorway for three turns and
hurts whoever is standing in it is a genuinely new kind of state — a per-tile effect with a
duration, an owner, and rules for spreading.

That is the expensive part of this proposal, and it is worth being honest that "set something
on fire" is mostly a request for **tile hazards**, not for a lighter.

### 2.3 An object — a wall segment with state
This is the cheap one, and it is cheap because of a decision already taken: walls are
entities. Each segment carries a replicated component naming its **kind**, and the kind
decides height, whether sight passes and whether it stops a bullet. Change the kind and every
consumer — line of sight, cover, the camera's occlusion fade, the renderer — agrees
immediately, on both peers, with nothing new on the wire.

So an interactive object is a wall kind that can change:

| Object | Starts as | Use | Becomes |
| --- | --- | --- | --- |
| Door | closed: stops sight, stops bullets | push it (free, or a point) | open: a doorway |
| Locked door | closed, and refuses the push | a **key**, or a crowbar, or a boot | open, or broken |
| Shutter | closed | crowbar | open |
| Glazing | transparent, stops nothing, cannot be walked through | any hit, or a thrown stone | gone — and loudly |

Today's wall kinds are `None`, `Solid`, `Parapet` and `Glass`. A door is the missing one, and
it is missing in an interesting way: the map generator already places **doorways** — gaps in a
run of wall, chosen along a spanning tree over the rooms so every room is reachable. Those
gaps are where doors would go, and the generator already knows which of them are interior and
which lead outside.

## 3. Keys, and why a lock is a good idea

A locked door is the first thing in the game that a squad cannot solve with damage. Every
other obstacle is either walked around or shot. A lock asks a different question: *did anybody
bring the key, and is it worth the AP to look for another way in?*

- A **key** is an item with no effects of its own — it exists to satisfy a lock. That is a
  new shape: every item today is a bundle of effects, and a key is a bundle of *permissions*.
- A lock can be answered three ways, and the three should feel different: the key (quiet,
  cheap), a crowbar or a shoulder (slow, loud), or the window beside it (fast, very loud, and
  it leaves glass on the floor).
- **Where keys come from** is a campaign question, not a combat one: found on the map, carried
  by a specific enemy, or brought from the base. It ties directly to the roster and stash work
  in [Progression](progression-and-meta.md), so a lock is also a reason to have a stash.

## 4. What the player sees

The interaction verb should be the one they already know from a medkit.

- Items that can be pointed at something announce it on their row, exactly as targeted
  medical kit does now, and pressing the row starts a **pick a target** step instead of
  firing the item off.
- The pick step accepts whatever that item can point at: squadmates, tiles in reach, or the
  door in front of you — one selection mode, filtered by the item rather than three modes the
  player has to learn.
- Anything the squad can interact with should be legible *before* the item is in hand. A door
  that is locked should read as locked from across the room; discovering it only after walking
  up and spending the points is the kind of surprise that feels like a bug.
- Reach is one tile, as it is for treatment. A soldier who wants the door open stands at it.

## 5. What exists today, precisely

| Hook | Where | What it gives this design |
| --- | --- | --- |
| Item effects as data | `src/core/Items.ts` | A new verb is an effect kind plus one branch |
| Targeted use | `ItemSystem.use(user, id, target?)` | The two-tap interaction, already built and replicated |
| Walls as entities | `WallComponent` (`kind`, replicated) | Object state that every consumer and both peers already read |
| Wall materials | `WALLS` in `src/core/Walls.ts` | Height, transparency and shielding per kind |
| Doorways | `generateMap` round 3 | Somewhere to put doors, already reachability-checked |
| Statuses with duration | `StatusesComponent`, ticked per turn | The model a tile hazard would be a sibling of — but per unit, not per tile |

## 6. What it needs, honestly

1. **A target that is not a unit.** `ItemSystem.use` takes soldiers. Pointing an item at a
   tile or a wall segment means the command, the wire message and the effect switch all learn
   a target that is one of several kinds. This is the load-bearing change; everything else in
   this document is data on top of it.
2. **A door kind, and lock state.** Cheap, given walls are entities. The lock itself is one
   more field on the wall segment, and it replicates with the rest.
3. **Per-tile hazards with a clock.** New. Needed only for fire and for placed charges; keys
   and doors do not want it. Worth splitting into its own item so that "open the locked door"
   can ship without waiting for "burn the barn down".
4. **Interaction range and pathing.** A door you cannot reach is a door you cannot open, and
   the planner currently routes to tiles, not to *things*.

## 7. Risks and open questions

- **Verb sprawl.** Three ways to open a door is good; ten items that each open one kind of
  thing is a menu. The test for a new interactive object: does it change what a squad *does*,
  or only how long it takes?
- **Fire is a balance change disguised as a feature.** An effect that persists on the ground
  and spreads is the first thing in the game that damages units on nobody's turn. It wants
  measuring with the sweep before it is believed.
- **Enemies as targets** needs a rule for whether a peer may aim a helpful item at your
  soldier, which is a wire-trust question, not a design one.
- **Who may open what.** If a door can be opened on your turn by a unit you do not own, the
  sender-resolved contract needs a sentence about it.
