/**
 * @internal BoundVectorQuery — fluent builder for `SearchVectors`.
 *
 * Sibling of {@link BoundQuery}, deliberately narrower. `SearchVectors` has no
 * pagination and no cursor, so the cursor combinators (`.startFrom()`,
 * `.paginate()`, `.maxPages()`, `.reverse()`) and the page terminal (`.fetch()`)
 * are STRUCTURALLY ABSENT rather than present-and-failing: the builder cannot
 * express an operation the API does not have.
 *
 * `.partition()` is likewise enforced by the type. When the vector index
 * declares partition composites, the terminal methods only appear after
 * `.partition({...})` has been called — mirroring the "PK composites required"
 * rule on index query accessors.
 *
 * See `DESIGN.md §14 Vector Search`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { EmbedderService } from "@effect-dynamodb/schema/Embedder.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import type { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { EmbeddingError, VectorIndexBackfilling } from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import type {
  Similarity,
  VectorFilterInput,
  VectorIndexDefinition,
} from "@effect-dynamodb/schema/VectorIndex.js"
import { clampTopK, DEFAULT_TOP_K, toSimilarity } from "@effect-dynamodb/schema/VectorIndex.js"
import { Effect, Option } from "effect"
import { DynamoClient, type DynamoClientError } from "../DynamoClient.js"
import { fromAttributeMap, toAttributeValue } from "../Marshaller.js"
import type { TableConfig } from "../Table.js"

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * A single approximate-nearest-neighbour hit.
 *
 * `similarity` is normalized higher-is-more-similar for every distance
 * function; `rawScore` preserves the wire value (which runs the other way for
 * COSINE and EUCLIDEAN). See `DESIGN.md §14`.
 */
export interface VectorHit<A> {
  readonly item: A
  readonly similarity: Similarity
  readonly rawScore: number
}

/** Error channel for a vector search terminal. */
export type VectorSearchError =
  | DynamoClientError
  | ValidationError
  | EmbeddingError
  | VectorIndexBackfilling

// ---------------------------------------------------------------------------
// Builder types
// ---------------------------------------------------------------------------

/** Combinators available at every stage of the builder. */
export interface BoundVectorQueryCombinators<Model, Partition, A> {
  /**
   * Equality-only filter over the index's declared `INLINE_FILTER` attributes.
   *
   * `SearchConditionExpression` supports ONLY the equality operator (API
   * Reference). The restriction is expressed in one relaxable alias —
   * `VectorFilterInput` — so widening it when AWS adds range operators is a
   * single edit.
   */
  readonly filter: (
    filters: VectorFilterInput<Extract<keyof Model, string>>,
  ) => BoundVectorQuery<Model, Partition, A>

  /** Number of nearest neighbours to return. Clamped to 1..100; default 10. */
  readonly topK: (k: number) => BoundVectorQuery<Model, Partition, A>

  /** Project a subset of attributes. Returns partial records. */
  readonly select: (
    attributes: ReadonlyArray<Extract<keyof Model, string>>,
  ) => BoundVectorQuery<Model, Partition, Record<string, unknown>>
}

/** Terminals — available only once every required partition composite is bound. */
export interface BoundVectorQueryTerminals<A> {
  /**
   * Execute the search and collect the hits, most similar first.
   *
   * The ONLY terminal: `SearchVectors` returns at most `TopK` results in one
   * shot with no cursor, so there is nothing for `.fetch()` or `.paginate()` to
   * mean.
   */
  readonly collect: () => Effect.Effect<Array<VectorHit<A>>, VectorSearchError, never>
}

/** Partition binding — present iff the index declares partition composites. */
export interface BoundVectorQueryWithPartition<Model, Partition, A> {
  /**
   * Bind the index's declared partition composites. Required by the types when
   * `partition: [...]` is declared on the vector index — the composed HASH value
   * is mandatory in every `SearchVectors` call once an index has a HASH element.
   */
  readonly partition: (composites: Partition) => BoundVectorQuery<Model, never, A>
}

/**
 * Vector search builder. Terminals appear only once `Partition` is discharged,
 * so an index with declared partition composites cannot be searched without
 * supplying them.
 */
export type BoundVectorQuery<Model, Partition, A> = [Partition] extends [never]
  ? BoundVectorQueryCombinators<Model, Partition, A> & BoundVectorQueryTerminals<A>
  : BoundVectorQueryCombinators<Model, Partition, A> &
      BoundVectorQueryWithPartition<Model, Partition, A>

// ---------------------------------------------------------------------------
// Config + state
// ---------------------------------------------------------------------------

/** @internal Wiring supplied by `DynamoClient.make` when building an accessor. */
export interface BoundVectorQueryConfig {
  readonly entityType: string
  /** Logical vector index name (as declared on `Entity.make`). */
  readonly logicalName: string
  readonly definition: VectorIndexDefinition
  readonly schema: DynamoSchema.DynamoSchema
  readonly tableTag: import("effect").Context.Service<TableConfig, TableConfig>
  readonly decode: (raw: Record<string, unknown>) => Effect.Effect<any, ValidationError>
  readonly provide: <X, E>(eff: Effect.Effect<X, E, any>) => Effect.Effect<X, E, never>
}

/** @internal Immutable accumulated builder state. */
interface VectorQueryState {
  readonly query: string | ReadonlyArray<number>
  readonly partition: Record<string, unknown> | undefined
  readonly filters: Record<string, unknown>
  readonly topK: number
  readonly projection: ReadonlyArray<string> | undefined
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** @internal */
export class BoundVectorQueryImpl<Model, Partition, A> {
  constructor(
    readonly _config: BoundVectorQueryConfig,
    readonly _state: VectorQueryState,
  ) {}

  private _with(patch: Partial<VectorQueryState>): BoundVectorQueryImpl<Model, Partition, A> {
    return new BoundVectorQueryImpl(this._config, { ...this._state, ...patch })
  }

  partition(composites: Record<string, unknown>): BoundVectorQueryImpl<Model, never, A> {
    return new BoundVectorQueryImpl<Model, never, A>(this._config, {
      ...this._state,
      partition: composites,
    })
  }

  filter(filters: Record<string, unknown>): BoundVectorQueryImpl<Model, Partition, A> {
    return this._with({ filters: { ...this._state.filters, ...filters } })
  }

  topK(k: number): BoundVectorQueryImpl<Model, Partition, A> {
    return this._with({ topK: clampTopK(k) })
  }

  select(
    attributes: ReadonlyArray<string>,
  ): BoundVectorQueryImpl<Model, Partition, Record<string, unknown>> {
    return new BoundVectorQueryImpl<Model, Partition, Record<string, unknown>>(this._config, {
      ...this._state,
      projection: attributes,
    })
  }

  collect(): Effect.Effect<Array<VectorHit<A>>, VectorSearchError, never> {
    return this._config.provide(this._execute())
  }

  /** @internal The unprovided search program. */
  private _execute(): Effect.Effect<
    Array<VectorHit<A>>,
    VectorSearchError,
    DynamoClient | TableConfig
  > {
    const { entityType, logicalName, definition, schema, tableTag, decode } = this._config
    const state = this._state
    return Effect.gen(function* () {
      const client = yield* DynamoClient
      const { name: tableName } = yield* tableTag

      // 1. Resolve the query vector. A string goes through the Embedder; a
      //    number array is used verbatim (pre-computed query embeddings are a
      //    first-class case — reranking, cached queries, ANN benchmarking).
      const vector =
        typeof state.query === "string"
          ? yield* embedQuery(entityType, logicalName, definition, state.query)
          : state.query
      if (vector.length !== definition.dimensions) {
        return yield* new EmbeddingError({
          entityType,
          index: logicalName,
          reason:
            `Query vector has ${vector.length} dimensions but vector index ` +
            `"${definition.index}" declares ${definition.dimensions}.`,
        })
      }

      // 2. Compose the HASH partition value. Always present — the entity type
      //    is baked in, which is what scopes a shared physical index to one
      //    entity (see `DESIGN.md §14`).
      const partitionValue = KeyComposer.composeVectorPartition(
        schema,
        entityType,
        definition,
        state.partition ?? {},
      )

      // 3. Build the equality-only SearchConditionExpression.
      const names: Record<string, string> = { "#vp": definition.partitionField }
      const values: Record<string, AttributeValue> = { ":vp": toAttributeValue(partitionValue) }
      const conditions: Array<string> = ["#vp = :vp"]
      let filterIndex = 0
      for (const [field, value] of Object.entries(state.filters)) {
        if (value === undefined) continue
        const nameKey = `#vf${filterIndex}`
        const valueKey = `:vf${filterIndex}`
        names[nameKey] = field
        values[valueKey] = toAttributeValue(value)
        conditions.push(`${nameKey} = ${valueKey}`)
        filterIndex++
      }

      const input: {
        TableName: string
        IndexName: string
        SearchVector: Array<AttributeValue>
        TopK: number
        SearchConditionExpression: string
        ExpressionAttributeNames: Record<string, string>
        ExpressionAttributeValues: Record<string, AttributeValue>
        ProjectionExpression?: string
      } = {
        TableName: tableName,
        IndexName: definition.index,
        // Bare array of N values — NOT an L-wrapped list. The stored attribute
        // is an `L` of `N`; the request operand is the flat array. The
        // asymmetry never reaches users.
        SearchVector: vector.map((component) => ({ N: String(component) })),
        TopK: state.topK,
        SearchConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }

      if (state.projection !== undefined) {
        const projectionParts: Array<string> = []
        state.projection.forEach((attribute, index) => {
          const nameKey = `#vp${index}`
          names[nameKey] = attribute
          projectionParts.push(nameKey)
        })
        input.ProjectionExpression = projectionParts.join(", ")
      }

      const output = yield* client
        .searchVectors(input)
        .pipe(Effect.mapError((error) => classifyBackfill(error, tableName, definition.index)))

      // 4. Decode each hit through the entity schema and normalize the score.
      const hits: Array<VectorHit<A>> = []
      for (const result of output.SearchResults ?? []) {
        if (!result.Item) continue
        const raw = fromAttributeMap(result.Item) as Record<string, unknown>
        const decoded =
          state.projection === undefined ? yield* decode(raw) : (stripManagedAttributes(raw) as A)
        const rawScore = result.Score ?? 0
        hits.push({
          item: decoded as A,
          similarity: toSimilarity(rawScore, definition.distance),
          rawScore,
        })
      }
      return hits
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @internal Resolve the `Embedder` and embed the query text.
 *
 * Resolved via `Effect.serviceOption` for the same reason as the write path:
 * only entities with vector indexes need one, and a missing service should be a
 * pointed error rather than a widened `R` on every entity operation.
 */
const embedQuery = (
  entityType: string,
  logicalName: string,
  definition: VectorIndexDefinition,
  text: string,
): Effect.Effect<ReadonlyArray<number>, EmbeddingError, never> =>
  Effect.gen(function* () {
    const maybe = yield* Effect.serviceOption(Embedder)
    if (Option.isNone(maybe)) {
      return yield* new EmbeddingError({
        entityType,
        index: logicalName,
        reason:
          `No Embedder service is available to embed the search text. Provide one via ` +
          `DynamoClient.make({ embedder }), or pass a pre-computed query vector ` +
          `(number[]) instead of a string.`,
      })
    }
    const embedder: EmbedderService = maybe.value
    const embedded = yield* embedder.embed(text)
    if (embedded.length !== definition.dimensions) {
      return yield* new EmbeddingError({
        entityType,
        index: logicalName,
        reason:
          `Embedder produced ${embedded.length} dimensions but vector index ` +
          `"${definition.index}" declares ${definition.dimensions}.`,
      })
    }
    return embedded
  })

/**
 * @internal Translate a backfill rejection into a tagged error that names the
 * remedy. DynamoDB rejects `SearchVectors` until a newly created index reports
 * ACTIVE with `Backfilling: false`.
 */
const classifyBackfill = (
  error: DynamoClientError,
  tableName: string,
  indexName: string,
): DynamoClientError | VectorIndexBackfilling => {
  const cause = error.cause
  const message =
    typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message: unknown }).message)
      : String(cause)
  return /backfill|not active|is being created/i.test(message)
    ? new VectorIndexBackfilling({ tableName, indexName, cause })
    : error
}

/**
 * @internal Strip library-managed attributes from a projected result.
 *
 * Projected results bypass the entity schema decode (they are partial by
 * construction), so the `__edd_*` bookkeeping would otherwise leak into user
 * code the way it never does on the full-record path.
 */
const stripManagedAttributes = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("__edd_")) continue
    out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** @internal Create a vector search builder for a single accessor invocation. */
export const makeBoundVectorQuery = <Model, Partition, A>(
  config: BoundVectorQueryConfig,
  query: string | ReadonlyArray<number>,
): BoundVectorQuery<Model, Partition, A> =>
  new BoundVectorQueryImpl<Model, Partition, A>(config, {
    query,
    partition: undefined,
    filters: {},
    topK: DEFAULT_TOP_K,
    projection: undefined,
  }) as unknown as BoundVectorQuery<Model, Partition, A>
