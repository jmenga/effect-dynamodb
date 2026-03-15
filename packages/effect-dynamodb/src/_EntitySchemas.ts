/**
 * @internal Entity schema building — derived schemas and system field resolution.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import { Schema, SchemaAST } from "effect"
import type {
  TimestampFieldConfig,
  TimestampsConfig,
  UniqueConstraintDef,
  UniqueFieldsDef,
  VersionedConfig,
} from "./_EntityConfig.js"
import { type DynamoEncoding, getEncoding, isHidden, isImmutable } from "./DynamoModel.js"
import type { IndexDefinition } from "./KeyComposer.js"

// ---------------------------------------------------------------------------
// Resolved system field names (internal)
// ---------------------------------------------------------------------------

export interface ResolvedSystemFields {
  readonly createdAt: string | null
  readonly createdAtEncoding: DynamoEncoding | null
  readonly updatedAt: string | null
  readonly updatedAtEncoding: DynamoEncoding | null
  readonly version: string | null
}

/** Check if a value is a Schema (has .ast property) vs a plain config object */
const isSchema = (value: unknown): value is Schema.Top =>
  typeof value === "object" && value !== null && "ast" in value

/**
 * Resolve a single TimestampFieldConfig into field name + encoding.
 * Returns [fieldName, encoding | null].
 */
const resolveTimestampField = (
  config: TimestampFieldConfig | undefined,
  defaultName: string,
): [string, DynamoEncoding | null] => {
  if (config === undefined) return [defaultName, null]
  if (typeof config === "string") return [config, null]
  if (isSchema(config)) {
    const encoding = getEncoding(config)
    return [defaultName, encoding ?? null]
  }
  // Object config: { field?, schema? }
  const fieldName = config.field ?? defaultName
  const encoding = config.schema ? (getEncoding(config.schema) ?? null) : null
  return [fieldName, encoding]
}

export const resolveSystemFields = (
  timestamps?: TimestampsConfig | undefined,
  versioned?: VersionedConfig | undefined,
): ResolvedSystemFields => {
  let createdAt: string | null = null
  let createdAtEncoding: DynamoEncoding | null = null
  let updatedAt: string | null = null
  let updatedAtEncoding: DynamoEncoding | null = null
  let version: string | null = null

  if (timestamps === true) {
    createdAt = "createdAt"
    updatedAt = "updatedAt"
  } else if (typeof timestamps === "object" && timestamps !== null) {
    ;[createdAt, createdAtEncoding] = resolveTimestampField(timestamps.created, "createdAt")
    ;[updatedAt, updatedAtEncoding] = resolveTimestampField(timestamps.updated, "updatedAt")
  }

  if (versioned === true) {
    version = "version"
  } else if (typeof versioned === "object" && versioned !== null) {
    version = versioned.field ?? "version"
  }

  return { createdAt, createdAtEncoding, updatedAt, updatedAtEncoding, version }
}

// ---------------------------------------------------------------------------
// Helper: collect primary key composite attribute names
// ---------------------------------------------------------------------------

export const primaryKeyComposites = (
  indexes: globalThis.Record<string, IndexDefinition>,
): ReadonlyArray<string> => {
  const primary = indexes.primary
  if (!primary) return []
  const composites = new Set<string>()
  for (const attr of primary.pk.composite) composites.add(attr)
  for (const attr of primary.sk.composite) composites.add(attr)
  return Array.from(composites)
}

// ---------------------------------------------------------------------------
// Helper: collect all key field names across all indexes
// ---------------------------------------------------------------------------

export const allKeyFieldNames = (
  indexes: globalThis.Record<string, IndexDefinition>,
): ReadonlyArray<string> => {
  const fields = new Set<string>()
  for (const key of Object.keys(indexes)) {
    const index = indexes[key]
    if (index) {
      fields.add(index.pk.field)
      fields.add(index.sk.field)
    }
  }
  return Array.from(fields)
}

// ---------------------------------------------------------------------------
// Helper: collect all composite attribute names across all indexes
// ---------------------------------------------------------------------------

export const allCompositeAttributes = (
  indexes: globalThis.Record<string, IndexDefinition>,
): ReadonlyArray<string> => {
  const attrs = new Set<string>()
  for (const key of Object.keys(indexes)) {
    const index = indexes[key]
    if (index) {
      for (const attr of index.pk.composite) attrs.add(attr)
      for (const attr of index.sk.composite) attrs.add(attr)
    }
  }
  return Array.from(attrs)
}

// ---------------------------------------------------------------------------
// Schema helpers: get .fields from Schema.Class or Schema.Struct
// ---------------------------------------------------------------------------

export type SchemaFields = globalThis.Record<string, Schema.Top>

interface SchemaWithFields {
  readonly fields: SchemaFields
}

const hasFields = (schema: Schema.Top): schema is Schema.Top & SchemaWithFields =>
  "fields" in schema && typeof (schema as globalThis.Record<string, unknown>).fields === "object"

export const getFields = (model: Schema.Top): SchemaFields => {
  if (hasFields(model)) return model.fields
  throw new Error("Entity model must be a Schema.Class or Schema.Struct with .fields")
}

/**
 * Infer a default DynamoEncoding for standard Effect date schemas that lack
 * an explicit DynamoEncoding annotation. This enables Pattern B (pure model
 * with Schema.DateTimeUtcFromString etc.) to work without explicit storedAs.
 *
 * Detection uses the typeConstructor annotation from Effect's schema AST.
 */
export const inferDefaultEncoding = (schema: Schema.Top): DynamoEncoding | undefined => {
  const resolved = SchemaAST.resolve(schema.ast) as globalThis.Record<string, unknown> | undefined
  if (!resolved) return undefined
  const tc = resolved.typeConstructor as { _tag?: string } | undefined
  if (tc?._tag === "effect/DateTime.Utc") return { storage: "string", domain: "DateTime.Utc" }
  if (tc?._tag === "effect/DateTime.Zoned") return { storage: "string", domain: "DateTime.Zoned" }
  // Check for native Date via meta annotation
  const meta = resolved.meta as { _tag?: string } | undefined
  if (meta?._tag === "isDateValid") return { storage: "string", domain: "Date" }
  return undefined
}

// ---------------------------------------------------------------------------
// Build derived schemas at make() time
// ---------------------------------------------------------------------------

export interface DerivedSchemas {
  /** Pure model fields schema (wire format — for input validation) */
  readonly modelSchema: Schema.Codec<any>
  /** Model fields with fromSelf for date-annotated fields (for decode after deserialization) */
  readonly modelDecodeSchema: Schema.Codec<any>
  /** Model + system fields schema */
  readonly recordSchema: Schema.Codec<any>
  /** Same as model (system fields auto-managed) */
  readonly inputSchema: Schema.Codec<any>
  /** Input fields minus primary key composites — the common "create" payload */
  readonly createSchema: Schema.Codec<any>
  /** Optional model fields minus keys and immutable */
  readonly updateSchema: Schema.Codec<any>
  /** Primary key composites only */
  readonly keySchema: Schema.Codec<any>
  /** Record + key attrs + __edd_e__ */
  readonly itemSchema: Schema.Codec<any>
  /** Record fields + deletedAt for soft-deleted items */
  readonly deletedRecordSchema: Schema.Codec<any>
}

/**
 * Map a DynamoEncoding domain type to its "from self" Schema.
 * Used in record/item schemas so Schema.decode accepts domain values
 * directly (after deserializeDateFields has converted storage→domain).
 */
const dateFromSelfSchema = (encoding: DynamoEncoding): Schema.Top => {
  switch (encoding.domain) {
    case "DateTime.Utc":
      return Schema.DateTimeUtc
    case "DateTime.Zoned":
      return Schema.DateTimeZoned
    case "Date":
      return Schema.DateValid
  }
}

export const buildDerivedSchemas = (
  modelFields: SchemaFields,
  indexes: globalThis.Record<string, IndexDefinition>,
  systemFields: ResolvedSystemFields,
  resolvedRefs: ReadonlyArray<{
    readonly fieldName: string
    readonly idFieldName: string
    readonly identifierSchema: Schema.Top
  }> = [],
): DerivedSchemas => {
  // --- Build fromSelf field map for date fields ---
  // These replace transform schemas with their "from self" variants so
  // Schema.decode accepts domain values after storage→domain conversion.
  // Checks both explicit DynamoEncoding annotations AND inferred defaults
  // from standard Effect date schemas (Pattern B: pure model).
  const fromSelfFields: globalThis.Record<string, Schema.Top> = {}
  for (const [fieldName, fieldSchema] of Object.entries(modelFields)) {
    const encoding = getEncoding(fieldSchema) ?? inferDefaultEncoding(fieldSchema)
    if (encoding) {
      fromSelfFields[fieldName] = dateFromSelfSchema(encoding)
    }
  }

  // --- Model Schema: pure model fields (accepts wire format for input decode) ---
  const modelSchema = Schema.Struct(modelFields)

  // --- Model Decode Schema: model fields with fromSelf for date-annotated fields ---
  // Used in decodeAs after deserializeDateFields has converted storage→domain.
  const modelDecodeSchema =
    Object.keys(fromSelfFields).length > 0
      ? Schema.Struct({ ...modelFields, ...fromSelfFields })
      : modelSchema

  // --- Record Schema: model + system fields ---
  // For date-annotated fields, use "from self" schemas (accept domain values directly)
  const systemSchemaFields: globalThis.Record<string, Schema.Top> = {}
  if (systemFields.createdAt) {
    // Custom encoding → use fromSelf (deserializeDateFields handles storage→domain)
    // Default → use DateTimeUtcFromString (ISO string → DateTime.Utc)
    systemSchemaFields[systemFields.createdAt] = systemFields.createdAtEncoding
      ? Schema.DateTimeUtc
      : Schema.DateTimeUtcFromString
  }
  if (systemFields.updatedAt) {
    systemSchemaFields[systemFields.updatedAt] = systemFields.updatedAtEncoding
      ? Schema.DateTimeUtc
      : Schema.DateTimeUtcFromString
  }
  if (systemFields.version) {
    systemSchemaFields[systemFields.version] = Schema.Number
  }
  const recordSchema = Schema.Struct({
    ...modelFields,
    ...fromSelfFields,
    ...systemSchemaFields,
  })

  // --- Input Schema: ref-aware (swap ref fields for ID fields when refs present) ---
  const refFieldSet = new Set(resolvedRefs.map((r) => r.fieldName))
  const inputSchema =
    resolvedRefs.length > 0
      ? (() => {
          const inputFields: globalThis.Record<string, Schema.Top> = {}
          for (const [key, field] of Object.entries(modelFields)) {
            if (refFieldSet.has(key)) continue // skip ref fields
            inputFields[key] = field
          }
          // Add ID fields for each ref (uses the ref entity's identifier schema for branded types)
          for (const ref of resolvedRefs) {
            inputFields[ref.idFieldName] = ref.identifierSchema
          }
          return Schema.Struct(inputFields)
        })()
      : modelSchema

  // --- Create Schema: input fields minus primary key composites ---
  const pkComposites = new Set(primaryKeyComposites(indexes))
  const createFieldsAcc: globalThis.Record<string, Schema.Top> = {}
  for (const [key, field] of Object.entries(modelFields)) {
    if (pkComposites.has(key)) continue // skip PK composites (auto-generated)
    if (refFieldSet.has(key)) continue // skip ref fields (replaced by ID fields)
    createFieldsAcc[key] = field
  }
  // Add ID fields for each ref (skip if the ref field IS a PK composite)
  for (const ref of resolvedRefs) {
    if (pkComposites.has(ref.fieldName)) continue
    createFieldsAcc[ref.idFieldName] = ref.identifierSchema
  }
  const createSchema = Schema.Struct(createFieldsAcc as Schema.Struct.Fields)

  // --- Update Schema: optional model fields minus key composites & immutable ---
  const updateFieldsAcc: globalThis.Record<string, Schema.Top> = {}
  for (const [key, field] of Object.entries(modelFields)) {
    if (pkComposites.has(key)) continue
    if (isImmutable(field)) continue
    if (refFieldSet.has(key)) continue // skip ref fields in update (replaced by ID fields)
    updateFieldsAcc[key] = Schema.optional(field)
  }
  // Add optional ID fields for each ref in update (uses ref entity's identifier schema)
  for (const ref of resolvedRefs) {
    if (pkComposites.has(ref.fieldName)) continue // ref on PK composite — skip
    if (isImmutable(modelFields[ref.fieldName]!)) continue // immutable ref — skip
    updateFieldsAcc[ref.idFieldName] = Schema.optional(ref.identifierSchema)
  }
  const updateSchema = Schema.Struct(updateFieldsAcc as Schema.Struct.Fields)

  // --- Key Schema: primary key composite attributes only ---
  const keyCompositeNames = primaryKeyComposites(indexes)
  const keyFields: globalThis.Record<string, Schema.Top> = {}
  for (const name of keyCompositeNames) {
    const field = modelFields[name]
    if (field) keyFields[name] = field
  }
  const keySchema = Schema.Struct(keyFields)

  // --- Item Schema: record + key attrs (pk, sk, gsi*) + __edd_e__ ---
  const keyAttrFields: globalThis.Record<string, Schema.Top> = {}
  for (const fieldName of allKeyFieldNames(indexes)) {
    keyAttrFields[fieldName] = Schema.String
  }
  const itemSchema = Schema.Struct({
    ...modelFields,
    ...fromSelfFields,
    ...systemSchemaFields,
    ...keyAttrFields,
    __edd_e__: Schema.String,
  })

  // --- Deleted Record Schema: record + deletedAt ---
  const deletedRecordSchema = Schema.Struct({
    ...modelFields,
    ...fromSelfFields,
    ...systemSchemaFields,
    deletedAt: Schema.String,
  })

  // --- Hidden-aware decode schemas: strip DynamoModel.Hidden fields from model/record ---
  // These are used for "model" and "record" decode modes. Hidden fields are
  // still present in "item" and "native" modes.
  const hiddenFieldNames = new Set<string>()
  for (const [fieldName, fieldSchema] of Object.entries(modelFields)) {
    if (isHidden(fieldSchema)) hiddenFieldNames.add(fieldName)
  }
  const hasHiddenFields = hiddenFieldNames.size > 0

  const modelDecodeVisibleSchema = hasHiddenFields
    ? Schema.Struct(
        Object.fromEntries(
          Object.entries({ ...modelFields, ...fromSelfFields }).filter(
            ([k]) => !hiddenFieldNames.has(k),
          ),
        ),
      )
    : modelDecodeSchema

  const recordVisibleSchema = hasHiddenFields
    ? Schema.Struct(
        Object.fromEntries(
          Object.entries({
            ...modelFields,
            ...fromSelfFields,
            ...systemSchemaFields,
          }).filter(([k]) => !hiddenFieldNames.has(k)),
        ),
      )
    : recordSchema

  // All schemas are built from concrete field schemas (Schema.String, Schema.Number,
  // Schema.DateTimeUtcFromString, etc.) which all have R = never. TypeScript cannot infer this
  // because the fields are stored in dynamically-typed records, so we cast.
  type S = Schema.Codec<any>
  return {
    modelSchema: modelSchema as unknown as S,
    modelDecodeSchema: modelDecodeVisibleSchema as unknown as S,
    recordSchema: recordVisibleSchema as unknown as S,
    inputSchema: inputSchema as unknown as S,
    createSchema: createSchema as unknown as S,
    updateSchema: updateSchema as unknown as S,
    keySchema: keySchema as unknown as S,
    itemSchema: itemSchema as unknown as S,
    deletedRecordSchema: deletedRecordSchema as unknown as S,
  }
}

// ---------------------------------------------------------------------------
// Unique constraint field resolver
// ---------------------------------------------------------------------------

export const resolveUniqueFields = (def: UniqueConstraintDef): ReadonlyArray<string> =>
  Array.isArray(def) ? def : (def as { readonly fields: UniqueFieldsDef }).fields
