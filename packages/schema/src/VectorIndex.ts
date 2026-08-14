/**
 * VectorIndex — declarative vector-search index configuration (pure).
 *
 * A vector index is declared on `Entity.make({ vectorIndexes })` and normalized
 * here into a {@link VectorIndexDefinition}. This module owns every pure concern
 * of vector search: attribute naming, quota validation, distance-function
 * normalization, and score→{@link Similarity} conversion.
 *
 * AWS-SDK-free by construction — the runtime `effect-dynamodb` package maps a
 * {@link VectorIndexDefinition} onto `CreateTable.VectorIndexes` /
 * `SearchVectorsInput` shapes.
 *
 * See `DESIGN.md §14 Vector Search`.
 */

import type * as DynamoSchema from "./DynamoSchema.js"

// ---------------------------------------------------------------------------
// Limits (DynamoDB service quotas)
// ---------------------------------------------------------------------------

/** Minimum vector dimensionality accepted by DynamoDB. */
export const MIN_DIMENSIONS = 1
/** Maximum vector dimensionality accepted by DynamoDB. */
export const MAX_DIMENSIONS = 4096
/** Minimum `TopK` accepted by `SearchVectors`. */
export const MIN_TOP_K = 1
/** Maximum `TopK` accepted by `SearchVectors` (hard limit — there is no pagination). */
export const MAX_TOP_K = 100
/** Default `TopK` applied when `.topK()` is not called. */
export const DEFAULT_TOP_K = 10
/** Maximum `INLINE_FILTER` attributes per vector index. */
export const MAX_INLINE_FILTERS = 18
/** Maximum vector indexes per physical table. */
export const MAX_VECTOR_INDEXES_PER_TABLE = 5

// ---------------------------------------------------------------------------
// Attribute naming — library-managed, mirrors the `__edd_e__` convention
// ---------------------------------------------------------------------------

/**
 * Name of the stored embedding attribute for a physical vector index.
 * Deliberately ugly so it cannot collide with a user model field.
 */
export const vectorAttributeName = (physicalIndexName: string): string =>
  `__edd_v_${physicalIndexName}__`

/**
 * Name of the composed HASH partition attribute for a physical vector index.
 * Always written alongside the vector — see `DESIGN.md §14`.
 */
export const vectorPartitionAttributeName = (physicalIndexName: string): string =>
  `__edd_vp_${physicalIndexName}__`

/**
 * Name of the soft-delete stash attribute. A tombstone keeps the embedding here
 * (non-indexed, so sparse semantics drop the item out of the index) so
 * `restore()` never has to call the Embedder again.
 */
export const vectorStashAttributeName = (physicalIndexName: string): string =>
  `__edd_vs_${physicalIndexName}__`

// ---------------------------------------------------------------------------
// Distance functions
// ---------------------------------------------------------------------------

/** Distance function for a vector index. Immutable once the index is created. */
export type DistanceFunction = "cosine" | "euclidean" | "dotProduct"

/** The three distance functions, in declaration order. */
export const distanceFunctions: ReadonlyArray<DistanceFunction> = [
  "cosine",
  "euclidean",
  "dotProduct",
]

/** Map a library distance function to the DynamoDB wire enum value. */
export const toWireDistanceFunction = (
  distance: DistanceFunction,
): "COSINE" | "EUCLIDEAN" | "DOT_PRODUCT" => {
  switch (distance) {
    case "cosine":
      return "COSINE"
    case "euclidean":
      return "EUCLIDEAN"
    case "dotProduct":
      return "DOT_PRODUCT"
  }
}

// ---------------------------------------------------------------------------
// Similarity — normalized, branded, higher-is-more-similar
// ---------------------------------------------------------------------------

declare const SimilarityBrand: unique symbol

/**
 * A normalized similarity score: **higher is always more similar**, regardless
 * of distance function. Branded so a raw wire score can never be mistaken for
 * one (COSINE and EUCLIDEAN scores run the other way).
 *
 * - `cosine` (wire 0…2, lower closer) → `1 - raw / 2`, giving 0…1.
 * - `euclidean` (wire 0…∞, lower closer) → `1 / (1 + raw)`, giving 0…1.
 * - `dotProduct` (wire −∞…∞, higher closer) → `raw` unchanged.
 */
export type Similarity = number & { readonly [SimilarityBrand]: "Similarity" }

/**
 * Normalize a raw `SearchVectors` score into a {@link Similarity}.
 *
 * See the ranking table in `DESIGN.md §14` — the emulation layer's unit tests
 * reproduce it verbatim.
 */
export const toSimilarity = (rawScore: number, distance: DistanceFunction): Similarity => {
  switch (distance) {
    case "cosine":
      return (1 - rawScore / 2) as Similarity
    case "euclidean":
      return (1 / (1 + rawScore)) as Similarity
    case "dotProduct":
      return rawScore as Similarity
  }
}

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Source-text derivation for an embedding.
 *
 * `fields` is a declared field list rather than an opaque function so the
 * library can introspect it — that is what lets `update` decide whether a write
 * touched the embedding source (see `DESIGN.md §14 Write path`). `compose` may
 * customize how the picked values are joined; the default joins non-empty values
 * with a single space.
 */
export interface VectorSourceConfig<TField extends string = string> {
  readonly fields: ReadonlyArray<TField>
  readonly compose?: ((picked: Record<string, unknown>) => string) | undefined
}

/**
 * Vector index configuration as authored on `Entity.make({ vectorIndexes })`.
 *
 * @typeParam TField - Union of model field names, so `source` / `partition` /
 *   `filters` are checked against the model at the type level.
 */
export interface VectorIndexConfig<TField extends string = string> {
  /** Physical vector index name on the table (e.g. `"vec1"`). */
  readonly name: string
  /** Embedding dimensionality. Immutable after `CreateTable`. */
  readonly dimensions: number
  /** Distance function. Immutable after `CreateTable`. Defaults to `"cosine"`. */
  readonly distance?: DistanceFunction | undefined
  /** Model fields feeding the embedding. */
  readonly source: VectorSourceConfig<TField>
  /**
   * Extra composites folded into the composed HASH partition attribute. The
   * entity type is always included; these narrow further (e.g. per-tenant).
   */
  readonly partition?: ReadonlyArray<TField> | undefined
  /** Model fields exposed as `INLINE_FILTER` attributes (equality-only, ≤ 18). */
  readonly filters?: ReadonlyArray<TField> | undefined
  /** Key casing override. Defaults to the table schema's casing. */
  readonly casing?: DynamoSchema.Casing | undefined
}

/**
 * Normalized internal form of a {@link VectorIndexConfig}. Every optional has
 * been resolved, and the two library-managed attribute names are precomputed.
 */
export interface VectorIndexDefinition {
  /** Physical vector index name on the table. */
  readonly index: string
  readonly dimensions: number
  readonly distance: DistanceFunction
  readonly sourceFields: ReadonlyArray<string>
  readonly compose: ((picked: Record<string, unknown>) => string) | undefined
  readonly partition: ReadonlyArray<string>
  readonly filters: ReadonlyArray<string>
  readonly casing: DynamoSchema.Casing | undefined
  /** `__edd_v_<index>__` — the stored embedding. */
  readonly vectorField: string
  /** `__edd_vp_<index>__` — the composed HASH partition value. */
  readonly partitionField: string
  /** `__edd_vs_<index>__` — the soft-delete stash. */
  readonly stashField: string
}

/**
 * Normalize a {@link VectorIndexConfig} into a {@link VectorIndexDefinition}.
 * Pure — validation lives in {@link validateVectorIndexes}.
 */
export const normalizeVectorIndexConfig = (config: VectorIndexConfig): VectorIndexDefinition => ({
  index: config.name,
  dimensions: config.dimensions,
  distance: config.distance ?? "cosine",
  sourceFields: [...config.source.fields],
  compose: config.source.compose,
  partition: config.partition ? [...config.partition] : [],
  filters: config.filters ? [...config.filters] : [],
  casing: config.casing,
  vectorField: vectorAttributeName(config.name),
  partitionField: vectorPartitionAttributeName(config.name),
  stashField: vectorStashAttributeName(config.name),
})

// ---------------------------------------------------------------------------
// Source text derivation
// ---------------------------------------------------------------------------

/**
 * Derive the text to embed from a record, using the index's declared source
 * fields. Returns `undefined` when no source field carries a usable value —
 * the caller then skips embedding entirely (sparse semantics keep the item out
 * of the index).
 */
export const deriveSourceText = (
  definition: VectorIndexDefinition,
  record: Record<string, unknown>,
): string | undefined => {
  const picked: Record<string, unknown> = {}
  for (const field of definition.sourceFields) {
    const value = record[field]
    if (value !== undefined && value !== null) picked[field] = value
  }
  if (Object.keys(picked).length === 0) return undefined
  if (definition.compose) {
    const composed = definition.compose(picked)
    return composed.length > 0 ? composed : undefined
  }
  const joined = definition.sourceFields
    .map((field) => picked[field])
    .filter((value): value is unknown => value !== undefined)
    .map((value) => String(value))
    .filter((value) => value.length > 0)
    .join(" ")
  return joined.length > 0 ? joined : undefined
}

/**
 * Does this update payload touch any of the index's source fields?
 *
 * Mirrors the per-half evaluation gate of policy-aware GSI composition (§7): a
 * writer that does not name a source field neither pays for an embedding call
 * nor clobbers a vector another writer owns. Membership (not value) is what
 * counts, so an explicit `undefined`/`null` still counts as touching.
 */
export const touchesSource = (
  definition: VectorIndexDefinition,
  updatePayload: Record<string, unknown>,
): boolean => definition.sourceFields.some((field) => field in updatePayload)

// ---------------------------------------------------------------------------
// Filters — equality-only (see DESIGN.md §14)
// ---------------------------------------------------------------------------

/**
 * The single relaxable alias for `SearchConditionExpression` operand shapes.
 *
 * The API Reference restricts the expression to the equality operator for BOTH
 * `HASH` and `INLINE_FILTER` attributes. The SDK JSDoc already advertises range
 * operators for `INLINE_FILTER`, so widening looks imminent — when it lands,
 * this alias is the one edit required.
 */
export type VectorFilterOperand = string | number | boolean

/** Equality-only filter shorthand: `{ category: "footwear", inStock: true }`. */
export type VectorFilterInput<TField extends string = string> = {
  readonly [K in TField]?: VectorFilterOperand
}

// ---------------------------------------------------------------------------
// Validation (EDD-903x)
// ---------------------------------------------------------------------------

/**
 * Validate an entity's vector index declarations at `Entity.make()` time.
 *
 * @throws on invalid configuration (EDD-903x).
 */
export const validateVectorIndexes = (params: {
  readonly entityType: string
  readonly definitions: Record<string, VectorIndexDefinition>
  readonly validFields: ReadonlySet<string>
}): void => {
  const { entityType, definitions, validFields } = params
  const sortedFields = () => [...validFields].sort().join(", ")
  const seenPhysical = new Map<string, string>()

  for (const [logicalName, definition] of Object.entries(definitions)) {
    if (
      !Number.isInteger(definition.dimensions) ||
      definition.dimensions < MIN_DIMENSIONS ||
      definition.dimensions > MAX_DIMENSIONS
    ) {
      throw new Error(
        `[EDD-9030] Entity "${entityType}": vector index "${logicalName}" has dimensions ` +
          `${definition.dimensions}. DynamoDB accepts an integer in ${MIN_DIMENSIONS}..${MAX_DIMENSIONS}.`,
      )
    }

    if (definition.sourceFields.length === 0) {
      throw new Error(
        `[EDD-9031] Entity "${entityType}": vector index "${logicalName}" declares no source.fields. ` +
          `At least one model field must feed the embedding.`,
      )
    }

    const checkFields = (label: string, fields: ReadonlyArray<string>): void => {
      for (const field of fields) {
        if (!validFields.has(field)) {
          throw new Error(
            `[EDD-9031] Entity "${entityType}": vector index "${logicalName}" ${label} references ` +
              `unknown attribute "${field}". Valid attributes: ${sortedFields()}`,
          )
        }
      }
    }
    checkFields("source.fields", definition.sourceFields)
    checkFields("partition", definition.partition)
    checkFields("filters", definition.filters)

    if (definition.filters.length > MAX_INLINE_FILTERS) {
      throw new Error(
        `[EDD-9032] Entity "${entityType}": vector index "${logicalName}" declares ` +
          `${definition.filters.length} filters. DynamoDB allows at most ${MAX_INLINE_FILTERS} ` +
          `INLINE_FILTER attributes per vector index.`,
      )
    }

    const duplicateFilter = definition.filters.find(
      (field, i) => definition.filters.indexOf(field) !== i,
    )
    if (duplicateFilter !== undefined) {
      throw new Error(
        `[EDD-9032] Entity "${entityType}": vector index "${logicalName}" lists filter ` +
          `"${duplicateFilter}" more than once.`,
      )
    }

    const previous = seenPhysical.get(definition.index)
    if (previous !== undefined) {
      throw new Error(
        `[EDD-9033] Entity "${entityType}": vector indexes "${previous}" and "${logicalName}" both ` +
          `target physical index "${definition.index}". One entity may bind a physical vector index once ` +
          `— sharing is across entities, not within one.`,
      )
    }
    seenPhysical.set(definition.index, logicalName)
  }

  if (seenPhysical.size > MAX_VECTOR_INDEXES_PER_TABLE) {
    throw new Error(
      `[EDD-9034] Entity "${entityType}" declares ${seenPhysical.size} vector indexes. ` +
        `DynamoDB allows at most ${MAX_VECTOR_INDEXES_PER_TABLE} per table.`,
    )
  }
}

/**
 * Clamp a caller-supplied `TopK` into DynamoDB's accepted range.
 *
 * Clamping (rather than failing) mirrors how `.limit()` behaves elsewhere in the
 * library — an out-of-range K is a caller mistake with an obvious correct
 * interpretation, not a data-integrity problem.
 */
export const clampTopK = (topK: number): number =>
  Math.min(MAX_TOP_K, Math.max(MIN_TOP_K, Math.floor(topK)))
