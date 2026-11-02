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
  KEY_DELIMITER,
} from "./DynamoSchema.js"
import type { CompositeKeyHoleError } from "./Errors.js"
import { encodeBigInt, encodeNumber } from "./internal/NumericKey.js"
import {
  concatBytes,
  interleave,
  type Layout,
  prefixSegment,
  toBytes,
} from "./internal/ZOrderCurve.js"
import { type DeclaredDimension, declareDimension } from "./internal/ZOrderDimension.js"
import type * as ZOrder from "./ZOrder.js"

/**
 * Index key part definition (pk or sk of an index). `field` is the physical
 * key attribute; `composite` names the model attributes composed into it —
 * `F`, on `Entity.make`, is the model's field names (plus ref-derived ids), so
 * a misspelled one is a compile error. `zorder` / `prefix` belong to a Z-order
 * sort key ({@link ZOrderKeyPart}) and are a type error here — on a partition
 * key half or on the primary key.
 */
export interface KeyPart<F extends string = string> {
  readonly field: string
  readonly composite: ReadonlyArray<F>
  readonly zorder?: never
  readonly prefix?: never
}

/**
 * A Z-order sort key, as declared on a secondary index (#171): the bits of the
 * `zorder` dimensions interleaved into one binary (`B`) value, behind the
 * exact-match `prefix` composites. It has no `composite`: the fields that feed
 * it are the prefix composites and the dimensions' fields. `TFields` is the
 * model's fields (name → type) on `Entity.make`, which types each prefix
 * composite and each dimension entry from the field it names.
 */
export interface ZOrderKeyPart<TFields = globalThis.Record<string, unknown>> {
  /** Physical attribute name, stored as `B`. */
  readonly field: string
  /** Exact-match composites, in front of the address. */
  readonly prefix?: ReadonlyArray<ZOrder.PrefixPart<keyof TFields & string>>
  /** The interleaved dimensions; declaration order is interleave priority. */
  readonly zorder: ReadonlyArray<ZOrder.Dimension<TFields>>
  readonly composite?: never
}

/** One normalised prefix composite: its field, and its hash width when hashed. */
export interface ZOrderPrefixSegment {
  readonly field: string
  readonly hash: number | undefined
}

/** The Z-order specifics of a normalised sort key half. */
export interface ZOrderHalf {
  readonly prefix: ReadonlyArray<ZOrderPrefixSegment>
  /** The dimensions as declared (options checked), in interleave order. */
  readonly dimensions: ReadonlyArray<DeclaredDimension>
  /**
   * The dimensions bound to the entity's fields (internal). `undefined` on the
   * half `normalizeGsiConfig` returns, until `Entity.make` binds it.
   */
  readonly layout: Layout | undefined
}

/**
 * A normalised Z-order sort key half. Built only by `normalizeGsiConfig` and
 * bound by `Entity.make`. `composite` is derived — the prefix composites, then
 * the dimensions' fields — so every check that reads "the fields feeding this
 * key" covers it; only the sites that string-compose a key branch on
 * {@link isZOrderHalf}.
 */
export interface ZOrderSkPart {
  readonly field: string
  readonly composite: ReadonlyArray<string>
  readonly zorderHalf: ZOrderHalf
}

/** Is this sort key half a Z-order one? */
export const isZOrderHalf = (part: KeyPart | ZOrderSkPart): part is ZOrderSkPart =>
  "zorderHalf" in part && part.zorderHalf !== undefined

/** A composed key value: text for a string half, bytes for a Z-order half. */
export type KeyValue = string | Uint8Array

/**
 * Per-half policy value controlling how `Entity.update` and time-series
 * `.append` handle a GSI half the writer touches but can't compose.
 *
 * Per-half evaluation gate (v1.7.3 skip-predicate): a half is *skipped* — no
 * SET, no REMOVE, no policy fires — iff it has composites, none of them is in
 * `Entity.remove([...])`, and every one is absent from both the update payload
 * and the key record. Every other half is *evaluated*.
 *
 * For evaluated halves the policy decides the outcome when the structural
 * rule can't compose (empty leading prefix OR hole pattern; for a Z-order
 * half, any prefix composite or dimension absent — it never truncates):
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
  readonly pk?: IndexPolicyKey
  readonly sk?: IndexPolicyKey
}

/** Index definition for primary or secondary index (internal format) */
export interface IndexDefinition {
  readonly index?: string | undefined // Physical GSI name (omit for primary)
  readonly collection?: string | ReadonlyArray<string>
  readonly type?: "isolated" | "clustered" | undefined // Default: "isolated"
  readonly pk: KeyPart
  readonly sk: KeyPart | ZOrderSkPart
  /** Key casing override; see {@link GsiConfig.casing}. Defaults to the schema's. */
  readonly casing?: DynamoSchema.Casing
  /**
   * Optional per-half policy for `Entity.update` and `.append`. Not consulted
   * on `put()` — put always omits a GSI's keys when any of its composites is
   * missing.
   */
  readonly indexPolicy?: IndexPolicy
}

/** GSI definition as specified on Entity.make() indexes config.
 * Mirrors the primaryKey structure with an added `name` for the physical GSI.
 * `TFields` is the model's fields (name → type) on `Entity.make`: composites,
 * prefix composites and dimensions are typed from it. */
export interface GsiConfig<TFields = globalThis.Record<string, unknown>> {
  /** Physical GSI name (e.g., `"gsi1"`). */
  readonly name: string
  /** Optional collection name. String for single, array for sub-collections. */
  readonly collection?: string | ReadonlyArray<string>
  /** SK ordering mode. `"isolated"` (default) puts entity type before composites; `"clustered"` puts entity type after composites (required for sub-collections). */
  readonly type?: "isolated" | "clustered"
  /** Partition key: physical field name + composite attributes. */
  readonly pk: KeyPart<keyof TFields & string>
  /**
   * Sort key: physical field name + composite attributes — or a Z-order key
   * (`zorder`, optional `prefix`; see {@link ZOrderKeyPart}).
   */
  readonly sk: KeyPart<keyof TFields & string> | ZOrderKeyPart<TFields>
  /**
   * Key casing for this index, overriding the schema's `casing`. Applies to the
   * entity type / collection name and the composite names and values in both
   * halves; the `$<schema>#v<n>` prefix keeps the schema's casing. Members of a
   * collection must agree on it (EDD-9055).
   */
  readonly casing?: DynamoSchema.Casing
  /**
   * Per-half sparse/preserve policy. Applied by `Entity.update` and
   * time-series `.append`. Defaults to `"preserve"` on each half. Not
   * applied on `put()`. See `DESIGN.md §7 Policy-Aware GSI Composition`.
   */
  readonly indexPolicy?: IndexPolicy
}

/** The casing an index's keys are composed with: its own, else the schema's. */
export const effectiveCasing = (
  schema: DynamoSchema.DynamoSchema,
  index: IndexDefinition,
): DynamoSchema.Casing => index.casing ?? schema.casing

/**
 * Fail when a collection's members would compose its keys with different
 * casings. They share one physical index, so a member whose keys are cased
 * differently writes into partitions the collection query never reads.
 */
export const assertCollectionCasingAgreement = (
  collectionName: string,
  members: ReadonlyArray<{
    readonly key: string
    readonly schema: DynamoSchema.DynamoSchema
    readonly index: IndexDefinition
  }>,
): void => {
  const casings = members.map((m) => ({ key: m.key, casing: effectiveCasing(m.schema, m.index) }))
  if (new Set(casings.map((c) => c.casing)).size > 1) {
    throw new Error(
      `[EDD-9055] Collection "${collectionName}" members compose its keys with different ` +
        `casings (${casings.map((c) => `${c.key}: ${c.casing}`).join(", ")}). They share one ` +
        `physical index, so their keys would never meet — give the collection's index the same ` +
        `\`casing\` on every member.`,
    )
  }
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
  const pkHalf = config.pk as { readonly zorder?: unknown; readonly prefix?: unknown }
  if (pkHalf.zorder !== undefined || pkHalf.prefix !== undefined) {
    throw zorderMalformed(
      config.name,
      "zorder / prefix belong on the sort key; a partition key is always composed from its composites.",
    )
  }
  const sk = config.sk as {
    readonly field: string
    readonly composite?: ReadonlyArray<string>
    readonly zorder?: unknown
    readonly prefix?: unknown
  }
  const isZOrder = sk.zorder !== undefined || sk.prefix !== undefined
  return {
    index: config.name,
    ...(config.collection !== undefined && { collection: config.collection }),
    type: config.type ?? "isolated",
    pk: { field: config.pk.field, composite: [...config.pk.composite] },
    sk: isZOrder
      ? normalizeZOrderHalf(config, sk)
      : { field: sk.field, composite: [...sk.composite!] },
    ...(config.casing !== undefined && { casing: config.casing }),
    ...(config.indexPolicy !== undefined && { indexPolicy: config.indexPolicy }),
  }
}

const zorderMalformed = (index: string, why: string): Error =>
  new Error(`[EDD-9086] Index "${index}" declares a malformed Z-order sort key: ${why}`)

/**
 * Normalise a declared Z-order sort key: the prefix as `{ field, hash }`, the
 * dimensions as declared, and the derived `composite`. Unbound — `Entity.make`
 * resolves each dimension's storage from the model and lays the address out.
 * Raises the structural `[EDD-9086]` cases visible without the model, and
 * `[EDD-9087]` for a `hash` outside 1..8 or a dimension's options (checked
 * without the model; `Entity.make` checks them against the field).
 */
const normalizeZOrderHalf = (
  config: GsiConfig,
  sk: {
    readonly field: string
    readonly composite?: ReadonlyArray<string>
    readonly zorder?: unknown
    readonly prefix?: unknown
  },
): ZOrderSkPart => {
  const index = config.name
  if (sk.composite !== undefined) {
    throw zorderMalformed(
      index,
      "composite can't be combined with zorder or prefix — the fields feeding a Z-order key are its prefix composites and dimensions.",
    )
  }
  if (sk.zorder === undefined) {
    throw zorderMalformed(index, "prefix needs zorder: a prefix is the front of a Z-order key.")
  }
  if (!Array.isArray(sk.zorder) || sk.zorder.length === 0) {
    throw zorderMalformed(
      index,
      'zorder must be a non-empty array of dimension entries (e.g. { field: "price", min: 0, max: 100 }).',
    )
  }
  if (config.type === "clustered") {
    throw zorderMalformed(
      index,
      'type "clustered" orders a collection\'s keys; a Z-order key carries no entity type to cluster on.',
    )
  }
  const declaredPrefix = sk.prefix ?? []
  if (!Array.isArray(declaredPrefix)) {
    throw zorderMalformed(index, "prefix must be an array of field names or { field, hash }.")
  }
  const prefix = declaredPrefix.map((part: unknown): ZOrderPrefixSegment => {
    if (typeof part === "string") return { field: part, hash: undefined }
    const p = part as { readonly field?: unknown; readonly hash?: unknown }
    if (typeof p !== "object" || p === null || typeof p.field !== "string") {
      throw zorderMalformed(index, "each prefix part is a field name or { field, hash }.")
    }
    if (typeof p.hash !== "number" || !Number.isInteger(p.hash) || p.hash < 1 || p.hash > 8) {
      throw new Error(
        `[EDD-9087] Index "${index}" prefix composite "${p.field}": hash ${JSON.stringify(p.hash)} ` +
          `must be an integer from 1 to 8 (bytes of its FNV-1a-64 hash).`,
      )
    }
    return { field: p.field, hash: p.hash }
  })
  const dimensions = (sk.zorder as ReadonlyArray<unknown>).map((entry) =>
    declareDimension(index, entry, (why) => zorderMalformed(index, why)),
  )
  const composite = [...prefix.map((p) => p.field), ...dimensions.map((d) => d.field)]
  const twice = composite.find((field, i) => composite.indexOf(field) !== i)
  if (twice !== undefined) {
    throw zorderMalformed(
      index,
      `"${twice}" is listed twice; each field feeds a Z-order key once, as a prefix composite or a dimension.`,
    )
  }
  return { field: sk.field, composite, zorderHalf: { prefix, dimensions, layout: undefined } }
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
 * Numeric values are encoded so their key text sorts in numeric order
 * (`internal/NumericKey.ts` has the format):
 * - number → a non-negative integer below 1e16 (or `-0`) is zero-padded to 16
 *   digits, as up to 1.36; negatives, fractions, larger values and ±Infinity
 *   take the order-preserving forms (`-3.14` → `-9999999999999996.85:`)
 * - bigint → the same, zero-padded to 38 digits below 1e38
 *
 * Throws `[EDD-9096]` (`KeyValueError`) for `NaN`, which has no order, and for
 * a bigint of more than 1,000 digits.
 *
 * DateTime values are formatted as ISO strings for correct sort order:
 * - DateTime.Zoned → ISO string with offset (preserves timezone info)
 * - DateTime.Utc → ISO string
 * - Date → ISO string
 */
export const serializeValue = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number") return encodeNumber(value)
  if (typeof value === "bigint") return encodeBigInt(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  // DateTime types → ISO string (Zoned normalized to UTC for sort order)
  if (typeof value === "object" && value !== null && DateTime.isDateTime(value)) {
    return DateTime.formatIso(value)
  }
  // Native Date
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/** The highest code point a sort key composite's text escapes: `%`. */
const ESCAPED_MAX = 0x25

/**
 * A composite value's serialized text as a sort key holds it (#171): cased,
 * then each code point U+0000–U+0025 — control characters, space, `!`, `"`,
 * `#`, `$` and `%` — escaped as `%` and two hex digits (space → `%20`, `#` →
 * `%23`, `%` → `%25`), the hex digits in upper case, or lower case under
 * `"lowercase"` casing. Any other text is unchanged, so a value without such a
 * character keeps its 1.36 key text.
 *
 * Every escaped value sorts as its cased value and starts with its cased
 * prefixes' text: an unescaped character sorts above `%`, and an escape starts
 * with `%` and keeps the order of the code points it replaces. A composite's
 * text followed by the key delimiter (`#`, below `%`) therefore sorts before
 * every key of a greater value — `new#…` before `new%20york#…` and
 * `new%21#…` — and a bound on any composite is one exact key range.
 *
 * Casing comes first so the hex digits are the only text it can't reach: the
 * composer cases the key again, which leaves cased text as it is.
 */
export const sortKeyText = (text: string, casing: DynamoSchema.Casing): string => {
  const cased = applyCasing(text, casing)
  let escaped = ""
  let from = 0
  for (let i = 0; i < cased.length; i++) {
    const code = cased.charCodeAt(i)
    if (code > ESCAPED_MAX) continue
    const hex = code.toString(16).padStart(2, "0")
    escaped += `${cased.slice(from, i)}%${casing === "lowercase" ? hex : hex.toUpperCase()}`
    from = i + 1
  }
  return from === 0 ? cased : `${escaped}${cased.slice(from)}`
}

/** A composite value's text in a sort key: {@link serializeValue}, then {@link sortKeyText}. */
export const serializeSortKeyValue = (value: unknown, casing: DynamoSchema.Casing): string =>
  sortKeyText(serializeValue(value), casing)

/** {@link extractComposites} for a sort key half: each value's {@link sortKeyText}. */
const extractSortKeyComposites = (
  composite: ReadonlyArray<string>,
  record: Record<string, unknown>,
  casing: DynamoSchema.Casing,
): ReadonlyArray<string> =>
  extractComposites(composite, record).map((text) => sortKeyText(text, casing))

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
  assertStringHalf(index, "composeSk")
  const composites = extractSortKeyComposites(
    index.sk.composite,
    record,
    effectiveCasing(schema, index),
  )
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
 * Refuse a Z-order half in a function that composes key text. Such a half is a
 * binary address with no text form, so reaching one here is a library bug.
 */
const assertStringHalf = (index: IndexDefinition, fn: string): void => {
  if (isZOrderHalf(index.sk)) {
    throw new Error(
      `KeyComposer.${fn}: index "${index.index ?? "primary"}" has a Z-order sort key, which ` +
        `has no text form — compose it with composeZOrderSk / composeSkValue.`,
    )
  }
}

/**
 * Compose the bytes of a Z-order sort key half from a key-form record:
 *
 * ```
 * seg(prefix_1) ‖ … ‖ seg(prefix_k) ‖ toBytes(interleave(q(dim_1), …, q(dim_m)), W)
 * ```
 *
 * No schema prefix, no entity type, no version byte: the partition key keeps
 * entities apart. Prefix values are cased like any composite (the index's
 * effective casing). Throws `[EDD-9092]` (`ZOrderValueError`) for a value a
 * dimension can't quantize; the record must carry every field.
 */
export const composeZOrderSk = (
  schema: DynamoSchema.DynamoSchema,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Uint8Array => {
  if (!isZOrderHalf(index.sk)) {
    throw new Error(
      `KeyComposer.composeZOrderSk: index "${index.index ?? "primary"}" has no Z-order sort key.`,
    )
  }
  const { prefix, layout } = index.sk.zorderHalf
  if (layout === undefined) {
    throw new Error(
      `KeyComposer.composeZOrderSk: index "${index.index}" was never bound to an entity — ` +
        `Entity.make binds a Z-order sort key's dimensions to the model's fields.`,
    )
  }
  const casing = effectiveCasing(schema, index)
  const segments = prefix.map((part) => {
    const value = record[part.field]
    if (value === undefined || value === null) {
      throw new Error(`Missing composite attribute "${part.field}" in record`)
    }
    return prefixSegment(serializeSortKeyValue(value, casing), part.hash)
  })
  const levels = layout.dimensions.map((dim) => {
    const value = record[dim.field]
    if (value === undefined || value === null) {
      throw new Error(`Missing composite attribute "${dim.field}" in record`)
    }
    return dim.quantize(value)
  })
  return concatBytes([...segments, toBytes(interleave(layout, levels), layout.bytes)])
}

/** {@link composeSk} for a string half, {@link composeZOrderSk} for a Z-order half. */
export const composeSkValue = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): KeyValue =>
  isZOrderHalf(index.sk)
    ? composeZOrderSk(schema, index, record)
    : composeSk(schema, entityType, entityVersion, index, record)

/**
 * The item segment of an entity's history keys (version snapshots and
 * soft-delete tombstones): the composite part of the item's primary sort key,
 * exactly as `liveSk` — its live sort key — carries it (`kind_a#seq_0000000001`).
 * `undefined` for a primary index without sort key composites: one item per
 * partition, whose history keys carry no segment (see
 * `DynamoSchema.HistoryKeyOptions`).
 */
export const composeHistoryItemSegment = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  primary: IndexDefinition,
  liveSk: string,
): string | undefined => {
  if (primary.sk.composite.length === 0) return undefined
  const bare = composeSk(
    schema,
    entityType,
    entityVersion,
    { ...primary, sk: { ...primary.sk, composite: [] } },
    {},
  )
  return liveSk.startsWith(`${bare}#`) ? liveSk.slice(bare.length + 1) : undefined
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
): Record<string, KeyValue> => ({
  [index.pk.field]: composePk(schema, entityType, index, record),
  [index.sk.field]: composeSkValue(schema, entityType, entityVersion, index, record),
})

/**
 * Non-throwing variant of composeIndexKeys. Returns undefined if any composite
 * attribute is missing. Used for sparse GSI support.
 *
 * The presence check reads values without serializing them: a present value
 * that has no key text (`NaN`, `[EDD-9096]`) or no Z-order level
 * (`[EDD-9092]`) must reach the composer that refuses it, not be serialized
 * as text first — a Z-order half's `composite` lists its dimension fields.
 */
export const tryComposeIndexKeys = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): Record<string, KeyValue> | undefined => {
  const present = (composite: ReadonlyArray<string>) =>
    composite.every((attr) => record[attr] !== undefined && record[attr] !== null)
  if (!present(index.pk.composite) || !present(index.sk.composite)) return undefined
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
): Record<string, KeyValue> => {
  const result: Record<string, KeyValue> = {}
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
  readonly sets: Record<string, KeyValue>
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
  assertStringHalf(index, "composeSkPrefixUpTo")
  const slice = index.sk.composite.slice(0, stopBefore)
  const composites = extractSortKeyComposites(slice, record, effectiveCasing(schema, index))
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
 * Classify a Z-order sort key half the skip-predicate decided not to skip —
 * all or nothing. Every field feeds the address, so a partial record can't
 * compose a meaningful one and there is no truncation:
 *
 * - every prefix composite and dimension present in `record` → SET;
 * - otherwise `'sparse'` → drop (REMOVE);
 * - otherwise a field of the half in `removedSet` → drop (cascade override);
 * - otherwise noop (`'preserve'`: the stored address may go stale).
 */
const classifyZOrderHalf = (
  fields: ReadonlyArray<string>,
  record: Record<string, unknown>,
  policy: IndexPolicyKey,
  halfHasRemoved: boolean,
): "set" | "drop" | "noop" => {
  if (fields.every((field) => record[field] !== undefined && record[field] !== null)) return "set"
  if (policy === "sparse" || halfHasRemoved) return "drop"
  return "noop"
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
    readonly removedSet?: ReadonlySet<string>
  },
): GsiUpdateResult => {
  const sets: Record<string, KeyValue> = {}
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

    if (!skipSk && isZOrderHalf(index.sk)) {
      // A Z-order half is all or nothing (#171): its address follows every
      // field, so it is never truncated.
      const outcome = classifyZOrderHalf(skComposites, merged, policy.sk, skHasRemoved)
      if (outcome === "drop") removes.push(index.sk.field)
      else if (outcome === "set") sets[index.sk.field] = composeZOrderSk(schema, index, merged)
    } else if (!skipSk) {
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
    readonly casing?: DynamoSchema.Casing
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
    readonly casing?: DynamoSchema.Casing
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
 * Count the leading SK composites present in `record`, stopping at the first
 * missing one — the same walk `composeSortKeyPrefix` performs.
 */
const availableSkCount = (index: IndexDefinition, record: Record<string, unknown>): number => {
  assertStringHalf(index, "availableSkCount")
  let n = 0
  for (const attr of index.sk.composite) {
    const value = record[attr]
    if (value === undefined || value === null) break
    n++
  }
  return n
}

/**
 * Compose the operand for a `begins_with` sort key condition from the leading
 * SK composites present in `record`.
 *
 * This is `composeSortKeyPrefix` plus **the delimiter rule**: a trailing
 * `KEY_DELIMITER` is appended **iff at least one composite remains
 * unsupplied**.
 *
 * Why the rule is conditional:
 *
 * - **Partial prefix** — composites remain, so the stored key continues past
 *   this point with `#<next>`. Without the delimiter the operand stops
 *   mid-segment and silently matches sibling values that merely *start with*
 *   the supplied one: `status_done` would also match `status_done_archived`
 *   and `status_doneish` (issue #115).
 * - **Complete key** — every composite was supplied, so the stored key ends
 *   here. Appending a delimiter would match nothing — and leaving it off makes
 *   `begins_with` match every longer value of the last composite (`a` also
 *   matching `ab`). A complete key is matched with `=` instead: see
 *   {@link composeSortKeyCondition}, which query accessors use.
 *
 * Numeric composites need both halves of the rule: an integer's text is a
 * prefix of a fraction's (`0000000000000003` of `0000000000000003.14`), so
 * `{ seq: 3 }` as a bare `begins_with` operand would also match `seq` 3.14
 * and 3.5 — whether `seq` is followed by further composites (the delimiter
 * stops it) or is the last one (`=` stops it). Only non-negative integers are
 * fixed-width — do NOT "simplify" the rule away on the grounds that integer
 * fixtures pass either way.
 *
 * Every consumer that turns SK composites into a key *prefix* must use this
 * function (or the same rule) — the entity/GSI query accessors and the
 * `BETWEEN` bounds that clamp a `.where()` condition to an accessor-pinned
 * prefix. Two call sites disagreeing about where a segment ends is the bug.
 */
export const composeSortKeyBeginsWith = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  assertStringHalf(index, "composeSortKeyBeginsWith")
  const prefix = composeSortKeyPrefix(schema, entityType, entityVersion, index, record)
  const complete = availableSkCount(index, record) === index.sk.composite.length
  return complete ? prefix : `${prefix}${KEY_DELIMITER}`
}

/**
 * The sort key condition a query accessor sends for the leading SK composites
 * present in `record` (the caller has checked at least one is):
 *
 * - **Complete key** — every composite supplied: `{ eq }` on the composed
 *   key, which is exactly the key `composeSk` writes. `begins_with` on it
 *   would also match every longer value of the last composite — `name: "a"`
 *   matching `"ab"`, and `seq: 3` matching 3.14 and 3.5, whose key text
 *   extends 3's. On the primary index `=` also leaves out the item's history
 *   rows, whose keys extend the current one.
 * - **Partial prefix** — `{ beginsWith }` on {@link composeSortKeyBeginsWith}:
 *   the prefix and the delimiter, so it stops on a segment boundary.
 */
export const composeSortKeyCondition = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): { readonly eq: string } | { readonly beginsWith: string } => {
  assertStringHalf(index, "composeSortKeyCondition")
  const prefix = composeSortKeyPrefix(schema, entityType, entityVersion, index, record)
  return availableSkCount(index, record) === index.sk.composite.length
    ? { eq: prefix }
    : { beginsWith: `${prefix}${KEY_DELIMITER}` }
}

/**
 * Compose a partial sort key prefix for query operations.
 * Used when not all SK composite attributes are provided.
 *
 * For example, if SK composite is ["department", "hireDate"] and only "department"
 * is provided, this generates a begins_with prefix.
 *
 * This is the raw composed **value** at a position — it carries no trailing
 * delimiter. For a `begins_with` operand use `composeSortKeyBeginsWith`, which
 * adds the delimiter when composites remain.
 */
export const composeSortKeyPrefix = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  entityVersion: number,
  index: IndexDefinition,
  record: Record<string, unknown>,
): string => {
  assertStringHalf(index, "composeSortKeyPrefix")
  // Collect available composites and their names (stop at first missing)
  const casing = effectiveCasing(schema, index)
  const available: Array<string> = []
  const names: Array<string> = []
  for (const attr of index.sk.composite) {
    const value = record[attr]
    if (value === undefined || value === null) break
    available.push(serializeSortKeyValue(value, casing))
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
// Event item SK format: `<currentSk>#e#<orderBy value's sort key text>`.
// Casing is applied to both the `#e#` infix and the value for consistency with
// the rest of the SK — matches how every other composite segment is cased —
// and the value is escaped as every sort key composite is (`sortKeyText`).
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
  `${currentSk}#${applyCasing(EVENT_SK_INFIX, casing)}#${serializeSortKeyValue(orderByValue, casing)}`

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
