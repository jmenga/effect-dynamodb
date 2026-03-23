/**
 * Collections — Explicit GSI access pattern definitions.
 *
 * `Collections.make()` defines ALL GSI-based access patterns. A collection owns
 * the index definition (GSI name, PK field, PK composites, SK field) and each
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
import type { IndexDefinition, KeyPart } from "./KeyComposer.js"

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

/** A member binding within a collection: entity reference + SK composite config. */
export interface CollectionMember<E extends CollectionEntityLike = CollectionEntityLike> {
  readonly _tag: "CollectionMember"
  readonly entity: E
  readonly sk: { readonly composite: ReadonlyArray<string> }
}

/**
 * Bind an entity to a collection with its SK composites.
 *
 * @param entity - The entity to bind
 * @param config - SK composite configuration for this entity within the collection
 */
export const member = <E extends CollectionEntityLike>(
  entity: E,
  config: { readonly sk: { readonly composite: ReadonlyArray<string> } },
): CollectionMember<E> => ({
  _tag: "CollectionMember" as const,
  entity,
  sk: config.sk,
})

// ---------------------------------------------------------------------------
// Collection type — carries full definition + member types
// ---------------------------------------------------------------------------

/** Collection type (clustered or isolated). */
export type CollectionType = "clustered" | "isolated"

/** Collection configuration passed to `Collections.make()`. */
export interface CollectionConfig<TMembers extends Record<string, CollectionMember>> {
  /** Physical GSI name (e.g., `"gsi3"`). */
  readonly index: string
  /** Partition key field and composite attributes (shared by all members). */
  readonly pk: KeyPart
  /** Sort key field (shared by all members). */
  readonly sk: { readonly field: string }
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
  readonly index: string
  readonly pk: KeyPart
  readonly sk: { readonly field: string }
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
  TPk extends KeyPart,
> = {
  readonly [K in TPk["composite"][number]]: PickFieldType<FirstMemberModel<TMembers>, K>
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
 * @param name - Collection name (used as SK prefix in clustered mode)
 * @param config - Index configuration + member declarations
 * @returns A Collection definition carrying typed member info
 *
 * @example
 * ```ts
 * const Assignments = Collections.make("assignments", {
 *   index: "gsi3",
 *   pk: { field: "gsi3pk", composite: ["employee"] },
 *   sk: { field: "gsi3sk" },
 *   members: {
 *     Employees: Collections.member(Employees, { sk: { composite: [] } }),
 *     Tasks: Collections.member(Tasks, { sk: { composite: ["project", "task"] } }),
 *   },
 * })
 * ```
 */
export const make = <
  const TName extends string,
  const TMembers extends Record<string, CollectionMember>,
>(
  name: TName,
  config: CollectionConfig<TMembers>,
): Collection<TName, TMembers> => {
  const memberEntries = Object.entries(config.members)
  const collectionType = config.type ?? "clustered"

  // --- Validation ---

  // At least one member
  if (memberEntries.length === 0) {
    throw new Error(`Collection '${name}' requires at least 1 member`)
  }

  // No duplicate entity types
  const entityTypes = new Set<string>()
  for (const [memberName, m] of memberEntries) {
    if (entityTypes.has(m.entity.entityType)) {
      throw new Error(
        `Entity type '${m.entity.entityType}' appears in multiple members of collection '${name}'`,
      )
    }
    entityTypes.add(m.entity.entityType)

    // Validate PK composites exist on entity model
    const fields = getModelFieldNames(m.entity.model)
    for (const attr of config.pk.composite) {
      if (!fields.has(attr)) {
        throw new Error(
          `Attribute '${attr}' not found on ${m.entity.entityType} model (collection '${name}', member '${memberName}')`,
        )
      }
    }

    // Validate SK composites exist on entity model
    for (const attr of m.sk.composite) {
      if (!fields.has(attr)) {
        throw new Error(
          `Attribute '${attr}' not found on ${m.entity.entityType} model (collection '${name}', member '${memberName}')`,
        )
      }
    }
  }

  return {
    _tag: "Collection" as const,
    name,
    index: config.index,
    pk: config.pk,
    sk: config.sk,
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
  _memberKey: string,
  m: CollectionMember,
): IndexDefinition => ({
  index: collection.index,
  collection: collection.name,
  type: collection.type,
  pk: collection.pk,
  sk: {
    field: collection.sk.field,
    composite: [...m.sk.composite],
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
