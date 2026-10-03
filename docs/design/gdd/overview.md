---
title: "GDD: Overview, Lore & World Setting"
id: "GDD-OVERVIEW"
type: "gdd"
status: "active"
lastReviewed: "2026-10-01"
appliesTo:
  - "src/game/**"
relatedDocs:
  - "docs/design/gdd/README.md"
  - "docs/design/gdd/progression-and-meta.md"
  - "docs/design/gdd/economy-and-bases.md"
tags: ["lore", "world", "factions"]
---

# GDD: Overview, Lore & World Setting

## 1. Setting & Backstory

A massive alien vessel breaks up on entry over Earth. Its hull devastates one impact zone; pods, stasis capsules and debris come down at sites across the world; and the discharge sends out an EMP shockwave that collapses global power grids and electronic infrastructure. There is no single ground zero: every region has a crash site of its own.

- **Human Perspective**: In the wake of the blackout, human survivors fractured into opportunistic scavengers, prepper enclaves, and paramilitary remnants fighting for dwindling resources.
- **Alien Perspective**: The extraterrestrial crew was fleeing a hostile cosmic entity when an in-flight collision with the legacy Voyager 1 probe forced an emergency descent. Awakened from stasis as the ship came apart, scattered across crash sites half a world from one another, with non-functional drives, the aliens are stranded with *no way home*. They are decentralized survivor factions because the crash scattered them, not by choice.

---

## 2. Factions

**Humans are the only playable faction at the start. The aliens are run by the game.** Playing
as an alien is planned, but much later — after a significant in-game event (the world's own
story opening the door), once the player base has grown enough to fill a second side, or when
there is simply more time to build it. Until then the aliens are AI: the "E" in PvPvE, with the
same rules, kit and morale as anyone else. Their lore and strengths below are written for both
uses — what an AI alien fights with now is what a player alien will play with later.

**An AI alien has no persistent identity.** There is no alien roster, no named survivor who
remembers you, nothing carried from one fight to the next. Meeting them works like a wild
encounter in Pokémon: a random alien squad, rolled fresh for that fight, at a random place
(§4). It fights, and once the fight is settled it is gone. Only the human side keeps what
happened — growth, wounds, the dead.

### Human Survivors
- **Strengths**: Adaptation to terrestrial biomes, direct consumption of local food supplies, broad kinetic firearm proficiencies.
- **Vulnerabilities**: Higher susceptibility to environmental hazards and radiation.

### Stranded Aliens (AI-run; playable later)
- **Strengths**: Advanced plasma/energy technologies, enhanced bio-mechanical traits, specialized energy harvesting.
- **Vulnerabilities**: Need specialized matter converters for food synthesis; high energy reliance.

---

## 3. The Opening: How a Player Arrives

**Status:** designed, not built. Today registration deals six characters straight into the
roster screen; the opening below hands over two (`ITEM-047`).

A player begins at a random point near their real-world location: the game world is laid over
the real one, and a player in Lyon starts somewhere around Lyon. The anchor is the latitude and
longitude Cloudflare reports for the connection (`request.cf`), an IP-based estimate that is
city-level at best; the start is drawn uniformly over the area within **50 km** of it, and the
crash site the opening plays out at is placed there. Only the drawn point is kept, never the
reported one.

Two players who live near each other start in the same area: two players drawn from one anchor
land about 45 km apart on average, and neighbours are likely to share an anchor, because an
IP estimate tends to put a whole city on one point. The radius keeps them from landing on top of each
other; it does not guarantee it once many players share an anchor (a pair lands within 1 km of
each other about one time in 2,500, so a hundred players from one city would produce a couple of
such pairs). A draw within a minimum distance of an existing start is therefore drawn again.
Placing players where they physically are also lines in-game position up with real distance,
which is what [RFC-0002](../rfc/0002-region-sharded-durable-objects.md) §6.1 wants when it
places a region's server.

The draw is setup, not rules: it uses system randomness, the way dealing a squad does, and
never the match stream.

The opening is short and played, not watched. It ends when the player holds two characters and
somewhere to stand.

### Human
The pulse hits wherever the player is. Screens die, engines stall, the phone in your hand is a
brick. One other person is with you — whoever you were with when it happened. Something is
coming down over the region, close.

Where you were decides what comes next, and that is the Nomadic/Settled choice
([Economy & Bases](economy-and-bases.md) §1) given as an answer rather than a menu. Near walls —
a bunker, a warehouse, a prepper compound — you bar the door: Settled. On the road, beside an old
diesel the pulse had nothing in to kill, you keep moving: Nomadic.

### Alien (later: when aliens become playable)
The opening starts in the fall, not after it. Stasis fails as the ship comes apart; two pods
come down within reach of each other, and the rest of the crew is somewhere else — scattered,
not dead. The wreck you landed in is the Settled answer: fixed, defensible, full of dead
technology to salvage. A craft or ground vehicle stripped off it before anyone else arrives is
the Nomadic one.

### Two, not a squad
The opening hands over two characters, named, and nothing more. "Squad" is an overstatement at
first: the early fights are fought by two, and the bench grows by finding people — survivors in
the ruins, and, once aliens are playable, scattered crew for them. How many a
player can keep is set by the bases and vehicles they hold
([Progression & Squads](progression-and-meta.md#5-permadeath-wounds--roster-persistence) §5,
[Economy & Bases](economy-and-bases.md) §1), not by a number dealt at registration. A lost fight
still carries one of the fallen out alive (Progression §5), so a player who starts with two is
never left with nobody.

### Why this frame
- **The title holds for both sides.** The aliens cannot go home; the humans' home ended at the
  same instant. One event, two losses.
- **The scattering does the worldbuilding.** Decentralized alien factions (§1), a crash site per
  region, and every recruit being somebody the crash separated from somebody else all follow from
  the ship breaking up rather than landing whole.
- **Two makes every loss count.** Losing one of two is half of everything a player has, which is
  what permadeath is for.

---

## 4. Dynamic World & Global Events

The shared world map features emergent environmental hazards, regional player-driven milestones
and the encounters the AI aliens provide. How the map, travel and encounters on the road work is
in [World & Travel](world-and-travel.md).
- **Wild Encounters**: a random alien squad at a random place, rolled fresh for the fight and
  gone after it (§2). It is the commonest fight early on, and the first kind of fight that states
  its own squad cap rather than a flat one (`ITEM-047`): a player with two characters can be met
  by a squad sized for two.
- **Radio Networks**: Players constructing communications towers gradually unlock regional chat and shared intelligence.
- **Environmental Shocks**: Radiation storms, EMP aftershocks, and road washouts dynamically alter travel times and combat visibility.
- **Late-Game Threat**: Clues and escalating incursions from the cosmic pursuer that originally drove the aliens to Earth.
