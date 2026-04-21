/**
 * Collections — Explicit GSI access pattern definitions.
 *
 * `Collections.make()` defines ALL GSI-based access patterns. A collection owns
 * the index definition (GSI name, PK/SK fields), shared PK composites, and each
 * member entity specifies only its own SK composites.
 *
 * A collection can have one member (entity-specific access pattern) or multiple
 * members (cross-entity access pattern). Entities only define their primary key —
 * all secondary index definitions live in Collections.make().
 *
 * @module
 */

import type { Schema } from "effect"
import { getFields } from "./internal/EntitySchemas.js"
import type { IndexDefinition } from "./KeyComposer.js"

// ---------------------------------------------------------------------------
// Structural entity constraint — minimal type for entities used in Collections
// ---------------------------------------------------------------------------

/** @internal Minimal structural type for entities used in Collections. */
export interface CollectionEntityLike {
  readonly _tag: "Entity"
  readonly model: Schema.Top
  readonly entityType: string
  readonly indexes: Record<string, IndexDefinition>
  readonly schemas: {
    readonly recordSchema: Schema.Codec<any>
  }
}

// ---------------------------------------------------------------------------
// CollectionMember — entity + its SK composites within a collection
// ---------------------------------------------------------------------------

/** A member binding within a collection: entity reference + SK composite attributes. */
export interface CollectionMember<E extends CollectionEntityLike = CollectionEntityLike> {
  readonly _tag: "CollectionMember"
  readonly entity: E
  readonly sk: ReadonlyArray<string>
}

/**
 * Bind an entity to a collection with its SK composite attributes.
 *
 * @param entity - The entity to bind
 * @param sk - SK composite attribute names for this entity within the collection
 */
export const member = <E extends CollectionEntityLike>(
  entity: E,
  sk: ReadonlyArray<string>,
): CollectionMember<E> => ({
  _tag: "CollectionMember" as const,
  entity,
  sk,
})

// ---------------------------------------------------------------------------
// Collection type — carries full definition + member types
// ---------------------------------------------------------------------------

/** Collection type (clustered or isolated). */
export type CollectionType = "clustered" | "isolated"

/** GSI index definition for a collection. */
export interface CollectionIndex {
  /** Physical GSI name (e.g., `"gsi3"`). */
  readonly name: string
  /** PK field name (e.g., `"gsi3pk"`). */
  readonly pk: string
  /** SK field name (e.g., `"gsi3sk"`). */
  readonly sk: string
}

/** Collection configuration passed to `Collections.make()`. */
export interface CollectionConfig<
  TName extends string,
  TMembers extends Record<string, CollectionMember>,
> {
  /** Collection name — used as SK prefix in clustered mode. Changing this breaks existing data. */
  readonly name: TName
  /** Physical GSI definition: index name + PK/SK field names. */
  readonly index: CollectionIndex
  /** Shared PK composite attributes (e.g., `["employee"]`). */
  readonly composite: ReadonlyArray<string>
  /** Collection type: `"clustered"` (default) or `"isolated"`. */
  readonly type?: CollectionType
  /** Named record mapping member names to `Collections.member()` declarations. */
  readonly members: TMembers
}

/**
 * A Collection definition — carries index config, member types, and computed
 * types for PK input, per-member SK composites, and grouped result.
 */
export interface Collection<
  TName extends string = string,
  TMembers extends Record<string, CollectionMember> = Record<string, CollectionMember>,
> {
  readonly _tag: "Collection"
  readonly name: TName
  readonly index: CollectionIndex
  readonly composite: ReadonlyArray<string>
  readonly type: CollectionType
  readonly members: TMembers
}

// ---------------------------------------------------------------------------
// Result type computation
// ---------------------------------------------------------------------------

/** Extract the model type from a CollectionMember's entity. */
type MemberModelType<M extends CollectionMember> =
  M["entity"]["schemas"]["recordSchema"] extends Schema.Codec<infer A> ? A : unknown

/** Grouped collection result: member names → arrays of their model types. */
export type CollectionResult<TMembers extends Record<string, CollectionMember>> = {
  readonly [K in keyof TMembers]: Array<MemberModelType<TMembers[K]>>
}

// ---------------------------------------------------------------------------
// PK input type computation
// ---------------------------------------------------------------------------

/** Extract the model fields type from a Schema.Top (Schema.Class or Schema.Struct). */
type ModelFields<M extends Schema.Top> = M extends { readonly fields: infer F } ? F : never

/** Pick composite fields from the model, making them required. */
export type CollectionPkInput<
  TMembers extends Record<string, CollectionMember>,
  TComposite extends ReadonlyArray<string>,
> = {
  readonly [K in TComposite[number]]: PickFieldType<FirstMemberModel<TMembers>, K>
}

/** Get the first member's model type (for PK composite type inference). */
type FirstMemberModel<TMembers extends Record<string, CollectionMember>> =
  TMembers[keyof TMembers]["entity"]["model"]

/** Pick a single field type from model fields. */
type PickFieldType<M extends Schema.Top, K extends string> =
  ModelFields<M> extends Record<K, Schema.Top> ? Schema.Schema.Type<ModelFields<M>[K]> : string

// ---------------------------------------------------------------------------
// Collections.make()
// ---------------------------------------------------------------------------

/**
 * Create a Collection definition with explicit GSI access pattern.
 *
 * @param config - Collection configuration
 * @returns A Collection definition carrying typed member info
 *
 * @example
 * ```ts
 * const assignments = Collections.make({
 *   name: "assignments",
 *   index: { name: "gsi3", pk: "gsi3pk", sk: "gsi3sk" },
 *   composite: ["employee"],
 *   members: {
 *     Employees: Collections.member(Employees, []),
 *     Tasks: Collections.member(Tasks, ["project", "task"]),
 *   },
 * })
 * ```
 */
export const make = <
  const TName extends string,
  const TMembers extends Record<string, CollectionMember>,
>(
  config: CollectionConfig<TName, TMembers>,
): Collection<TName, TMembers> => {
  const memberEntries = Object.entries(config.members)
  const collectionType = config.type ?? "isolated"

  // --- Validation ---

  // At least one member
  if (memberEntries.length === 0) {
    throw new Error(`Collection '${config.name}' requires at least 1 member`)
  }

  // No duplicate entity types
  const entityTypes = new Set<string>()
  for (const [memberName, m] of memberEntries) {
    if (entityTypes.has(m.entity.entityType)) {
      throw new Error(
        `Entity type '${m.entity.entityType}' appears in multiple members of collection '${config.name}' (member '${memberName}')`,
      )
    }
    entityTypes.add(m.entity.entityType)

    // Validate PK composites exist on entity model
    const fields = getModelFieldNames(m.entity.model)
    for (const attr of config.composite) {
      if (!fields.has(attr)) {
        throw new Error(
          `Attribute '${attr}' not found on ${m.entity.entityType} model (collection '${config.name}', member '${memberName}')`,
        )
      }
    }

    // Validate SK composites exist on entity model
    for (const attr of m.sk) {
      if (!fields.has(attr)) {
        throw new Error(
          `Attribute '${attr}' not found on ${m.entity.entityType} model (collection '${config.name}', member '${memberName}')`,
        )
      }
    }
  }

  return {
    _tag: "Collection" as const,
    name: config.name,
    index: config.index,
    composite: config.composite,
    type: collectionType,
    members: config.members,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the IndexDefinition for a member entity from collection config + member SK.
 * Used by DynamoClient.make() to inject GSI indexes into entities.
 *
 * @internal
 */
export const buildMemberIndexDef = (
  collection: Collection,
  m: CollectionMember,
): IndexDefinition => ({
  index: collection.index.name,
  collection: collection.name,
  type: collection.type,
  pk: { field: collection.index.pk, composite: [...collection.composite] },
  sk: {
    field: collection.index.sk,
    composite: [...m.sk],
  },
})

/** @internal Get model field names (including ref ID fields). */
const getModelFieldNames = (model: Schema.Top): Set<string> => {
  try {
    const fields = getFields(model)
    const names = new Set(Object.keys(fields))
    // Also add ref-derived ID fields (fieldNameId)
    for (const fieldName of Object.keys(fields)) {
      names.add(`${fieldName}Id`)
    }
    return names
  } catch {
    // If model doesn't have .fields, return empty set (validation will fail)
    return new Set()
  }
}
