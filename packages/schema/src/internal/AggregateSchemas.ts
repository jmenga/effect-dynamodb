/**
 * @internal Aggregate schema derivation — input and update schema building.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import { Schema } from "effect"
import { ConfiguredModelTag } from "../DynamoModel.js"
import type { AggregateEdge, ManyEdge, RefEntity } from "./AggregateEdges.js"
import type { AggregateInputType, BoundSubAggregate } from "./AggregateTypes.js"
import {
  extractArrayElement as extractArrayElementImpl,
  getSchemaFields as getSchemaFieldsImpl,
  isFieldOptional as isFieldOptionalImpl,
} from "./SchemaAccessors.js"

// ---------------------------------------------------------------------------
// Input schema derivation
// ---------------------------------------------------------------------------

/**
 * Derive an input schema from an aggregate definition.
 *
 * Edge-driven: walks edges to determine field transformations.
 * - OneEdge / RefEdge fields → `${field}Id: Schema.String`
 * - Sub-aggregate edges are recursed
 * - Many-edge array elements are recursed for ref replacement
 * - PK composite fields are omitted (auto-generated)
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
>(
  schema: TSchema,
  edges: TEdges,
  pkComposites: TPK,
): DerivedAggregateSchemas<AggregateInputType<Schema.Schema.Type<TSchema>, TEdges, TPK>> => {
  type Result = DerivedAggregateSchemas<
    AggregateInputType<Schema.Schema.Type<TSchema>, TEdges, TPK>
  >
  const fields = getSchemaFields(schema)
  if (!fields) {
    return { inputSchema: schema, createSchema: schema, updateSchema: schema } as unknown as Result
  }

  const omit = new Set(pkComposites)
  const newFields: Record<string, unknown> = {}

  for (const [name, fieldSchema] of Object.entries(fields)) {
    if (omit.has(name)) continue

    const edge = edges[name]
    if (edge && "_tag" in edge) {
      const isOpt = isFieldOptional(fieldSchema)

      if (edge._tag === "RefEdge" || edge._tag === "OneEdge") {
        // RefEdge / OneEdge → ${name}Id: Schema.String
        newFields[`${name}Id`] = isOpt ? Schema.optionalKey(Schema.String) : Schema.String
      } else if (edge._tag === "BoundSubAggregate") {
        const sub = (edge as BoundSubAggregate<any>).aggregate
        const subSchemas = deriveAggregateSchemas(sub.schema, sub.edges, [])
        newFields[name] = isOpt
          ? Schema.optionalKey(subSchemas.inputSchema)
          : subSchemas.inputSchema
      } else if (edge._tag === "ManyEdge") {
        const manyEdge = edge as ManyEdge
        const fieldKey = manyEdge.inputField ?? name
        const elemSchema = deriveElementInputSchema(fieldSchema, manyEdge.entity)
        if (elemSchema) {
          newFields[fieldKey] = isOpt
            ? Schema.optionalKey(Schema.Array(elemSchema))
            : Schema.Array(elemSchema)
        } else {
          newFields[fieldKey] = fieldSchema
        }
      }
      continue
    }

    // Regular field → keep as-is (toCodecJson applied at the end handles Date)
    newFields[name] = fieldSchema
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
  if (entity) {
    const entityFieldName = deriveEntityFieldName(entity)
    let hasChanges = false
    const newFields: Record<string, unknown> = {}
    for (const [name, fSchema] of Object.entries(elemFields)) {
      if (name === entityFieldName) {
        // This field references the entity — transform to ${name}Id: Schema.String
        const isOpt = isFieldOptional(fSchema)
        newFields[`${name}Id`] = isOpt ? Schema.optionalKey(Schema.String) : Schema.String
        hasChanges = true
      } else {
        newFields[name] = fSchema
      }
    }
    if (!hasChanges) return elemSchema
    return Schema.Struct(newFields as any)
  }

  return elemSchema
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
