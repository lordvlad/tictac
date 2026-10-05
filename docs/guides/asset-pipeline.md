---
title: "Asset Pipeline Guide (3D Models, Draco, Icons)"
id: "GUIDE-ASSET-PIPELINE"
type: "guide"
status: "active"
lastReviewed: "2026-09-14"
appliesTo:
  - "scripts/build-character.mjs"
  - "scripts/build-icons.mjs"
  - "scripts/icons.json"
  - "src/render/SoldierView.ts"
  - "src/render/WeaponModel.ts"
  - "src/render/LoadoutScene.ts"
  - "public/**"
relatedDocs:
  - "docs/guides/getting-started.md"
tags: ["assets", "gltf", "draco", "icons", "pipeline"]
---

# Asset Pipeline Guide

## 1. Overview

Assets in `tictac` are optimized for web delivery with zero runtime stalls:
- **3D Character Mesh & Animations**: glTF/GLB processed via `@gltf-transform`; almost all of the
  source's weight is keyframes, so the saving comes from dropping clips rather than from
  compressing geometry.
- **Icons & Glyphs**: Optimized SVGs selected from `game-icons.net` via `scripts/icons.json` and compiled to `public/icons/`.

---

## 2. 3D Character Model Pipeline

The source glTF model lives in `assets/UAL1_Standard.glb`. The build script `scripts/build-character.mjs` processes it into `public/character.glb`.

### Transformations Applied:
1. **Clip whitelist and rename**: `KEEP` maps a source clip name to the key the game looks up.
   Everything else is disposed with its channels and samplers. The source ships 43 clips on a
   ~13.7k-triangle mesh, so this is where the 7.27 MB becomes 2.43 MB.
2. **Accessor pruning**: only `PropertyType.ACCESSOR`. Pruning nodes or meshes risks dropping
   skeleton joints that the skin references but nothing else "uses".
3. **Fail on a missing clip**: a key that is not in the source exits non-zero, because a missing
   clip is silent at runtime — `animationsMap.get` returns undefined and the soldier holds its
   last pose.

The thirteen shipped clips are `idle`, `crouch`, `run`, `crouchWalk`, `aim`, `shoot`, `hit`,
`reload`, `punch`, `swing`, `throw`, `interact` and `death`. Every one of them is played by
`SoldierView`; `tests/animation.test.ts` fails if the asset and that list diverge. Adding a clip
means adding it to `KEEP`, to the list in that test, and to whatever plays it.

### Rebuilding Character Assets:
```bash
bun run build:character
```

No Draco pass runs today: the mesh is small and the file is nearly all animation. The runtime
still points `DRACOLoader` at `public/draco/` (`src/main.ts`), so a Draco-compressed asset would
load if one were produced.

---

## 2b. Weapon Models

`public/weapons/<WeaponId>.glb` are CC0 models from Quaternius' *Ultimate Guns Pack* (credits in
`public/weapons/CREDITS.txt`). `main.tsx` loads one asset per `WeaponId` as `weapon-<id>`, and
`HeldWeapon` (`src/render/WeaponModel.ts`, used by `SoldierView` and `LoadoutScene`) parents the
matching model to the `hand_r` bone. Models are authored stock down +X, muzzle toward -X, ~5.5
units long, so one `WEAPON_SCALE` serves them.

The model is *not* fixed to the palm's orientation: clips disagree about which way the hand
faces, so a rigid attachment points at the floor whenever the arm hangs. Every frame `update()`
turns the muzzle to the soldier's front, level when the hand is at shoulder height and dropped
40° at low ready as it falls, and keeps the tuned grip point (`GRIP_POSITION`, measured against the
`aim` clip, shotgun overridden) in the palm. The pack has no handheld minigun, so `gatling` uses
the bulkiest body (`Bullpup_1`). Portraits are still unarmed.

---

## 3. Icon Compilation Pipeline

HUD, weapon, ammo, grenade, and trait icons are sourced from `vendor/game-icons` (licensed CC BY 3.0).

### Workflow for Adding New Icons:
1. Ensure the submodule is initialized:
   ```bash
   git submodule update --init
   ```
2. Open `scripts/icons.json` and map the application icon name to the game-icons path:
   ```json
   {
     "weapon-plasma": "skoll/plasma-rifle",
     "item-nanite": "lorc/nanites"
   }
   ```
3. Run the icon generator:
   ```bash
   bun run icons
   ```
4. This outputs:
   - Optimized SVG files in `public/icons/<name>.svg`
   - Generated attribution in `public/icons/CREDITS.txt`
   - TypeScript identifiers in `src/hud/icons.ts` (if applicable)
