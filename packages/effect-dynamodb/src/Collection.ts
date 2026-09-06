/**
 * Collection — Multi-entity queries across a shared table/index.
 *
 * A Collection groups entities that share a common index. Querying a Collection
 * returns items of all member entity types, each decoded through its own schema.
 * Entity selectors narrow a collection query to a single entity type.
 *
 * Collections are built from Entity index definitions that share a `collection` name.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  compositeKeyFormKind,
  makeCompositeKeyForm,
  toCompositeKeyRecord,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import type { IndexDefinition } from "@effect-dynamodb/schema/KeyComposer.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, type Schema } from "effect"
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
  ) => import("effect").Effect.Effect<
    any,
    import("@effect-dynamodb/schema/Errors.js").ValidationError
  >
}

// ---------------------------------------------------------------------------
// Collection types
// ---------------------------------------------------------------------------

type EntityRecord<E extends CollectionEntity> = Schema.Schema.Type<E["schemas"]["recordSchema"]>

type CollectionResult<TEntities extends Record<string, CollectionEntity>> = {
  readonly [K in keyof TEntities]: Array<EntityRecord<TEntities[K]>>
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

  /** Query all entities in the collection. Returns grouped results keyed by entity name. */
  readonly query: (
    pkComposites: Record<string, unknown>,
  ) => Query.Query<CollectionResult<TEntities>>

  /** Entity selectors — narrow to a single entity type */
  readonly [K: string]: unknown
}

// ---------------------------------------------------------------------------
// Collection.make()
// ---------------------------------------------------------------------------

/**
 * Create a Collection from a set of entities that share an index with a common collection name.
 *
 * @param name - The collection name (must match a `collection` property in an entity's index definition)
 * @param entities - Map of entity names to Entity instances
 * @returns A Collection with a `.query()` method and per-entity selector methods
 */
/**
 * The composite key form for one collection member — the same rule
 * (`internal/CompositeCodec.ts`) its own accessors and its write path apply.
 *
 * Without it, `Collections.make()`'s query builder composed the partition key
 * from the caller's raw Type-side record while the rows were written from the
 * key form, so a `DateEpochMs` or `BigIntFromString` composite matched nothing.
 */
/** The schema a member's key form is derived from — `inputSchema` when the
 * member is a runtime entity, else its raw model. */
const keyFormSourceOf = (entity: unknown): Schema.Top => {
  const e = entity as {
    readonly model?: unknown
    readonly schemas?: { readonly inputSchema?: unknown }
  }
  return (e.schemas?.inputSchema ?? e.model) as Schema.Top
}

const collectionKeyForm = (
  entity: unknown,
  record: Record<string, unknown>,
): Record<string, unknown> => {
  const e = entity as {
    readonly model?: unknown
    readonly schemas?: { readonly inputSchema?: unknown }
  }
  const source = (e.schemas?.inputSchema ?? e.model) as Schema.Top | undefined
  if (source === undefined) return record
  const form = makeCompositeKeyForm(source, (attr, value) => {
    throw new Error(
      `[EDD-9050] Composite "${attr}" could not be put into its key form: ` +
        `${JSON.stringify(String(value))} resolves under neither encode nor decode->encode.`,
    )
  })
  return toCompositeKeyRecord(form, record)
}

export const make = <
  const TName extends string,
  const TEntities extends Record<string, CollectionEntity>,
>(
  name: TName,
  entities: TEntities,
): Collection<TEntities> & {
  readonly [K in keyof TEntities]: (
    pkComposites: Record<string, unknown>,
  ) => Query.Query<EntityRecord<TEntities[K]>>
} => {
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

  // Compute the SK prefix for clustered collections.
  // For sub-collections (collection: ["parent", "child"]), the prefix includes
  // the hierarchy from the root up to and including this collection name.
  let collectionSkPrefix: string | undefined
  if (collectionType === "clustered" && sharedSkField) {
    // Find the collection hierarchy from the first entity's index definition
    const firstIndex = entityEntries[0]![1].indexes[sharedIndexName!]!
    const coll = firstIndex.collection
    const casing = firstIndex.casing ?? sharedSchema.casing

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
  const collectionDecoder = (raw: Record<string, unknown>) => {
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

    return entry.entity._decodeRecord(raw).pipe(
      Effect.map((decoded) => ({
        _entityKey: entry.key,
        _entityType: entityType,
        _decoded: decoded,
      })),
    )
  }

  // Build the query function
  const buildQuery = (
    pkComposites: Record<string, unknown>,
    targetEntityTypes: ReadonlyArray<string>,
    decoder: (raw: Record<string, unknown>) => Effect.Effect<unknown, ValidationError>,
  ) => {
    // Use the first entity to compose the PK (they share the same index pattern)
    const firstEntity = entityEntries[0]![1]
    const indexDef = firstEntity.indexes[sharedIndexName!]!
    // Same key form the member entities' write path uses — see
    // `internal/CompositeCodec.ts`. Members are checked for agreement at
    // `Collections.make()` time, so the first member's form speaks for all.
    const pkValue = KeyComposer.composePk(
      sharedSchema!,
      firstEntity.entityType,
      indexDef,
      collectionKeyForm(firstEntity, pkComposites),
    )

    return Query.make({
      tableName: "",
      indexName: sharedDynamoIndexName,
      pkField: sharedPkField!,
      pkValue,
      skField: sharedSkField,
      entityTypes: targetEntityTypes,
      decoder,
      resolveTableName: firstEntity._tableTag.useSync((tc: TableConfig) => tc.name),
      keyFields: [
        sharedPkField,
        sharedSkField,
        firstEntity.indexes.primary?.pk.field,
        firstEntity.indexes.primary?.sk.field,
      ],
    })
  }

  // Main query: returns grouped results
  const queryAll = (pkComposites: Record<string, unknown>) => {
    const groupDecoder = (raw: Record<string, unknown>) =>
      collectionDecoder(raw) as Effect.Effect<
        { _entityKey: string; _entityType: string; _decoded: unknown },
        ValidationError
      >

    // We need a custom decoder that groups results
    // The Query will return flat items — we need to post-process into groups
    // We'll use the collectionDecoder and the collect terminal will group them
    const rawQuery = buildQuery(pkComposites, entityTypes, groupDecoder)

    // Override with a custom decoder that produces the grouped result
    let q = Query.make<CollectionResult<TEntities>>({
      tableName: "",
      indexName: sharedDynamoIndexName,
      pkField: sharedPkField!,
      pkValue: rawQuery._state.pkValue,
      skField: sharedSkField,
      entityTypes,
      resolveTableName: entityEntries[0]![1]._tableTag.useSync((tc: TableConfig) => tc.name),
      keyFields: [
        sharedPkField,
        sharedSkField,
        entityEntries[0]![1].indexes.primary?.pk.field,
        entityEntries[0]![1].indexes.primary?.sk.field,
      ],
      decoder: (raw) => {
        // This decoder gets called per-item, but Query.collect collects all items
        // We need to tag each item with its entity key so the caller can group
        return collectionDecoder(raw) as Effect.Effect<any, ValidationError>
      },
    })

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
    selectors[key] = (pkComposites: Record<string, unknown>) => {
      const indexDef = entity.indexes[sharedIndexName!]!
      const pkValue = KeyComposer.composePk(
        sharedSchema!,
        entity.entityType,
        indexDef,
        collectionKeyForm(entity, pkComposites),
      )

      let q = Query.make({
        tableName: "",
        indexName: sharedDynamoIndexName,
        pkField: sharedPkField!,
        pkValue,
        skField: sharedSkField,
        entityTypes: [entity.entityType],
        decoder: (raw) => entity._decodeRecord(raw),
        resolveTableName: entity._tableTag.useSync((tc: TableConfig) => tc.name),
        keyFields: [
          sharedPkField,
          sharedSkField,
          entity.indexes.primary?.pk.field,
          entity.indexes.primary?.sk.field,
        ],
      })

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
    }
  }

  return {
    _tag: "Collection" as const,
    name,
    entities,
    query: queryAll,
    ...selectors,
  } as Collection<TEntities> & {
    readonly [K in keyof TEntities]: (
      pkComposites: Record<string, unknown>,
    ) => Query.Query<EntityRecord<TEntities[K]>>
  }
}
