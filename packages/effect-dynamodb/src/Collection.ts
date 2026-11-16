/**
 * Collection — Multi-entity queries across a shared table/index.
 *
 * A Collection groups entities that share a common index. Querying a Collection
 * returns items of all member entity types, each decoded through its own schema.
 * Entity selectors narrow a collection query to a single entity type.
 *
 * Collections are built from Entity index definitions that share a `collection` name.
 */

import type { NoOffload, OffloadFields } from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { type BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  compositeKeyFormKind,
  makeCompositeDomainKeyForm,
  refuseInexact,
  toCompositeKeyRecord,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import type {
  DefaultOffloadModes,
  EntityRecordType,
  ReadBlobErrors,
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
import type { IndexDefinition } from "@effect-dynamodb/schema/KeyComposer.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, type Schema } from "effect"
import type { Modes } from "./internal/OffloadRead.js"
import type { MemberItem, StateOf } from "./internal/OffloadTypes.js"
import {
  collectionPackedQueryOptions,
  entityPackedQueryOptions,
  type PackedAttributeGuard,
} from "./internal/Packed.js"
import type { NoOffloadState, OffloadState, View } from "./Offload.js"
import * as Query from "./Query.js"
import type { TableConfig } from "./Table.js"

// ---------------------------------------------------------------------------
// Structural entity constraint — avoids Entity interface invariance in TIndexes.
// A specific Entity<User, Table, "User", { primary: ..., byEmail: ... }, ...> is
// structurally assignable to this because only covariant properties are checked.
// ---------------------------------------------------------------------------

/** Minimal structural type for entities used in Collections. */
interface CollectionEntity {
  readonly _tag: "Entity"
  readonly entityType: string
  readonly indexes: Record<string, IndexDefinition>
  readonly _schema: DynamoSchema.DynamoSchema
  readonly _tableTag: import("effect").Context.Service<TableConfig, TableConfig>
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
  }
  readonly _decodeRecord: (
    raw: globalThis.Record<string, unknown>,
    modes?: Modes,
    operation?: string,
  ) => import("effect").Effect.Effect<any, ValidationError | BlobStoreError>
  /** Packed attributes an expression may not look inside (EDD-9076, #147). */
  readonly _packedGuards?: ReadonlyArray<PackedAttributeGuard> | undefined
  /** Read packed attributes of a raw row by their stored form (#147). */
  readonly _unpackFields?:
    | ((raw: Record<string, unknown>, operation?: string) => Effect.Effect<void, ValidationError>)
    | undefined
  /** The stored attributes `_unpackFields` reads (a projection naming none runs no hook). */
  readonly _dispatchAttributes?: ReadonlyArray<string> | undefined
}

// ---------------------------------------------------------------------------
// Collection types
// ---------------------------------------------------------------------------

/**
 * The fields a member offloads (#179) — {@link NoOffload} when none, and for
 * type-erased fields (`any`), which read as none.
 */
type MemberOffload<E> = E extends { readonly _offloadFields?: infer T }
  ? Exclude<T, undefined> extends infer F extends OffloadFields
    ? 0 extends 1 & F
      ? NoOffload
      : F
    : NoOffload
  : NoOffload

/**
 * A member's record type (`Entity.Record`: model fields plus system fields) —
 * what its record decoder yields. (Read off `recordSchema`, which entities
 * type as `Codec<any>`, it was `any`.)
 */
type MemberRecord<E extends CollectionEntity> = E extends {
  readonly model: Schema.Top
  readonly timestamps: unknown
  readonly versioned: unknown
}
  ? EntityRecordType<
      E["model"],
      E["timestamps"],
      E["versioned"],
      E extends { readonly timeSeries?: infer TS } ? TS : undefined
    >
  : Schema.Schema.Type<E["schemas"]["recordSchema"]>

/** A member's records as a collection query reads them: offloaded fields in the default modes. */
type EntityRecord<E extends CollectionEntity> = View<MemberRecord<E>, MemberOffload<E>>

/** A member selector's query state: `Query.offloaded` re-types its records. */
type MemberQueryState<E extends CollectionEntity> = StateOf<MemberOffload<E>, MemberRecord<E>>

/** The blob errors reading the members raises under the default modes (#179). */
type MemberBlobErrors<TEntities extends Record<string, CollectionEntity>> = {
  readonly [K in keyof TEntities]: ReadBlobErrors<MemberOffload<TEntities[K]>, DefaultOffloadModes>
}[keyof TEntities]

/** Each member's offloaded fields, record and entity type. */
type Members<TEntities extends Record<string, CollectionEntity>> = {
  readonly [K in keyof TEntities & string]: {
    readonly fields: MemberOffload<TEntities[K]>
    readonly item: MemberRecord<TEntities[K]>
    readonly entityType: TEntities[K]["entityType"]
  }
}

/** Every member's offloaded fields together. */
type AllMemberFields<TEntities extends Record<string, CollectionEntity>> = {
  readonly overflow: {
    readonly [K in keyof TEntities]: MemberOffload<TEntities[K]>["overflow"]
  }[keyof TEntities]
  readonly binary: {
    readonly [K in keyof TEntities]: MemberOffload<TEntities[K]>["binary"]
  }[keyof TEntities]
}

/**
 * One item of a grouped collection query: the member it belongs to
 * (`_entityKey`), its entity type and its record (`_decoded`), offloaded
 * fields in the default modes.
 */
type CollectionItem<TEntities extends Record<string, CollectionEntity>> = MemberItem<
  Members<TEntities>,
  DefaultOffloadModes
>

/**
 * A grouped collection query's state (§9.2): a per-member map, so
 * `Query.offloaded` re-types each member's record — `NoOffloadState` when no
 * member offloads.
 */
type CollectionState<TEntities extends Record<string, CollectionEntity>> = [
  AllMemberFields<TEntities>["overflow"] | AllMemberFields<TEntities>["binary"],
] extends [never]
  ? NoOffloadState
  : {
      readonly fields: AllMemberFields<TEntities>
      readonly modes: DefaultOffloadModes
      readonly item: CollectionItem<TEntities>
      readonly members: Members<TEntities>
    }

/** A member selector of a collection over `TEntities`. */
type MemberSelectors<TEntities extends Record<string, CollectionEntity>> = {
  readonly [K in keyof TEntities]: (
    pkComposites: Record<string, unknown>,
  ) => Query.Query<
    EntityRecord<TEntities[K]>,
    ReadBlobErrors<MemberOffload<TEntities[K]>, DefaultOffloadModes>,
    MemberQueryState<TEntities[K]>
  >
}

/**
 * A Collection groups entities that share a common index for cross-entity queries.
 * Querying a Collection returns items of all member entity types, each decoded
 * through its own schema. Entity selectors narrow a query to a single entity type.
 *
 * Created via {@link make}.
 *
 * @typeParam TEntities - Map of entity names to Entity instances
 */
export interface Collection<TEntities extends Record<string, CollectionEntity>> {
  readonly _tag: "Collection"
  readonly name: string
  readonly entities: TEntities

  /**
   * Query all entities in the collection. Each item is tagged with its member:
   * `{ _entityKey, _entityType, _decoded }`, `_decoded` the member's record.
   * `Query.offloaded` re-types every member's record (#179).
   */
  readonly query: (
    pkComposites: Record<string, unknown>,
  ) => Query.Query<
    CollectionItem<TEntities>,
    MemberBlobErrors<TEntities>,
    CollectionState<TEntities>
  >

  /** Entity selectors — narrow to a single entity type */
  readonly [K: string]: unknown
}

// ---------------------------------------------------------------------------
// Collection.make()
// ---------------------------------------------------------------------------

/** The schema a member's key form is derived from — `inputSchema` when the
 * member is a runtime entity, else its raw model. */
const keyFormSourceOf = (entity: unknown): Schema.Top => {
  const e = entity as {
    readonly model?: unknown
    readonly schemas?: { readonly inputSchema?: unknown }
  }
  return (e.schemas?.inputSchema ?? e.model) as Schema.Top
}

/**
 * The composite key form for one collection member — the same rule
 * (`internal/CompositeCodec.ts`) its own accessors and its write path apply.
 *
 * Without it, `Collections.make()`'s query builder composed the partition key
 * from the caller's raw Type-side record while the rows were written from the
 * key form, so a `DateEpochMs` or `BigIntFromString` composite matched nothing.
 */
const collectionKeyForm = (
  entity: unknown,
  record: Record<string, unknown>,
  needs: ReadonlyArray<string>,
): Record<string, unknown> => {
  const source = keyFormSourceOf(entity) as Schema.Top | undefined
  if (source === undefined) return record
  // The caller's composites are DOMAIN values: the key `put` wrote for one is the
  // key form of the value it stores (`Entity._domainKeyForm`).
  const form = makeCompositeDomainKeyForm(source, (attr, value, reason) => {
    if (reason !== undefined) return refuseInexact(`Composite "${attr}"`, value, reason)
    throw new Error(
      `[EDD-9050] Composite "${attr}" could not be put into its key form: ` +
        `${JSON.stringify(String(value))} resolves under neither encode nor decode->encode.`,
    )
  })
  return toCompositeKeyRecord(form, record, needs)
}

/**
 * Create a Collection from a set of entities that share an index with a common collection name.
 *
 * @param name - The collection name (must match a `collection` property in an entity's index definition)
 * @param entities - Map of entity names to Entity instances
 * @returns A Collection with a `.query()` method (each item tagged with its
 *   member) and per-entity selector methods
 */
export const make = <
  const TName extends string,
  const TEntities extends Record<string, CollectionEntity>,
>(
  name: TName,
  entities: TEntities,
): Collection<TEntities> & MemberSelectors<TEntities> => {
  // Discover the shared index — find the first entity's index that has this collection name
  const entityEntries = Object.entries(entities)
  if (entityEntries.length === 0) {
    throw new Error(`Collection "${name}" requires at least one entity`)
  }

  // Find the shared index definition across entities
  let sharedIndexName: string | undefined
  let sharedPkField: string | undefined
  let sharedSkField: string | undefined
  let sharedDynamoIndexName: string | undefined
  let sharedSchema:
    | ReturnType<typeof import("@effect-dynamodb/schema/DynamoSchema.js").make>
    | undefined

  let collectionType: "isolated" | "clustered" = "isolated"

  for (const [, entity] of entityEntries) {
    for (const [indexName, indexDef] of Object.entries(entity.indexes)) {
      if (indexName === "primary") continue
      const coll = indexDef.collection
      if (coll === name || (Array.isArray(coll) && coll.includes(name))) {
        sharedIndexName = indexName
        sharedPkField = indexDef.pk.field
        sharedSkField = indexDef.sk.field
        sharedDynamoIndexName = indexDef.index
        sharedSchema = entity._schema
        collectionType = indexDef.type ?? "isolated"
        break
      }
    }
    if (sharedIndexName) break
  }

  if (!sharedIndexName || !sharedPkField || !sharedSchema) {
    throw new Error(`No entity in collection "${name}" has an index with collection: "${name}"`)
  }

  // Members share ONE physical index, so they must agree on how each partition
  // key composite is spelled in a key. Two members disagreeing (`Schema.Date`
  // vs `DynamoModel.DateEpochMs`, say) write into the same partition under
  // forms that can never match, and composing with the first member's form
  // would silently drop the others' rows. A real modelling conflict — fail here
  // rather than at query time.
  {
    const attrs = new Set<string>()
    for (const [, entity] of entityEntries) {
      for (const attr of entity.indexes[sharedIndexName]?.pk.composite ?? []) attrs.add(attr)
    }
    for (const attr of attrs) {
      // `absent` and `identity` are the SAME behaviour — both pass the value
      // through untouched — so a member that simply does not declare the
      // attribute (a ref-derived id, or an index whose composite list differs)
      // is not in conflict. Only a genuine difference in how the value is
      // transformed is. This catches identity-vs-transformed and
      // numeric-Type-vs-encoded; two DIFFERENT encoded transforms of the same
      // kind still classify alike and are not detected here.
      const kinds = entityEntries
        .filter(([, e]) => (e.indexes[sharedIndexName]?.pk.composite ?? []).includes(attr))
        .map(([key, entity]) => {
          const kind = compositeKeyFormKind(keyFormSourceOf(entity), attr)
          return { key, kind: kind === "absent" ? "identity" : kind }
        })
      if (new Set(kinds.map((k) => k.kind)).size > 1) {
        throw new Error(
          `[EDD-9050] Collection "${name}" members disagree on how the partition key ` +
            `composite "${attr}" is composed into a key ` +
            `(${kinds.map((k) => `${k.key}: ${k.kind}`).join(", ")}). They share one physical ` +
            `index, so rows written under different forms can never match — align the ` +
            `attribute's schema across the member models.`,
        )
      }
    }
  }
  KeyComposer.assertCollectionCasingAgreement(
    name,
    entityEntries.flatMap(([key, entity]) => {
      const index = entity.indexes[sharedIndexName]
      return index === undefined ? [] : [{ key, schema: entity._schema, index }]
    }),
  )
  const checkShardsAgreement = () =>
    KeyComposer.assertCollectionShardsAgreement(
      name,
      entityEntries.flatMap(([key, entity]) => {
        const index = entity.indexes[sharedIndexName]
        return index === undefined ? [] : [{ key, index, schema: entity._schema }]
      }),
    )
  checkShardsAgreement()
  // A member whose index's table is supplied at run time (#287): its queries compose their
  // partitions when a terminal runs, from the `ShardLayouts` of its context.
  const provided = entityEntries.some(([, entity]) =>
    KeyComposer.hasProvidedShards({ index: entity.indexes[sharedIndexName]! }),
  )

  // Compute the SK prefix for clustered collections.
  // For sub-collections (collection: ["parent", "child"]), the prefix includes
  // the hierarchy from the root up to and including this collection name.
  let collectionSkPrefix: string | undefined
  if (collectionType === "clustered" && sharedSkField) {
    // Find the collection hierarchy from the first entity's index definition
    const firstIndex = entityEntries[0]![1].indexes[sharedIndexName!]!
    const coll = firstIndex.collection
    const casing = KeyComposer.effectiveCasing(sharedSchema, firstIndex)

    if (Array.isArray(coll)) {
      // Sub-collection: include hierarchy up to and including the target name
      const idx = coll.indexOf(name)
      const hierarchy = coll.slice(0, idx + 1)
      const pre = DynamoSchema.prefix(sharedSchema)
      const casedNames = hierarchy.map((n) => DynamoSchema.applyCasing(n, casing))
      collectionSkPrefix = `${pre}#${casedNames.join("#")}`
    } else {
      // Simple collection: just the collection name
      collectionSkPrefix = DynamoSchema.composeCollectionKey(sharedSchema, name, [], {
        casing,
      })
    }
  }

  // Build entity type discriminator lookup
  const entityByType = new Map<string, { key: string; entity: CollectionEntity }>()
  const entityTypes: Array<string> = []
  for (const [key, entity] of entityEntries) {
    entityByType.set(entity.entityType, { key, entity })
    entityTypes.push(entity.entityType)
  }

  // Collection decoder: decode and group items by entity type
  const collectionDecoder = (raw: Record<string, unknown>, modes: Modes) => {
    const entityType = raw.__edd_e__ as string | undefined
    if (!entityType) {
      return Effect.fail(
        new ValidationError({
          entityType: "unknown",
          operation: "collection.decode",
          cause: "Item missing __edd_e__",
        }),
      )
    }

    const entry = entityByType.get(entityType)
    if (!entry) {
      return Effect.fail(
        new ValidationError({
          entityType,
          operation: "collection.decode",
          cause: `Unknown entity type "${entityType}" in collection "${name}"`,
        }),
      )
    }

    return entry.entity._decodeRecord(raw, modes, "collection.decode").pipe(
      Effect.map((decoded) => ({
        _entityKey: entry.key,
        _entityType: entityType,
        _decoded: decoded,
      })),
    )
  }

  // The collection's partition key. Same key form the member entities' write
  // path uses — see `internal/CompositeCodec.ts`. Members are checked for
  // agreement at `Collections.make()` time, so the first member's form speaks
  // for all.
  const collectionPartitions = (pkComposites: Record<string, unknown>) => {
    const firstEntity = entityEntries[0]![1]
    // A member's table supplied at run time (#287): the members agree only once the tables
    // in context are known, so they are compared as the partitions are composed.
    if (provided) checkShardsAgreement()
    // Members share the partitions, whatever each hashes: never pruned (#183).
    return KeyComposer.composeReadPartitions(
      sharedSchema!,
      firstEntity.entityType,
      firstEntity.indexes[sharedIndexName!]!,
      collectionKeyForm(
        firstEntity,
        pkComposites,
        firstEntity.indexes[sharedIndexName!]!.pk.composite,
      ),
      { prune: false },
    )
  }
  // A composite with no key text (`NaN`, an inexact number) refuses the query, as a bound
  // collection's does: its terminal fails with a `ValidationError` and sends nothing.
  const refusable = <A, E, O extends OffloadState>(
    build: () => Query.Query<A, E, O>,
  ): Query.Query<A, E, O> =>
    Query.orRefusal({ name: "Collection.query", target: name }, build, (refusal) =>
      Query.refused<A, E, O>(sharedDynamoIndexName, refusal),
    )

  // Main query: every member's items, each tagged with its member by
  // `collectionDecoder` (`{ _entityKey, _entityType, _decoded }`) — the
  // terminals return them as they come, ungrouped.
  const queryAll = (pkComposites: Record<string, unknown>) => {
    const read = provided ? undefined : collectionPartitions(pkComposites)
    let q = Query.make<
      CollectionItem<TEntities>,
      MemberBlobErrors<TEntities>,
      CollectionState<TEntities>
    >({
      tableName: "",
      indexName: sharedDynamoIndexName,
      pkField: sharedPkField!,
      pkValue: read?.partitions[0] ?? "",
      skField: sharedSkField,
      entityTypes,
      resolveTableName: entityEntries[0]![1]._tableTag.useSync((tc: TableConfig) => tc.name),
      keyFields: [
        sharedPkField,
        sharedSkField,
        entityEntries[0]![1].indexes.primary?.pk.field,
        entityEntries[0]![1].indexes.primary?.sk.field,
      ],
      decoder: (raw, modes) => collectionDecoder(raw, modes),
      ...collectionPackedQueryOptions(entityEntries.map(([, entity]) => entity)),
      keyConditionDiagnosis: { operation: "query", label: `collection "${name}"` },
    })

    q =
      read !== undefined
        ? Query.fanOut(q, read)
        : Query.fanOutDeferred(q, () =>
            Query.orRefusal<KeyComposer.ReadPartitions | ValidationError>(
              { name: "Collection.query", target: name },
              () => collectionPartitions(pkComposites),
              (refusal) => refusal,
            ),
          )

    // Clustered collections add begins_with SK condition on collection prefix
    if (collectionType === "clustered" && collectionSkPrefix) {
      q = q.pipe(Query.where({ beginsWith: collectionSkPrefix }))
    }

    return q
  }

  // Entity selector functions
  const selectors: Record<string, (pkComposites: Record<string, unknown>) => Query.Query<unknown>> =
    {}

  for (const [key, entity] of entityEntries) {
    selectors[key] = (pkComposites: Record<string, unknown>) =>
      refusable(() => {
        const indexDef = entity.indexes[sharedIndexName!]!
        const compose = () =>
          KeyComposer.composeReadPartitions(
            sharedSchema!,
            entity.entityType,
            indexDef,
            collectionKeyForm(entity, pkComposites, indexDef.pk.composite),
            { prune: false },
          )
        // A table supplied at run time (#287): composed when a terminal runs.
        const read = provided ? undefined : compose()
        const pkValue = read?.partitions[0] ?? ""

        let q = Query.make({
          tableName: "",
          indexName: sharedDynamoIndexName,
          pkField: sharedPkField!,
          pkValue,
          skField: sharedSkField,
          entityTypes: [entity.entityType],
          decoder: (raw, modes) => entity._decodeRecord(raw, modes, "collection.decode"),
          ...entityPackedQueryOptions(entity),
          resolveTableName: entity._tableTag.useSync((tc: TableConfig) => tc.name),
          keyFields: [
            sharedPkField,
            sharedSkField,
            entity.indexes.primary?.pk.field,
            entity.indexes.primary?.sk.field,
          ],
          keyConditionDiagnosis: { operation: "query", label: `collection "${name}" (${key})` },
        }).pipe((made) =>
          read !== undefined
            ? Query.fanOut(made, read)
            : Query.fanOutDeferred(made, () =>
                Query.orRefusal<KeyComposer.ReadPartitions | ValidationError>(
                  { name: "Collection.query", target: name },
                  () => {
                    checkShardsAgreement()
                    return compose()
                  },
                  (refusal) => refusal,
                ),
              ),
        )

        // Clustered entity selectors add begins_with on the entity SK prefix.
        // For sub-collections, the prefix uses the FULL hierarchy from root to
        // the queried collection name, matching what composeSk writes at put time.
        if (collectionType === "clustered" && collectionSkPrefix) {
          const coll = indexDef.collection
          const hierarchy = Array.isArray(coll) ? coll.slice(0, coll.indexOf(name) + 1) : name
          const entitySkPrefix = DynamoSchema.composeClusteredSortKey(
            sharedSchema!,
            hierarchy,
            entity.entityType,
            1,
            [],
            { casing: indexDef.casing },
          )
          q = q.pipe(Query.where({ beginsWith: entitySkPrefix }))
        }

        return q
      })
  }

  return {
    _tag: "Collection" as const,
    name,
    entities,
    query: (pkComposites: Record<string, unknown>) => refusable(() => queryAll(pkComposites)),
    ...selectors,
  } as Collection<TEntities> & MemberSelectors<TEntities>
}
