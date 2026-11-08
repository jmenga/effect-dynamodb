/**
 * @internal Aggregate schema derivation — input and update schema building.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import { Schema, SchemaAST } from "effect"
import { ConfiguredModelTag } from "../DynamoModel.js"
import type { AggregateEdge, ManyEdge, RefEntity } from "./AggregateEdges.js"
import type {
  AggregateInputType,
  AggregateStampNames,
  BoundSubAggregate,
} from "./AggregateTypes.js"
import { bothKindsKeyRefusal, storedFieldAtPath } from "./CompositeCodec.js"
import type { TimestampsConfig } from "./EntityConfig.js"
import { optionalField, type ResolvedSystemFields, resolveSystemFields } from "./EntitySchemas.js"
import {
  extractArrayElement as extractArrayElementImpl,
  extractKeyedValue,
  getSchemaFields as getSchemaFieldsImpl,
  isFieldOptional as isFieldOptionalImpl,
} from "./SchemaAccessors.js"

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * `timestamps` resolved over a value's fields, by the entity's rules: `Schema.optional` wraps the
 * value that's read, a date is the library's, and any other field of that name is the caller's.
 */
export const resolveAggregateStamps = (
  timestamps: TimestampsConfig | undefined,
  fields: Record<string, Schema.Top> | undefined,
  owner: string,
): ResolvedSystemFields =>
  resolveSystemFields(
    timestamps,
    undefined,
    undefined,
    Object.fromEntries(
      Object.entries(fields ?? {}).map(([name, field]) => [
        name,
        optionalField(field)?.inner ?? field,
      ]),
    ),
    {},
    owner,
  )

/**
 * `[EDD-9121]`: a partition key the library would move on every write. An aggregate's rows all live
 * under its partition key and a write only ever `Put`s rows under it, so the key would stop matching
 * the value at the first update, and nothing could find the aggregate by what it holds.
 */
export const refuseAggregateKeyOverMovingValue = (
  aggregate: string,
  timestamps: TimestampsConfig | undefined,
  fields: Record<string, Schema.Top> | undefined,
  composite: ReadonlyArray<string>,
): void => {
  const { updatedAt } = resolveAggregateStamps(timestamps, fields, `Aggregate "${aggregate}"`)
  if (updatedAt !== null && composite.includes(updatedAt)) {
    throw new Error(
      `[EDD-9121] Aggregate "${aggregate}": its partition key can't be composed from ` +
        `"${updatedAt}". The library changes it on every write and a partition key never changes, ` +
        `so the key would stop matching the value at the first update. Remove it from the ` +
        `partition key, or use a field the library doesn't manage.`,
    )
  }
}

/**
 * The fields of a `many` edge's ELEMENT, read off the parent model's field: the array's element
 * (`players: Schema.Array(PlayerSheet)` → `PlayerSheet`'s), or a keyed collection's value, the
 * elements of a custom `decompose` over it. `undefined` when the field says nothing about what its
 * `decompose` returns, or the element exposes no fields (a scalar, or an opaque ref).
 */
export const manyElementFields = (
  parentFields: Record<string, Schema.Top> | undefined,
  edgeName: string,
): Record<string, Schema.Top> | undefined => {
  const field = parentFields?.[edgeName]
  if (field === undefined) return undefined
  const element = extractArrayElement(field) ?? extractKeyedValue(field)
  return element === undefined ? undefined : getSchemaFields(element)
}

/**
 * `[EDD-9121]`: a `many` edge's sort key the library would move on every write, on the root's edges
 * and those of the sub-aggregates under it. Whose `updatedAt` it is, is the row's: a field of that
 * name of another type is the caller's, and a root's turns the stamp off on every row.
 */
export const refuseManySortKeysOverMovingValue = (
  aggregate: string,
  timestamps: TimestampsConfig | undefined,
  rootFields: Record<string, Schema.Top> | undefined,
  rootEdges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
): void => {
  const owner = `Aggregate "${aggregate}"`
  if (resolveAggregateStamps(timestamps, rootFields, owner).updatedAt === null) return
  const walk = (
    fields: Record<string, Schema.Top> | undefined,
    edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  ): void => {
    for (const [name, edge] of Object.entries(edges)) {
      if (!("_tag" in edge)) continue
      if (edge._tag === "BoundSubAggregate") {
        const sub = (edge as BoundSubAggregate<any>).aggregate
        walk(getSchemaFields(sub.schema), sub.edges)
      } else if (edge._tag === "ManyEdge") {
        const entity = (edge as ManyEdge).entity
        const element =
          manyElementFields(fields, name) ??
          (entity === undefined ? undefined : getSchemaFields(unwrapModel(entity.model)))
        const { updatedAt } = resolveAggregateStamps(timestamps, element, owner)
        if (updatedAt !== null && (edge as ManyEdge).sk?.composite.includes(updatedAt) === true) {
          throw new Error(
            `[EDD-9121] Aggregate "${aggregate}": edge "${name}"'s sort key can't be composed ` +
              `from "${updatedAt}". The library changes it on every write and a sort key never ` +
              `changes, so the key would stop matching the value at the first update.`,
          )
        }
      }
    }
  }
  walk(rootFields, rootEdges)
}

/**
 * `[EDD-9128]`: a key an aggregate composes from a field storing both numeric kinds
 * (`bothKindsKeyRefusal`): its partition key, its collection and list keys, and a `many` edge's sort
 * key, on the root's edges and those of the sub-aggregates under it. A sort-key composite that's a
 * path into a value (`player.id`) is followed to the field a row stores there, through an optional,
 * nullable, suspended or class value on the way (`storedFieldAtPath`): a value transformed on the
 * way is judged by what it's stored as, so a struct storing a number at `n` and decoding it to a
 * union of both kinds loads, and one storing either kind there doesn't.
 */
export const refuseAggregateKeysOverBothKinds = (
  aggregate: string,
  rootFields: Record<string, Schema.Top> | undefined,
  config: {
    readonly pk: { readonly composite: ReadonlyArray<string> }
    readonly collection?: { readonly sk?: { readonly composite?: ReadonlyArray<string> } }
    readonly list?: {
      readonly pk: { readonly composite: ReadonlyArray<string> }
      readonly sk: { readonly composite: ReadonlyArray<string> }
    }
  },
  rootEdges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
): void => {
  const owner = `Aggregate "${aggregate}"`
  const refuse = (
    where: string,
    fields: Record<string, Schema.Top> | undefined,
    composites: ReadonlyArray<string>,
  ): void => {
    for (const attr of composites) {
      const field = storedFieldAtPath(fields, attr)
      if (field === undefined) continue
      const refused = bothKindsKeyRefusal(owner, where, attr, field)
      if (refused !== undefined) throw refused
    }
  }
  refuse("its partition key", rootFields, config.pk.composite)
  refuse("its collection sort key", rootFields, config.collection?.sk?.composite ?? [])
  if (config.list !== undefined) {
    refuse("its list partition key", rootFields, config.list.pk.composite)
    refuse("its list sort key", rootFields, config.list.sk.composite)
  }
  const walk = (
    fields: Record<string, Schema.Top> | undefined,
    edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  ): void => {
    for (const [name, edge] of Object.entries(edges)) {
      if (!("_tag" in edge)) continue
      if (edge._tag === "BoundSubAggregate") {
        const sub = (edge as BoundSubAggregate<any>).aggregate
        walk(getSchemaFields(sub.schema), sub.edges)
      } else if (edge._tag === "ManyEdge") {
        const entity = (edge as ManyEdge).entity
        const element =
          manyElementFields(fields, name) ??
          (entity === undefined ? undefined : getSchemaFields(unwrapModel(entity.model)))
        refuse(`edge "${name}"'s sort key`, element, (edge as ManyEdge).sk?.composite ?? [])
      }
    }
  }
  walk(rootFields, rootEdges)
}

/** The dates the rows of a value with `fields` declare, of those `timestamps` stamps. */
const managedDates = (
  stamps: AggregateStamps,
  fields: Record<string, Schema.Top>,
): ReadonlySet<string> => {
  const own = resolveAggregateStamps(stamps.config, fields, "Aggregate")
  return new Set(
    [own.createdAtCollision ? own.createdAt : null, own.updatedAtCollision ? own.updatedAt : null]
      .filter((name): name is string => name !== null)
      .filter((name) => stamps.names.has(name)),
  )
}

/** `timestamps`, and the names it stamps on this aggregate's rows. */
interface AggregateStamps {
  readonly config: TimestampsConfig | undefined
  readonly names: ReadonlySet<string>
}

/** A managed date's input field: optional, supplied or not. */
const stampInput = (field: Schema.Top): Schema.Top =>
  Schema.optionalKey((optionalField(field)?.inner ?? field) as Schema.Top) as unknown as Schema.Top

/** A row's value on the input: as the model has it, but for the dates the library stamps. */
const rowInput = (schema: Schema.Top, stamps: AggregateStamps): Schema.Top => {
  const fields = getSchemaFields(schema)
  if (fields === undefined) return schema
  const managed = managedDates(stamps, fields)
  if (managed.size === 0) return schema
  return Schema.Struct(
    Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        managed.has(name) ? stampInput(field) : field,
      ]),
    ) as any,
  )
}

// ---------------------------------------------------------------------------
// Input schema derivation
// ---------------------------------------------------------------------------

/**
 * Derive an input schema from an aggregate definition.
 *
 * Edge-driven: walks edges to determine field transformations.
 * - RefEdge, and OneEdge with an entity, fields → `${field}Id: Schema.String`: `create` fetches it
 * - OneEdge without one → the value itself, which is all `create` can take
 * - Sub-aggregate edges are recursed
 * - Many-edge array elements are recursed for ref replacement
 * - PK composite fields are omitted (auto-generated)
 * - A date `timestamps` stamps is optional, at any level
 * - `Schema.toCodecJson` is applied at the end so Date fields accept ISO strings
 */
/**
 * Precisely-typed derived aggregate schemas. `TInput` is the aggregate's derived
 * input/create payload type (see {@link AggregateInputType}); `updateSchema` is
 * the same shape with every field optional. This lets the table-free
 * `deriveAggregateSchemas` path be as typed as the top-level `Aggregate.make`,
 * so an AWS-free contract package can read `typeof result.inputSchema.Type`
 * without fabricating a stub table tag (issue #67).
 */
export interface DerivedAggregateSchemas<TInput = unknown> {
  readonly inputSchema: Schema.Codec<TInput>
  /** Alias for `inputSchema` — aggregates have no PK-composite stripping on create. */
  readonly createSchema: Schema.Codec<TInput>
  readonly updateSchema: Schema.Codec<Partial<TInput>>
}

export const deriveAggregateSchemas = <
  TSchema extends Schema.Top,
  const TEdges extends Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  const TPK extends ReadonlyArray<string>,
  const TTimestamps extends TimestampsConfig | undefined = undefined,
>(
  schema: TSchema,
  edges: TEdges,
  pkComposites: TPK,
  timestamps?: TTimestamps,
): DerivedAggregateSchemas<
  AggregateInputType<
    Schema.Schema.Type<TSchema>,
    TEdges,
    TPK,
    AggregateStampNames<Schema.Schema.Type<TSchema>, TTimestamps>
  >
> => {
  const own = resolveAggregateStamps(timestamps, getSchemaFields(schema), "Aggregate")
  return deriveWithStamps(schema, edges, pkComposites, {
    config: timestamps,
    names: new Set([own.createdAt, own.updatedAt].filter((name) => name !== null)),
  }) as never
}

const deriveWithStamps = (
  schema: Schema.Top,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any, any>>,
  pkComposites: ReadonlyArray<string>,
  stamps: AggregateStamps,
): DerivedAggregateSchemas<unknown> => {
  type Result = DerivedAggregateSchemas<unknown>
  const fields = getSchemaFields(schema)
  if (!fields) {
    return { inputSchema: schema, createSchema: schema, updateSchema: schema } as unknown as Result
  }

  const omit = new Set(pkComposites)
  const managed = managedDates(stamps, fields)
  const newFields: Record<string, unknown> = {}

  for (const [name, fieldSchema] of Object.entries(fields)) {
    if (omit.has(name)) continue

    const edge = edges[name]
    if (edge && "_tag" in edge) {
      const isOpt = isFieldOptional(fieldSchema)

      if (edge._tag === "OneEdge" && edge.entity === undefined) {
        const value = rowInput(optionalField(fieldSchema)?.inner ?? fieldSchema, stamps)
        newFields[name] = isOpt ? Schema.optionalKey(value) : value
      } else if (edge._tag === "RefEdge" || edge._tag === "OneEdge") {
        newFields[`${name}Id`] = isOpt ? Schema.optionalKey(Schema.String) : Schema.String
      } else if (edge._tag === "BoundSubAggregate") {
        const sub = (edge as BoundSubAggregate<any>).aggregate
        const subSchemas = deriveWithStamps(sub.schema, sub.edges, [], stamps)
        newFields[name] = isOpt
          ? Schema.optionalKey(subSchemas.inputSchema)
          : subSchemas.inputSchema
      } else if (edge._tag === "ManyEdge") {
        const manyEdge = edge as ManyEdge
        const fieldKey = manyEdge.inputField ?? name
        const elemSchema = deriveElementInputSchema(fieldSchema, manyEdge.entity, stamps)
        if (elemSchema) {
          newFields[fieldKey] = isOpt
            ? Schema.optionalKey(Schema.Array(elemSchema))
            : Schema.Array(elemSchema)
        } else {
          newFields[fieldKey] = keyedInput(fieldSchema, stamps)
        }
      }
      continue
    }

    // Regular field → keep as-is (toCodecJson applied at the end handles Date)
    newFields[name] = managed.has(name) ? stampInput(fieldSchema) : fieldSchema
  }

  const inputSchema = Schema.toCodecJson(Schema.Struct(newFields as any))

  // Update schema: all fields optional
  const optionalFields: Record<string, unknown> = {}
  for (const [name, fieldSchema] of Object.entries(newFields)) {
    optionalFields[name] = isFieldOptional(fieldSchema as Schema.Top)
      ? fieldSchema
      : Schema.optional(fieldSchema as Schema.Top)
  }
  const updateSchema = Schema.toCodecJson(Schema.Struct(optionalFields as any))

  // Runtime members are `Schema.Codec<unknown>`-shaped; the precise input type
  // is a compile-time phantom (`AggregateInputType`) — same approach the
  // top-level `Aggregate.make` overload uses. `createSchema` aliases `inputSchema`.
  return { inputSchema, createSchema: inputSchema, updateSchema } as unknown as Result
}

/** A `Schema.Record` many edge's input (a custom `decompose`): its values' stamps are optional. */
const keyedInput = (fieldSchema: Schema.Top, stamps: AggregateStamps): Schema.Top => {
  const inner = optionalField(fieldSchema)?.inner ?? fieldSchema
  if (!SchemaAST.isObjects(inner.ast)) return fieldSchema
  const record = inner as unknown as { readonly key?: Schema.Top; readonly value?: Schema.Top }
  if (record.key === undefined || record.value === undefined) return fieldSchema
  const value = rowInput(record.value, stamps)
  if (value === record.value) return fieldSchema
  const input = Schema.Record(record.key as never, value)
  return isFieldOptional(fieldSchema) ? Schema.optionalKey(input) : input
}

/**
 * Check if a field schema represents an optional field.
 *
 * Delegates to {@link SchemaAccessors.isFieldOptional}, which uses the stable
 * `SchemaAST.isOptional` guard. Re-exported here (and from `Aggregate.ts`) for
 * backwards-compatible access.
 */
export const isFieldOptional = (fieldSchema: Schema.Top): boolean =>
  isFieldOptionalImpl(fieldSchema)

/**
 * Derive a field name from an entity's model identifier.
 * E.g., entity with model identifier "Umpire" → "umpire" (lowercase first letter).
 */
export const deriveEntityFieldName = (entity: RefEntity): string => {
  const s = entity.model as unknown as Record<string, unknown>
  const identifier =
    "identifier" in s && typeof s.identifier === "string" ? s.identifier : entity.entityType
  return identifier.charAt(0).toLowerCase() + identifier.slice(1)
}

/**
 * Derive input schema for a many-edge array element.
 * Extracts the element type from the field schema (which may be an Array
 * or optional(Array)). If the element IS the entity (matches the entity model),
 * transforms to Schema.String. Otherwise, finds the entity-derived field within
 * the element and transforms it.
 */
export const deriveElementInputSchema = (
  arrayFieldSchema: Schema.Top,
  entity?: RefEntity,
  stamps?: AggregateStamps,
): Schema.Top | undefined => {
  const elemSchema = extractArrayElement(arrayFieldSchema)
  if (!elemSchema) return undefined

  const elemFields = getSchemaFields(elemSchema)

  // Check if the element itself IS the entity model (e.g., Array<Umpire>)
  if (entity && elemFields && isSchemaMatchingEntity(elemSchema, entity)) {
    // Element IS the entity → array of IDs (Schema.String)
    return Schema.String
  }

  if (!elemFields) return elemSchema

  // Element wraps entity + attributes — find the entity-derived field and transform it
  const entityFieldName = entity ? deriveEntityFieldName(entity) : undefined
  const managed = stamps === undefined ? undefined : managedDates(stamps, elemFields)
  let hasChanges = false
  const newFields: Record<string, unknown> = {}
  for (const [name, fSchema] of Object.entries(elemFields)) {
    if (name === entityFieldName) {
      // This field references the entity — transform to ${name}Id: Schema.String
      const isOpt = isFieldOptional(fSchema)
      newFields[`${name}Id`] = isOpt ? Schema.optionalKey(Schema.String) : Schema.String
      hasChanges = true
    } else if (managed?.has(name) === true) {
      newFields[name] = stampInput(fSchema)
      hasChanges = true
    } else {
      newFields[name] = fSchema
    }
  }
  return hasChanges ? Schema.Struct(newFields as any) : elemSchema
}

/**
 * The paths of an aggregate's `many` edges, sub-aggregates included. The collection such a field is
 * declared as is taken apart by `decompose` and put back by `assemble`, so it's never stored itself.
 */
export const manyEdgePaths = (
  edges: Readonly<Record<string, unknown>> | undefined,
  at = "",
): ReadonlySet<string> => {
  const paths = new Set<string>()
  for (const [name, edge] of Object.entries(edges ?? {})) {
    const path = at === "" ? name : `${at}.${name}`
    const tagged = edge as {
      readonly _tag?: string
      readonly aggregate?: { readonly edges?: Readonly<Record<string, unknown>> }
    }
    if (tagged._tag === "ManyEdge") paths.add(path)
    if (tagged._tag === "BoundSubAggregate") {
      for (const nested of manyEdgePaths(tagged.aggregate?.edges, path)) paths.add(nested)
    }
  }
  return paths
}

/**
 * Unwrap a ConfiguredModel to get the raw Schema.Class model.
 * ConfiguredModel wraps the original model with DynamoDB-specific overrides
 * (field renaming, storage encoding) and has shape { model: M, attributes: ... }.
 */
export const unwrapModel = (model: Schema.Top): Schema.Top => {
  const m = model as unknown as Record<string | symbol, unknown>
  if (m[ConfiguredModelTag] === true && "model" in m) {
    return m.model as Schema.Top
  }
  return model
}

/**
 * Check if a schema matches an entity model (same Schema.Class identifier).
 * This is used to detect when an array element IS the entity (e.g., Array<Umpire>),
 * as opposed to wrapping the entity (e.g., Array<{ umpire: Umpire, role: string }>).
 * Unwraps ConfiguredModel if the entity uses DynamoModel.configure.
 */
export const isSchemaMatchingEntity = (schema: Schema.Top, entity: RefEntity): boolean => {
  const s = schema as unknown as Record<string, unknown>
  const entityModel = unwrapModel(entity.model) as unknown as Record<string, unknown>
  // Compare Schema.Class identifiers
  if ("identifier" in s && "identifier" in entityModel) {
    return s.identifier === entityModel.identifier
  }
  return false
}

/**
 * Extract the element schema from a field that is `Schema.Array(T)`,
 * `Schema.NonEmptyArray(T)`, `Schema.optionalKey(Schema.Array(T))`, or
 * `Schema.optional(Schema.Array(T))`. Returns `T`.
 *
 * Delegates to {@link SchemaAccessors.extractArrayElement}, which routes
 * through `SchemaAST.isArrays`/`isUnion` guards and the typed `.value` /
 * `.schema` / `.members` accessors. Re-exported here (and from `Aggregate.ts`)
 * for backwards-compatible access.
 */
export const extractArrayElement = (fieldSchema: Schema.Top): Schema.Top | undefined =>
  extractArrayElementImpl(fieldSchema)

/**
 * Access `.fields` on a Schema.Class or Schema.Struct.
 *
 * Delegates to {@link SchemaAccessors.getSchemaFields} (typed `.fields`).
 * Re-exported here (and from `Aggregate.ts`) for backwards-compatible access.
 */
export const getSchemaFields = (schema: Schema.Top): Record<string, Schema.Top> | undefined =>
  getSchemaFieldsImpl(schema)
