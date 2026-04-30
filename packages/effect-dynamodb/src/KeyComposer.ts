/**
 * KeyComposer — Composite key composition for DynamoDB keys.
 *
 * v2 uses attribute-list composition (composite: ["userId"]) instead of
 * template strings ("USER#${userId}"). The DynamoSchema module handles
 * the key format; KeyComposer extracts attribute values and delegates.
 */

import { DateTime } from "effect"
import type * as DynamoSchema from "./DynamoSchema.js"
import {
  applyCasing,
  composeClusteredSortKey,
  composeCollectionKey,
  composeIsolatedSortKey,
  composeKey,
} from "./DynamoSchema.js"
import { type CompositeKeyHoleError, makeCompositeKeyHoleError } from "./Errors.js"

/** Index key part definition (pk or sk of an index) */
export interface KeyPart {
  readonly field: string
  readonly composite: ReadonlyArray<string>
}

/**
 * Per-composite policy value controlling how `Entity.update` and time-series
 * `.append` handle a composite attribute that is absent from the merged update
 * payload.
 *
 * - `"sparse"` — absent → REMOVE `gsiNpk`/`gsiNsk`; item drops out of the GSI.
 * - `"preserve"` — absent → leave the stored GSI key field untouched.
 *
 * Attributes not covered by an `indexPolicy` default to `"preserve"`. See
 * `DESIGN.md §7 Policy-Aware GSI Composition` for full decision rules.
 */
export type IndexPolicyAttr = "sparse" | "preserve"

/**
 * Function form of an index policy. Receives the merged record
 * (`primaryKey + payload` at update time, `primaryKey + appendInput` at append
 * time) and returns a per-attribute policy map. Only keys corresponding to
 * composite attributes of this GSI are consulted; additional keys are ignored.
 */
export type IndexPolicy = (
  item: Readonly<Record<string, unknown>>,
) => Partial<Record<string, IndexPolicyAttr>>

/** Index definition for primary or secondary index (internal format) */
export interface IndexDefinition {
  readonly index?: string | undefined // Physical GSI name (omit for primary)
  readonly collection?: string | ReadonlyArray<string> | undefined
  readonly type?: "isolated" | "clustered" | undefined // Default: "isolated"
  readonly pk: KeyPart
  readonly sk: KeyPart
  readonly casing?: DynamoSchema.Casing | undefined
  /**
   * Optional per-composite policy for `Entity.update` and `.append`. Not
   * consulted on `put()` — put always omits a GSI's keys when any of its
   * composites is missing.
   */
  readonly indexPolicy?: IndexPolicy | undefined
}

/** GSI definition as specified on Entity.make() indexes config.
 * Mirrors the primaryKey structure with an added `name` for the physical GSI. */
export interface GsiConfig {
  /** Physical GSI name (e.g., `"gsi1"`). */
  readonly name: string
  /** Optional collection name. String for single, array for sub-collections. */
  readonly collection?: string | ReadonlyArray<string> | undefined
  /** SK ordering mode. `"isolated"` (default) puts entity type before composites; `"clustered"` puts entity type after composites (required for sub-collections). */
  readonly type?: "isolated" | "clustered" | undefined
  /** Partition key: physical field name + composite attributes. */
  readonly pk: KeyPart
  /** Sort key: physical field name + composite attributes. */
  readonly sk: KeyPart
  /**
   * Per-composite sparse/preserve policy. Applied by `Entity.update` and
   * time-series `.append`. Defaults to `"preserve"` for any composite the
   * function does not specify. Not applied on `put()`.
   *
   * At append-time, returned keys must be members of the `appendInput`
   * schema (enforced at `Entity.make()`) — composites owned by other writers
   * cannot have policy at append-time, since `.append` cannot touch them.
   */
  readonly indexPolicy?: IndexPolicy | undefined
}

/** Normalize a GsiConfig (entity input) to an IndexDefinition (internal format). */
export const normalizeGsiConfig = (config: GsiConfig): IndexDefinition => {
  // Detect old format and give helpful migration error
  if ("index" in config && typeof (config as Record<string, unknown>).index === "object") {
    throw new Error(
      `[EDD-9003] GsiConfig uses old format with "index" property. ` +
        `Migrate to: { name: "gsi1", pk: { field: "gsi1pk", composite: [...] }, sk: { field: "gsi1sk", composite: [...] } }`,
    )
  }
  if (!config.name || !config.pk || !config.sk) {
    throw new Error(
      `[EDD-9003] Invalid GsiConfig: requires name, pk: { field, composite }, sk: { field, composite }`,
    )
  }
  return {
    index: config.name,
    collection: config.collection,
    type: config.type ?? "isolated",
    pk: { field: config.pk.field, composite: [...config.pk.composite] },
    sk: { field: config.sk.field, composite: [...config.sk.composite] },
    indexPolicy: config.indexPolicy,
  }
}

/**
 * Extract composite attribute values from an entity record.
 *
 * Given composite: ["tenantId", "email"] and record: { tenantId: "t-1", email: "a@b.com" }
 * Returns: ["t-1", "a@b.com"]
 */
export const extractComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> =>
  composite.map((attr) => {
    const value = record[attr]
    if (value === undefined || value === null) {
      throw new Error(`Missing composite attribute "${attr}" in record`)
    }
    return serializeValue(value)
  })

/**
 * Non-throwing variant of extractComposites. Returns undefined when any
 * composite attribute is missing or null. Used for sparse GSI support —
 * if a GSI's composites aren't all present, the index is simply skipped.
 */
export const tryExtractComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
): ReadonlyArray<string> | undefined => {
  const values: Array<string> = []
  for (const attr of composite) {
    const value = record[attr]
    if (value === undefined || value === null) return undefined
    values.push(serializeValue(value))
  }
  return values
}

/**
 * Serialize a value for use in a composite key.
 *
 * Numeric values are zero-padded for correct lexicographic sort order:
 * - number → 16-digit zero-padded string (covers Number.MAX_SAFE_INTEGER)
 * - bigint → 38-digit zero-padded string (covers DynamoDB's max precision)
 *
 * DateTime values are formatted as ISO strings for correct sort order:
 * - DateTime.Zoned → ISO string with offset (preserves timezone info)
 * - DateTime.Utc → ISO string
 * - Date → ISO string
 */
export const serializeValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value).padStart(16, "0")
  if (typeof value === "bigint") return String(value).padStart(38, "0")
  if (typeof value === "boolean") return value ? "true" : "false"
  // DateTime types → ISO string (Zoned normalized to UTC for sort order)
  if (typeof value === "object" && value !== null && DateTime.isDateTime(value)) {
    return DateTime.formatIso(value)
  }
  // Native Date
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/**
 * Compose a partition key for an entity index.
 *
 * For non-collection indexes: `$schema#v<version>#entityType#attr1#attr2`
 * For collection indexes: `$schema#v<version>#collectionName#attr1#attr2`
 */
export const composePk = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.pk.composite, record)
  const names = [...index.pk.composite]
  const collection = index.collection

  if (collection !== undefined) {
    // Collection index — PK uses collection name
    const collectionName = Array.isArray(collection) ? collection[0]! : collection
    return composeCollectionKey(schema, collectionName, composites, { casing: index.casing, names })
  }

  // Regular entity index — PK uses entity type
  return composeKey(schema, entityType, composites, { casing: index.casing, names })
}

/**
 * Compose a sort key for an entity index.
 *
 * For isolated indexes: `$schema#v<version>#entityType_version#attr1#attr2`
 * For clustered indexes: `$schema#v<version>#collectionName#entityType_version#attr1#attr2`
 * For non-collection indexes: `$schema#v<version>#entityType#attr1#attr2`
 */
export const composeSk = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.sk.composite, record)
  const names = [...index.sk.composite]
  const collection = index.collection
  const collectionType = index.type ?? "isolated"

  if (collection !== undefined) {
    if (collectionType === "clustered") {
      // For sub-collections (collection: ["parent", "child"]) the FULL hierarchy
      // is written into the SK so a begins_with query at any level matches.
      return composeClusteredSortKey(schema, collection, entityType, entityVersion, composites, {
        casing: index.casing,
        names,
      })
    }
    // Isolated
    return composeIsolatedSortKey(schema, entityType, entityVersion, composites, {
      casing: index.casing,
      names,
    })
  }

  // Non-collection — simple entity key
  return composeKey(schema, entityType, composites, { casing: index.casing, names })
}

/**
 * Compose all key attributes for a single index.
 * Returns a record mapping field names to composed key values.
 */
export const composeIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> => ({
  [index.pk.field]: composePk(schema, entityType, index, record),
  [index.sk.field]: composeSk(schema, entityType, entityVersion, index, record),
})

/**
 * Non-throwing variant of composeIndexKeys. Returns undefined if any composite
 * attribute is missing. Used for sparse GSI support.
 */
export const tryComposeIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, string> | undefined => {
  if (tryExtractComposites(index.pk.composite, record) === undefined) return undefined
  if (tryExtractComposites(index.sk.composite, record) === undefined) return undefined
  return composeIndexKeys(schema, entityType, entityVersion, index, record)
}

/**
 * Compose keys for all indexes of an entity.
 * Returns a flat record of all key field -> value mappings.
 */
export const composeAllKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexes: Record<string, IndexDefinition>,
  record: Record<string, unknown>,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [indexName, index] of Object.entries(indexes)) {
    if (indexName === "primary") {
      // Primary index always required — throws on missing composites
      Object.assign(result, composeIndexKeys(schema, entityType, entityVersion, index, record))
    } else {
      // GSI — sparse-aware: skip if any composite is missing
      const keys = tryComposeIndexKeys(schema, entityType, entityVersion, index, record)
      if (keys !== undefined) Object.assign(result, keys)
    }
  }
  return result
}

/**
 * Result of policy-aware GSI update composition.
 *
 * - `sets`: map of GSI key field name → composed value (emit as SET clauses).
 * - `removes`: list of GSI key field names to REMOVE (item drops out of GSI).
 *
 * `sets` and `removes` are mutually exclusive — a single field never appears
 * in both for the same update.
 */
export interface GsiUpdateResult {
  readonly sets: Record<string, string>
  readonly removes: ReadonlyArray<string>
}

/**
 * Compose a sort key from the leading prefix `[sk_0, ..., sk_(stopBefore-1)]`
 * of an index's SK composites. Used by hierarchical SK pruning when a
 * trailing SK composite is explicitly cleared with `preserve` policy — the
 * resulting `gsiNsk` keeps the parent context and the item stays queryable
 * at the coarser depth.
 *
 * `stopBefore === 0` produces the bare entity/collection prefix with no
 * composite values (the item still belongs to the GSI but at the broadest
 * scope — `begins_with(sk, "<prefix>")` matches it).
 *
 * See `DESIGN.md §7.6 Hierarchical SK Pruning`.
 */
export const composeSkPrefixUpTo = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
  stopBefore: number,
): string => {
  const slice = index.sk.composite.slice(0, stopBefore)
  const composites = extractComposites(slice, record)
  const collection = index.collection
  const collectionType = index.type ?? "isolated"

  if (collection !== undefined) {
    if (collectionType === "clustered") {
      return composeClusteredSortKey(schema, collection, entityType, entityVersion, composites, {
        casing: index.casing,
        names: [...slice],
      })
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, composites, {
      casing: index.casing,
      names: [...slice],
    })
  }

  return composeKey(schema, entityType, composites, {
    casing: index.casing,
    names: [...slice],
  })
}

/**
 * Policy-aware GSI key composition for `Entity.update` and time-series
 * `.append`.
 *
 * Implements the v2 unified-hierarchy three-way payload classification:
 * - **present** (`attr: <value>` in payload, or inherited from `keyRecord`)
 *   — value is used in composition.
 * - **explicit clear** (`attr: null` or `attr: undefined` in payload) —
 *   `null` and `undefined` collapse and cascade unconditionally; policy is
 *   bypassed for explicit clears.
 * - **omitted** (key not in payload at all) — `indexPolicy` is consulted.
 *   Default policy is `"preserve"` for any composite not declared.
 *
 * Per-attribute outcomes (per touched GSI):
 *
 * | State         | PK composite              | SK composite                                 |
 * | ------------- | ------------------------- | -------------------------------------------- |
 * | omitted+sparse| Drop the GSI              | Drop the GSI                                 |
 * | omitted+preserve | No-op for that half     | No-op for that half                          |
 * | clear+sparse  | Drop the GSI              | Drop the GSI                                 |
 * | clear+preserve| Drop the GSI (degrades to sparse on PK — partition migration is almost always wrong) | **Truncate `gsiNsk`** at this composite (hierarchical pruning) |
 *
 * Cascade (`Entity.remove([attr])`) overrides everything: any composite in
 * `removedSet` forces a full GSI drop.
 *
 * **Hole detection.** Throws `CompositeKeyHoleError` (EDD-9024) when an SK
 * composite at position `i` is cleared (with preserve) while a composite at
 * position `j > i` is still present in the merged payload — composed keys
 * cannot carry holes.
 *
 * A GSI is considered "touched" when any of its composites appears in
 * `updatePayload` (present, explicit clear, or omitted-with-`indexPolicy`),
 * or `removedSet`. GSIs without an `indexPolicy` are skipped when none of
 * their composites are touched. GSIs with a policy are always evaluated —
 * the policy is a declarative statement about the GSI's membership.
 *
 * See `DESIGN.md §7 Policy-Aware GSI Composition` for the full decision
 * algorithm and worked decision table, and `§7.6 Hierarchical SK Pruning`
 * for the trailing-clear truncation contract.
 *
 * @throws {CompositeKeyHoleError} EDD-9024 on hole-pattern detection.
 */
export const composeGsiKeysForUpdatePolicyAware = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  indexes: Record<string, IndexDefinition>,
  updatePayload: Record<string, unknown>,
  keyRecord: Record<string, unknown>,
  options?: {
    readonly removedSet?: ReadonlySet<string> | undefined
    /**
     * Attributes that appear in `updatePayload` with value `null` or
     * `undefined` — i.e. the consumer explicitly cleared them. The library
     * distinguishes this from omission to give consumers an unambiguous
     * "drop this composite from the key" instruction; `null` and
     * `undefined` collapse here to eliminate the long-standing footgun of
     * dev confusion between the two in TypeScript with
     * `exactOptionalPropertyTypes`.
     */
    readonly clearedSet?: ReadonlySet<string> | undefined
  },
): GsiUpdateResult => {
  const sets: Record<string, string> = {}
  const removes: Array<string> = []
  const removedSet = options?.removedSet
  // Derive clearedSet: any payload entry whose value is null or undefined.
  // `null` and `undefined` collapse — both signal "explicit clear, drop this
  // composite from the key now". The caller may also supply an explicit
  // clearedSet for cases where the cleared signal arrives outside of
  // `updatePayload` (e.g. computed paths). The two are unioned.
  const clearedSet: Set<string> = new Set(options?.clearedSet ?? [])
  for (const [k, v] of Object.entries(updatePayload)) {
    if (v === null || v === undefined) clearedSet.add(k)
  }

  for (const [indexName, index] of Object.entries(indexes)) {
    if (indexName === "primary") continue

    const pkComposites = index.pk.composite
    const skComposites = index.sk.composite
    const allComposites = [...pkComposites, ...skComposites]

    const cascadeRemove =
      removedSet !== undefined && allComposites.some((attr) => removedSet.has(attr))
    const touchedByPayload = allComposites.some((attr) => attr in updatePayload)
    const hasPolicy = index.indexPolicy !== undefined

    if (!cascadeRemove && !touchedByPayload && !hasPolicy) continue

    // Cascade takes precedence over policy.
    if (cascadeRemove) {
      removes.push(index.pk.field, index.sk.field)
      continue
    }

    // Build merged record for value extraction. Cleared attrs are excluded so
    // their value is undefined when composed.
    const merged: Record<string, unknown> = { ...keyRecord }
    for (const [k, v] of Object.entries(updatePayload)) {
      if (clearedSet.has(k)) continue // cleared → exclude
      merged[k] = v
    }
    const policy = index.indexPolicy?.(merged) ?? {}

    const isPresent = (attr: string): boolean => {
      const v = merged[attr]
      return v !== undefined && v !== null
    }
    const isCleared = (attr: string): boolean => clearedSet.has(attr)
    const isOmitted = (attr: string): boolean => !(attr in updatePayload) && !isPresent(attr)

    // ---- Drop signals (any → REMOVE both keys, then continue) ----

    // PK composite cleared (any policy degrades to sparse — partition
    // migration is almost always wrong, see DESIGN.md §7).
    const pkClear = pkComposites.some(isCleared)
    if (pkClear) {
      removes.push(index.pk.field, index.sk.field)
      continue
    }

    // PK composite omitted with sparse policy.
    const pkOmittedSparse = pkComposites.some(
      (attr) => isOmitted(attr) && policy[attr] === "sparse",
    )
    if (pkOmittedSparse) {
      removes.push(index.pk.field, index.sk.field)
      continue
    }

    // SK composite cleared with sparse policy.
    const skClearSparse = skComposites.some((attr) => isCleared(attr) && policy[attr] === "sparse")
    if (skClearSparse) {
      removes.push(index.pk.field, index.sk.field)
      continue
    }

    // SK composite omitted with sparse policy.
    const skOmittedSparse = skComposites.some(
      (attr) => isOmitted(attr) && policy[attr] === "sparse",
    )
    if (skOmittedSparse) {
      removes.push(index.pk.field, index.sk.field)
      continue
    }

    // ---- Hierarchical SK truncation: SK clear with preserve ----

    // First SK position cleared under preserve. Earlier sparse-clear case
    // already handled above, so any cleared SK attr at this point is preserve.
    let truncateAt = -1
    for (let i = 0; i < skComposites.length; i++) {
      const attr = skComposites[i]!
      if (isCleared(attr)) {
        truncateAt = i
        break
      }
    }

    if (truncateAt !== -1) {
      // Hole check: any SK composite at position j > truncateAt that is
      // present in the composed payload would compose to a syntactically
      // invalid prefix. Throw EDD-9024 with location info.
      for (let j = truncateAt + 1; j < skComposites.length; j++) {
        const attr = skComposites[j]!
        if (isPresent(attr)) {
          throw makeCompositeKeyHoleError({
            entityType,
            indexName: index.index ?? indexName,
            clearedComposite: skComposites[truncateAt]!,
            trailingComposite: attr,
            clearedPosition: truncateAt,
            trailingPosition: j,
            half: "sk",
          })
        }
      }

      // Truncation requires the leading prefix attrs to be present (in merged).
      // Any missing-preserve in the leading prefix collapses to the half-wise
      // preserve rule for the SK — leave SK alone instead of truncating.
      const leadingAllPresent = skComposites.slice(0, truncateAt).every(isPresent)
      if (leadingAllPresent) {
        sets[index.sk.field] = composeSkPrefixUpTo(
          schema,
          entityType,
          entityVersion,
          index,
          merged,
          truncateAt,
        )
      }

      // PK side recomposes if all PK composites are present (no SET if any
      // PK composite is omitted-with-preserve — same as the half-wise rule).
      if (pkComposites.every(isPresent)) {
        sets[index.pk.field] = composePk(schema, entityType, index, merged)
      }
      continue
    }

    // ---- No drop, no truncation: standard half-wise recompose ----
    const pkAllPresent = pkComposites.every(isPresent)
    const skAllPresent = skComposites.every(isPresent)

    if (pkAllPresent && skAllPresent) {
      Object.assign(sets, composeIndexKeys(schema, entityType, entityVersion, index, merged))
      continue
    }
    if (pkAllPresent) {
      sets[index.pk.field] = composePk(schema, entityType, index, merged)
    }
    if (skAllPresent) {
      sets[index.sk.field] = composeSk(schema, entityType, entityVersion, index, merged)
    }
  }

  return { sets, removes }
}

/** @internal — re-export for documentation cross-reference. */
export type { CompositeKeyHoleError }

/**
 * Compose a partial sort key prefix for query operations.
 * Used when not all SK composite attributes are provided.
 *
 * For example, if SK composite is ["department", "hireDate"] and only "department"
 * is provided, this generates a begins_with prefix.
 */
export const composeSortKeyPrefix = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  // Collect available composites and their names (stop at first missing)
  const available: Array<string> = []
  const names: Array<string> = []
  for (const attr of index.sk.composite) {
    const value = record[attr]
    if (value === undefined || value === null) break
    available.push(serializeValue(value))
    names.push(attr)
  }

  const collection = index.collection
  const collectionType = index.type ?? "isolated"

  if (collection !== undefined) {
    if (collectionType === "clustered") {
      // For sub-collections, pass the full hierarchy so the SK prefix matches
      // the same hierarchy written by composeSk during put.
      return composeClusteredSortKey(schema, collection, entityType, entityVersion, available, {
        casing: index.casing,
        names,
      })
    }
    return composeIsolatedSortKey(schema, entityType, entityVersion, available, {
      casing: index.casing,
      names,
    })
  }

  return composeKey(schema, entityType, available, { casing: index.casing, names })
}

// ---------------------------------------------------------------------------
// Time-series key helpers (used by `Entity.append()` / `.history()`).
// Event item SK format: `<currentSk>#e#<serialised-orderBy-value>`.
// Casing is applied to both the `#e#` infix and the value for consistency with
// the rest of the SK — matches how every other composite segment is cased.
// ---------------------------------------------------------------------------

const EVENT_SK_INFIX = "e"

/**
 * Compose an event-item sort key by decorating the current-item SK.
 *
 * Given `currentSk = "$app#v1#telemetry_1"` and `orderByValue = 42`, returns
 * `"$app#v1#telemetry_1#e#0000000000000042"` (with default lowercase casing).
 */
export const composeEventSk = (
  currentSk: string,
  orderByValue: unknown,
  casing: DynamoSchema.Casing = "lowercase",
): string =>
  `${currentSk}#${applyCasing(EVENT_SK_INFIX, casing)}#${applyCasing(serializeValue(orderByValue), casing)}`

/**
 * Compose the prefix used to scope `.history()` queries to event items only.
 *
 * Given `currentSk = "$app#v1#telemetry_1"`, returns
 * `"$app#v1#telemetry_1#e#"`.
 */
export const composeEventSkPrefix = (
  currentSk: string,
  casing: DynamoSchema.Casing = "lowercase",
): string => `${currentSk}#${applyCasing(EVENT_SK_INFIX, casing)}#`
