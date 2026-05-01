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
 * Per-half policy value controlling how `Entity.update` and time-series
 * `.append` handle a GSI half whose composites are absent from the merged
 * update payload.
 *
 * - `"sparse"` — when the half's composites are entirely absent (whole-half
 *   empty), REMOVE both `gsiNpk` and `gsiNsk` (item drops out of the GSI).
 *   On a hole pattern (`[A, _, C]`), truncate the half to the leading prefix
 *   `[A]` and ignore trailing values.
 * - `"preserve"` — whole-half-empty is a no-op; the stored values for that
 *   half stay intact. On a hole pattern, throw `CompositeKeyHoleError`
 *   (EDD-9024) at write time.
 *
 * Halves not declared in `indexPolicy` default to `"preserve"`. See
 * `DESIGN.md §7 Policy-Aware GSI Composition` for the full decision rules
 * (structural composition, two drop triggers, decision table).
 */
export type IndexPolicyHalf = "sparse" | "preserve"

/**
 * Per-half index policy declaration. Both halves default to `"preserve"`
 * when omitted (or when `indexPolicy` is omitted entirely from the GSI
 * config).
 *
 * The standard composition path has only payload-level information (no
 * read-before-write), so per-attribute policy callbacks were removed in
 * v3 — within a single half, per-attribute mixing has no coherent semantic
 * because a half is a single concatenated string.
 */
export interface IndexPolicy {
  readonly pk?: IndexPolicyHalf | undefined
  readonly sk?: IndexPolicyHalf | undefined
}

/** Index definition for primary or secondary index (internal format) */
export interface IndexDefinition {
  readonly index?: string | undefined // Physical GSI name (omit for primary)
  readonly collection?: string | ReadonlyArray<string> | undefined
  readonly type?: "isolated" | "clustered" | undefined // Default: "isolated"
  readonly pk: KeyPart
  readonly sk: KeyPart
  readonly casing?: DynamoSchema.Casing | undefined
  /**
   * Optional per-half policy for `Entity.update` and `.append`. Not consulted
   * on `put()` — put always omits a GSI's keys when any of its composites is
   * missing.
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
   * Per-half sparse/preserve policy. Applied by `Entity.update` and
   * time-series `.append`. Defaults to `"preserve"` on each half. Not
   * applied on `put()`. See `DESIGN.md §7 Policy-Aware GSI Composition`.
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
 * Compose a partition key from the leading prefix
 * `[pk_0, ..., pk_(stopBefore-1)]` of an index's PK composites. Used by v3's
 * structural composition rule when a trailing PK composite is absent and the
 * half's `indexPolicy.pk` is `"preserve"` (or absent — defaults to preserve).
 *
 * `stopBefore === 0` produces the bare entity/collection prefix with no
 * composite values.
 */
const composePkPrefixUpTo = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  index: IndexDefinition,
  record: Record<string, unknown>,
  stopBefore: number,
): string => {
  const slice = index.pk.composite.slice(0, stopBefore)
  const composites = extractComposites(slice, record)
  const collection = index.collection

  if (collection !== undefined) {
    const collectionName = Array.isArray(collection) ? collection[0]! : collection
    return composeCollectionKey(schema, collectionName, composites, {
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
 * Compose a sort key from the leading prefix `[sk_0, ..., sk_(stopBefore-1)]`
 * of an index's SK composites. Used by v3's structural composition rule when a
 * trailing SK composite is absent and the half's `indexPolicy.sk` is
 * `"preserve"` (or absent — defaults to preserve), or when a hole pattern is
 * encountered under `"sparse"`.
 *
 * `stopBefore === 0` produces the bare entity/collection prefix with no
 * composite values (the item still belongs to the GSI but at the broadest
 * scope — `begins_with(sk, "<prefix>")` matches it).
 *
 * See `DESIGN.md §7 Policy-Aware GSI Composition`.
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
 * Per-half outcome of the structural composition rule.
 *
 * - `kind: "set"` — the half composed to a (possibly truncated) value.
 *   `length` is the number of leading composites included.
 * - `kind: "noop"` — preserve policy + whole-half-empty: leave the stored
 *   key field untouched.
 * - `kind: "drop"` — sparse policy + whole-half-empty: REMOVE the half (and,
 *   per the GSI roll-up rule, also REMOVE the other half).
 * - `kind: "hole-throw"` — preserve policy + hole pattern: throw EDD-9024.
 *   The position is the absent composite; trailingPosition is the first
 *   present trailing composite.
 */
type HalfOutcome =
  | { readonly kind: "set"; readonly length: number }
  | { readonly kind: "noop" }
  | { readonly kind: "drop" }
  | {
      readonly kind: "hole-throw"
      readonly absentPosition: number
      readonly trailingPosition: number
    }

/**
 * Apply v3's structural composition rule to a single half.
 *
 * Walks the composite list left-to-right, finds the longest leading prefix of
 * present values, and classifies the result based on whether the prefix is
 * partial, whether trailing values are present (hole), and whether the half
 * is empty. Policy is consulted only for hole + whole-half-empty cases.
 */
const classifyHalf = (
  composites: ReadonlyArray<string>,
  record: Record<string, unknown>,
  policy: IndexPolicyHalf,
): HalfOutcome => {
  // No composites at all (e.g. sk.composite = []) — emit a SET of length 0
  // (the bare entity prefix). Policy is irrelevant in this case; this is the
  // standard "primary key with empty SK composite" shape.
  if (composites.length === 0) {
    return { kind: "set", length: 0 }
  }

  let leadingLen = 0
  while (leadingLen < composites.length) {
    const v = record[composites[leadingLen]!]
    if (v === undefined || v === null) break
    leadingLen++
  }

  // All present → SET full length.
  if (leadingLen === composites.length) {
    return { kind: "set", length: leadingLen }
  }

  // Some absent. Check for hole (a present composite after the absent run).
  let firstTrailingPresent = -1
  for (let j = leadingLen + 1; j < composites.length; j++) {
    const v = record[composites[j]!]
    if (v !== undefined && v !== null) {
      firstTrailingPresent = j
      break
    }
  }

  if (firstTrailingPresent !== -1) {
    // Hole pattern. Policy decides.
    if (policy === "preserve") {
      return {
        kind: "hole-throw",
        absentPosition: leadingLen,
        trailingPosition: firstTrailingPresent,
      }
    }
    // sparse → truncate to leading prefix. If the leading prefix is empty
    // (the absent run starts at position 0), this collapses to whole-half-
    // empty, which sparse drops.
    return leadingLen === 0 ? { kind: "drop" } : { kind: "set", length: leadingLen }
  }

  // No hole — pure trailing-absent. If the leading prefix is empty, the whole
  // half is empty; policy decides.
  if (leadingLen === 0) {
    return policy === "sparse" ? { kind: "drop" } : { kind: "noop" }
  }

  // Non-empty leading prefix with trailing absent → truncate. Same outcome
  // under both policies.
  return { kind: "set", length: leadingLen }
}

/**
 * Resolve the per-half policy for an index. Defaults each half to `"preserve"`
 * when omitted (or when `indexPolicy` is omitted entirely).
 */
const resolveIndexPolicy = (
  policy: IndexPolicy | undefined,
): { pk: IndexPolicyHalf; sk: IndexPolicyHalf } => ({
  pk: policy?.pk ?? "preserve",
  sk: policy?.sk ?? "preserve",
})

/**
 * Policy-aware GSI key composition for `Entity.update` and time-series
 * `.append` — v3 per-half structural composition.
 *
 * Implements two-way payload classification:
 * - **present** (`attr: <value>` in payload, or inherited from `keyRecord`)
 *   — value is used in composition.
 * - **absent** (key omitted, or `attr: null`, or `attr: undefined`) — the
 *   structural rule treats all three identically.
 *
 * For each touched GSI half (PK and SK independently), walk the composite
 * list left-to-right and build the longest valid leading prefix. Policy is
 * consulted only for the hole pattern (truncate under sparse, throw EDD-9024
 * under preserve) and the whole-half-empty case (drop both keys under
 * sparse, no-op under preserve).
 *
 * Cascade (`Entity.remove([attr])`) overrides everything: any composite in
 * `removedSet` forces a full GSI drop (REMOVE both `gsiNpk` and `gsiNsk`).
 *
 * A GSI is considered "touched" when any of its composites appears in
 * `updatePayload`, or `removedSet`. GSIs without an `indexPolicy` are skipped
 * when none of their composites are touched. GSIs with a policy are always
 * evaluated — the policy is a declarative statement about the GSI's
 * membership invariant.
 *
 * See `DESIGN.md §7 Policy-Aware GSI Composition` for the full decision
 * algorithm, decision table, and the two-drop-trigger framing.
 *
 * @throws {CompositeKeyHoleError} EDD-9024 on hole-pattern detection under
 *   `'preserve'` policy.
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
  },
): GsiUpdateResult => {
  const sets: Record<string, string> = {}
  const removes: Array<string> = []
  const removedSet = options?.removedSet

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

    // Build merged record for value extraction. Two-way classification: any
    // payload value that is `null` or `undefined` is treated as absent (the
    // attribute is excluded from `merged`). `keyRecord` provides values for
    // composites the consumer didn't touch.
    const merged: Record<string, unknown> = { ...keyRecord }
    for (const [k, v] of Object.entries(updatePayload)) {
      if (v === null || v === undefined) {
        delete merged[k]
        continue
      }
      merged[k] = v
    }

    const policy = resolveIndexPolicy(index.indexPolicy)
    const pkOutcome = classifyHalf(pkComposites, merged, policy.pk)
    const skOutcome = classifyHalf(skComposites, merged, policy.sk)

    // Hole-throw on either half raises EDD-9024 with the offending location.
    if (pkOutcome.kind === "hole-throw") {
      throw makeCompositeKeyHoleError({
        entityType,
        indexName: index.index ?? indexName,
        clearedComposite: pkComposites[pkOutcome.absentPosition]!,
        trailingComposite: pkComposites[pkOutcome.trailingPosition]!,
        clearedPosition: pkOutcome.absentPosition,
        trailingPosition: pkOutcome.trailingPosition,
        half: "pk",
      })
    }
    if (skOutcome.kind === "hole-throw") {
      throw makeCompositeKeyHoleError({
        entityType,
        indexName: index.index ?? indexName,
        clearedComposite: skComposites[skOutcome.absentPosition]!,
        trailingComposite: skComposites[skOutcome.trailingPosition]!,
        clearedPosition: skOutcome.absentPosition,
        trailingPosition: skOutcome.trailingPosition,
        half: "sk",
      })
    }

    // Whole-GSI drop: any half declared sparse + whole-half-empty drops both
    // halves together. This is the implicit drop trigger.
    if (pkOutcome.kind === "drop" || skOutcome.kind === "drop") {
      removes.push(index.pk.field, index.sk.field)
      continue
    }

    // Per-half SET / no-op. Halves are emitted independently — preserve +
    // empty leaves the stored value alone.
    if (pkOutcome.kind === "set") {
      sets[index.pk.field] =
        pkOutcome.length === pkComposites.length
          ? composePk(schema, entityType, index, merged)
          : composePkPrefixUpTo(schema, entityType, index, merged, pkOutcome.length)
    }
    if (skOutcome.kind === "set") {
      sets[index.sk.field] =
        skOutcome.length === skComposites.length
          ? composeSk(schema, entityType, entityVersion, index, merged)
          : composeSkPrefixUpTo(schema, entityType, entityVersion, index, merged, skOutcome.length)
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
