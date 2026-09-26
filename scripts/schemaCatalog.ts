/**
 * The pure half of the wire-shape guard: extracting shapes, and deciding
 * whether a checked-in catalog still describes them.
 *
 * Split from `build-schema-catalog.ts` so the decision — the part worth being
 * sure of forever — is importable and testable without spawning a process or
 * touching a file, the same way `Db.ts` is importable apart from the CLI that
 * opens one. See that file's own doc comment for what this guards and why.
 */
import ts from 'typescript'
import { Faction } from '../src/config'
import type { Component } from '../src/ecs/Component'
import {
  ActionPointsComponent,
  AimRulesComponent,
  AmmoComponent,
  ArmorComponent,
  AwarenessComponent,
  CoverRulesComponent,
  DeedsComponent,
  GrenadeSpecsComponent,
  GroundComponent,
  HealthComponent,
  IdentityComponent,
  InventoryComponent,
  ItemsComponent,
  MatchRulesComponent,
  MoraleComponent,
  PositionComponent,
  SightedComponent,
  StanceComponent,
  StatusesComponent,
  StatusSpecsComponent,
  TraitsComponent,
  WallComponent,
  WeaponComponent,
} from '../src/ecs/components'

export const NETWORK_MANAGER = 'src/game/NetworkManager.ts'

/** One default instance of every component this build replicates. */
export const REPLICATED_COMPONENTS: readonly Component[] = [
  new IdentityComponent(Faction.Blue, 0, 'sample'),
  new PositionComponent(),
  new HealthComponent(),
  new ActionPointsComponent(),
  new ArmorComponent(),
  new WeaponComponent(),
  new AmmoComponent(),
  new GrenadeSpecsComponent(),
  new InventoryComponent(),
  new ItemsComponent(),
  new StanceComponent(),
  new SightedComponent(),
  new AwarenessComponent(),
  new MoraleComponent(),
  new DeedsComponent(),
  new StatusesComponent(),
  new TraitsComponent(),
  new MatchRulesComponent(),
  new AimRulesComponent(),
  new CoverRulesComponent(),
  new StatusSpecsComponent(),
  new WallComponent(),
  new GroundComponent(),
]

export interface WireShapeCatalog {
  protocolVersion: number
  commands: Record<string, Record<string, string>>
  components: Record<string, unknown>
}

/**
 * Every `NetworkMessage` variant's fields, read off the union's own text.
 *
 * No type-checker: every variant is already an object type literal in the
 * source, so its property signatures are read straight off the parse tree —
 * name, optionality, and the declared type's own text, never hand-copied.
 */
export async function commandShapes(
  path: string = NETWORK_MANAGER,
): Promise<Record<string, Record<string, string>>> {
  const text = await Bun.file(path).text()
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

  let union: ts.UnionTypeNode | null = null
  source.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'NetworkMessage' && ts.isUnionTypeNode(node.type)) {
      union = node.type
    }
  })
  if (!union) throw new Error(`could not find the NetworkMessage union in ${path}`)

  const shapes: Record<string, Record<string, string>> = {}
  for (const member of (union as ts.UnionTypeNode).types) {
    if (!ts.isTypeLiteralNode(member)) {
      throw new Error(`a NetworkMessage variant in ${path} is not an object literal type`)
    }
    const fields: Record<string, string> = {}
    let variant: string | null = null
    for (const member2 of member.members) {
      if (!ts.isPropertySignature(member2) || !member2.type) continue
      const name = member2.name.getText(source)
      const typeText = member2.type.getText(source).replace(/\s+/g, ' ').trim()
      fields[name] = member2.questionToken ? `optional ${typeText}` : typeText
      if (name === 'type' && ts.isLiteralTypeNode(member2.type) && ts.isStringLiteral(member2.type.literal)) {
        variant = member2.type.literal.text
      }
    }
    if (!variant) throw new Error(`a NetworkMessage variant in ${path} has no literal "type" field`)
    if (Object.hasOwn(shapes, variant)) throw new Error(`two NetworkMessage variants are both named "${variant}"`)
    shapes[variant] = fields
  }
  return shapes
}

/**
 * A value's structural shape: sorted keys for a plain object, the shape of the
 * first element for a nonempty array (arrays are homogeneous everywhere this
 * is used), and `typeof` for everything else.
 */
export function shapeOf(value: unknown): unknown {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : 'array<unknown>'
  if (typeof value === 'object') {
    const shape: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) shape[key] = shapeOf((value as Record<string, unknown>)[key])
    return shape
  }
  return typeof value
}

export function componentShapes(
  components: readonly Component[] = REPLICATED_COMPONENTS,
): Record<string, unknown> {
  const shapes: Record<string, unknown> = {}
  for (const component of components) {
    if (Object.hasOwn(shapes, component.name)) {
      throw new Error(`two replicated components both name themselves "${component.name}"`)
    }
    shapes[component.name] = shapeOf(component.serialize())
  }
  return shapes
}

/** Recursively sorts object keys, so a comparison and the checked-in file are order-independent. */
export function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sorted((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

export async function liveCatalog(protocolVersion: number): Promise<WireShapeCatalog> {
  return sorted({
    protocolVersion,
    commands: await commandShapes(),
    components: componentShapes(),
  }) as WireShapeCatalog
}

export type Verdict =
  | { ok: true; message: string }
  | { ok: false; reason: 'missing' | 'needs-version-bump' | 'stale'; message: string }

/**
 * Whether `existing` — the checked-in catalog — still describes `live`.
 *
 * Fails in exactly two situations: the shape differs and the protocol version
 * did not move (the accident this guard exists to catch), or the shape
 * differs and the version did move but the catalog was never regenerated to
 * match (the same staleness `docs:catalog --check` guards). A change that
 * touches no shape passes regardless of the version.
 */
export function decide(existing: WireShapeCatalog, live: WireShapeCatalog, out: string): Verdict {
  const sameShape =
    JSON.stringify(sorted(existing.commands)) === JSON.stringify(sorted(live.commands)) &&
    JSON.stringify(sorted(existing.components)) === JSON.stringify(sorted(live.components))

  if (sameShape) {
    return { ok: true, message: `${out} is in step with the code` }
  }
  if (existing.protocolVersion === live.protocolVersion) {
    return {
      ok: false,
      reason: 'needs-version-bump',
      message:
        `a command or a replicated component's serialized shape changed, but ` +
        `PROTOCOL_VERSION (src/version.ts) is still ${live.protocolVersion}.\n` +
        `A shape change is a decision, not an accident: bump PROTOCOL_VERSION, then run: bun run schema:catalog`,
    }
  }
  return {
    ok: false,
    reason: 'stale',
    message: `${out} is out of date for protocol ${live.protocolVersion} — run: bun run schema:catalog`,
  }
}
