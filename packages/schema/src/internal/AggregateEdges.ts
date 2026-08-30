/**
 * @internal Aggregate edge descriptor types and builders.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import type { Schema } from "effect"

// ---------------------------------------------------------------------------
// RefEntity — structural entity type for refs (avoids import of Entity)
// ---------------------------------------------------------------------------

/**
 * Structural entity type for refs — avoids import of Entity.
 *
 * Generic over `model` and `indexes` so the concrete entity (including its
 * branded primary-key identifier type) flows through the edge builders into
 * the derived aggregate input/update types. The defaults keep the bare
 * `RefEntity` (no type arguments) usable as a non-generic structural bound for
 * the edge descriptors and the runtime helpers in `AggregateSchemas.ts`.
 *
 * `indexes` mirrors `Entity.indexes` (`{ primary: { pk: { composite } }, ... }`);
 * `RefEntityIdentifierValue` reads `indexes.primary.pk.composite` to recover the
 * branded id type. A wider/looser `indexes` simply falls back to `string`.
 *
 * This is a PURE structural bound: edge derivation only reads
 * `model`/`indexes`/`entityType`/`schemas` to recover the ref-id field and its
 * (branded) identifier type — it never calls a runtime operation. It must
 * therefore be satisfiable by a pure `EntityDefinition` (which has no `get`), so
 * aggregate edges can be authored from `@effect-dynamodb/schema` entities with
 * no AWS runtime (issue #66). The runtime ref-hydration path narrows back to a
 * `get`-bearing entity at its single call site.
 */
export interface RefEntity<M extends Schema.Top = Schema.Top, TIndexes = unknown> {
  readonly _tag: "Entity"
  readonly entityType: string
  readonly model: M
  readonly indexes: TIndexes
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
  }
}

// ---------------------------------------------------------------------------
// Edge descriptor types
// ---------------------------------------------------------------------------

/**
 * A one-to-one edge: one member item per aggregate instance.
 *
 * Generic over the referenced entity `E` so its branded primary-key identifier
 * type flows into the derived aggregate input/update types via
 * `RefEntityIdentifierValue<E>`. `E = RefEntity` (the default) preserves the
 * non-generic shape for edges without an associated entity.
 */
export interface OneEdge<E extends RefEntity = RefEntity> {
  readonly _tag: "OneEdge"
  readonly name: string
  readonly entityType: string
  readonly entity?: E
  readonly discriminator?: Record<string, unknown>
}

/** Configuration for a many edge */
export interface ManyEdgeConfig<E extends RefEntity = RefEntity> {
  readonly entityType: string
  readonly entity?: E
  readonly inputField?: string
  readonly edgeAttributes?: ReadonlyArray<string>
  readonly sk?: { readonly composite: ReadonlyArray<string> }
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
}

/**
 * A one-to-many edge: multiple member items per aggregate instance.
 *
 * Generic over the referenced entity `E` so the array element id type can be
 * recovered as the entity's branded identifier when the element IS the ref.
 */
export interface ManyEdge<E extends RefEntity = RefEntity> {
  readonly _tag: "ManyEdge"
  readonly name: string
  readonly entityType: string
  readonly entity?: E
  readonly inputField?: string
  readonly edgeAttributes?: ReadonlyArray<string>
  readonly sk?: { readonly composite: ReadonlyArray<string> }
  readonly assemble?: ((items: ReadonlyArray<unknown>) => unknown) | undefined
  readonly decompose?: ((value: unknown) => ReadonlyArray<unknown>) | undefined
}

/**
 * A ref edge: no decomposition, hydrates via entity, data stays inline.
 *
 * Generic over the referenced entity `E` so its branded identifier flows into
 * the derived aggregate input/update types.
 */
export interface RefEdge<E extends RefEntity = RefEntity> {
  readonly _tag: "RefEdge"
  readonly entity: E
}

/** Union of edge types */
export type AggregateEdge = OneEdge<any> | ManyEdge<any> | RefEdge<any>

// ---------------------------------------------------------------------------
// Edge builders
// ---------------------------------------------------------------------------

/**
 * Create a one-to-one edge descriptor.
 *
 * Generic over the referenced entity `E` so the entity's branded primary-key
 * identifier flows into the derived aggregate input/update types. When `entity`
 * is omitted, `E` defaults to `RefEntity` and the edge id falls back to `string`.
 */
export const one = <const E extends RefEntity = RefEntity>(
  name: string,
  config: {
    readonly entityType: string
    readonly entity?: E
    readonly discriminator?: Record<string, unknown>
  },
): OneEdge<E> => ({
  _tag: "OneEdge",
  name,
  entityType: config.entityType,
  // Spread rather than assign: under `exactOptionalPropertyTypes` an absent
  // optional field must stay absent, not be set to an explicit `undefined`.
  ...(config.entity !== undefined && { entity: config.entity }),
  ...(config.discriminator !== undefined && { discriminator: config.discriminator }),
})

/** Create a one-to-many edge descriptor */
export function many<const E extends RefEntity, const IF extends string>(
  name: string,
  config: ManyEdgeConfig<E> & { readonly inputField: IF },
): ManyEdge<E> & { readonly inputField: IF }
export function many<const E extends RefEntity>(
  name: string,
  config: ManyEdgeConfig<E>,
): ManyEdge<E>
export function many(name: string, config: ManyEdgeConfig): ManyEdge {
  return {
    _tag: "ManyEdge",
    name,
    entityType: config.entityType,
    ...(config.entity !== undefined && { entity: config.entity }),
    ...(config.inputField !== undefined && { inputField: config.inputField }),
    ...(config.edgeAttributes !== undefined && { edgeAttributes: config.edgeAttributes }),
    ...(config.sk !== undefined && { sk: config.sk }),
    ...(config.assemble !== undefined && { assemble: config.assemble }),
    ...(config.decompose !== undefined && { decompose: config.decompose }),
  }
}

/**
 * Create a ref edge descriptor — no decomposition, hydrates via entity, data
 * stays inline. Generic over `E` so the entity's branded identifier flows into
 * the derived aggregate input/update types.
 */
export const ref = <const E extends RefEntity>(entity: E): RefEdge<E> => ({
  _tag: "RefEdge",
  entity,
})

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const isOneEdge = (edge: AggregateEdge): edge is OneEdge<any> => edge._tag === "OneEdge"
export const isManyEdge = (edge: AggregateEdge): edge is ManyEdge<any> => edge._tag === "ManyEdge"
export const isRefEdge = (edge: AggregateEdge): edge is RefEdge<any> => edge._tag === "RefEdge"
