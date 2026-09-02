import { GLOBAL_ENTITY_ID, type World } from './World'
import {
  AimRulesComponent,
  CoverRulesComponent,
  MatchRulesComponent,
  StatusSpecsComponent,
} from './components'

/**
 * Attach the match-wide tuning tables to the singleton global entity.
 *
 * These components wrap the live `RULES` / `AIM` / `COVER` / `STATUSES`
 * objects, so a debug edit to any of them is picked up by the same component
 * diff that carries per-unit state. There is no separate rules channel.
 */
export function createGlobalRules(world: World): number {
  world.addComponent(GLOBAL_ENTITY_ID, new MatchRulesComponent())
  world.addComponent(GLOBAL_ENTITY_ID, new AimRulesComponent())
  world.addComponent(GLOBAL_ENTITY_ID, new CoverRulesComponent())
  world.addComponent(GLOBAL_ENTITY_ID, new StatusSpecsComponent())
  return GLOBAL_ENTITY_ID
}
