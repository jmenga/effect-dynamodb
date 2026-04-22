/**
 * @internal Entity schema building — derived schemas and system field resolution.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import { Schema, SchemaAST } from "effect"
import { type DynamoEncoding, getEncoding, isHidden } from "../DynamoModel.js"
import type { IndexDefinition } from "../KeyComposer.js"
import type {
  TimeSeriesConfig,
  TimestampFieldConfig,
  TimestampsConfig,
  UniqueConstraintDef,
  UniqueFieldsDef,
  VersionedConfig,
} from "./EntityConfig.js"

// ---------------------------------------------------------------------------
// Resolved system field names (internal)
// ---------------------------------------------------------------------------

export interface ResolvedSystemFields {
  readonly createdAt: string | null
  readonly createdAtEncoding: DynamoEncoding | null
  /** True when the model declares a field whose name matches `createdAt`. */
  readonly createdAtCollision: boolean
  readonly updatedAt: string | null
  readonly updatedAtEncoding: DynamoEncoding | null
  /** True when the model declares a field whose name matches `updatedAt`. */
  readonly updatedAtCollision: boolean
  readonly version: string | null
  /** True when the model declares a field whose name matches `version`. */
  readonly versionCollision: boolean
}

/**
 * Minimal shape of the `attributes` record on a ConfiguredModel — we only need
 * `encoding` here. Declared locally to avoid importing ConfiguredModel types.
 */
export type ConfiguredAttributeEncodings = globalThis.Record<
  string,
  { readonly encoding?: DynamoEncoding }
>

/**
 * Resolve the effective DynamoEncoding for a model-declared field, applying
 * ConfiguredModel storage overrides on top of schema-level annotations.
 *
 * Precedence: schema annotation (getEncoding) > inferred default (Effect date
 * schemas) > none. ConfiguredModel `storedAs` then overrides storage only,
 * preserving the domain from the schema side when present.
 *
 * Returns `null` if the field is not a date-compatible schema.
 */
export const resolveFieldEncoding = (
  fieldSchema: Schema.Top,
  override: DynamoEncoding | undefined,
): DynamoEncoding | null => {
  let encoding: DynamoEncoding | null =
    getEncoding(fieldSchema) ?? inferDefaultEncoding(fieldSchema) ?? null
  if (override) {
    encoding = {
      storage: override.storage,
      domain: encoding?.domain ?? override.domain,
    }
  }
  return encoding
}

/**
 * Build the field → DynamoEncoding map for a set of model fields, merging
 * ConfiguredModel storage overrides. Used at `Entity.make()` time.
 */
export const buildFieldEncodings = (
  modelFields: SchemaFields,
  configuredAttributes: ConfiguredAttributeEncodings,
): globalThis.Record<string, DynamoEncoding> => {
  const encodings: globalThis.Record<string, DynamoEncoding> = {}
  for (const [fieldName, fieldSchema] of Object.entries(modelFields)) {
    const encoding = resolveFieldEncoding(fieldSchema, configuredAttributes[fieldName]?.encoding)
    if (encoding) encodings[fieldName] = encoding
  }
  return encodings
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
  timeSeries?: TimeSeriesConfig<any> | undefined,
  modelFields: SchemaFields = {},
  configuredAttributes: ConfiguredAttributeEncodings = {},
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

  // Time-series entities auto-suppress `updatedAt` — the `orderBy` attribute
  // serves as the update clock. `createdAt` is preserved.
  if (timeSeries !== undefined && timeSeries !== null) {
    if (updatedAt !== null) {
      if (
        typeof timestamps === "object" &&
        timestamps !== null &&
        (timestamps as { updated?: unknown }).updated !== undefined
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          "[effect-dynamodb] timeSeries entity: `timestamps.updated` is ignored — " +
            "the `orderBy` attribute is the event-time clock.",
        )
      }
      updatedAt = null
      updatedAtEncoding = null
    }
  }

  // Collision detection: when the model declares a field whose name matches
  // an active system field, there are two cases:
  //   (a) Date-compatible schema → library-managed with user override
  //       support. Encoding reads from the model field (precedence over
  //       `timestamps` config default).
  //   (b) Non-date schema → user owns the field entirely. Library skips
  //       timestamp management for this field (effectively as if the
  //       corresponding `timestamps.created`/`updated` was never set).
  //       This preserves existing patterns where users declare `createdAt`
  //       as a plain string composite.
  let createdAtCollision = false
  if (createdAt && createdAt in modelFields) {
    const modelEncoding = resolveFieldEncoding(
      modelFields[createdAt]!,
      configuredAttributes[createdAt]?.encoding,
    )
    if (modelEncoding) {
      createdAtEncoding = modelEncoding
      createdAtCollision = true
    } else {
      // Non-date collision: user owns the field.
      createdAt = null
      createdAtEncoding = null
    }
  }
  let updatedAtCollision = false
  if (updatedAt && updatedAt in modelFields) {
    const modelEncoding = resolveFieldEncoding(
      modelFields[updatedAt]!,
      configuredAttributes[updatedAt]?.encoding,
    )
    if (modelEncoding) {
      updatedAtEncoding = modelEncoding
      updatedAtCollision = true
    } else {
      updatedAt = null
      updatedAtEncoding = null
    }
  }
  const versionCollision = !!(version && version in modelFields)

  return {
    createdAt,
    createdAtEncoding,
    createdAtCollision,
    updatedAt,
    updatedAtEncoding,
    updatedAtCollision,
    version,
    versionCollision,
  }
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
  /**
   * Typed input schema — the public payload type users see. Ref-aware (ref
   * fields swapped for ID fields). System-colliding `createdAt`/`updatedAt`
   * are marked optional; `version` (if colliding) is stripped.
   */
  readonly inputSchema: Schema.Codec<any>
  /**
   * Runtime input decode schema. Same shape as `inputSchema` but with fromSelf
   * variants for date fields so decode accepts domain values (matches the TS
   * contract). Used by put/create/upsert at runtime.
   */
  readonly inputDecodeSchema: Schema.Codec<any>
  /** Input fields minus primary key composites — the common "create" payload */
  readonly createSchema: Schema.Codec<any>
  /** Optional model fields minus keys and immutable */
  readonly updateSchema: Schema.Codec<any>
  /**
   * Runtime update decode schema. Same shape as `updateSchema` but with
   * fromSelf variants for date fields so decode accepts domain values. Used
   * by update at runtime.
   */
  readonly updateDecodeSchema: Schema.Codec<any>
  /** Primary key composites only */
  readonly keySchema: Schema.Codec<any>
  /** Record + key attrs + __edd_e__ */
  readonly itemSchema: Schema.Codec<any>
  /** Record fields + deletedAt for soft-deleted items */
  readonly deletedRecordSchema: Schema.Codec<any>
  /**
   * `appendInput` schema for `.append()` on time-series entities.
   * `null` when the entity is not configured with `timeSeries`.
   */
  readonly appendInputSchema: Schema.Codec<any> | null
  /**
   * Record schema for history/event items. Same shape as `recordSchema` minus
   * `updatedAt` (time-series auto-suppresses it). `null` when the entity is
   * not configured with `timeSeries`.
   */
  readonly historyRecordSchema: Schema.Codec<any> | null
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
  immutableFields: ReadonlySet<string> = new Set(),
  identifierField: string | undefined = undefined,
  timeSeries: TimeSeriesConfig<any> | undefined = undefined,
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

  // --- System-collision handling for input/update schemas ---
  // When the model declares a field whose name matches an active system field,
  // the input shape changes:
  //   - createdAt / updatedAt → marked optional (user may supply a value or
  //     leave absent and let the library generate).
  //   - version → stripped entirely (optimistic locking requires library-
  //     managed increment; user-supplied values would break the mechanic).
  // `createdAt` is also treated as immutable in the update schema.
  const optionalOnCollide = new Set<string>()
  if (systemFields.createdAtCollision && systemFields.createdAt)
    optionalOnCollide.add(systemFields.createdAt)
  if (systemFields.updatedAtCollision && systemFields.updatedAt)
    optionalOnCollide.add(systemFields.updatedAt)
  const strippedFromInput = new Set<string>()
  if (systemFields.versionCollision && systemFields.version)
    strippedFromInput.add(systemFields.version)
  const strippedFromUpdate = new Set<string>(strippedFromInput)
  if (systemFields.createdAtCollision && systemFields.createdAt)
    strippedFromUpdate.add(systemFields.createdAt)

  const applySystemCollisionAdjustments = (
    fieldName: string,
    fieldSchema: Schema.Top,
    kind: "input" | "update",
  ): Schema.Top | null => {
    const strippedSet = kind === "update" ? strippedFromUpdate : strippedFromInput
    if (strippedSet.has(fieldName)) return null
    if (optionalOnCollide.has(fieldName)) return Schema.optional(fieldSchema)
    return fieldSchema
  }

  // --- Input Schema: ref-aware (swap ref fields for ID fields when refs present) ---
  const refFieldSet = new Set(resolvedRefs.map((r) => r.fieldName))
  const buildInputFieldsAcc = (
    dateVariant: "transform" | "fromSelf",
  ): globalThis.Record<string, Schema.Top> => {
    const acc: globalThis.Record<string, Schema.Top> = {}
    for (const [key, field] of Object.entries(modelFields)) {
      if (refFieldSet.has(key)) continue
      const base = dateVariant === "fromSelf" && fromSelfFields[key] ? fromSelfFields[key] : field
      const adjusted = applySystemCollisionAdjustments(key, base, "input")
      if (adjusted !== null) acc[key] = adjusted
    }
    for (const ref of resolvedRefs) {
      acc[ref.idFieldName] = ref.identifierSchema
    }
    return acc
  }
  const inputSchema = Schema.Struct(buildInputFieldsAcc("transform") as Schema.Struct.Fields)
  const inputDecodeSchema = Schema.Struct(buildInputFieldsAcc("fromSelf") as Schema.Struct.Fields)

  // --- Create Schema: input fields minus identifier (or PK composites as fallback) ---
  const pkComposites = new Set(primaryKeyComposites(indexes))
  const createOmitFields = identifierField ? new Set([identifierField]) : pkComposites
  const createFieldsAcc: globalThis.Record<string, Schema.Top> = {}
  for (const [key, field] of Object.entries(modelFields)) {
    if (createOmitFields.has(key)) continue // skip identifier/PK composites (auto-generated)
    if (refFieldSet.has(key)) continue // skip ref fields (replaced by ID fields)
    const adjusted = applySystemCollisionAdjustments(key, field, "input")
    if (adjusted !== null) createFieldsAcc[key] = adjusted
  }
  // Add ID fields for each ref (skip if the ref field is an omitted field)
  for (const ref of resolvedRefs) {
    if (createOmitFields.has(ref.fieldName)) continue
    createFieldsAcc[ref.idFieldName] = ref.identifierSchema
  }
  const createSchema = Schema.Struct(createFieldsAcc as Schema.Struct.Fields)

  // --- Update Schema: optional model fields minus key composites & immutable ---
  const buildUpdateFieldsAcc = (
    dateVariant: "transform" | "fromSelf",
  ): globalThis.Record<string, Schema.Top> => {
    const acc: globalThis.Record<string, Schema.Top> = {}
    for (const [key, field] of Object.entries(modelFields)) {
      if (pkComposites.has(key)) continue
      if (immutableFields.has(key)) continue
      if (refFieldSet.has(key)) continue
      if (strippedFromUpdate.has(key)) continue
      const base = dateVariant === "fromSelf" && fromSelfFields[key] ? fromSelfFields[key] : field
      acc[key] = Schema.optional(base)
    }
    for (const ref of resolvedRefs) {
      if (pkComposites.has(ref.fieldName)) continue
      if (immutableFields.has(ref.fieldName)) continue
      acc[ref.idFieldName] = Schema.optional(ref.identifierSchema)
    }
    return acc
  }
  const updateSchema = Schema.Struct(buildUpdateFieldsAcc("transform") as Schema.Struct.Fields)
  const updateDecodeSchema = Schema.Struct(buildUpdateFieldsAcc("fromSelf") as Schema.Struct.Fields)

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

  // --- Time-series derived schemas ---
  // `appendInputSchema`: the user-supplied schema directly. `Entity.make()`
  //    enforces that every PK/SK composite + `orderBy` appears in its fields.
  // `historyRecordSchema`: event-item shape. Model fields (with fromSelf for
  //    date-annotated) + createdAt (when configured, no updatedAt ever since
  //    timeSeries auto-suppresses). No GSI key attrs — events strip GSI keys.
  const timeSeriesEnabled = timeSeries !== undefined && timeSeries !== null
  const appendInputSchema = timeSeriesEnabled ? timeSeries.appendInput : null
  // Events are point-in-time facts keyed by `orderBy`. They do NOT carry
  // `createdAt` or `updatedAt` (§4.5 — events already carry `orderBy` as the
  // temporal anchor). Schema is just model fields with fromSelf for dates.
  const historyRecordSchema = timeSeriesEnabled
    ? (() => {
        const hiddenFilter = (record: globalThis.Record<string, Schema.Top>) =>
          hasHiddenFields
            ? Object.fromEntries(Object.entries(record).filter(([k]) => !hiddenFieldNames.has(k)))
            : record
        return Schema.Struct(
          hiddenFilter({
            ...modelFields,
            ...fromSelfFields,
          }) as Schema.Struct.Fields,
        )
      })()
    : null

  // All schemas are built from concrete field schemas (Schema.String, Schema.Number,
  // Schema.DateTimeUtcFromString, etc.) which all have R = never. TypeScript cannot infer this
  // because the fields are stored in dynamically-typed records, so we cast.
  type S = Schema.Codec<any>
  return {
    modelSchema: modelSchema as unknown as S,
    modelDecodeSchema: modelDecodeVisibleSchema as unknown as S,
    recordSchema: recordVisibleSchema as unknown as S,
    inputSchema: inputSchema as unknown as S,
    inputDecodeSchema: inputDecodeSchema as unknown as S,
    createSchema: createSchema as unknown as S,
    updateSchema: updateSchema as unknown as S,
    updateDecodeSchema: updateDecodeSchema as unknown as S,
    keySchema: keySchema as unknown as S,
    itemSchema: itemSchema as unknown as S,
    deletedRecordSchema: deletedRecordSchema as unknown as S,
    appendInputSchema: appendInputSchema as unknown as S | null,
    historyRecordSchema: historyRecordSchema as unknown as S | null,
  }
}

// ---------------------------------------------------------------------------
// Unique constraint field resolver
// ---------------------------------------------------------------------------

export const resolveUniqueFields = (def: UniqueConstraintDef): ReadonlyArray<string> =>
  Array.isArray(def) ? def : (def as { readonly fields: UniqueFieldsDef }).fields
