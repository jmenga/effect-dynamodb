/**
 * Aggregate (pure definition layer) — builds the AWS-free half of an Aggregate:
 * the Schema.Class hierarchy binding, edge graph, partition/collection key
 * configuration, and the derived `inputSchema` / `updateSchema` / `createSchema`.
 *
 * This module is AWS-SDK-free in BOTH its runtime import graph and its
 * emitted `.d.ts` surface. The full `effect-dynamodb` package provides the
 * operational `Aggregate.make` (with `get` / `create` / `update` / `delete` /
 * `list`) that additionally carries the AWS runtime (DynamoClient, Marshaller,
 * Batch/Transaction). Both reuse the pure {@link deriveAggregateSchemas}
 * derivation so the schemas have a single source of truth.
 *
 * `Aggregate.make()` here returns a pure {@link AggregateDefinition} (top-level
 * form) or a {@link SubAggregate} (sub-aggregate form). Consumers who only need
 * the derived schemas can import it from `@effect-dynamodb/schema` without
 * pulling the AWS SDK into their dependency graph or type surface.
 */

import type { Schema } from "effect"
import type * as DynamoSchemaModule from "./DynamoSchema.js"
import type { DiscriminatorConfig } from "./internal/AggregateCursor.js"
import type { AggregateEdge } from "./internal/AggregateEdges.js"
import {
  deriveAggregateSchemas,
  getSchemaFields,
  refuseAggregateKeyOverMovingValue,
  refuseManySortKeysOverMovingValue,
} from "./internal/AggregateSchemas.js"
import type {
  AggregateEdgesConfig,
  AggregateEdgesGuard,
  AggregateInputType,
  AggregateStampNames,
  BoundSubAggregate,
  SubAggregate,
} from "./internal/AggregateTypes.js"
import type { TimestampsConfig } from "./internal/EntityConfig.js"
import type { ModelFieldName } from "./internal/EntityTypes.js"
import { refuseAggregateKeyInTableKey } from "./internal/SharedKeyAttribute.js"

export type { Cursor, DiscriminatorConfig, UpdateContext } from "./internal/AggregateCursor.js"
export {
  type AggregateEdge,
  isManyEdge,
  isOneEdge,
  isRefEdge,
  type ManyEdge,
  type ManyEdgeConfig,
  many,
  type OneEdge,
  type OneEdgeConfig,
  one,
  type RefEdge,
  type RefEntity,
  ref,
} from "./internal/AggregateEdges.js"
export {
  type DerivedAggregateSchemas,
  deriveAggregateSchemas,
  deriveElementInputSchema,
  deriveEntityFieldName,
  extractArrayElement,
  getSchemaFields,
  isFieldOptional,
  isSchemaMatchingEntity,
  unwrapModel,
} from "./internal/AggregateSchemas.js"
export type {
  AggregateInputType,
  BoundSubAggregate,
  Input,
  Key,
  SubAggregate,
  Type,
  UpdateFn,
} from "./internal/AggregateTypes.js"

// ---------------------------------------------------------------------------
// TypeId
// ---------------------------------------------------------------------------

export const TypeId: unique symbol = Symbol.for("effect-dynamodb/Aggregate")
export type TypeId = typeof TypeId

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** A minimal table tag reference — the pure layer never executes against it. */
export interface AggregateTableLike {
  readonly Tag: unknown
}

interface SubAggregateConfig<
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>> = Record<
    string,
    AggregateEdge | BoundSubAggregate<any, any>
  >,
> {
  readonly root: { readonly entityType: string }
  readonly edges: TEdges
}

/** `F`: the aggregate schema's fields, which the composites name. */
interface CollectionConfig<F extends string = string> {
  readonly index: string
  readonly name: string
  readonly sk: {
    readonly field: string
    readonly composite: ReadonlyArray<F>
  }
}

interface ListCollectionConfig<F extends string = string> extends CollectionConfig<F> {
  readonly pk: {
    readonly field: string
    readonly composite: ReadonlyArray<F>
  }
  readonly cardinality?: number
}

interface AggregateConfig<
  _TSchema extends Schema.Top,
  TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>> = Record<
    string,
    AggregateEdge | BoundSubAggregate<any, any>
  >,
  TPK extends ReadonlyArray<string> = ReadonlyArray<string>,
> {
  readonly table: AggregateTableLike
  readonly schema: DynamoSchemaModule.DynamoSchema
  readonly pk: { readonly field: string; readonly composite: TPK }
  readonly collection: CollectionConfig<ModelFieldName<_TSchema>>
  readonly list?: ListCollectionConfig<ModelFieldName<_TSchema>>
  readonly context?: ReadonlyArray<ModelFieldName<_TSchema>>
  /**
   * Auto-managed `created` / `updated` attributes on every row the aggregate
   * writes. Accepted here for parity with the operational `Aggregate.make` in
   * `effect-dynamodb`, which owns the write path that stamps them.
   */
  readonly timestamps?: TimestampsConfig
  readonly root: { readonly entityType: string }
  readonly edges: TEdges
}

// ---------------------------------------------------------------------------
// AggregateDefinition — the pure half of an Aggregate (no AWS operations)
// ---------------------------------------------------------------------------

/**
 * The pure aggregate definition produced by the top-level form of {@link make}.
 * Carries the schema binding, partition/collection key configuration, and the
 * derived `inputSchema` / `updateSchema` / `createSchema`. Does NOT carry the
 * AWS-coupled CRUD operations — those live on the runtime `effect-dynamodb`
 * `Aggregate` type.
 *
 * **Derivation-only.** Unlike the pure {@link EntityDefinition} (which
 * `DynamoClient.make` promotes to a full operational entity), a pure
 * `AggregateDefinition` is **not bindable** via `DynamoClient.make`: the
 * aggregate decompose/assemble engine is AWS-coupled and cannot be reconstructed
 * from a pure definition. Use this type for its derived schemas (e.g. HttpApi
 * payloads, validation). To get an operational aggregate (`get`/`create`/
 * `update`/`delete`/`list`), author it with `effect-dynamodb`'s `Aggregate.make`
 * and bind that. Passing a pure `AggregateDefinition` to `DynamoClient.make`
 * is a compile error (it lacks the operational members).
 */
export interface AggregateDefinition<TSchema extends Schema.Top, TInput = unknown> {
  readonly [TypeId]: TypeId
  readonly _tag: "Aggregate"
  readonly schema: TSchema
  /** @internal Tag of the table this aggregate is bound to. */
  readonly _tableTag: unknown
  /** Primary key field name (e.g., "pk") */
  readonly pkField: string
  /** Collection GSI config */
  readonly collection: {
    readonly index: string
    readonly sk: { readonly field: string }
  }
  /** List GSI config — undefined when not configured */
  readonly listIndex:
    | {
        readonly index: string
        readonly pk: { readonly field: string }
        readonly sk: { readonly field: string }
      }
    | undefined
  /** Derived input schema for `create()`. */
  readonly inputSchema: Schema.Codec<TInput>
  /** Alias for `inputSchema`. */
  readonly createSchema: Schema.Codec<TInput>
  /** Derived update schema — all `inputSchema` fields made optional. */
  readonly updateSchema: Schema.Codec<Partial<TInput>>
}

// ---------------------------------------------------------------------------
// make — overloaded for sub-aggregate and top-level forms
// ---------------------------------------------------------------------------

/**
 * Create a pure aggregate definition.
 *
 * **Sub-aggregate form** — `Aggregate.make(Schema, { root, edges })`:
 * Returns a composable {@link SubAggregate} with `.with()` for discriminator binding.
 *
 * **Top-level form** — `Aggregate.make(Schema, { table, schema, pk, collection, ... })`:
 * Returns a pure {@link AggregateDefinition} carrying the derived schemas.
 *
 * This pure form is AWS-SDK-free. The full operational `Aggregate.make` (with
 * `get` / `create` / `update` / `delete` / `list`) is exported from
 * `effect-dynamodb`.
 */
// The top-level form comes first: an editor completing a config takes its
// contextual type from the first overload, and the top-level form is the one
// whose `pk`, `collection`, `list` and `context` name schema fields.
export function make<
  TSchema extends Schema.Top,
  const TEdges extends AggregateEdgesConfig<TSchema>,
  const TPK extends ReadonlyArray<ModelFieldName<TSchema>>,
  const TTimestamps extends TimestampsConfig | undefined = undefined,
>(
  schema: TSchema,
  config: AggregateConfig<TSchema, TEdges, TPK> & {
    readonly edges: AggregateEdgesGuard<TSchema, TEdges>
    readonly timestamps?: TTimestamps
  },
): AggregateDefinition<
  TSchema,
  AggregateInputType<
    Schema.Schema.Type<TSchema>,
    TEdges,
    TPK,
    AggregateStampNames<Schema.Schema.Type<TSchema>, TTimestamps>
  >
>
export function make<
  TSchema extends Schema.Top,
  const TEdges extends AggregateEdgesConfig<TSchema>,
>(
  schema: TSchema,
  // The top-level form's keys, refused here, so an error in a top-level config
  // is reported against the top-level overload (it fails this one on each key).
  config: SubAggregateConfig<TEdges> & {
    readonly edges: AggregateEdgesGuard<TSchema, TEdges>
    readonly table?: undefined
    readonly schema?: undefined
    readonly pk?: undefined
    readonly collection?: undefined
  },
): SubAggregate<TSchema, TEdges>
export function make<TSchema extends Schema.Top>(
  schema: TSchema,
  config: SubAggregateConfig | AggregateConfig<TSchema>,
): SubAggregate<TSchema> | AggregateDefinition<TSchema> {
  if (!("table" in config) || config.table === undefined) {
    return makeSubAggregate(schema, config as SubAggregateConfig)
  }
  return makeAggregateDefinition(schema, config as AggregateConfig<TSchema>)
}

const makeSubAggregate = <TSchema extends Schema.Top>(
  schema: TSchema,
  config: SubAggregateConfig,
): SubAggregate<TSchema> => {
  const sub: SubAggregate<TSchema> = {
    _tag: "SubAggregate",
    schema,
    root: config.root,
    edges: config.edges,
    with: (discConfig: DiscriminatorConfig) => ({
      _tag: "BoundSubAggregate",
      aggregate: sub,
      discriminator: discConfig.discriminator,
    }),
  }
  return sub
}

const makeAggregateDefinition = <TSchema extends Schema.Top>(
  schema: TSchema,
  config: AggregateConfig<TSchema>,
): AggregateDefinition<TSchema> => {
  refuseAggregateKeyInTableKey(
    config.root.entityType,
    [config.pk.field, "sk"],
    [
      ...(config.collection.index === undefined
        ? []
        : [["its collection sort key", config.collection.sk.field] as const]),
      ...(config.list === undefined
        ? []
        : [
            ["its list partition key", config.list.pk.field] as const,
            ["its list sort key", config.list.sk.field] as const,
          ]),
    ],
  )
  refuseAggregateKeyOverMovingValue(
    config.root.entityType,
    config.timestamps,
    getSchemaFields(schema),
    config.pk.composite,
  )
  refuseManySortKeysOverMovingValue(
    config.root.entityType,
    config.timestamps,
    getSchemaFields(schema),
    config.edges,
  )
  const derivedSchemas = deriveAggregateSchemas(
    schema,
    config.edges,
    config.pk.composite,
    config.timestamps,
  )

  return {
    [TypeId]: TypeId,
    _tag: "Aggregate",
    _tableTag: config.table.Tag,
    schema,
    pkField: config.pk.field,
    collection: {
      index: config.collection.index,
      sk: { field: config.collection.sk.field },
    },
    listIndex: config.list
      ? {
          index: config.list.index,
          pk: { field: config.list.pk.field },
          sk: { field: config.list.sk.field },
        }
      : undefined,
    inputSchema: derivedSchemas.inputSchema as unknown as Schema.Codec<unknown>,
    createSchema: derivedSchemas.inputSchema as unknown as Schema.Codec<unknown>,
    updateSchema: derivedSchemas.updateSchema as unknown as Schema.Codec<Partial<unknown>>,
  } as AggregateDefinition<TSchema>
}

/** A bound aggregate placeholder type — the operational form lives in effect-dynamodb. */
export type BoundAggregate<TSchema extends Schema.Top, _TKey = unknown, _TInput = unknown> = {
  readonly schema: TSchema
}
