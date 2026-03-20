/**
 * @internal Aggregate edge descriptor types and builders.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import type { Schema } from "effect"

// ---------------------------------------------------------------------------
// RefEntity — structural entity type for refs (avoids import of Entity)
// ---------------------------------------------------------------------------

/** Structural entity type for refs — avoids import of Entity */
export interface RefEntity {
  readonly _tag: "Entity"
  readonly entityType: string
  readonly model: Schema.Top
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
  }
  /** Get an entity by key — uses `any` for structural compatibility with Entity's narrower key type */
  readonly get: (key: any) => any
}

// ---------------------------------------------------------------------------
// Edge descriptor types
// ---------------------------------------------------------------------------

/** A one-to-one edge: one member item per aggregate instance */
export interface OneEdge {
  readonly _tag: "OneEdge"
  readonly name: string
  readonly entityType: string
  readonly entity?: RefEntity | undefined
  readonly discriminator?: Record<string, unknown> | undefined
}

/** Configuration for a many edge */
export interface ManyEdgeConfig {
  readonly entityType: string
  readonly entity?: RefEntity | undefined
  readonly inputField?: string | undefined
  readonly edgeAttributes?: ReadonlyArray<string> | undefined
  readonly sk?: { readonly composite: ReadonlyArray<string> } | undefined
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
}

/** A one-to-many edge: multiple member items per aggregate instance */
export interface ManyEdge {
  readonly _tag: "ManyEdge"
  readonly name: string
  readonly entityType: string
  readonly entity?: RefEntity | undefined
  readonly inputField?: string | undefined
  readonly edgeAttributes?: ReadonlyArray<string> | undefined
  readonly sk?: { readonly composite: ReadonlyArray<string> } | undefined
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
}

/** A ref edge: no decomposition, hydrates via entity, data stays inline */
export interface RefEdge {
  readonly _tag: "RefEdge"
  readonly entity: RefEntity
}

/** Union of edge types */
export type AggregateEdge = OneEdge | ManyEdge | RefEdge

// ---------------------------------------------------------------------------
// Edge builders
// ---------------------------------------------------------------------------

/** Create a one-to-one edge descriptor */
export const one = (
  name: string,
  config: {
    readonly entityType: string
    readonly entity?: RefEntity
    readonly discriminator?: Record<string, unknown>
  },
): OneEdge => ({
  _tag: "OneEdge",
  name,
  entityType: config.entityType,
  entity: config.entity,
  discriminator: config.discriminator,
})

/** Create a one-to-many edge descriptor */
export function many<const IF extends string>(
  name: string,
  config: ManyEdgeConfig & { readonly inputField: IF },
): ManyEdge & { readonly inputField: IF }
export function many(name: string, config: ManyEdgeConfig): ManyEdge
export function many(name: string, config: ManyEdgeConfig): ManyEdge {
  return {
    _tag: "ManyEdge",
    name,
    entityType: config.entityType,
    entity: config.entity,
    inputField: config.inputField,
    edgeAttributes: config.edgeAttributes,
    sk: config.sk,
    assemble: config.assemble,
    decompose: config.decompose,
  }
}

/** Create a ref edge descriptor — no decomposition, hydrates via entity, data stays inline */
export const ref = (entity: RefEntity): RefEdge => ({
  _tag: "RefEdge",
  entity,
})

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const isOneEdge = (edge: AggregateEdge): edge is OneEdge => edge._tag === "OneEdge"
export const isManyEdge = (edge: AggregateEdge): edge is ManyEdge => edge._tag === "ManyEdge"
export const isRefEdge = (edge: AggregateEdge): edge is RefEdge => edge._tag === "RefEdge"
