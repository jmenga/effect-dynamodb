/**
 * DynamoModel — Schema annotations and date schemas for effect-dynamodb.
 *
 * Provides:
 * - `Immutable` annotation — marks fields as read-only after creation
 * - `Hidden` annotation — marks fields as excluded from default decode (asModel/asRecord)
 * - `DynamoEncoding` annotation — controls how date fields are stored in DynamoDB
 * - Date schemas — wire ↔ domain ↔ storage transformations for DateTime.Utc, DateTime.Zoned, Date
 * - `storedAs` modifier — overrides DynamoDB storage format via annotation
 *
 * See docs/design-dynamo-model.md for the three-layer model (wire → domain → storage).
 */

import { DateTime, Effect, Option, Schema, SchemaAST, SchemaGetter, SchemaIssue } from "effect"

// ---------------------------------------------------------------------------
// Immutable annotation
// ---------------------------------------------------------------------------

/** Unique symbol for the Immutable annotation */
const ImmutableId: unique symbol = Symbol.for("effect-dynamodb/Immutable")

/**
 * Mark a schema field as immutable (read-only after creation).
 *
 * Immutable fields:
 * - Included in Entity.Input (provided on creation)
 * - Included in Entity.Record (readable)
 * - Excluded from Entity.Update (cannot be changed)
 *
 * Key-composite fields are inherently immutable and don't need this annotation.
 */
export const Immutable = <S extends Schema.Top>(schema: S): S =>
  schema.pipe(Schema.annotate({ [ImmutableId]: true })) as S

/**
 * Check if a schema field has the Immutable annotation.
 */
export const isImmutable = (schema: Schema.Top): boolean =>
  ((SchemaAST.resolve(schema.ast) as globalThis.Record<symbol, unknown> | undefined)?.[
    ImmutableId
  ] as boolean) ?? false

// ---------------------------------------------------------------------------
// Identifier annotation
// ---------------------------------------------------------------------------

/** Unique symbol for the Identifier annotation */
const IdentifierId: unique symbol = Symbol.for("effect-dynamodb/Identifier")

/**
 * Mark a schema field as the primary identifier for ref resolution.
 *
 * Entities that can be referenced via `DynamoModel.ref` must annotate exactly
 * one field with `identifier`. The annotated field should be a string or
 * branded string type.
 */
export const identifier = <S extends Schema.Top>(schema: S): S =>
  schema.pipe(Schema.annotate({ [IdentifierId]: true })) as S

/**
 * Check if a schema field has the Identifier annotation.
 */
export const isIdentifier = (schema: Schema.Top): boolean =>
  ((SchemaAST.resolve(schema.ast) as globalThis.Record<symbol, unknown> | undefined)?.[
    IdentifierId
  ] as boolean) ?? false

/**
 * Find the identifier field in a schema with `.fields` (Schema.Class or Schema.Struct).
 * Checks both schema-level `DynamoModel.identifier` annotations and ConfiguredModel
 * `identifier: true` overrides.
 *
 * Returns the field name and schema, or undefined if no field has the identifier annotation.
 */
export const getIdentifierField = (
  model: Schema.Top,
): { readonly name: string; readonly schema: Schema.Top } | undefined => {
  // Check ConfiguredModel attributes first (configure-level overrides take precedence)
  if (isConfiguredModel(model)) {
    const configured = model as ConfiguredModel<Schema.Top>
    for (const [name, attr] of Object.entries(configured.attributes)) {
      if (attr.identifier) {
        const rawModel = configured.model
        if (
          "fields" in rawModel &&
          typeof (rawModel as globalThis.Record<string, unknown>).fields === "object"
        ) {
          const fields = (rawModel as unknown as { fields: globalThis.Record<string, Schema.Top> })
            .fields
          const fieldSchema = fields[name]
          if (fieldSchema) return { name, schema: fieldSchema }
        }
        // Fallback: return with a generic string schema
        return { name, schema: Schema.String as unknown as Schema.Top }
      }
    }
    // Fall through to check schema-level annotations on the inner model
    return getIdentifierField(configured.model)
  }

  if (
    !("fields" in model) ||
    typeof (model as globalThis.Record<string, unknown>).fields !== "object"
  )
    return undefined
  const fields = (model as unknown as { fields: globalThis.Record<string, Schema.Top> }).fields
  for (const [name, fieldSchema] of Object.entries(fields)) {
    if (isIdentifier(fieldSchema)) return { name, schema: fieldSchema }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Ref annotation
// ---------------------------------------------------------------------------

/** Unique symbol for the Ref annotation */
const RefId: unique symbol = Symbol.for("effect-dynamodb/Ref")

/** Annotation metadata stored on ref-annotated fields */
export interface RefAnnotation {
  readonly _tag: "Ref"
  /** Schema.Class identifier of the referenced type (e.g., "Team", "Player") */
  readonly refSchemaId?: string | undefined
}

/**
 * Mark a schema field as a denormalized reference to another entity.
 *
 * Ref fields:
 * - In `Entity.Input`, become ID fields (e.g., `team: Team` → `teamId: string`)
 * - In `Entity.Record`, remain the full entity domain type
 * - In `Entity.Update`, become optional ID fields
 * - In DynamoDB, store the entity's core domain data as an embedded map
 *
 * The referenced entity's model must have exactly one `DynamoModel.identifier`-annotated field.
 */
export const ref = <S extends Schema.Top>(schema: S): S => {
  // Extract Schema.Class identifier if available (e.g., "Team" from Schema.Class<Team>("Team"))
  // In Effect v4, Schema.Class exposes `identifier` (not `_tag`) as the class name
  const s = schema as globalThis.Record<string, unknown>
  const refSchemaId =
    "identifier" in schema && typeof s.identifier === "string"
      ? s.identifier
      : "_tag" in schema && typeof s._tag === "string"
        ? s._tag
        : undefined
  return schema.pipe(
    Schema.annotate({ [RefId]: { _tag: "Ref", refSchemaId } satisfies RefAnnotation }),
  ) as S
}

/**
 * Check if a schema field has the Ref annotation.
 */
export const isRef = (schema: Schema.Top): boolean => {
  const ann = (SchemaAST.resolve(schema.ast) as globalThis.Record<symbol, unknown> | undefined)?.[
    RefId
  ]
  return ann != null && typeof ann === "object" && (ann as RefAnnotation)._tag === "Ref"
}

/**
 * Check if a field is a ref, considering both schema-level annotations and
 * ConfiguredModel overrides. Use this when you have access to the configured model.
 */
export const isRefField = (fieldName: string, model: Schema.Top): boolean => {
  // Check ConfiguredModel attributes
  if (isConfiguredModel(model)) {
    const configured = model as ConfiguredModel<Schema.Top>
    if (configured.attributes[fieldName]?.ref) return true
    // Fall through to check schema-level annotation on the inner model
    return isRefField(fieldName, configured.model)
  }
  // Check schema-level annotation
  if (
    "fields" in model &&
    typeof (model as globalThis.Record<string, unknown>).fields === "object"
  ) {
    const fields = (model as unknown as { fields: globalThis.Record<string, Schema.Top> }).fields
    const fieldSchema = fields[fieldName]
    if (fieldSchema) return isRef(fieldSchema)
  }
  return false
}

/**
 * Get the full Ref annotation metadata from a schema field.
 * Returns undefined if the field is not ref-annotated.
 */
export const getRefAnnotation = (schema: Schema.Top): RefAnnotation | undefined => {
  const ann = (SchemaAST.resolve(schema.ast) as globalThis.Record<symbol, unknown> | undefined)?.[
    RefId
  ]
  if (ann != null && typeof ann === "object" && (ann as RefAnnotation)._tag === "Ref") {
    return ann as RefAnnotation
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Hidden annotation
// ---------------------------------------------------------------------------

/** Unique symbol for the Hidden annotation */
const HiddenId: unique symbol = Symbol.for("effect-dynamodb/Hidden")

/**
 * Mark a schema field as hidden from default decode modes (asModel, asRecord).
 *
 * Hidden fields:
 * - Stored in DynamoDB normally
 * - Visible in asItem and asNative decode modes
 * - Stripped from asModel and asRecord decode modes
 *
 * Use for internal/infrastructure fields that shouldn't leak into application code.
 */
export const Hidden = <S extends Schema.Top>(schema: S): S =>
  schema.pipe(Schema.annotate({ [HiddenId]: true })) as S

/**
 * Check if a schema field has the Hidden annotation.
 */
export const isHidden = (schema: Schema.Top): boolean =>
  ((SchemaAST.resolve(schema.ast) as globalThis.Record<symbol, unknown> | undefined)?.[
    HiddenId
  ] as boolean) ?? false

// ---------------------------------------------------------------------------
// DynamoEncoding annotation
// ---------------------------------------------------------------------------

/** Unique symbol for the DynamoEncoding annotation */
export const DynamoEncodingKey: unique symbol = Symbol.for("effect-dynamodb/DynamoEncoding")

/**
 * Describes how a date field is stored in DynamoDB.
 * - `storage` — the DynamoDB attribute format
 * - `domain` — the domain type (for deserialization dispatch)
 */
export interface DynamoEncoding {
  readonly storage: "string" | "epochMs" | "epochSeconds"
  readonly domain: "DateTime.Utc" | "DateTime.Zoned" | "Date"
}

/**
 * Read the DynamoEncoding annotation from a schema, if present.
 */
export const getEncoding = (schema: Schema.Top): DynamoEncoding | undefined =>
  (SchemaAST.resolve(schema.ast) as globalThis.Record<symbol, unknown> | undefined)?.[
    DynamoEncodingKey
  ] as DynamoEncoding | undefined

// ---------------------------------------------------------------------------
// Date schemas — DateTime.Utc domain
// ---------------------------------------------------------------------------

/**
 * Wire: ISO 8601 string ↔ Domain: DateTime.Utc
 *
 * Default storage: ISO string (`S`).
 * This is a thin wrapper around `Schema.DateTimeUtcFromString` with the DynamoEncoding annotation.
 */
export const DateString = Schema.DateTimeUtcFromString.pipe(
  Schema.annotate({
    [DynamoEncodingKey]: { storage: "string", domain: "DateTime.Utc" } satisfies DynamoEncoding,
  }),
)

/**
 * Wire: epoch milliseconds (number) ↔ Domain: DateTime.Utc
 *
 * Default storage: epoch ms (`N`).
 */
export const DateEpochMs = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.transform((n: number) => DateTime.makeUnsafe(n)),
    encode: SchemaGetter.transform((dt: DateTime.Utc) => DateTime.toEpochMillis(dt)),
  }),
  Schema.annotate({
    [DynamoEncodingKey]: { storage: "epochMs", domain: "DateTime.Utc" } satisfies DynamoEncoding,
  }),
)

/**
 * Wire: epoch seconds (number) ↔ Domain: DateTime.Utc
 *
 * Default storage: epoch seconds (`N`).
 * DynamoDB TTL requires this format.
 */
export const DateEpochSeconds = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.transform((n: number) => DateTime.makeUnsafe(n * 1000)),
    encode: SchemaGetter.transform((dt: DateTime.Utc) =>
      Math.floor(DateTime.toEpochMillis(dt) / 1000),
    ),
  }),
  Schema.annotate({
    [DynamoEncodingKey]: {
      storage: "epochSeconds",
      domain: "DateTime.Utc",
    } satisfies DynamoEncoding,
  }),
)

/**
 * Wire: auto-detect epoch ms or seconds ↔ Domain: DateTime.Utc
 *
 * Uses a minimum threshold to disambiguate: if the value interpreted as ms
 * produces a date before `minimum`, it tries seconds instead.
 *
 * @param options.minimum - Threshold date for disambiguation
 * @param options.encode - Epoch schema for wire encoding (default: DateEpochMs)
 */
export const DateEpoch = (options: {
  readonly minimum: string | DateTime.DateTime.Input
  readonly encode?: typeof DateEpochMs | typeof DateEpochSeconds
}) => {
  const minEpochMs =
    typeof options.minimum === "string"
      ? new Date(options.minimum).getTime()
      : DateTime.toEpochMillis(DateTime.makeUnsafe(options.minimum))
  const encodeSchema = options.encode ?? DateEpochMs
  const encodeEncoding = getEncoding(encodeSchema)

  return Schema.Number.pipe(
    Schema.decodeTo(Schema.DateTimeUtc, {
      decode: SchemaGetter.transformOrFail((n: number) => {
        // Try milliseconds first
        try {
          const asMs = DateTime.makeUnsafe(n)
          if (DateTime.toEpochMillis(asMs) >= minEpochMs) {
            return Effect.succeed(asMs)
          }
        } catch {
          // fall through
        }
        // Fall back to seconds
        try {
          const asSec = DateTime.makeUnsafe(n * 1000)
          if (DateTime.toEpochMillis(asSec) >= minEpochMs) {
            return Effect.succeed(asSec)
          }
        } catch {
          // fall through
        }
        return Effect.fail(new SchemaIssue.InvalidType(Schema.Number.ast, Option.some(n)))
      }),
      encode: SchemaGetter.transform((dt: DateTime.Utc) =>
        Schema.encodeSync(encodeSchema)(dt as any),
      ),
    }),
    Schema.annotate({
      [DynamoEncodingKey]: {
        storage: encodeEncoding?.storage ?? "epochMs",
        domain: "DateTime.Utc",
      } satisfies DynamoEncoding,
    }),
  )
}

// ---------------------------------------------------------------------------
// Date schemas — DateTime.Zoned domain
// ---------------------------------------------------------------------------

/**
 * Wire: ISO 8601 string with offset/zone ↔ Domain: DateTime.Zoned
 *
 * Default storage: extended ISO with zone (`S`).
 * Format: `2024-01-01T15:00:00+09:00[Asia/Tokyo]`
 *
 * Cannot use epoch storage — timezone information would be lost (enforced at type level via storedAs).
 */
export const DateTimeZoned = Schema.String.pipe(
  Schema.decodeTo(Schema.DateTimeZoned, {
    decode: SchemaGetter.transformOrFail((s: string) => {
      // Parse extended ISO format: "2024-01-01T15:00:00+09:00[Asia/Tokyo]"
      const match = s.match(/^(.+)\[(.+)\]$/)
      if (match) {
        const dateStr = match[1]!
        const tzName = match[2]!
        try {
          const utc = DateTime.makeUnsafe(dateStr)
          return Effect.succeed(DateTime.makeZonedUnsafe(utc, { timeZone: tzName }))
        } catch {
          return Effect.fail(new SchemaIssue.InvalidType(Schema.String.ast, Option.some(s)))
        }
      }
      // Try parsing as offset-only: "2024-01-01T15:00:00+09:00"
      try {
        const utc = DateTime.makeUnsafe(s)
        return Effect.succeed(DateTime.makeZonedUnsafe(utc, { timeZone: "UTC" }))
      } catch {
        return Effect.fail(new SchemaIssue.InvalidType(Schema.String.ast, Option.some(s)))
      }
    }),
    encode: SchemaGetter.transform((dt: DateTime.Zoned) => DateTime.formatIsoZoned(dt)),
  }),
  Schema.annotate({
    [DynamoEncodingKey]: { storage: "string", domain: "DateTime.Zoned" } satisfies DynamoEncoding,
  }),
)

// ---------------------------------------------------------------------------
// Unsafe date schemas — native Date domain
// ---------------------------------------------------------------------------

/**
 * Wire: ISO 8601 string ↔ Domain: native Date (mutable)
 *
 * Default storage: ISO string (`S`).
 * For interop with non-Effect code that expects native JS Date objects.
 */
export const UnsafeDateString = Schema.String.pipe(
  Schema.decodeTo(Schema.DateValid, {
    decode: SchemaGetter.transform((s: string) => new Date(s)),
    encode: SchemaGetter.transform((d: Date) => d.toISOString()),
  }),
  Schema.annotate({
    [DynamoEncodingKey]: { storage: "string", domain: "Date" } satisfies DynamoEncoding,
  }),
)

/**
 * Wire: epoch milliseconds (number) ↔ Domain: native Date (mutable)
 *
 * Default storage: epoch ms (`N`).
 */
export const UnsafeDateEpochMs = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateValid, {
    decode: SchemaGetter.transform((ms: number) => new Date(ms)),
    encode: SchemaGetter.transform((d: Date) => d.getTime()),
  }),
  Schema.annotate({
    [DynamoEncodingKey]: { storage: "epochMs", domain: "Date" } satisfies DynamoEncoding,
  }),
)

/**
 * Wire: epoch seconds (number) ↔ Domain: native Date (mutable)
 *
 * Default storage: epoch seconds (`N`).
 */
export const UnsafeDateEpochSeconds = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateValid, {
    decode: SchemaGetter.transform((s: number) => new Date(s * 1000)),
    encode: SchemaGetter.transform((d: Date) => Math.floor(d.getTime() / 1000)),
  }),
  Schema.annotate({
    [DynamoEncodingKey]: {
      storage: "epochSeconds",
      domain: "Date",
    } satisfies DynamoEncoding,
  }),
)

// ---------------------------------------------------------------------------
// TTL alias
// ---------------------------------------------------------------------------

/**
 * Alias for `DateEpochSeconds`. DynamoDB TTL requires epoch seconds.
 * A named alias makes intent clear at the call site.
 */
export const TTL = DateEpochSeconds

// ---------------------------------------------------------------------------
// storedAs modifier
// ---------------------------------------------------------------------------

/**
 * Override the DynamoDB storage format for a date field.
 *
 * `storedAs` reads the DynamoEncoding annotation from the target storage schema
 * and applies its storage format to the field schema. The domain type must match
 * (enforced at the type level via the `A` constraint).
 *
 * @example
 * ```typescript
 * // Wire: ISO string, DynamoDB: epoch seconds (for TTL)
 * DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))
 *
 * // Wire: epoch ms, DynamoDB: ISO string
 * DynamoModel.DateEpochMs.pipe(DynamoModel.storedAs(DynamoModel.DateString))
 * ```
 *
 * Type-safe: incompatible domain types produce a compile error:
 * ```typescript
 * // Type error — DateTime.Zoned ≠ DateTime.Utc
 * DynamoModel.DateTimeZoned.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))
 * ```
 */
export const storedAs = <A>(
  storageSchema: Schema.Schema<A>,
): (<S extends Schema.Schema<A>>(fieldSchema: S) => S) => {
  const storageEncoding = getEncoding(storageSchema as Schema.Top)
  if (!storageEncoding) {
    throw new Error("storedAs: target schema has no DynamoEncoding annotation")
  }
  return <S extends Schema.Schema<A>>(fieldSchema: S): S => {
    const currentEncoding = getEncoding(fieldSchema as Schema.Top)
    return (fieldSchema as Schema.Top).pipe(
      Schema.annotate({
        [DynamoEncodingKey]: {
          storage: storageEncoding.storage,
          domain: currentEncoding?.domain ?? storageEncoding.domain,
        } satisfies DynamoEncoding,
      }),
    ) as unknown as S
  }
}

// ---------------------------------------------------------------------------
// ConfiguredModel
// ---------------------------------------------------------------------------

/** Unique symbol identifying a ConfiguredModel wrapper */
export const ConfiguredModelTag: unique symbol = Symbol.for("effect-dynamodb/ConfiguredModel")

/**
 * A model wrapped with DynamoDB-specific attribute overrides.
 *
 * Carries the original model plus per-field configuration:
 * - `field` — rename domain field → DynamoDB attribute name
 * - `storedAs` — override DynamoDB storage encoding (resolved to DynamoEncoding)
 * - `identifier` — mark field as the identity field for ref resolution
 * - `ref` — mark field as a denormalized reference to another entity
 */
export interface ConfiguredModel<M extends Schema.Top> {
  readonly [ConfiguredModelTag]: true
  readonly model: M
  readonly attributes: globalThis.Record<
    string,
    {
      readonly field?: string
      readonly encoding?: DynamoEncoding
      readonly identifier?: boolean
      readonly ref?: boolean
    }
  >
}

/**
 * Check if a value is a ConfiguredModel.
 */
export const isConfiguredModel = (value: unknown): value is ConfiguredModel<Schema.Top> =>
  typeof value === "object" &&
  value !== null &&
  (value as globalThis.Record<symbol, unknown>)[ConfiguredModelTag] === true

/**
 * Attribute override for a single field in `DynamoModel.configure`.
 *
 * - `field` — Rename the domain field to a different DynamoDB attribute name
 * - `storedAs` — Override DynamoDB storage format via a DynamoModel date schema
 * - `identifier` — Mark as the identity field for ref resolution (replaces model-level DynamoModel.identifier)
 * - `ref` — Mark as a denormalized reference field (replaces model-level DynamoModel.ref)
 */
type AttributeConfig<A> = {
  readonly field?: string
  readonly storedAs?: Schema.Schema<A>
  readonly identifier?: boolean
  readonly ref?: boolean
}

/**
 * Type-safe attribute overrides map: keys constrained to model fields,
 * `storedAs` constrained to matching domain type.
 */
type ConfigureAttributes<M extends Schema.Top> = {
  readonly [K in keyof Schema.Schema.Type<M>]?: AttributeConfig<Schema.Schema.Type<M>[K]>
}

/**
 * Create a configured model with per-field DynamoDB overrides.
 *
 * Separates DynamoDB infrastructure (storage format, field renaming) from
 * the domain model, enabling pure models that work across storage backends.
 *
 * @example
 * ```typescript
 * class Order extends Schema.Class<Order>("Order")({
 *   orderId: Schema.String,
 *   placedAt: Schema.DateTimeUtcFromString,
 *   expiresAt: Schema.DateTimeUtcFromString,
 * }) {}
 *
 * const OrderModel = DynamoModel.configure(Order, {
 *   expiresAt: { field: "ttl", storedAs: DynamoModel.DateEpochSeconds },
 * })
 * ```
 */
export const configure = <M extends Schema.Top>(
  model: M,
  attributes: ConfigureAttributes<M>,
): ConfiguredModel<M> => {
  const resolved: globalThis.Record<
    string,
    {
      readonly field?: string
      readonly encoding?: DynamoEncoding
      readonly identifier?: boolean
      readonly ref?: boolean
    }
  > = {}
  for (const [key, config] of Object.entries(
    attributes as globalThis.Record<string, AttributeConfig<unknown>>,
  )) {
    const entry: {
      field?: string
      encoding?: DynamoEncoding
      identifier?: boolean
      ref?: boolean
    } = {}
    if (config.field) entry.field = config.field
    if (config.identifier) entry.identifier = true
    if (config.ref) entry.ref = true
    if (config.storedAs) {
      const encoding = getEncoding(config.storedAs as Schema.Top)
      if (!encoding) {
        throw new Error(
          `DynamoModel.configure: storedAs schema for "${key}" has no DynamoEncoding annotation`,
        )
      }
      entry.encoding = encoding
    }
    resolved[key] = entry
  }
  return {
    [ConfiguredModelTag]: true as const,
    model,
    attributes: resolved,
  }
}
