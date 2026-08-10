import {
  DataTexture,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  RedFormat,
  UnsignedByteType,
  type WebGLProgramParametersWithUniforms,
} from 'three'
import { TILE } from '../config'
import type { Grid } from '../core/Grid'

/**
 * The battlefield floor.
 *
 * Rather than spawning one mesh per tile (784 draw calls), the whole floor is a
 * single plane whose material is patched to sample two per-tile data textures:
 *
 *   uFog     R8   0 = unknown, 0.5 = explored (remembered), 1 = visible
 *   uOverlay RGBA8 per-tile highlight colour + alpha (paths, LOS, waypoints)
 *
 * Both are uploaded only when marked dirty. Grid lines are drawn analytically
 * in the fragment shader.
 */
export class Ground {
  readonly mesh: Mesh
  readonly fogTexture: DataTexture
  readonly overlayTexture: DataTexture

  private readonly size: number
  private readonly fogData: Uint8Array
  private readonly overlayData: Uint8Array
  private fogDirty = true
  private overlayDirty = true

  constructor(private readonly grid: Grid) {
    this.size = grid.size

    this.fogData = new Uint8Array(this.size * this.size)
    this.fogTexture = new DataTexture(
      this.fogData,
      this.size,
      this.size,
      RedFormat,
      UnsignedByteType,
    )
    // Linear filtering softens fog boundaries so they do not look like a
    // checkerboard of hard squares.
    this.fogTexture.minFilter = LinearFilter
    this.fogTexture.magFilter = LinearFilter
    this.fogTexture.needsUpdate = true

    this.overlayData = new Uint8Array(this.size * this.size * 4)
    this.overlayTexture = new DataTexture(
      this.overlayData,
      this.size,
      this.size,
      RGBAFormat,
      UnsignedByteType,
    )
    // Overlay tiles must stay crisp — they communicate exact tile boundaries.
    this.overlayTexture.minFilter = NearestFilter
    this.overlayTexture.magFilter = NearestFilter
    this.overlayTexture.needsUpdate = true

    const extent = this.size * TILE
    const geometry = new PlaneGeometry(extent, extent)
    geometry.rotateX(-Math.PI / 2)

    const material = new MeshStandardMaterial({
      color: 0x6c6f63,
      roughness: 0.95,
      metalness: 0.0,
    })

    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uFog = { value: this.fogTexture }
      shader.uniforms.uOverlay = { value: this.overlayTexture }
      shader.uniforms.uGridSize = { value: this.size }
      shader.uniforms.uHalfExtent = { value: (this.size * TILE) / 2 }

      // Tile coordinates are derived from world position, not from the `uv`
      // attribute: three only declares `uv` when a texture map is bound, so
      // relying on it here would break the moment the material changes.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;',
        )

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform sampler2D uFog;
          uniform sampler2D uOverlay;
          uniform float uGridSize;
          uniform float uHalfExtent;
          varying vec2 vWorldXZ;
          `,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>

          // World -> tile space. Tile (x, y) spans [x, x+1) x [y, y+1).
          vec2 tileCoord = (vWorldXZ + uHalfExtent) / ${TILE.toFixed(1)};
          vec2 tileUv = tileCoord / uGridSize;

          // --- grid lines -------------------------------------------------
          vec2 gridDist = abs(fract(tileCoord) - 0.5);
          vec2 gridWidth = fwidth(tileCoord);
          vec2 gridLine = smoothstep(vec2(0.5) - gridWidth * 1.5, vec2(0.5), gridDist);
          float grid = max(gridLine.x, gridLine.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6, grid * 0.8);

          // --- tile overlay (paths / LOS / selection) ---------------------
          vec4 overlay = texture2D(uOverlay, tileUv);
          diffuseColor.rgb = mix(diffuseColor.rgb, overlay.rgb, overlay.a);

          // --- fog of war -------------------------------------------------
          float fogValue = texture2D(uFog, tileUv).r;
          // 0 -> nearly black, ~0.46 -> dim memory, 1 -> fully lit
          float lit = mix(0.07, 1.0, fogValue);
          diffuseColor.rgb *= lit;
          `,
        )
    }
    // Force a distinct program from any other MeshStandardMaterial.
    material.customProgramCacheKey = () => 'tictac-ground'

    this.mesh = new Mesh(geometry, material)
    this.mesh.receiveShadow = true
    this.mesh.name = 'ground'
    this.mesh.userData.type = 'ground'
  }

  // ---------------------------------------------------------------------------
  // Fog
  // ---------------------------------------------------------------------------

  /** `values` is one byte per tile: 0 unknown, 1 explored, 2 visible. */
  setFogFromVisibility(values: Uint8Array): void {
    for (let i = 0; i < this.fogData.length; i++) {
      const v = values[i]!
      this.fogData[i] = v === 2 ? 255 : v === 1 ? 118 : 0
    }
    this.fogDirty = true
  }

  /** Reveal the entire map (used before the first visibility pass). */
  revealAll(): void {
    this.fogData.fill(255)
    this.fogDirty = true
  }

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------

  clearOverlay(): void {
    this.overlayData.fill(0)
    this.overlayDirty = true
  }

  /**
   * Paint a tile. `color` is 0xRRGGBB, `alpha` in [0, 1].
   * Later writes overwrite earlier ones.
   */
  paintTile(x: number, y: number, color: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return
    const i = (y * this.size + x) * 4
    this.overlayData[i] = (color >> 16) & 0xff
    this.overlayData[i + 1] = (color >> 8) & 0xff
    this.overlayData[i + 2] = color & 0xff
    this.overlayData[i + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    this.overlayDirty = true
  }

  /** Upload any dirty textures. Call once per frame. */
  flush(): void {
    if (this.fogDirty) {
      this.fogTexture.needsUpdate = true
      this.fogDirty = false
    }
    if (this.overlayDirty) {
      this.overlayTexture.needsUpdate = true
      this.overlayDirty = false
    }
  }

  dispose(): void {
    this.fogTexture.dispose()
    this.overlayTexture.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshStandardMaterial).dispose()
  }
}
