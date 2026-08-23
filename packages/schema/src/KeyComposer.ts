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
import type { CompositeKeyHoleError } from "./Errors.js"

/** Index key part definition (pk or sk of an index) */
export interface KeyPart {
  readonly field: string
  readonly composite: ReadonlyArray<string>
}

/**
 * Per-half policy value controlling how `Entity.update` and time-series
 * `.append` handle a GSI half the writer touches but can't compose.
 *
 * Per-half evaluation gate (v1.7.1): a half is *touched* iff at least one of
 * its composite names appears in the update payload (regardless of value,
 * including `undefined`) OR appears in `Entity.remove([...])`. Untouched
 * halves are skipped entirely — no SET, no REMOVE, no policy fires.
 *
 * For *touched* halves the policy decides the outcome when the structural
 * rule can't compose (empty leading prefix OR hole pattern):
 * - `"sparse"` — REMOVE this half's key attribute (the half drops out of the
 *   GSI). The other half follows its own per-half outcome independently —
 *   there is no GSI-wide cascade. The DDB projection rule means an item with
 *   only one key attribute is invisible in the GSI; the surviving half's
 *   value is preserved for rejoin without other writers re-firing.
 * - `"preserve"` — noop (leave the stored key for this half untouched). The
 *   stored value may go stale until either (a) the next write that touches
 *   this half supplies enough composites to recompose, or (b) a composite of
 *   this half is named in `Entity.remove([...])` — the cascade override
 *   then REMOVEs this half's key.
 *
 * Halves not declared in `indexPolicy` default to `"preserve"`. See
 * `DESIGN.md §7 Policy-Aware GSI Composition` for the full decision rules
 * (per-half evaluation gate, per-half outcome, cascade override, decision
 * table).
 */
export type IndexPolicyKey = "sparse" | "preserve"

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
  readonly pk?: IndexPolicyKey | undefined
  readonly sk?: IndexPolicyKey | undefined
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
 * Per-half outcome of the v1.7.1 structural composition rule.
 *
 * - `kind: "set"` — the half composed to a (possibly truncated) value.
 *   `length` is the number of leading composites included.
 * - `kind: "noop"` — preserve policy + can't-compose AND no composite of this
 *   half is in `removedSet`: leave the stored key field untouched (stored
 *   value may go stale).
 * - `kind: "drop"` — REMOVE this half's key. Fires when the half is touched
 *   AND the structural rule can't compose AND either (a) policy is
 *   `'sparse'` OR (b) a composite of this half is in `removedSet` (cascade
 *   override under preserve).
 *
 * No `hole-throw` outcome — EDD-9024 was deprecated in v1.7.1 (hole patterns
 * collapse into can't-compose under the unified rule).
 */
type HalfOutcome =
  | { readonly kind: "set"; readonly length: number }
  | { readonly kind: "noop" }
  | { readonly kind: "drop" }

/**
 * Apply v1.7.1's structural composition rule to a single half that the
 * skip-predicate gate (v1.7.3) decided not to skip.
 *
 * The caller is responsible for the per-half evaluation gate — `classifyHalf`
 * is only called once the gate has decided this half should be evaluated
 * (the half has no composites; OR a composite is in `removedSet`; OR a
 * composite is in `updatePayload` or `keyRecord`).
 *
 * Walks the composite list left-to-right, finds the longest leading prefix of
 * present values in `record`, and classifies the result:
 *
 * - **Compose succeeded** (non-empty leading prefix AND no hole — i.e. all
 *   absent composites are at trailing positions only): SET.
 * - **Compose failed** (empty leading prefix OR hole pattern): outcome
 *   depends on `policy` and whether any composite of this half is in
 *   `removedSet`:
 *   - `'sparse'` → drop.
 *   - `'preserve'` AND any composite in `removedSet` → drop (cascade
 *     override under preserve — the consumer's explicit signal trumps
 *     stale-data preservation).
 *   - `'preserve'` AND no composite in `removedSet` → noop (preserve
 *     preservation; stored key may be stale).
 *
 * Hole patterns collapse into can't-compose — silent partial composition
 * (truncate-and-discard-trailing) is a worse failure mode than dropping the
 * half because it would lie about the data shape to readers. The previous
 * v1.7.0 sparse-truncate-on-hole behavior is gone.
 */
const classifyHalf = (
  composites: ReadonlyArray<string>,
  record: Record<string, unknown>,
  policy: IndexPolicyKey,
  halfHasRemoved: boolean,
): HalfOutcome => {
  // No composites at all (e.g. sk.composite = []) — emit a SET of length 0
  // (the bare entity prefix). Policy is irrelevant; this is the standard
  // "primary key with empty SK composite" shape.
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
  let hasHole = false
  for (let j = leadingLen + 1; j < composites.length; j++) {
    const v = record[composites[j]!]
    if (v !== undefined && v !== null) {
      hasHole = true
      break
    }
  }

  // Compose-can-succeed iff non-empty leading prefix AND no hole.
  // (Trailing-absent without a hole is a clean truncation.)
  if (!hasHole && leadingLen > 0) {
    return { kind: "set", length: leadingLen }
  }

  // Compose failed (empty leading prefix OR hole pattern). Per-half outcome:
  if (policy === "sparse") return { kind: "drop" }
  // preserve — cascade override under removedSet, otherwise noop.
  return halfHasRemoved ? { kind: "drop" } : { kind: "noop" }
}

/**
 * Resolve the per-half policy for an index. Defaults each half to `"preserve"`
 * when omitted (or when `indexPolicy` is omitted entirely).
 */
const resolveIndexPolicy = (
  policy: IndexPolicy | undefined,
): { pk: IndexPolicyKey; sk: IndexPolicyKey } => ({
  pk: policy?.pk ?? "preserve",
  sk: policy?.sk ?? "preserve",
})

/**
 * Policy-aware GSI key composition for `Entity.update` and time-series
 * `.append` — v1.7.1 per-half structural composition with per-half evaluation
 * gate and per-half cascade.
 *
 * **Per-half evaluation gate (reframed in v1.7.3 as a skip-predicate).** Each
 * half (PK and SK) is independently asked one question: *can this half be
 * safely skipped?* The gate exists for exactly one reason — multi-writer
 * protection: prevent writer A from clobbering keys for halves it doesn't
 * own when writer B does own them. The skip-predicate states that purpose
 * directly: skip iff multi-writer protection actually applies (the half has
 * composites, no composite was explicitly removed, and every composite is
 * absent from BOTH `updatePayload` AND `keyRecord` — so this writer is
 * genuinely not claiming ownership of this half on this call). If the half
 * cannot be safely skipped, it is evaluated by the structural rule.
 *
 * Pre-v1.7.3 the predicate was inverted ("list cases for which to evaluate"
 * as a chain of `||` clauses) and had to enumerate every shape: payload
 * membership (v1.7.0), `removedSet` membership (v1.7.1), `keyRecord`
 * membership (v1.7.2). Each missed shape required another tactical patch:
 * v1.7.1 missed the multi-writer leak (#41), v1.7.2 missed the
 * PK-composites-only case (#43), v1.7.2 then missed the empty-composite-half
 * case (#46) because every `.some(...)` clause trivially returned `false`
 * for an empty composite array. The skip-predicate closes the entire class
 * of degenerate-case bugs structurally.
 *
 * **Two-way payload classification.**
 * - **present** (`attr: <value>` in payload, or inherited from `keyRecord`)
 *   — value is used in composition.
 * - **absent** (key omitted, or `attr: null`, or `attr: undefined`) — the
 *   structural rule treats all three identically.
 *
 * **Per-half outcome (v1.7.1 unified rule).** For each touched half:
 * 1. Run the structural rule (longest leading prefix of present values in
 *    the merged record).
 * 2. If the prefix is non-empty AND there's no hole → SET (full or truncated).
 * 3. Otherwise (empty leading prefix OR hole pattern):
 *    - `'sparse'` → REMOVE this half's key.
 *    - `'preserve'` AND any composite of this half is in `removedSet` →
 *      REMOVE (cascade override under preserve).
 *    - `'preserve'` AND no composite in `removedSet` → noop (stored key
 *      retained, may be stale until next write touches the half).
 *
 * **Per-half roll-up (v1.7.1).** Each half's outcome applies to its own key
 * attribute only. PK dropping doesn't drop SK; SK dropping doesn't drop PK.
 * The item may be invisible in the GSI during a single-half-dropped period
 * (DDB projection rule needs both keys for query visibility), but the
 * surviving half's value persists for rejoin without other writers re-firing.
 * The v1.7.0 GSI-wide cascade is gone.
 *
 * **`Entity.remove([attr])` cascade (v1.7.1: per-half).** Composites in
 * `removedSet` contribute to the merged record as "absent" (same as
 * undefined-in-payload) AND make their containing half "touched" for the
 * evaluation gate AND trigger the cascade override under preserve. The
 * cascade no longer drops both halves of every GSI containing the cleared
 * attribute — only the half(s) whose composite list contains it.
 *
 * See `DESIGN.md §7 Policy-Aware GSI Composition` for the full decision
 * table and worked multi-writer examples.
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

    // Per-half evaluation gate (reframed in v1.7.3 as a skip-predicate —
    // closes #46 and the class of degenerate-case bugs that v1.7.0–v1.7.2
    // were chasing as separate `||` arms). The gate's only purpose is
    // multi-writer protection — preventing writer A from clobbering keys
    // for halves it doesn't own when writer B does own them. The skip
    // predicate states that purpose directly: skip iff
    //
    //   - the half has composites (otherwise the value is a constant
    //     entity/collection prefix — nothing to multi-writer-clobber, so
    //     skipping would just leave a missing key forever — closes #46),
    //   - AND no composite of this half was explicitly removed (cascade
    //     intent must always evaluate),
    //   - AND every composite is absent from BOTH `updatePayload` AND
    //     `keyRecord` (so this writer is genuinely not claiming ownership
    //     of this half on this call — preserves the v1.7.1 multi-writer
    //     fix #41 and the v1.7.2 PK-composites-only fix #43, since
    //     entity-PK composites are always present in `keyRecord`).
    //
    // The negation `!shouldSkip` is observably equivalent to the previous
    // touched-predicate `||`-chain extended with `composites.length === 0`:
    // every fix the touched-predicate accumulated falls out of one of the
    // skip-predicate's three structural conditions. See `DESIGN.md §7`.
    const pkHasRemoved =
      removedSet !== undefined && pkComposites.some((attr) => removedSet.has(attr))
    const skHasRemoved =
      removedSet !== undefined && skComposites.some((attr) => removedSet.has(attr))
    const skipPk =
      pkComposites.length > 0 &&
      !pkHasRemoved &&
      pkComposites.every((attr) => !(attr in updatePayload) && !(attr in keyRecord))
    const skipSk =
      skComposites.length > 0 &&
      !skHasRemoved &&
      skComposites.every((attr) => !(attr in updatePayload) && !(attr in keyRecord))

    if (skipPk && skipSk) continue

    // Build merged record for value extraction. Two-way classification: any
    // payload value that is `null` or `undefined` is treated as absent. Any
    // composite in `removedSet` is also treated as absent (the cascade
    // signal). `keyRecord` provides values for composites the consumer did
    // not touch (typically the entity's primary-key composites pulled
    // through to GSI composites that share the names).
    const merged: Record<string, unknown> = { ...keyRecord }
    for (const [k, v] of Object.entries(updatePayload)) {
      if (v === null || v === undefined) {
        delete merged[k]
        continue
      }
      merged[k] = v
    }
    if (removedSet !== undefined) {
      for (const attr of removedSet) {
        delete merged[attr]
      }
    }

    const policy = resolveIndexPolicy(index.indexPolicy)

    if (!skipPk) {
      const pkOutcome = classifyHalf(pkComposites, merged, policy.pk, pkHasRemoved)
      if (pkOutcome.kind === "drop") {
        removes.push(index.pk.field)
      } else if (pkOutcome.kind === "set") {
        sets[index.pk.field] =
          pkOutcome.length === pkComposites.length
            ? composePk(schema, entityType, index, merged)
            : composePkPrefixUpTo(schema, entityType, index, merged, pkOutcome.length)
      }
      // noop — emit nothing for this half.
    }

    if (!skipSk) {
      const skOutcome = classifyHalf(skComposites, merged, policy.sk, skHasRemoved)
      if (skOutcome.kind === "drop") {
        removes.push(index.sk.field)
      } else if (skOutcome.kind === "set") {
        sets[index.sk.field] =
          skOutcome.length === skComposites.length
            ? composeSk(schema, entityType, entityVersion, index, merged)
            : composeSkPrefixUpTo(
                schema,
                entityType,
                entityVersion,
                index,
                merged,
                skOutcome.length,
              )
      }
      // noop — emit nothing for this half.
    }
  }

  return { sets, removes }
}

// ---------------------------------------------------------------------------
// Vector index partition composition
// ---------------------------------------------------------------------------

/**
 * Compose the HASH partition value for a vector index:
 * `$schema#v<version>#<entityType>[#<partition composite values>]`.
 *
 * Identical prefixing and casing rules to {@link composePk} — a vector index's
 * partition attribute IS a composed key, it just lives on a different index
 * type. Because the entity type is always in the value, searches on a shared
 * physical vector index are automatically scoped to one entity (the vector
 * analogue of the `__edd_e__` filter on every Query). See `DESIGN.md §14`.
 *
 * Returns `undefined` when a declared partition composite is missing from the
 * record — the item then simply has no partition attribute, and DynamoDB's
 * sparse index semantics leave it out of the index.
 */
export const tryComposeVectorPartition = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  index: {
    readonly partition: ReadonlyArray<string>
    readonly casing?: DynamoSchema.Casing | undefined
  },
  record: Record<string, unknown>,
): string | undefined => {
  const composites = tryExtractComposites(index.partition, record)
  if (composites === undefined) return undefined
  return composeKey(schema, entityType, composites, {
    casing: index.casing,
    names: [...index.partition],
  })
}

/**
 * Throwing variant of {@link tryComposeVectorPartition}. Used on the search
 * path, where a missing partition composite is a caller error rather than a
 * sparse-index outcome.
 */
export const composeVectorPartition = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  index: {
    readonly partition: ReadonlyArray<string>
    readonly casing?: DynamoSchema.Casing | undefined
  },
  record: Record<string, unknown>,
): string => {
  const composites = extractComposites(index.partition, record)
  return composeKey(schema, entityType, composites, {
    casing: index.casing,
    names: [...index.partition],
  })
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
