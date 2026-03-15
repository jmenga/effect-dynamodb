/**
 * @internal Aggregate schema derivation — input and update schema building.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import { Schema } from "effect"
import type { AggregateEdge, ManyEdge, RefEntity } from "./_AggregateEdges.js"
import type { BoundSubAggregate } from "./_AggregateTypes.js"

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
export interface DerivedAggregateSchemas {
  readonly inputSchema: Schema.Top
  readonly updateSchema: Schema.Top
}

export const deriveAggregateSchemas = (
  schema: Schema.Top,
  edges: Record<string, AggregateEdge | BoundSubAggregate<any>>,
  pkComposites: ReadonlyArray<string>,
): DerivedAggregateSchemas => {
  const fields = getSchemaFields(schema)
  if (!fields) return { inputSchema: schema, updateSchema: schema }

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

  return { inputSchema, updateSchema }
}

/**
 * Check if a field schema represents an optional field.
 * In Effect v4, Schema.optionalKey(X) sets `ast.context.isOptional = true`.
 */
export const isFieldOptional = (fieldSchema: Schema.Top): boolean => {
  const ast = (fieldSchema as unknown as Record<string, unknown>).ast as
    | { context?: { isOptional?: boolean } }
    | undefined
  return ast?.context?.isOptional === true
}

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
  // Check for ConfiguredModel tag (Symbol.for("effect-dynamodb/ConfiguredModel"))
  const tag = Symbol.for("effect-dynamodb/ConfiguredModel")
  if (m[tag] === true && "model" in m) {
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
 * Extract the element schema from a field that is Schema.Array(T) or
 * Schema.optionalKey(Schema.Array(T)). Returns T.
 *
 * In Effect v4:
 * - Schema.Array(T) has `ast._tag === "Arrays"`, `.schema === T`
 * - Schema.optionalKey(Schema.Array(T)) inherits "Arrays" AST but `.schema === Array(T)`
 *   (the inner array, not the element). Its AST has `context.isOptional === true`.
 */
export const extractArrayElement = (fieldSchema: Schema.Top): Schema.Top | undefined => {
  const s = fieldSchema as unknown as Record<string, unknown>
  const ast = s.ast as { _tag?: string; context?: { isOptional?: boolean } } | undefined

  if (ast?._tag === "Arrays" && "schema" in s) {
    if (ast.context?.isOptional === true) {
      // optionalKey(Array(T)): s.schema is Array(T), s.schema.schema is T
      const inner = s.schema as unknown as Record<string, unknown>
      if ("schema" in inner) return inner.schema as Schema.Top
    }
    // Direct Array(T): s.schema is T (the element)
    return s.schema as Schema.Top
  }

  // Schema.optional(Array(T)): ast._tag is "Union" with context.isOptional,
  // .schema is Union with .members[0] being Schema.Array(T)
  if (ast?._tag === "Union" && ast.context?.isOptional === true && "schema" in s) {
    const unionSchema = s.schema as unknown as Record<string, unknown>
    const members = unionSchema?.members as unknown[] | undefined
    if (Array.isArray(members)) {
      for (const member of members) {
        const m = member as Record<string, unknown>
        const mAst = m.ast as { _tag?: string } | undefined
        if (mAst?._tag === "Arrays" && "schema" in m) {
          return m.schema as Schema.Top
        }
      }
    }
  }

  return undefined
}

/**
 * Access .fields on a Schema.Class or Schema.Struct.
 */
export const getSchemaFields = (schema: Schema.Top): Record<string, Schema.Top> | undefined => {
  if ("fields" in schema && typeof (schema as Record<string, unknown>).fields === "object") {
    return (schema as unknown as { fields: Record<string, Schema.Top> }).fields
  }
  return undefined
}
