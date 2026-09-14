---
title: "Rendering Engine & View Pipeline"
id: "ARCH-RENDERING"
type: "architecture"
status: "active"
owner: "Engineering"
lastReviewed: "2026-09-14"
appliesTo:
  - "src/render/**"
  - "src/ecs/systems/RenderSystem.ts"
relatedDocs:
  - "docs/design/adr/0001-ecs-render-decoupling.md"
  - "docs/architecture/overview.md"
tags: ["rendering", "threejs", "animation", "views", "particles"]
---

# Rendering Engine & View Pipeline

## 1. Overview & Engine Stack

The game's visual presentation runs in the browser using **Three.js** and `@mavonengine/core`:
- **Engine Context (`src/engine.ts`)**: Narrow interface providing access to `scene`, `camera`, `canvas`, and loaded `assets`.
- **RenderSystem (`src/ecs/systems/RenderSystem.ts`)**: The single ECS system responsible for bridging component state into 3D transforms, animation playback, and mesh visibility.

---

## 2. View Separation Pipeline

```mermaid
graph LR
    subgraph Data ["Simulation Layer (Pure Data)"]
        Soldier[Soldier Entity]
        Pos[PositionComponent]
        Stance[StanceComponent]
        Health[HealthComponent]
    end

    subgraph System ["ECS System"]
        RenderSys[RenderSystem]
    end

    subgraph View ["Presentation Layer (Three.js)"]
        SoldierView[SoldierView]
        Mesh[glTF Skinned Mesh]
        Mixer[AnimationMixer]
        Mats[Cloned Materials / Team Colors]
    end

    Pos --> RenderSys
    Stance --> RenderSys
    Health --> RenderSys
    RenderSys --> SoldierView
    SoldierView --> Mesh
    SoldierView --> Mixer
    SoldierView --> Mats
```

---

## 3. Visual Effects & Feedback Systems

- **Tracers (`src/render/Tracers.ts`)**: Fast ballistic projectile lines with variable colors and speeds.
- **Damage Indicators (`src/render/DamageIndicators.ts`)**: Floating 3D floating text indicators for hits, misses, crits, and armor shred.
- **Combat FX (`src/render/SceneCombatFx.ts`)**: Concrete implementation of the `CombatFx` interface for interactive matches (spawns muzzle flashes, impact sparks, and death animations).
- **Ground & Grid Overlay (`src/render/Ground.ts` & `src/render/PathMarker.ts`)**: Procedurally textured terrain tiles, cover shield glyphs, and movement range boundary markers.
