/**
 * Collection — Multi-entity queries across a shared table/index.
 *
 * A Collection groups entities that share a common index. Querying a Collection
 * returns items of all member entity types, each decoded through its own schema.
 * Entity selectors narrow a collection query to a single entity type.
 *
 * Collections are built from Entity index definitions that share a `collection` name.
 */

import { Effect, Schema } from "effect"
import * as DynamoSchema from "./DynamoSchema.js"
import { ValidationError } from "./Errors.js"
import type { IndexDefinition } from "./KeyComposer.js"
import * as KeyComposer from "./KeyComposer.js"
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
  readonly _tableTag: import("effect").ServiceMap.Service<TableConfig, TableConfig>
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
  }
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
  let sharedSchema: ReturnType<typeof import("./DynamoSchema.js").make> | undefined

  let collectionType: "isolated" | "clustered" = "clustered"

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
        collectionType = indexDef.type ?? "clustered"
        break
      }
    }
    if (sharedIndexName) break
  }

  if (!sharedIndexName || !sharedPkField || !sharedSchema) {
    throw new Error(`No entity in collection "${name}" has an index with collection: "${name}"`)
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

    const recordSchema = entry.entity.schemas.recordSchema
    return Schema.decodeUnknownEffect(recordSchema)(raw).pipe(
      Effect.map((decoded) => ({
        _entityKey: entry.key,
        _entityType: entityType,
        _decoded: decoded,
      })),
      Effect.mapError(
        (cause) =>
          new ValidationError({
            entityType,
            operation: "collection.decode",
            cause,
          }),
      ),
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
    const pkValue = KeyComposer.composePk(
      sharedSchema!,
      firstEntity.entityType,
      indexDef,
      pkComposites,
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
        pkComposites,
      )

      const recordSchema = entity.schemas.recordSchema
      let q = Query.make({
        tableName: "",
        indexName: sharedDynamoIndexName,
        pkField: sharedPkField!,
        pkValue,
        skField: sharedSkField,
        entityTypes: [entity.entityType],
        decoder: (raw) =>
          Schema.decodeUnknownEffect(recordSchema)(raw).pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({
                  entityType: entity.entityType,
                  operation: "collection.selector.decode",
                  cause,
                }),
            ),
          ),
        resolveTableName: entity._tableTag.useSync((tc: TableConfig) => tc.name),
      })

      // Clustered entity selectors add begins_with on the entity SK prefix
      if (collectionType === "clustered" && collectionSkPrefix) {
        const entitySkPrefix = DynamoSchema.composeClusteredSortKey(
          sharedSchema!,
          name,
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
