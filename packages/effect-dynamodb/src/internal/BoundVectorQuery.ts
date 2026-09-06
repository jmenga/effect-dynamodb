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
import {
  EmbeddingError,
  ValidationError as ValidationErrorClass,
  VectorIndexBackfilling,
} from "@effect-dynamodb/schema/Errors.js"
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
export interface BoundVectorQueryCombinators<Model, Partition, Filters extends string, A> {
  /**
   * Equality-only filter over the index's declared `INLINE_FILTER` attributes.
   *
   * Two restrictions, both from the API rather than this library:
   *
   * 1. Only the equality operator is supported. That lives in one relaxable
   *    alias — `VectorFilterInput` — so widening it when AWS adds range
   *    operators for `INLINE_FILTER` is a single edit.
   * 2. Only attributes declared in the index's `filters: [...]` are filterable.
   *    `Filters` is that declared tuple as a union, so filtering on an
   *    undeclared attribute is a compile error rather than a
   *    `ValidationException` discovered in production.
   */
  readonly filter: (
    filters: VectorFilterInput<Filters>,
  ) => BoundVectorQuery<Model, Partition, Filters, A>

  /** Number of nearest neighbours to return. Clamped to 1..100; default 10. */
  readonly topK: (k: number) => BoundVectorQuery<Model, Partition, Filters, A>

  /** Project a subset of attributes. Returns partial records. */
  readonly select: (
    attributes: ReadonlyArray<Extract<keyof Model, string>>,
  ) => BoundVectorQuery<Model, Partition, Filters, Record<string, unknown>>
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
export interface BoundVectorQueryWithPartition<Model, Partition, Filters extends string, A> {
  /**
   * Bind the index's declared partition composites. Required by the types when
   * `partition: [...]` is declared on the vector index — the composed HASH value
   * is mandatory in every `SearchVectors` call once an index has a HASH element.
   */
  readonly partition: (composites: Partition) => BoundVectorQuery<Model, never, Filters, A>
}

/**
 * Vector search builder. Terminals appear only once `Partition` is discharged,
 * so an index with declared partition composites cannot be searched without
 * supplying them.
 */
export type BoundVectorQuery<Model, Partition, Filters extends string, A> = [Partition] extends [
  never,
]
  ? BoundVectorQueryCombinators<Model, Partition, Filters, A> & BoundVectorQueryTerminals<A>
  : BoundVectorQueryCombinators<Model, Partition, Filters, A> &
      BoundVectorQueryWithPartition<Model, Partition, Filters, A>

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
  /**
   * Domain field name → stored DynamoDB attribute name. Filter attributes,
   * projections and the emitted `SearchSchema` must all use STORED names —
   * items are written after `renameToDynamo`, so a `storedAs`-renamed field
   * would otherwise be filtered/projected under a name that is not on disk.
   */
  readonly resolveDbName: (domainName: string) => string
  /**
   * The entity's composite key form (`internal/CompositeCodec.ts`).
   *
   * `.partition(composites)` takes Type-side domain values, while the write
   * path composes `__edd_vp_*` from the key form — so without this, search
   * composed a different partition from `put` and a `DateEpochMs` partition
   * composite matched nothing.
   */
  readonly keyForm: (record: Record<string, unknown>) => Record<string, unknown>
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
export class BoundVectorQueryImpl<Model, Partition, Filters extends string, A> {
  constructor(
    readonly _config: BoundVectorQueryConfig,
    readonly _state: VectorQueryState,
  ) {}

  private _with(
    patch: Partial<VectorQueryState>,
  ): BoundVectorQueryImpl<Model, Partition, Filters, A> {
    return new BoundVectorQueryImpl(this._config, { ...this._state, ...patch })
  }

  partition(composites: Record<string, unknown>): BoundVectorQueryImpl<Model, never, Filters, A> {
    return new BoundVectorQueryImpl<Model, never, Filters, A>(this._config, {
      ...this._state,
      partition: composites,
    })
  }

  filter(filters: Record<string, unknown>): BoundVectorQueryImpl<Model, Partition, Filters, A> {
    return this._with({ filters: { ...this._state.filters, ...filters } })
  }

  topK(k: number): BoundVectorQueryImpl<Model, Partition, Filters, A> {
    return this._with({ topK: clampTopK(k) })
  }

  select(
    attributes: ReadonlyArray<string>,
  ): BoundVectorQueryImpl<Model, Partition, Filters, Record<string, unknown>> {
    return new BoundVectorQueryImpl<Model, Partition, Filters, Record<string, unknown>>(
      this._config,
      { ...this._state, projection: attributes },
    )
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
    const {
      entityType,
      logicalName,
      definition,
      schema,
      tableTag,
      decode,
      resolveDbName,
      keyForm,
    } = this._config
    const state = this._state
    return Effect.gen(function* () {
      const client = yield* DynamoClient
      const { name: tableName } = yield* tableTag

      // 0. Only attributes declared in `filters: [...]` are INLINE_FILTER
      //    attributes on the physical index. Filtering on anything else is a
      //    ValidationException from DynamoDB — catch it here so the failure is
      //    tagged, local, and names the declared set. (The type-level guard
      //    covers callers who use the typed accessor; this covers erased or
      //    dynamically-built filter records.)
      const declaredFilters = new Set(definition.filters)
      for (const field of Object.keys(state.filters)) {
        if (state.filters[field] === undefined) continue
        if (declaredFilters.has(field)) continue
        const declared = [...declaredFilters].sort().join(", ")
        return yield* new ValidationErrorClass({
          entityType,
          operation: `vectorSearch.${logicalName}.filter`,
          cause:
            `Attribute "${field}" is not an INLINE_FILTER attribute of vector index ` +
            `"${definition.index}". Declared filters: ${declared.length > 0 ? declared : "(none)"}. ` +
            `Add it to \`filters: [...]\` on the vector index, or filter after .collect().`,
        })
      }

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
      const partitionKeyForm = keyForm(state.partition ?? {})
      const partitionValue = KeyComposer.composeVectorPartition(
        schema,
        entityType,
        definition,
        partitionKeyForm,
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
        // Stored attribute name — a `storedAs`-renamed field lives on disk (and
        // in the index's SearchSchema) under its DB name, not its domain name.
        names[nameKey] = resolveDbName(field)
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
          const nameKey = `#vpr${index}`
          // Same stored-name reasoning as the filter attributes above.
          names[nameKey] = resolveDbName(attribute)
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
        // A result with no Score cannot be ranked or normalized. Coercing it to
        // 0 would be a lie under DOT_PRODUCT, where 0 is a real (orthogonal)
        // score — drop it instead.
        if (result.Score === undefined || result.Score === null) continue
        const raw = fromAttributeMap(result.Item) as Record<string, unknown>
        const decoded =
          state.projection === undefined
            ? yield* decode(raw)
            : (projectDomainNames(raw, state.projection, resolveDbName) as A)
        const rawScore = result.Score
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
  const fields = (typeof cause === "object" && cause !== null ? cause : {}) as Record<
    string,
    unknown
  >
  const read = (key: string): string | undefined =>
    fields[key] === undefined ? undefined : String(fields[key])
  // Prefer the structured discriminators — an SDK error's `name`/`Code` is
  // stable, whereas the human-readable message is not. The regex over the
  // message stays as a fallback for shapes that only carry prose.
  const name = read("name")
  const code = read("Code") ?? read("code")
  if (
    name === "IndexNotActiveException" ||
    name === "VectorIndexNotReadyException" ||
    code === "IndexNotActiveException" ||
    code === "VectorIndexNotReadyException"
  ) {
    return new VectorIndexBackfilling({ tableName, indexName, cause })
  }
  const message = read("message") ?? String(cause)
  return /backfill|not active|is being created/i.test(message)
    ? new VectorIndexBackfilling({ tableName, indexName, cause })
    : error
}

/**
 * @internal Rebuild a projected result under DOMAIN field names.
 *
 * Projected results bypass the entity schema decode (they are partial by
 * construction), which is also what bypasses the usual DB→domain rename. Read
 * each requested attribute from its stored name and emit it under the name the
 * caller asked for, so a `storedAs`-renamed field behaves the same here as on
 * the full-record path. Library-managed `__edd_*` attributes are never
 * requested, so they cannot leak.
 */
const projectDomainNames = (
  raw: Record<string, unknown>,
  projection: ReadonlyArray<string>,
  resolveDbName: (domainName: string) => string,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const domainName of projection) {
    const value = raw[resolveDbName(domainName)]
    if (value !== undefined) out[domainName] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** @internal Create a vector search builder for a single accessor invocation. */
export const makeBoundVectorQuery = <Model, Partition, Filters extends string, A>(
  config: BoundVectorQueryConfig,
  query: string | ReadonlyArray<number>,
): BoundVectorQuery<Model, Partition, Filters, A> =>
  new BoundVectorQueryImpl<Model, Partition, Filters, A>(config, {
    query,
    partition: undefined,
    filters: {},
    topK: DEFAULT_TOP_K,
    projection: undefined,
  }) as unknown as BoundVectorQuery<Model, Partition, Filters, A>
