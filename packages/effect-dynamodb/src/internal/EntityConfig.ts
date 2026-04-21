/**
 * @internal Entity configuration types — system field and constraint config.
 *
 * Extracted from Entity.ts for decomposition. Not part of the public API.
 */

import type { Duration, Schema } from "effect"

// ---------------------------------------------------------------------------
// System field configuration types
// ---------------------------------------------------------------------------

/**
 * Per-timestamp field configuration.
 *
 * - `string` — override field name only (default DateString schema)
 * - `Schema.Top` — override schema only (default field name)
 * - `{ field?, schema? }` — override both field name and schema
 */
export type TimestampFieldConfig =
  | string
  | Schema.Top
  | { readonly field?: string | undefined; readonly schema?: Schema.Top | undefined }

/**
 * Timestamp configuration for automatic `createdAt` / `updatedAt` fields.
 *
 * - `true` — add `createdAt` and `updatedAt` with default names and ISO string storage
 * - `{ created?, updated? }` — per-field configuration (string, schema, or object)
 * - `false` / `undefined` — no timestamps
 */
export type TimestampsConfig =
  | boolean
  | {
      readonly created?: TimestampFieldConfig | undefined
      readonly updated?: TimestampFieldConfig | undefined
    }

/**
 * Optimistic locking configuration via an auto-incrementing version field.
 *
 * - `true` — add a `version` field with default name
 * - `{ field?, retain?, ttl? }` — override field name and retention behavior
 * - `false` / `undefined` — no versioning
 */
export type VersionedConfig =
  | boolean
  | {
      readonly field?: string | undefined
      readonly retain?: boolean | undefined
      readonly ttl?: Duration.Duration | undefined
    }

/**
 * Soft-delete configuration. When enabled, deletes mark items rather than removing them.
 *
 * - `true` — enable soft delete with defaults
 * - `{ ttl?, preserveUnique? }` — configure TTL cleanup and unique constraint behavior
 * - `false` / `undefined` — hard deletes
 */
export type SoftDeleteConfig =
  | boolean
  | {
      readonly ttl?: Duration.Duration | undefined
      readonly preserveUnique?: boolean | undefined
    }

/**
 * Time-series configuration. When set, the entity stores one "current" item
 * per partition and many immutable "event" items. See guides/timeseries.mdx.
 *
 * Current-item SK matches the primary index SK. Event-item SK is
 * `<currentSk>#e#<orderBy-value>`, GSI keys stripped, `_ttl` set.
 *
 * `.append(input)` is a `TransactWriteItems` (UpdateItem current + Put event)
 * with CAS `attribute_not_exists(pk) OR #orderBy < :newOb`. Returns
 * `{ applied: true | false, current }` — stale is a value, not an error.
 *
 * Mutually exclusive with `versioned` (EDD-9012) and `softDelete` (EDD-9015).
 */
export type TimeSeriesConfig<TAppendInput extends Schema.Top = Schema.Top> = {
  /** Model attribute used as the monotonic clock for CAS and event SK decoration. Required. */
  readonly orderBy: string
  /** TTL applied to event items (not current). Omit for retention-forever. */
  readonly ttl?: Duration.Duration | undefined
  /**
   * REQUIRED schema restricting which model fields are allowed in `.append()`
   * input AND which fields are written into the current-item SET clause.
   * The schema MUST include `orderBy` plus all PK/SK composite fields.
   *
   * Fields in the model but NOT in this schema are never referenced by
   * `.append()`'s UpdateExpression and therefore cannot be overwritten — this
   * is the enrichment-preservation contract.
   *
   * Omitting `appendInput` is a hard error at `make()` time (EDD-9016).
   * Users who genuinely want every append to overwrite every model field
   * must pass the full model schema explicitly.
   */
  readonly appendInput: TAppendInput
}

/** An array of model field names that together form a unique constraint. */
export type UniqueFieldsDef = ReadonlyArray<string>

/**
 * A unique constraint definition — either a simple field list or an object
 * with additional options like TTL for sentinel items.
 */
export type UniqueConstraintDef =
  | UniqueFieldsDef
  | { readonly fields: UniqueFieldsDef; readonly ttl?: Duration.Duration | undefined }

/**
 * Map of named unique constraints. Each key is the constraint name,
 * each value defines which fields must be globally unique together.
 *
 * Enforced via DynamoDB transaction sentinel items.
 */
export type UniqueConfig = globalThis.Record<string, UniqueConstraintDef>

/**
 * Per-ref cascade index configuration. Tells Entity.make() which physical GSI
 * to use for auto-generated cascade indexes.
 *
 * The library fills in the PK/SK composites automatically from the resolved ref
 * and primary key — the consumer only specifies physical GSI details.
 */
export interface CascadeIndexConfig {
  /** Physical GSI name (e.g., "gsi3") */
  readonly index: string
  /** PK field descriptor */
  readonly pk: { readonly field: string }
  /** SK field descriptor */
  readonly sk: { readonly field: string }
}

/**
 * A ref value in the `refs` config — an object with the entity and optional cascade index config.
 *
 * Simple:    `refs: { player: { entity: Players } }`
 * Cascade:   `refs: { player: { entity: Players, cascade: { index: "gsi3", pk: { field: "gsi3pk" }, sk: { field: "gsi3sk" } } } }`
 */
export interface RefValue {
  readonly entity: { readonly _tag: "Entity" }
  readonly cascade?: CascadeIndexConfig
}
