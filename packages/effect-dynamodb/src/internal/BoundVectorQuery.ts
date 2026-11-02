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
 * Offloaded fields (#179, design §8.2, §8.4): the hits load together — one
 * batched resolution of their blob pointers — under the builder's read modes
 * (`.offloaded(mode)`, default overflow eager, binary lazy), which re-type the
 * hits and the terminal's blob errors, as on every other read builder. A
 * `select` projection is a raw projection: it resolves only when it names an
 * offloaded (or packed) attribute.
 *
 * See `DESIGN.md §14 Vector Search`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { EmbedderService } from "@effect-dynamodb/schema/Embedder.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import type { BlobStoreError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import {
  EmbeddingError,
  ValidationError as ValidationErrorClass,
  VectorIndexBackfilling,
} from "@effect-dynamodb/schema/Errors.js"
import type { OffloadMode } from "@effect-dynamodb/schema/internal/EntityTypes.js"
import { ownValue, setOwn } from "@effect-dynamodb/schema/internal/OwnNames.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import type {
  Similarity,
  VectorFilterInput,
  VectorIndexDefinition,
} from "@effect-dynamodb/schema/VectorIndex.js"
import { DEFAULT_TOP_K, toSimilarity } from "@effect-dynamodb/schema/VectorIndex.js"
import { Effect, Option } from "effect"
import type { DynamoClient, DynamoClientError } from "../DynamoClient.js"
import { fromAttributeMap, toAttributeValue } from "../Marshaller.js"
import type { NoOffloadState, OffloadModes, OffloadState } from "../Offload.js"
import type { TableConfig } from "../Table.js"
import * as Capacity from "./Capacity.js"
import { operandAsStored, type StoredFormAt } from "./Expr.js"
import { DEFAULT_MODES, type Modes, parseModes } from "./OffloadRead.js"
import type { OffloadedView, ReadErrors, WithItem, WithModes } from "./OffloadTypes.js"
import { marshalOrFail } from "./TransactableOps.js"
import { diagnoseFailure, explainDiagnosis, withCause } from "./WriteDiagnosis.js"

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

/**
 * Combinators available at every stage of the builder. `O` is the builder's
 * offload state (#179, design §9.2): `NoOffloadState` for an entity that
 * offloads nothing, whose types are exactly what they were before.
 */
export interface BoundVectorQueryCombinators<
  Model,
  Partition,
  Filters extends string,
  A,
  O extends OffloadState = NoOffloadState,
> {
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
  ) => BoundVectorQuery<Model, Partition, Filters, A, O>

  /**
   * Number of nearest neighbours to return; default 10. Sent as given, never
   * clamped: DynamoDB accepts an integer in 1..100, and when it rejects the
   * value `collect()` fails with a `ValidationError` naming it.
   */
  readonly topK: (k: number) => BoundVectorQuery<Model, Partition, Filters, A, O>

  /**
   * Project a subset of attributes. Returns partial records — a raw
   * projection: a projected packed or overflow field holds its parsed JSON
   * wire form (eager by default), a binary one its handle (lazy by default).
   */
  readonly select: (
    attributes: ReadonlyArray<Extract<keyof Model, string>>,
  ) => BoundVectorQuery<
    Model,
    Partition,
    Filters,
    Record<string, unknown>,
    WithItem<O, Record<string, unknown>>
  >

  /**
   * Read the hits' offloaded fields (#179) in `mode` — `"eager"` / `"lazy"`
   * for both kinds, or `{ overflow?, binary? }` over the current modes
   * (defaults: overflow eager, binary lazy). Re-types the hits and the
   * terminal's blob errors; a lazy read fetches nothing until a handle is
   * read. An unknown mode (untyped code) throws `[EDD-9117]`. An entity that
   * offloads nothing is unchanged.
   */
  readonly offloaded: <const M extends OffloadMode | OffloadModes>(
    mode: M,
  ) => BoundVectorQuery<Model, Partition, Filters, OffloadedView<A, O, M>, WithModes<O, M>>
}

/** Terminals — available only once every required partition composite is bound. */
export interface BoundVectorQueryTerminals<A, O extends OffloadState = NoOffloadState> {
  /**
   * Execute the search and collect the hits, most similar first.
   *
   * The ONLY terminal: `SearchVectors` returns at most `TopK` results in one
   * shot with no cursor, so there is nothing for `.fetch()` or `.paginate()` to
   * mean.
   */
  readonly collect: () => Effect.Effect<
    Array<VectorHit<A>>,
    VectorSearchError | ReadErrors<O>,
    never
  >
}

/** Partition binding — present iff the index declares partition composites. */
export interface BoundVectorQueryWithPartition<
  Model,
  Partition,
  Filters extends string,
  A,
  O extends OffloadState = NoOffloadState,
> {
  /**
   * Bind the index's declared partition composites. Required by the types when
   * `partition: [...]` is declared on the vector index — the composed HASH value
   * is mandatory in every `SearchVectors` call once an index has a HASH element.
   */
  readonly partition: (composites: Partition) => BoundVectorQuery<Model, never, Filters, A, O>
}

/**
 * Vector search builder. Terminals appear only once `Partition` is discharged,
 * so an index with declared partition composites cannot be searched without
 * supplying them.
 */
export type BoundVectorQuery<
  Model,
  Partition,
  Filters extends string,
  A,
  O extends OffloadState = NoOffloadState,
> = [Partition] extends [never]
  ? BoundVectorQueryCombinators<Model, Partition, Filters, A, O> & BoundVectorQueryTerminals<A, O>
  : BoundVectorQueryCombinators<Model, Partition, Filters, A, O> &
      BoundVectorQueryWithPartition<Model, Partition, Filters, A, O>

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
  /** Decode a hit's (already loaded) stored-name row under `modes`. */
  readonly decode: (
    raw: Record<string, unknown>,
    modes: Modes,
  ) => Effect.Effect<any, ValidationError | BlobStoreError>
  readonly provide: <X, E>(eff: Effect.Effect<X, E, any>) => Effect.Effect<X, E, never>
  /**
   * Load, in place, a batch of stored-name rows (#179): unpack their packed
   * attributes and resolve their blob pointers per `modes` — one batched
   * resolution for all the hits. `raw`: a projection's rows, whose values
   * stay their JSON wire form, as every other projection path returns them.
   */
  readonly loadRows: (
    rows: ReadonlyArray<Record<string, unknown>>,
    options: { readonly operation: string; readonly modes: Modes; readonly raw?: boolean },
  ) => Effect.Effect<void, ValidationError | BlobStoreError>
  /**
   * The stored attributes {@link loadRows} may rewrite. A projection naming
   * none of them loads nothing.
   */
  readonly readAttributes: ReadonlyArray<string>
  /**
   * Domain field name → stored DynamoDB attribute name. Filter attributes,
   * projections and the emitted `SearchSchema` must all use STORED names —
   * items are written after `renameToDynamo`, so a `storedAs`-renamed field
   * would otherwise be filtered/projected under a name that is not on disk.
   */
  readonly resolveDbName: (domainName: string) => string
  /**
   * How the entity stores a filter's value at a field (#242): an equality filter's value that is
   * one of Effect's instances, a `Date` or a primitive the field stores as another type is sent in
   * that form (`operandAsStored`).
   */
  readonly storedAt?: StoredFormAt | undefined
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
  /** The read modes of the hits' offloaded fields (#179). */
  readonly modes: Modes
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
    // Sent as given (#144): DynamoDB's rejection of a TopK outside 1..100 is
    // diagnosed at `collect()`, never clamped into a smaller search.
    return this._with({ topK: k })
  }

  select(
    attributes: ReadonlyArray<string>,
  ): BoundVectorQueryImpl<Model, Partition, Filters, Record<string, unknown>> {
    return new BoundVectorQueryImpl<Model, Partition, Filters, Record<string, unknown>>(
      this._config,
      { ...this._state, projection: attributes },
    )
  }

  offloaded(
    mode: OffloadMode | OffloadModes,
  ): BoundVectorQueryImpl<Model, Partition, Filters, any> {
    return this._with({
      modes: parseModes(mode, this._state.modes, "vectorSearch.offloaded"),
    }) as BoundVectorQueryImpl<Model, Partition, Filters, any>
  }

  collect(): Effect.Effect<Array<VectorHit<A>>, VectorSearchError | BlobStoreError, never> {
    // A named operation inside `provide` (consumed capacity, #174).
    return this._config.provide(
      Capacity.operation(
        "Entity.vectorSearch",
        { target: this._config.entityType, index: this._config.logicalName },
        this._execute(),
      ),
    )
  }

  /** @internal The unprovided search program. */
  private _execute(): Effect.Effect<
    Array<VectorHit<A>>,
    VectorSearchError | BlobStoreError,
    DynamoClient | TableConfig
  > {
    const {
      entityType,
      logicalName,
      definition,
      schema,
      tableTag,
      decode,
      loadRows,
      readAttributes,
      resolveDbName,
      keyForm,
      storedAt,
    } = this._config
    const state = this._state
    return Effect.gen(function* () {
      const client = yield* Capacity.client
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
        values[valueKey] = yield* marshalOrFail(
          entityType,
          "search",
          () =>
            toAttributeValue(
              storedAt === undefined ? value : operandAsStored(storedAt, [field], value, "value"),
              field,
            ),
          { outcome: "Nothing was sent." },
        )
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

      const output = yield* client.searchVectors(input).pipe(
        Effect.mapError((error) => classifyBackfill(error, tableName, definition.index)),
        // A TopK outside DynamoDB's range is not pre-checked (#144): its
        // rejection is confirmed against the TopK sent and named.
        diagnoseFailure({
          sent: () => ({ _tag: "Search", index: definition.index, topK: state.topK }),
          only: ["TopKOutOfRange"],
          rewrite: (diagnosis, original) =>
            new ValidationErrorClass({
              entityType,
              operation: `vectorSearch.${logicalName}.topK`,
              cause: withCause(
                explainDiagnosis(diagnosis, `vectorSearch.${logicalName}`),
                original,
              ),
            }),
        }),
      )

      // 4. Load the hits together — their packed attributes unpacked and
      //    their blob pointers resolved per the builder's modes, one batched
      //    resolution (#179, design §8.2) — then decode each through the
      //    entity schema and normalize the score. A projection is a raw read
      //    of the attributes it names: it loads only when it names one the
      //    load may rewrite.
      const found: Array<{ readonly raw: Record<string, unknown>; readonly rawScore: number }> = []
      for (const result of output.SearchResults ?? []) {
        if (!result.Item) continue
        // A result with no Score cannot be ranked or normalized. Coercing it to
        // 0 would be a lie under DOT_PRODUCT, where 0 is a real (orthogonal)
        // score — drop it instead.
        if (result.Score === undefined || result.Score === null) continue
        found.push({
          raw: fromAttributeMap(result.Item) as Record<string, unknown>,
          rawScore: result.Score,
        })
      }
      if (state.projection === undefined) {
        yield* loadRows(
          found.map((hit) => hit.raw),
          { operation: `vectorSearch.${logicalName}.decode`, modes: state.modes },
        )
      } else if (
        state.projection.some((attribute) => readAttributes.includes(resolveDbName(attribute)))
      ) {
        // The vector partition value bakes in the entity type, so every hit is
        // this entity's own row; one that says otherwise is left untouched.
        yield* loadRows(
          found
            .map((hit) => hit.raw)
            .filter((raw) => raw.__edd_e__ === undefined || raw.__edd_e__ === entityType),
          { operation: `vectorSearch.${logicalName}.select`, modes: state.modes, raw: true },
        )
      }
      const hits: Array<VectorHit<A>> = []
      for (const { raw, rawScore } of found) {
        const decoded =
          state.projection === undefined
            ? yield* decode(raw, state.modes)
            : (projectDomainNames(raw, state.projection, resolveDbName) as A)
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
    const value = ownValue(raw, resolveDbName(domainName))
    if (value !== undefined) setOwn(out, domainName, value)
  }
  return out
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** @internal Create a vector search builder for a single accessor invocation. */
export const makeBoundVectorQuery = <
  Model,
  Partition,
  Filters extends string,
  A,
  O extends OffloadState = NoOffloadState,
>(
  config: BoundVectorQueryConfig,
  query: string | ReadonlyArray<number>,
): BoundVectorQuery<Model, Partition, Filters, A, O> =>
  new BoundVectorQueryImpl<Model, Partition, Filters, A>(config, {
    query,
    partition: undefined,
    filters: {},
    topK: DEFAULT_TOP_K,
    projection: undefined,
    modes: DEFAULT_MODES,
  }) as unknown as BoundVectorQuery<Model, Partition, Filters, A, O>
