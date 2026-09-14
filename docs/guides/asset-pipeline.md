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
  - "public/**"
relatedDocs:
  - "docs/guides/getting-started.md"
tags: ["assets", "gltf", "draco", "icons", "pipeline"]
---

# Asset Pipeline Guide

## 1. Overview

Assets in `tictac` are optimized for web delivery with zero runtime stalls:
- **3D Character Mesh & Animations**: glTF/GLB processed via `@gltf-transform` with Draco compression.
- **Icons & Glyphs**: Optimized SVGs selected from `game-icons.net` via `scripts/icons.json` and compiled to `public/icons/`.

---

## 2. 3D Character Model Pipeline

The source glTF model lives in `assets/UAL1_Standard.glb`. The build script `scripts/build-character.mjs` processes it into `public/character.glb`.

### Transformations Applied:
1. **Deduplication**: Merges duplicate mesh accessors and textures.
2. **Material Normalization**: Ensures standard PBR material parameters compatible with Three.js.
3. **Draco Geometry Compression**: Compresses vertex positions, normals, and texture coordinates for minimal file size.
4. **Animation Strip/Preserve**: Retains key skeletal animations (Idle, Walk, Shoot, Crouch, Death).

### Rebuilding Character Assets:
```bash
bun run build:character
```

Draco WASM decoder binaries are served from `public/draco/` and loaded dynamically by Three.js `DRACOLoader`.

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
