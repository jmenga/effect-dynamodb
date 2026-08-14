/**
 * VectorSearchEmulation — a local stand-in for DynamoDB `SearchVectors`.
 *
 * DynamoDB Local does not implement vector search: `CreateTable` silently
 * accepts and discards `VectorIndexes`, and `SearchVectors` fails with
 * `UnknownOperationException`. LocalStack wraps DynamoDB Local and inherits the
 * gap. Without an emulation layer there is no way to exercise the full
 * write → search round trip without an AWS account, which would leave the most
 * interesting half of the feature untested.
 *
 * This layer wraps a `DynamoClient` layer and replaces `searchVectors` with a
 * Scan + brute-force implementation. Every other operation passes through
 * untouched, so the same layer stack serves the connected suite and the
 * runnable example.
 *
 * Fidelity is deliberate, not approximate: all three distance functions are
 * computed exactly as the developer guide documents them (including the score
 * DIRECTIONS, which differ), the HASH/INLINE_FILTER equality predicates are
 * evaluated, `ProjectionExpression` is honoured, and results are truncated to
 * `TopK`. The ranking output is unit-tested against the developer guide's
 * reference table.
 *
 * What it does NOT emulate: approximate (as opposed to exact) nearest-neighbour
 * behaviour, backfill states, or consumed-capacity reporting. An emulated search
 * is an exhaustive scan, so it is exact and slow — correct for tests, useless
 * for load.
 *
 * See `DESIGN.md §14 Vector Search`.
 */

import type {
  AttributeValue,
  SearchVectorsCommandInput,
  SearchVectorsCommandOutput,
} from "@aws-sdk/client-dynamodb"
import type {
  DistanceFunction,
  VectorIndexDefinition,
} from "@effect-dynamodb/schema/VectorIndex.js"
import { vectorAttributeName } from "@effect-dynamodb/schema/VectorIndex.js"
import { Effect, Layer } from "effect"
import { DynamoClient, type DynamoClientError, type DynamoClientService } from "./DynamoClient.js"
import { mergeVectorIndexes } from "./Table.js"

// ---------------------------------------------------------------------------
// Index registry
// ---------------------------------------------------------------------------

/** What the emulator needs to know about a physical vector index. */
export interface EmulatedVectorIndex {
  /** Attribute holding the stored embedding (`L` of `N`). */
  readonly vectorAttribute: string
  /** Distance function used to score candidates. */
  readonly distance: DistanceFunction
}

/** Minimal structural shape of a `Table` — avoids importing the full type. */
interface TableLikeForEmulation {
  readonly entities: Record<string, { readonly _tag: "Entity" }>
}

/**
 * Options for {@link layer}.
 *
 * `tables` is the ergonomic form: every registered entity's vector index
 * declarations are read straight off the table, so the emulator always agrees
 * with the definitions the writes used. `indexes` is the escape hatch for
 * hand-rolled setups.
 *
 * An index that appears in neither falls back to the library naming convention
 * (`__edd_v_<IndexName>__`) with cosine distance — enough for a smoke test, but
 * a declared table is what you want.
 */
export interface EmulationOptions {
  readonly tables?: Record<string, TableLikeForEmulation> | undefined
  readonly indexes?: Record<string, EmulatedVectorIndex> | undefined
}

/** @internal Build the IndexName → {vectorAttribute, distance} registry. */
const buildRegistry = (options: EmulationOptions | undefined): Map<string, EmulatedVectorIndex> => {
  const registry = new Map<string, EmulatedVectorIndex>()
  for (const table of Object.values(options?.tables ?? {})) {
    const merged = mergeVectorIndexes(
      table.entities as unknown as Parameters<typeof mergeVectorIndexes>[0],
    )
    for (const [indexName, { definition }] of merged) {
      registry.set(indexName, toEmulated(definition))
    }
  }
  for (const [indexName, entry] of Object.entries(options?.indexes ?? {})) {
    registry.set(indexName, entry)
  }
  return registry
}

/** @internal */
const toEmulated = (definition: VectorIndexDefinition): EmulatedVectorIndex => ({
  vectorAttribute: definition.vectorField,
  distance: definition.distance,
})

// ---------------------------------------------------------------------------
// Distance functions — see the reference table in DESIGN.md §14
// ---------------------------------------------------------------------------

/** @internal Dot product. Higher is more similar; may be negative. */
export const dotProduct = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0)
  return sum
}

/**
 * @internal Cosine DISTANCE (`1 - cosine similarity`), range 0…2.
 * Lower is more similar — the same direction DynamoDB reports.
 */
export const cosineDistance = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  const magnitudeA = Math.sqrt(dotProduct(a, a))
  const magnitudeB = Math.sqrt(dotProduct(b, b))
  if (magnitudeA === 0 || magnitudeB === 0) return 1
  return 1 - dotProduct(a, b) / (magnitudeA * magnitudeB)
}

/** @internal Euclidean (L2) distance, range 0…∞. Lower is more similar. */
export const euclideanDistance = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  let sum = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

/** @internal Score a candidate exactly as DynamoDB would report it. */
export const scoreVector = (
  query: ReadonlyArray<number>,
  candidate: ReadonlyArray<number>,
  distance: DistanceFunction,
): number => {
  switch (distance) {
    case "cosine":
      return cosineDistance(query, candidate)
    case "euclidean":
      return euclideanDistance(query, candidate)
    case "dotProduct":
      return dotProduct(query, candidate)
  }
}

/**
 * @internal Is a LOWER raw score more similar for this distance function?
 * COSINE and EUCLIDEAN report distances; DOT_PRODUCT reports a similarity.
 */
const lowerIsCloser = (distance: DistanceFunction): boolean => distance !== "dotProduct"

// ---------------------------------------------------------------------------
// AttributeValue helpers
// ---------------------------------------------------------------------------

/** @internal Read a stored embedding (`L` of `N`) out of an item. */
const readVector = (value: AttributeValue | undefined): ReadonlyArray<number> | undefined => {
  if (value === undefined) return undefined
  if (value.L !== undefined) {
    const numbers = value.L.map((element) => Number(element.N))
    return numbers.some((n) => Number.isNaN(n)) ? undefined : numbers
  }
  if (value.NS !== undefined) return value.NS.map((n) => Number(n))
  return undefined
}

/** @internal Structural equality over the scalar AttributeValue shapes. */
const attributeEquals = (a: AttributeValue | undefined, b: AttributeValue | undefined): boolean => {
  if (a === undefined || b === undefined) return false
  if (a.S !== undefined || b.S !== undefined) return a.S === b.S
  if (a.N !== undefined || b.N !== undefined) return Number(a.N) === Number(b.N)
  if (a.BOOL !== undefined || b.BOOL !== undefined) return a.BOOL === b.BOOL
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * @internal Parse the equality-only `SearchConditionExpression`.
 *
 * The expression grammar the library emits (and the only one the API supports)
 * is a conjunction of `#name = :value` terms, so a split is a complete parser
 * rather than a shortcut. Anything unrecognised is skipped rather than throwing:
 * an over-permissive emulator surfaces as a failed assertion in the test that
 * cares, which is easier to debug than a parse error from a layer.
 */
const parseEqualityConditions = (
  expression: string | undefined,
  names: Record<string, string> | undefined,
  values: Record<string, AttributeValue> | undefined,
): ReadonlyArray<{ readonly attribute: string; readonly value: AttributeValue }> => {
  if (!expression) return []
  const conditions: Array<{ attribute: string; value: AttributeValue }> = []
  for (const term of expression.split(/\s+AND\s+/i)) {
    const match = term.trim().match(/^([#\w.]+)\s*=\s*(:[\w]+)$/)
    if (!match) continue
    const rawName = match[1]!
    const rawValue = match[2]!
    const attribute = rawName.startsWith("#") ? (names?.[rawName] ?? rawName) : rawName
    const value = values?.[rawValue]
    if (value === undefined) continue
    conditions.push({ attribute, value })
  }
  return conditions
}

/** @internal Resolve a `ProjectionExpression` into concrete attribute names. */
const parseProjection = (
  expression: string | undefined,
  names: Record<string, string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (!expression) return undefined
  return expression
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith("#") ? (names?.[part] ?? part) : part))
}

// ---------------------------------------------------------------------------
// Emulated searchVectors
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link DynamoClientService} so `searchVectors` is emulated locally.
 * Every other operation delegates to the wrapped service unchanged.
 */
export const wrap = (
  service: DynamoClientService,
  options?: EmulationOptions,
): DynamoClientService => {
  const registry = buildRegistry(options)
  return {
    ...service,
    searchVectors: (
      input: SearchVectorsCommandInput,
    ): Effect.Effect<SearchVectorsCommandOutput, DynamoClientError> =>
      Effect.gen(function* () {
        const indexName = input.IndexName ?? ""
        const index = registry.get(indexName) ?? {
          vectorAttribute: vectorAttributeName(indexName),
          distance: "cosine" as const,
        }
        const queryVector = (input.SearchVector ?? []).map((element) => Number(element.N))
        const conditions = parseEqualityConditions(
          input.SearchConditionExpression,
          input.ExpressionAttributeNames,
          input.ExpressionAttributeValues,
        )
        const projection = parseProjection(
          input.ProjectionExpression,
          input.ExpressionAttributeNames,
        )
        const topK = input.TopK ?? 10

        // Exhaustive scan — the emulator trades speed for exactness.
        const candidates: Array<{ item: Record<string, AttributeValue>; score: number }> = []
        let exclusiveStartKey: Record<string, AttributeValue> | undefined
        do {
          const page = yield* service.scan({
            TableName: input.TableName,
            ExclusiveStartKey: exclusiveStartKey,
          })
          for (const item of page.Items ?? []) {
            const record = item as Record<string, AttributeValue>
            // Sparse index semantics: no embedding ⇒ not in the index.
            const stored = readVector(record[index.vectorAttribute])
            if (stored === undefined) continue
            if (!conditions.every((c) => attributeEquals(record[c.attribute], c.value))) continue
            candidates.push({
              item: record,
              score: scoreVector(queryVector, stored, index.distance),
            })
          }
          exclusiveStartKey = page.LastEvaluatedKey as Record<string, AttributeValue> | undefined
        } while (exclusiveStartKey !== undefined)

        candidates.sort((a, b) =>
          lowerIsCloser(index.distance) ? a.score - b.score : b.score - a.score,
        )

        return {
          $metadata: {},
          SearchResults: candidates.slice(0, topK).map(({ item, score }) => ({
            Item: projection === undefined ? item : project(item, projection),
            Score: score,
          })),
        } satisfies SearchVectorsCommandOutput
      }),
  }
}

/** @internal Reduce an item to the projected attributes. */
const project = (
  item: Record<string, AttributeValue>,
  attributes: ReadonlyArray<string>,
): Record<string, AttributeValue> => {
  const projected: Record<string, AttributeValue> = {}
  for (const attribute of attributes) {
    const value = item[attribute]
    if (value !== undefined) projected[attribute] = value
  }
  return projected
}

/**
 * Wrap a `DynamoClient` layer so `searchVectors` is emulated locally.
 *
 * @example
 * ```typescript
 * const DdbLocal = DynamoClient.layer({ region: "us-east-1", endpoint: "http://localhost:8000" })
 * const Emulated = VectorSearchEmulation.layer(DdbLocal, { tables: { MainTable } })
 * ```
 */
export const layer = <E, R>(
  inner: Layer.Layer<DynamoClient, E, R>,
  options?: EmulationOptions,
): Layer.Layer<DynamoClient, E, R> =>
  Layer.effect(
    DynamoClient,
    Effect.map(DynamoClient, (service) => wrap(service, options)),
  ).pipe(Layer.provide(inner)) as Layer.Layer<DynamoClient, E, R>
