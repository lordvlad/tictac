---
title: "Game Design Document (GDD) Index"
id: "GDD-INDEX"
type: "gdd"
status: "active"
lastReviewed: "2026-10-01"
appliesTo:
  - "src/game/**"
  - "src/core/**"
relatedDocs:
  - "docs/README.md"
  - "docs/architecture/overview.md"
tags: ["gdd", "design", "gameplay"]
---

# Game Design Document (GDD) — No Way Home / TicTac

## Executive Summary
"No Way Home" is a post-apocalyptic PvPvE turn-based tactics game with dynamic grid-based squad combat, base building, resource management, and meta progression. Players command squads of human survivors in a hazardous shared world laid over the real one; the stranded aliens are run by the game, and become playable much later.

## GDD Modules

| Document | Topic | Description |
| --- | --- | --- |
| [Overview & Setting](./overview.md) | Lore, World, Factions, Opening | Ship broken up over many crash sites, post-EMP earth, humans playable and aliens AI-run (playable later), and how a player arrives: the crash site nearest them, two characters. |
| [World & Travel](./world-and-travel.md) | World Map, Travel, Encounters (designed) | The real-Earth map, a squad's position as waypoints, wall-clock travel, where a player starts, and fights met on the road — including those the AI plays for an absent player. |
| [Combat Mechanics](./combat-mechanics.md) | Turn-based Tactics | Action Points, LOS DDA, cover rules, ballistic equations, weapons, traits. |
| [Status, Trait & Worn Kit Catalogue](./status-and-trait-catalog.md) | Reference (generated) | Every status, trait and passive item with its current numbers, and where each trait can be got from. |
| [Melee Combat](./melee-combat.md) | Contact Fighting (draft) | Fists, blades and bludgeons; contests instead of hit rolls, and the quiet kill. |
| [Noise & Stealth](./noise-and-stealth.md) | Information (draft) | Crouching as sneaking, loudness per action, enemy awareness, breaking glass and thrown stones. |
| [Interaction & Environment](./interaction-and-environment.md) | Verbs (draft) | Using items on squadmates, tiles and objects: keys and locks, doors, fire. |
| [Economy & Base Building](./economy-and-bases.md) | Meta Strategy | Nomadic vs Settled bases, resource gathering, food, crafting, research. |
| [Progression & Squads](./progression-and-meta.md) | RPG Progression | XP, promotions, morale and breaking, wounds, permadeath, recruitment, campaign roster. |
