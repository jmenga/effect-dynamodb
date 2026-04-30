/**
 * @internal Entity schema building — derived schemas and system field resolution.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import {
  DateTime,
  Effect,
  Option,
  Redacted,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
} from "effect"
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
// Self vs. transform schema detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the schema is a "self" schema — i.e. it carries no
 * encoding transformation. Self schemas have `ast.encoding === undefined`.
 *
 * - `Schema.DateTimeUtc` — self
 * - `Schema.DateTimeUtcFromString` — transform (encodes to string)
 * - `Schema.RedactedFromValue(...)` — transform
 * - any `.pipe(Schema.decodeTo(...))` chain — transform
 */
export const isSelfSchema = (schema: Schema.Top): boolean => schema.ast.encoding === undefined

/**
 * True if the schema is a self DateTime/Date schema that can have its storage
 * configured via a DynamoEncoding annotation. Distinguished from a transform
 * by `ast.encoding === undefined`.
 */
export const isSelfDateSchema = (schema: Schema.Top): boolean => {
  if (!isSelfSchema(schema)) return false
  // The self-schema check is necessary but not sufficient — also confirm the
  // type constructor matches one of the supported date domains.
  return inferDefaultEncoding(schema) !== undefined
}

/**
 * Returns true when the schema is a transform schema with a date typeConstructor
 * (e.g. `Schema.DateTimeUtcFromString`, `DynamoModel.DateEpochSeconds`).
 * Used to enforce the "transform owns the wire format" policy at Entity.make().
 */
export const isDateTransform = (schema: Schema.Top): boolean => {
  if (isSelfSchema(schema)) return false
  return inferDefaultEncoding(schema) !== undefined
}

// ---------------------------------------------------------------------------
// Self-date schema substitution
// ---------------------------------------------------------------------------

/**
 * Convert any input value (string / number / DateTime / Date) to the wire
 * primitive for a given encoding. Used by date substitutes' `encode` path.
 *
 * Wire format precisely matches the legacy `serializeDateForDynamo` output:
 * - `string` storage → ISO 8601 string (UTC for DateTime.Utc / Date; extended
 *   format for DateTime.Zoned)
 * - `epochMs` storage → integer milliseconds since the Unix epoch
 * - `epochSeconds` storage → integer seconds since the Unix epoch (TTL format)
 */
const toWirePrimitive = (value: unknown, encoding: DynamoEncoding): string | number => {
  let epochMs: number
  let zoned: DateTime.Zoned | undefined
  if (DateTime.isDateTime(value)) {
    if (DateTime.isZoned(value)) zoned = value
    epochMs = DateTime.toEpochMillis(value)
  } else if (value instanceof Date) {
    epochMs = value.getTime()
  } else if (typeof value === "string") {
    epochMs = new Date(value).getTime()
  } else if (typeof value === "number") {
    // Numeric inputs are interpreted in the encoding's storage scale already.
    if (encoding.storage === "epochSeconds") epochMs = value * 1000
    else epochMs = value
  } else {
    throw new Error(
      `[effect-dynamodb] toWirePrimitive: unsupported input ${typeof value} for ${encoding.domain}/${encoding.storage}`,
    )
  }
  switch (encoding.storage) {
    case "string":
      if (encoding.domain === "DateTime.Zoned" && zoned) return DateTime.formatIsoZoned(zoned)
      return new Date(epochMs).toISOString()
    case "epochMs":
      return epochMs
    case "epochSeconds":
      return Math.floor(epochMs / 1000)
  }
}

/**
 * Build a bidirectional Schema for a given DynamoEncoding.
 *
 * The encoded side is `Schema.Any` so `decode` tolerates either:
 * - the wire primitive (string / number) — the storage-shape input, OR
 * - a domain value (`DateTime.Utc`, `Date`, etc.) — what users typically pass
 *   into `entity.put({...})` and `.set({...})`.
 *
 * The `decode` direction always lifts to the domain type (DateTime.Utc /
 * DateTime.Zoned / Date). The `encode` direction always produces the wire
 * primitive. This makes both `Schema.encode(substituted)` and
 * `Schema.decode(substituted)` work end-to-end regardless of whether the
 * caller passed wire-form or domain-form.
 *
 * @internal
 */
export const buildDateTransform = (encoding: DynamoEncoding): Schema.Top => {
  const targetSchema = (() => {
    switch (encoding.domain) {
      case "DateTime.Utc":
        return Schema.DateTimeUtc as unknown as Schema.Top
      case "DateTime.Zoned":
        return Schema.DateTimeZoned as unknown as Schema.Top
      case "Date":
        return Schema.DateValid as unknown as Schema.Top
    }
  })()
  const liftToDomain = (value: unknown): unknown => {
    if (DateTime.isDateTime(value)) return value
    if (value instanceof Date) {
      switch (encoding.domain) {
        case "DateTime.Utc":
          return DateTime.makeUnsafe(value)
        case "DateTime.Zoned":
          return DateTime.makeZonedUnsafe(value, { timeZone: "UTC" })
        case "Date":
          return value
      }
    }
    if (typeof value === "string") {
      switch (encoding.domain) {
        case "DateTime.Utc":
          return DateTime.makeUnsafe(value)
        case "DateTime.Zoned": {
          const match = value.match(/^(.+)\[(.+)\]$/)
          if (match) {
            const utc = DateTime.makeUnsafe(match[1]!)
            return DateTime.makeZonedUnsafe(utc, { timeZone: match[2]! })
          }
          const utc = DateTime.makeUnsafe(value)
          return DateTime.makeZonedUnsafe(utc, { timeZone: "UTC" })
        }
        case "Date":
          return new Date(value)
      }
    }
    if (typeof value === "number") {
      const ms = encoding.storage === "epochSeconds" ? value * 1000 : value
      switch (encoding.domain) {
        case "DateTime.Utc":
          return DateTime.makeUnsafe(ms)
        case "DateTime.Zoned":
          return DateTime.makeZonedUnsafe(new Date(ms), { timeZone: "UTC" })
        case "Date":
          return new Date(ms)
      }
    }
    return value
  }
  return Schema.Any.pipe(
    Schema.decodeTo(targetSchema, {
      decode: SchemaGetter.transformOrFail((value: unknown) => {
        try {
          return Effect.succeed(liftToDomain(value))
        } catch {
          return Effect.fail(new SchemaIssue.InvalidType(Schema.Any.ast, Option.some(value)))
        }
      }),
      encode: SchemaGetter.transformOrFail((value: unknown) => {
        try {
          return Effect.succeed(toWirePrimitive(value, encoding))
        } catch {
          return Effect.fail(new SchemaIssue.InvalidType(Schema.Any.ast, Option.some(value)))
        }
      }),
    } as any),
  ) as unknown as Schema.Top
}

/**
 * Detects `Schema.RedactedFromValue(inner)` fields (and `Schema.Redacted`).
 * The encoded form of these schemas is "Forbidden" by Effect v4 design —
 * encoding bails out to prevent accidental leaks. To make the round-trip work
 * for our use case (write to DynamoDB, read back with Redacted on the domain
 * side), we substitute with a custom transform that explicitly extracts the
 * inner value via `Redacted.value` on encode and rewraps via `Redacted.make`
 * on decode.
 *
 * Returns the inner schema (the wire-format schema) when the field is a
 * Redacted-typed schema, otherwise undefined.
 */
const tryGetRedactedInner = (schema: Schema.Top): Schema.Top | undefined => {
  const resolved = SchemaAST.resolve(schema.ast) as
    | { typeConstructor?: { _tag?: string } }
    | undefined
  if (resolved?.typeConstructor?._tag !== "effect/Redacted") return undefined
  // The decoded type is `Redacted<T>` where the inner schema is at
  // `ast.typeParameters[0]`. Walk the AST and rebuild the Schema via
  // `Schema.make` so we get a fully-functional Schema (with `.pipe`).
  const ast = schema.ast as unknown as { typeParameters?: ReadonlyArray<unknown> }
  const params = ast.typeParameters
  if (!params || params.length === 0) return undefined
  const innerAst = params[0] as Schema.Top["ast"]
  return Schema.make<Schema.Top>(innerAst)
}

/**
 * Build a substitute Schema for a `Schema.RedactedFromValue(inner)` field.
 *
 * The substitute round-trips: produces `Redacted<T>` on the domain side and
 * the inner wire primitive on the encoded side. Both directions tolerate
 * either form on input — a user passing a plain inner value is wrapped via
 * `Redacted.make`; a user passing a `Redacted<T>` instance is unwrapped on
 * encode via `Redacted.value`. This permissive shape lets the put/update
 * paths handle the mixed wire/domain payloads users typically construct
 * (e.g. `.put({ secret: Redacted.make(...) })`).
 *
 * The encoded side is `Schema.Any` so decode tolerates either form; the
 * branch logic in `decode`/`encode` then steers the value to the right
 * representation.
 */
const buildRedactedSubstitute = (inner: Schema.Top): Schema.Top => {
  return Schema.Any.pipe(
    Schema.decodeTo(
      Schema.Redacted(inner) as unknown as Schema.Top,
      {
        decode: SchemaGetter.transform((value: unknown) =>
          Redacted.isRedacted(value) ? value : Redacted.make(value),
        ),
        encode: SchemaGetter.transform((r: unknown) =>
          Redacted.isRedacted(r) ? Redacted.value(r as Redacted.Redacted<unknown>) : r,
        ),
      } as any,
    ),
  ) as unknown as Schema.Top
}

/**
 * Substitute model fields with bidirectional transforms where needed:
 *
 *  - Self date schemas with an effective encoding (annotation or override)
 *    → tolerant date transform that accepts either wire form (string/number)
 *    or domain form (DateTime / Date) on decode, and always produces the
 *    configured wire primitive on encode.
 *  - `Schema.RedactedFromValue(inner)` fields → tolerant Redacted transform
 *    that accepts either form on decode and unwraps to wire primitive on
 *    encode (Effect v4's `RedactedFromValue` forbids encoding by default;
 *    our substitution makes the round-trip work for storage).
 *
 * Existing transform schemas (other than `RedactedFromValue`) are passed
 * through unchanged — the user-declared transform IS the wire format.
 *
 * Schema.Class fields (and Schema.Class fields nested inside Schema.Array,
 * Schema.optional, etc.) are NOT substituted here. Instead, callers run
 * `decode → encode` against the substituted schema: `Schema.decode` is
 * forgiving for Schema.Class (lifts plain objects to instances), and the
 * tolerant date / Redacted substitutes make the decode pass accept both
 * wire and domain values. The subsequent `Schema.encode` produces the
 * canonical wire shape.
 *
 * @internal
 */
export const substituteSchemas = (
  modelFields: SchemaFields,
  fieldEncodings: globalThis.Record<string, DynamoEncoding>,
): SchemaFields => {
  const out: SchemaFields = {}
  for (const [name, schema] of Object.entries(modelFields)) {
    // 1. Self-date substitution. Pattern A: user declared `Schema.DateTimeUtc`
    //    and chose a wire format via annotation. We substitute with the
    //    tolerant date transform so the encode pipeline produces the right
    //    wire primitive.
    if (isSelfDateSchema(schema)) {
      const enc = fieldEncodings[name]
      if (enc) {
        out[name] = buildDateTransform(enc)
        continue
      }
    }
    // 2. RedactedFromValue substitution. Effect v4's `RedactedFromValue`
    //    forbids encoding by design; substitute with a tolerant Redacted
    //    transform so the round-trip works for storage.
    const redactedInner = tryGetRedactedInner(schema)
    if (redactedInner !== undefined) {
      out[name] = buildRedactedSubstitute(redactedInner)
      continue
    }
    // Default: pass through unchanged. Pattern B transforms (DynamoModel.*,
    // Schema.DateTimeUtcFromString, Schema.NumberFromString, …) own their
    // wire format directly — `Schema.encode` handles the conversion.
    out[name] = schema
  }
  return out
}

/**
 * Validate that no model field combines a transform schema with a storage
 * override. The two configuration paths are mutually exclusive: either declare
 * a self schema (`Schema.DateTimeUtc`) and let the annotation drive storage,
 * OR declare a transform and own the wire format yourself — not both.
 *
 * Two override sources are checked:
 *
 *  1. `ConfiguredModel.storedAs` (configured attributes) — surfaces the
 *     override via `configuredAttributes[name].encoding`.
 *
 *  2. `DynamoModel.storedAs(...)` modifier piped onto the field schema —
 *     adds a `DynamoEncoding` annotation directly to the AST. We detect this
 *     by checking whether the field-level annotation disagrees with the
 *     transform's actual wire format (the `inferDefaultEncoding` of the
 *     transform). For an unmodified transform (e.g. `DynamoModel.DateString`
 *     with a matching ISO-string annotation), the two agree and the field is
 *     accepted.
 *
 * Throws at `Entity.make()` time if the conflict is detected.
 *
 * @internal
 */
export const validateNoTransformOverride = (
  modelFields: SchemaFields,
  configuredAttributes: ConfiguredAttributeEncodings,
): void => {
  const conflictMessage = (name: string) =>
    `[effect-dynamodb] Field "${name}": cannot apply DynamoEncoding storage override to a transform schema. ` +
    `Either declare a self schema (Schema.DateTimeUtc) and let the annotation drive storage, OR declare a transform and own the wire format — not both.`

  for (const [name, schema] of Object.entries(modelFields)) {
    if (!isDateTransform(schema)) continue

    // 1. ConfiguredModel.storedAs override?
    const configOverride = configuredAttributes[name]?.encoding
    if (configOverride !== undefined) {
      throw new Error(conflictMessage(name))
    }

    // 2. DynamoModel.storedAs() modifier on the schema itself? The modifier
    //    applies a `DynamoEncoding` annotation to the AST. Detect a conflict
    //    by comparing the annotation's storage with the transform's actual
    //    wire format (read from `ast.encoding[last].to._tag`). Granularity:
    //    we can distinguish "string" vs "number" wire forms; we cannot
    //    distinguish epochMs vs epochSeconds at this layer. The string-vs-
    //    number mismatch covers the most common breaking case.
    const annotated = getEncoding(schema)
    if (annotated === undefined) continue
    const transformWire = transformWireKind(schema)
    if (transformWire === undefined) continue
    const annotatedKind = annotated.storage === "string" ? "string" : "number"
    if (transformWire !== annotatedKind) {
      throw new Error(conflictMessage(name))
    }
  }
}

/**
 * Read the wire form ("string" or "number") that a transform schema actually
 * encodes to, by walking the encoding chain. Returns undefined when the chain
 * is missing or the leaf isn't a String / Number node.
 */
const transformWireKind = (schema: Schema.Top): "string" | "number" | undefined => {
  const enc = (schema.ast as { encoding?: ReadonlyArray<{ to: { _tag: string } }> }).encoding
  if (!enc || enc.length === 0) return undefined
  const leaf = enc[enc.length - 1]
  if (!leaf) return undefined
  const tag = leaf.to._tag
  if (tag === "String") return "string"
  if (tag === "Number") return "number"
  return undefined
}

// ---------------------------------------------------------------------------
// Build derived schemas at make() time
// ---------------------------------------------------------------------------

export interface DerivedSchemas {
  /** Pure model fields schema (substituted — used for both validation and decode) */
  readonly modelSchema: Schema.Codec<any>
  /** Model + system fields schema */
  readonly recordSchema: Schema.Codec<any>
  /**
   * Typed input schema — the public payload type users see. Ref-aware (ref
   * fields swapped for ID fields). System-colliding `createdAt`/`updatedAt`
   * are marked optional; `version` (if colliding) is stripped.
   *
   * Used both as the public type and as the runtime encode/decode schema.
   */
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
  fieldEncodings: globalThis.Record<string, DynamoEncoding> = {},
): DerivedSchemas => {
  // --- Substitute model fields ---
  // Self date schemas (with effective encoding) are replaced with bidirectional
  // transforms that produce the configured wire primitive. RedactedFromValue
  // fields are replaced with a custom bidirectional transform so encoding
  // round-trips. All other transform schemas are passed through — the user's
  // transform IS the wire format and we never override it.
  const fields = substituteSchemas(modelFields, fieldEncodings)

  // --- Model Schema: pure model fields (for input decode/encode) ---
  const modelSchema = Schema.Struct(fields)

  // --- Record Schema: model + system fields ---
  // System timestamp fields use Schema.DateTimeUtcFromString as the canonical
  // wire ↔ domain transform when they're library-managed. When the field
  // collides with a model-declared field, the model's substituted schema is
  // already in `fields` and we don't add a system-schema entry.
  const systemSchemaFields: globalThis.Record<string, Schema.Top> = {}
  if (systemFields.createdAt && !systemFields.createdAtCollision) {
    systemSchemaFields[systemFields.createdAt] = systemFields.createdAtEncoding
      ? buildDateTransform(systemFields.createdAtEncoding)
      : Schema.DateTimeUtcFromString
  }
  if (systemFields.updatedAt && !systemFields.updatedAtCollision) {
    systemSchemaFields[systemFields.updatedAt] = systemFields.updatedAtEncoding
      ? buildDateTransform(systemFields.updatedAtEncoding)
      : Schema.DateTimeUtcFromString
  }
  if (systemFields.version && !systemFields.versionCollision) {
    systemSchemaFields[systemFields.version] = Schema.Number
  }
  const recordSchema = Schema.Struct({
    ...fields,
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
  const buildInputFieldsAcc = (): globalThis.Record<string, Schema.Top> => {
    const acc: globalThis.Record<string, Schema.Top> = {}
    for (const [key, field] of Object.entries(fields)) {
      if (refFieldSet.has(key)) continue
      const adjusted = applySystemCollisionAdjustments(key, field, "input")
      if (adjusted !== null) acc[key] = adjusted
    }
    for (const ref of resolvedRefs) {
      acc[ref.idFieldName] = ref.identifierSchema
    }
    return acc
  }
  const inputSchema = Schema.Struct(buildInputFieldsAcc() as Schema.Struct.Fields)

  // --- Create Schema: input fields minus identifier (or PK composites as fallback) ---
  const pkComposites = new Set(primaryKeyComposites(indexes))
  const createOmitFields = identifierField ? new Set([identifierField]) : pkComposites
  const createFieldsAcc: globalThis.Record<string, Schema.Top> = {}
  for (const [key, field] of Object.entries(fields)) {
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
  // Each field wraps `Schema.NullishOr` so consumers can pass `null` or
  // `undefined` as an explicit clear signal — under indexPolicy v2, both
  // collapse to "clear this composite from the key now" (DESIGN.md §7).
  // The outer `Schema.optional` lets the key be omitted entirely (defers
  // to policy on omission).
  const buildUpdateFieldsAcc = (): globalThis.Record<string, Schema.Top> => {
    const acc: globalThis.Record<string, Schema.Top> = {}
    for (const [key, field] of Object.entries(fields)) {
      if (pkComposites.has(key)) continue
      if (immutableFields.has(key)) continue
      if (refFieldSet.has(key)) continue
      if (strippedFromUpdate.has(key)) continue
      acc[key] = Schema.optional(Schema.NullishOr(field as Schema.Top))
    }
    for (const ref of resolvedRefs) {
      if (pkComposites.has(ref.fieldName)) continue
      if (immutableFields.has(ref.fieldName)) continue
      acc[ref.idFieldName] = Schema.optional(Schema.NullishOr(ref.identifierSchema as Schema.Top))
    }
    return acc
  }
  const updateSchema = Schema.Struct(buildUpdateFieldsAcc() as Schema.Struct.Fields)

  // --- Key Schema: primary key composite attributes only ---
  const keyCompositeNames = primaryKeyComposites(indexes)
  const keyFields: globalThis.Record<string, Schema.Top> = {}
  for (const name of keyCompositeNames) {
    const field = fields[name]
    if (field) keyFields[name] = field
  }
  const keySchema = Schema.Struct(keyFields)

  // --- Item Schema: record + key attrs (pk, sk, gsi*) + __edd_e__ ---
  // Primary pk/sk are guaranteed present on every live item. GSI key fields
  // are sparse: they're written only when every source composite resolves, and
  // dropped when any composite is missing or indexPolicy evicts the index.
  // Stream NewImage / raw query results therefore routinely lack GSI keys —
  // mark them optional so decodeMarshalledItem decodes sparse items cleanly.
  const primaryKeyFieldNames = new Set<string>()
  const primary = indexes.primary
  if (primary) {
    primaryKeyFieldNames.add(primary.pk.field)
    primaryKeyFieldNames.add(primary.sk.field)
  }
  const keyAttrFields: globalThis.Record<string, Schema.Top> = {}
  for (const fieldName of allKeyFieldNames(indexes)) {
    keyAttrFields[fieldName] = primaryKeyFieldNames.has(fieldName)
      ? Schema.String
      : Schema.optional(Schema.String)
  }
  const itemSchema = Schema.Struct({
    ...fields,
    ...systemSchemaFields,
    ...keyAttrFields,
    __edd_e__: Schema.String,
  })

  // --- Deleted Record Schema: record + deletedAt ---
  const deletedRecordSchema = Schema.Struct({
    ...fields,
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

  const modelVisibleSchema = hasHiddenFields
    ? Schema.Struct(
        Object.fromEntries(Object.entries(fields).filter(([k]) => !hiddenFieldNames.has(k))),
      )
    : modelSchema

  const recordVisibleSchema = hasHiddenFields
    ? Schema.Struct(
        Object.fromEntries(
          Object.entries({
            ...fields,
            ...systemSchemaFields,
          }).filter(([k]) => !hiddenFieldNames.has(k)),
        ),
      )
    : recordSchema

  // --- Time-series derived schemas ---
  // `appendInputSchema`: the user-supplied schema, with the same substitution
  //    rules applied as the model fields (self date schemas → tolerant
  //    transforms, RedactedFromValue → tolerant Redacted). `Entity.make()`
  //    enforces that every PK/SK composite + `orderBy` appears in its fields.
  // `historyRecordSchema`: event-item shape. Substituted model fields + no
  //    system fields (events are point-in-time facts keyed by `orderBy`).
  const timeSeriesEnabled = timeSeries !== undefined && timeSeries !== null
  const appendInputSchema = timeSeriesEnabled
    ? (() => {
        const userSchema = timeSeries.appendInput as Schema.Top
        const userFields = (userSchema as unknown as { fields?: SchemaFields }).fields
        if (!userFields) return userSchema
        // Compute encodings for the appendInput fields (annotation +
        // inferred from typeConstructor for self schemas).
        const appendEncodings = buildFieldEncodings(userFields, {})
        const subbedFields = substituteSchemas(userFields, appendEncodings)
        return Schema.Struct(subbedFields as Schema.Struct.Fields) as unknown as Schema.Top
      })()
    : null
  const historyRecordSchema = timeSeriesEnabled
    ? (() => {
        const hiddenFilter = (record: globalThis.Record<string, Schema.Top>) =>
          hasHiddenFields
            ? Object.fromEntries(Object.entries(record).filter(([k]) => !hiddenFieldNames.has(k)))
            : record
        return Schema.Struct(hiddenFilter({ ...fields }) as Schema.Struct.Fields)
      })()
    : null

  // All schemas are built from concrete field schemas (Schema.String, Schema.Number,
  // Schema.DateTimeUtcFromString, etc.) which all have R = never. TypeScript cannot infer this
  // because the fields are stored in dynamically-typed records, so we cast.
  type S = Schema.Codec<any>
  return {
    modelSchema: modelVisibleSchema as unknown as S,
    recordSchema: recordVisibleSchema as unknown as S,
    inputSchema: inputSchema as unknown as S,
    createSchema: createSchema as unknown as S,
    updateSchema: updateSchema as unknown as S,
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
