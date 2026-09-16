import type { TraitId } from './Traits'
import { TraitId as Trait } from './Traits'

/**
 * Things that bolt onto a weapon rather than into a pocket.
 *
 * Separate from {@link Items} because the distinction is real: a stim is
 * carried by a soldier and a scope is fitted to a rifle. Moving one weapon to
 * another soldier takes its glass with it, and a weapon with no rail has
 * nowhere to put it at all.
 */
export const AttachmentId = {
  Scope: 'scope',
  Bipod: 'bipod',
  Suppressor: 'suppressor',
} as const
export type AttachmentId = (typeof AttachmentId)[keyof typeof AttachmentId]

export interface AttachmentSpec {
  id: AttachmentId
  name: string
  /** One line, as the loadout screen shows it. */
  description: string
  /** What fitting it does. The same fold a character's own traits go through. */
  traits: readonly TraitId[]
  /**
   * Slots it occupies. One for everything so far, but a bulky mod costing two
   * is the reason this is a number rather than a count of entries.
   */
  slots: number
}

export const ATTACHMENTS: Record<AttachmentId, AttachmentSpec> = {
  [AttachmentId.Scope]: {
    id: AttachmentId.Scope,
    name: 'Scope',
    description: 'Glass: -5 accuracy up close, a third less lost to distance.',
    traits: [Trait.Scoped],
    slots: 1,
  },
  [AttachmentId.Bipod]: {
    id: AttachmentId.Bipod,
    name: 'Bipod',
    description: '+10 accuracy and +6 evasion, but only while crouched.',
    traits: [Trait.Braced],
    slots: 1,
  },
  [AttachmentId.Suppressor]: {
    id: AttachmentId.Suppressor,
    name: 'Suppressor',
    description: 'Firing never gives the position away, but crits bite less.',
    traits: [Trait.Silenced],
    slots: 1,
  },
}
