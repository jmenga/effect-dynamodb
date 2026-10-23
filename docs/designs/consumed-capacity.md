# Design: reporting consumed capacity and request counts (#174)

**Issue:** [#174](https://github.com/jmenga/effect-dynamodb/issues/174)
**Status:** Designed, revised after an adversarial review (§15). Owner decisions 1–7 recorded in
§2. Implementation follows in the same PR (single-PR workflow: this doc is commit 1).
**Affected packages:** `packages/effect-dynamodb` (new `ConsumedCapacity` module, a new
`internal/Capacity.ts`, operation entry points in Entity / Query / Collection / Batch /
Transaction / Aggregate / EventStore / projections / change-feed checkpoint store),
`packages/effect-dynamodb-geo` (entry points for `put` / `nearby`), `packages/docs` (a new
guide), `packages/doctest` (sync of the new guide).
**Semver impact:** `minor`. Purely additive: there is one new namespace export, and no return
type, error type or `R` changes. With reporting off (the default), no request or response is
touched (§4.1). The version number is set when the change ships.

---

## 1. Problem

No operation sets `ReturnConsumedCapacity`, so an application can only estimate what a call
costs. Estimates hide the expensive cases:

- the head check on a large previous event;
- a `Query` that pages through a long stream;
- strong versus eventually consistent reads. Measured on AWS: a `Query` returning 301 KB cost
  74 RCU consistent and 37 RCU eventually consistent.

The application wants every store call traced with what it cost, so it can find redundant or
oversized reads and writes from deployed traces.

One library operation is often many requests. A paginated read is one request per page. A
`Batch.write` is chunks plus retries. An `EventStream.append` can write an inline snapshot. A
`commandHandler` invocation is a load and then an append. So the useful unit is the **library
operation**: its total RCU and WCU summed over every request it made, how many requests (pages)
that was, and which tables they hit.

## 2. Owner decisions (recorded)

1. **Opt-in, off by default.** When reporting is off, requests and responses are not changed at
   all: no `ReturnConsumedCapacity` is sent and no span is created. No operation's return type
   changes. Every service method keeps `R = never`; the new settings are a `Context.Reference`.
2. **Delivery.** Each library operation reports its totals on an Effect span for that operation.
   The attribute names follow OpenTelemetry style, and `aws.dynamodb.consumed_capacity.total`
   is always present. There is also an optional observer callback that receives one report per
   library operation.
3. **Coverage.** Every library operation is covered in this one release. Table-management calls
   consume no capacity and are out. The request flag and the summing live at **one choke
   point** that every data-plane request passes through. Operation entry points only name the
   operation. The choke point must also work when the application provides its own decorated or
   mocked `DynamoClient`.
4. **Nesting is explicit and never double counts in the observer** (§6).
5. **Failed calls:** capacity is reported whenever DynamoDB returns it, errors included. Which
   errors carry it was checked against the SDK model (§8).
6. **DynamoDB Local** does return `ConsumedCapacity` (verified, §11.1), so the connected tests
   assert real values.
7. **Version:** minor bump, done in the ship step.

---

## 3. Public API

### 3.1 Module: `ConsumedCapacity`

A new namespace export, `ConsumedCapacity` (`packages/effect-dynamodb/src/ConsumedCapacity.ts`).
Inside the library, the SDK type of the same name is imported as `SdkConsumedCapacity`.

```ts
import { ConsumedCapacity } from "effect-dynamodb"

/** How much detail DynamoDB is asked for. `"indexes"` adds the per-table / per-index breakdown. */
export type Level = "total" | "indexes"

export interface Options {
  /** Default `"total"` (ReturnConsumedCapacity: TOTAL). `"indexes"` sends INDEXES. */
  readonly level?: Level | undefined
  /** Default `true`: every library operation runs in a span carrying its totals (§5). */
  readonly spans?: boolean | undefined
  /**
   * Called once per ROOT library operation (§6), after it completes, fails or is
   * interrupted. Runs in the operation's fiber, inside its span, with reporting
   * suppressed for anything it does itself, even through a client bound with
   * reporting on (§6.5). A failure or defect is logged at warning level and never
   * changes the operation's result.
   */
  readonly onOperation?: ((report: OperationReport) => Effect.Effect<void>) | undefined
}

/** Turn reporting on for everything run under this layer. */
export const layer: (options?: Options) => Layer.Layer<never>

/** The same, when the observer needs services: build the options in an effect. */
export const layerEffect: <E, R>(options: Effect.Effect<Options, E, R>) => Layer.Layer<never, E, R>

/** Turn reporting off for a subtree (for example a test, or a noisy maintenance job). */
export const disabled: Layer.Layer<never>

/** The setting itself, a `Context.Reference` whose default is "off". Exported for
 *  `Effect.provideService(ConsumedCapacity.Reporting, ConsumedCapacity.make(options))`. */
export const Reporting: Context.Reference<Settings>
export const make: (options?: Options) => Settings

/**
 * Run `effect` as a named operation: its requests are summed into one report (and one span).
 * Library operations inside it nest under it (§6). Used by the geo package, and open to
 * applications that want one report per unit of work ("handleOrderPlaced").
 * With reporting off it returns `effect` unchanged.
 */
export const withOperation: {
  (name: string, options?: OperationOptions): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, name: string, options?: OperationOptions): Effect.Effect<A, E, R>
}
/** Stream form: the operation spans the stream's whole run (§7.3). */
export const withOperationStream: { /* same shape, Stream in / Stream out */ }

export interface OperationOptions {
  /** Low-cardinality subject: an entity type, stream name, aggregate or collection name. */
  readonly target?: string | undefined
  /** Logical index / accessor name, for query operations. */
  readonly index?: string | undefined
}

/** Span attribute names (§5), exported so applications and tests need no string literals. */
export const Attributes: {
  readonly total: "aws.dynamodb.consumed_capacity.total"
  // … every name in §5.2
}

/**
 * Strip per-call state from a context captured for later use: the current operation
 * scope (§6) and the tracer's parent span. The library applies it at every bind site
 * (§6.6); it is public so packages built on effect-dynamodb (the geo package) and
 * applications that write their own bound wrappers can do the same.
 */
export const detachContext: <R>(context: Context.Context<R>) => Context.Context<R>
```

`withOperation` and `withOperationStream` are `Function.dual`, as the project's conventions
require.

### 3.2 The report

```ts
export interface CapacityTotals {
  /** Σ CapacityUnits over every request (what DynamoDB bills, in RCU + WCU). */
  readonly capacityUnits: number
  readonly readCapacityUnits: number
  readonly writeCapacityUnits: number
  /** Data-plane requests sent, including retries of unprocessed batch items. For a read, the pages. */
  readonly requests: number
  /** Requests whose outcome carried no ConsumedCapacity: failures (§8), or a client that does not return it. */
  readonly unreportedRequests: number
}

export interface OperationReport extends CapacityTotals {
  readonly operation: string                  // "Entity.get", "EventStream.read", …
  readonly target: string | undefined         // "Order", "Ledgers", …
  readonly index: string | undefined          // "byCustomer"
  readonly tables: ReadonlyArray<string>      // every table a request named, sorted
  /** Requests per DynamoDB command: { Query: 3, GetItem: 1 }. `Query` + `Scan` are the pages read. */
  readonly requestsByCommand: Readonly<Partial<Record<Command, number>>>
  /** Per-table sums; with level "indexes", also per-table / per-index capacity. */
  readonly byTable: ReadonlyArray<TableCapacity>
  /** Vector index usage (billed in bytes, not capacity units). 0 when none. */
  readonly vectorSearchRequestBytes: number
  readonly vectorWriteRequestBytes: number
  /** Direct child operations, grouped by name (§6.3). Their totals are INCLUDED above. */
  readonly nested: ReadonlyArray<NestedOperation>
  readonly outcome: "success" | "failure" | "interrupted"
}

export interface TableCapacity extends CapacityTotals {
  readonly tableName: string
  readonly table?: IndexCapacity | undefined                                    // level "indexes"
  readonly globalSecondaryIndexes?: Readonly<Record<string, IndexCapacity>> | undefined
  readonly localSecondaryIndexes?: Readonly<Record<string, IndexCapacity>> | undefined
}
export interface IndexCapacity {
  readonly capacityUnits: number
  readonly readCapacityUnits: number
  readonly writeCapacityUnits: number
}
export interface NestedOperation extends CapacityTotals {
  readonly operation: string
  readonly calls: number
}
export type Command =
  | "GetItem" | "PutItem" | "UpdateItem" | "DeleteItem" | "Query" | "Scan"
  | "BatchGetItem" | "BatchWriteItem" | "TransactGetItems" | "TransactWriteItems" | "SearchVectors"
```

### 3.3 Usage

```ts
// Spans only: every library operation gets a span with its cost.
const AppLayer = Layer.mergeAll(DynamoClient.layer({ region }), ConsumedCapacity.layer())

// Spans plus an observer that feeds the application's metrics.
const CapacityLayer = ConsumedCapacity.layerEffect(
  Effect.gen(function* () {
    const metrics = yield* AppMetrics
    return {
      level: "indexes",
      onOperation: (report) => metrics.recordCapacity(report.operation, report.capacityUnits),
    } satisfies ConsumedCapacity.Options
  }),
)
```

Nothing else changes. A bound client built with `DynamoClient.make`, `EventStore.bind`,
`Aggregate.bind`, `GeoIndex.bind` or `EventStore.bindProjection` reports, and so does an
unbound op yielded under layers.

**Where the setting is read.** It is read at **run time**, from the operation's fiber. A bound
client provides the context it captured at bind time on top of the caller's, and the captured
context wins (`Effect.provide` merges, `packages/effect`'s `provideContext`). So:

- If `ConsumedCapacity.layer` was in the context when `DynamoClient.make` / `bind` ran, it is
  captured and applies to every call through that client.
- If it was not, the caller's run-time context decides.
- A run-time `ConsumedCapacity.disabled` cannot switch off a client that captured an enabled
  setting.

The guide says this. It is the same rule `Compression` and `Embedder` already follow.

The rule holds for every terminal, streams included: a stream terminal (`.paginate()`) reads the
setting once when the stream starts, **inside** the bound client's provided context, and provides
that resolved setting to every page pull (§7.3). So `collect`, `fetch`, `count` and `paginate`
through one client always agree.

---

## 4. Architecture

### 4.1 The choke point: an instrumented view of whatever `DynamoClient` is in context

Today every library code path gets the client with `yield* DynamoClient` (or
`Effect.map(DynamoClient, …)`). There are 48 resolution sites in 12 files:

- Entity 23, EventStore 6, ProjectionEngine 4, Aggregate 3, Query 3, Batch 2, Transaction 2;
- one each in CheckpointStore, BoundVectorQuery, TransactPlan, VectorSearchEmulation and
  DynamoClient.ts.

Behind them sit about 80 data-plane call sites. Some of those are in `Hydrate` and
`TransactableOps`, which take the resolved client as a parameter.

The 45 sites outside the allowlist below change to one internal accessor:

```ts
// internal/Capacity.ts
export const client: Effect.Effect<DynamoClientService, never, DynamoClient> =
  Effect.map(DynamoClient.asEffect(), instrument)
```

`instrument(service)` returns a `DynamoClientService` (memoised per service in a `WeakMap`).
Its 11 data-plane methods are `getItem`, `putItem`, `updateItem`, `deleteItem`, `query`,
`scan`, `batchGetItem`, `batchWriteItem`, `transactGetItems`, `transactWriteItems` and
`searchVectors`. Each one:

1. reads `Reporting` and the current operation scope (§6) from the **calling fiber** at call
   time. Both are `Context.Reference`s, so no requirement is added;
2. **when reporting is off**, calls `service.method(input)` with the *same input object*, and
   nothing else happens;
3. **when on**, sends `{ ...input, ReturnConsumedCapacity: input.ReturnConsumedCapacity ?? LEVEL }`
   (`"TOTAL"` / `"INDEXES"`). An explicit value set by a caller is respected (the library never
   sets one today). Then, on the request's exit (`Effect.onExit`), it records one request into
   the current scope (§4.3, §8).

Table-management methods pass through untouched.

Why this choke point meets decision 3:

- **It wraps the service on the consumer side, not inside `buildService`.** Whatever
  implementation is in context gets the same treatment: `DynamoClient.layer`, `layerConfig`, a
  user's decorated client, a `Layer.succeed` mock, `VectorSearchEmulation.layer`.
- **It is per request, so new operations are covered automatically.** Any new library code that
  gets the client through `Capacity.client` is flagged and summed. If it has no operation entry
  point yet, its requests land in an **implicit root operation** named `DynamoClient.<Command>`
  (for example `DynamoClient.GetItem`). The cost is still reported, under a name that shows the
  gap. A guard test fails if any operation in the coverage matrix produces an implicit root
  (§11.2).
- **A static guard test** (`test/capacity-guard.test.ts`) fails if a `src/` file of either
  package uses `DynamoClient` **as a value** outside an allowlist. "As a value" is any
  occurrence that is not a type position, an import, a comment, or a static member access
  other than `asEffect` / `use` (`DynamoClient.make`, `DynamoClient.layer*` are fine). That
  covers `yield* DynamoClient`, `DynamoClient.asEffect()`, `DynamoClient.use(…)`,
  `Effect.service(DynamoClient)`, `Effect.map(DynamoClient, …)` / `flatMap` / `andThen`,
  `Effect.serviceOption(DynamoClient)` and `Context.get(ctx, DynamoClient)`. The allowlist:
  - `internal/Capacity.ts`;
  - `DynamoClient.ts` (`makeFromConfig` captures context and table operations);
  - `internal/TransactPlan.ts` and `VectorSearchEmulation.ts`, the two places that *build* a
    replacement client (§4.2).

**Decorated clients and the request flag.** A decorator must forward `ReturnConsumedCapacity`
and return `ConsumedCapacity`, as a plain delegating decorator does. A decorator or mock that
drops them still works: its requests are counted, and they show up as `unreportedRequests`. The
testing guide says so.

### 4.2 Code that builds a replacement client

- **`internal/TransactPlan.ts`** records the writes of an entity op so
  `Transaction.transactWrite` can carry them. It resolves the **raw** client (`real`), builds
  the `recording` service and provides it as `DynamoClient` to the op. The op resolves through
  `Capacity.client`, so the recording service is instrumented exactly once:
  - real reads (`recording.getItem → real.getItem`) are counted once;
  - recorded writes fail locally with no `ConsumedCapacity` and are **not** counted, because
    nothing was sent. `record()` marks its failure as "not sent", and the instrumentation skips
    such failures (§8.3).

  Planning runs the op's **unwrapped core**, so the recorded write's local failure never
  produces an error span named after the entity op. To make that true for every internal
  composition, the operation scope sits on the op's **public terminals only** (§9.1): a new
  `_exec(mode)` on each op class wraps `_run(mode)` in the scope, and `asEffect`, the
  `Entity.asModel` / `asRecord` / `asItem` / `asNative` combinators and the bound builders call
  `_exec`. `_run` stays unwrapped, so the internal compositions that call it — `updateOrCreate`
  falling back to `create(...)._run`, `runUpdate`'s no-op re-read `get(key)._run`, planning's
  `op()` — open no nested scope. A planned missing-row update therefore produces no
  `Entity.create` span and nothing in `nested`.
- **`VectorSearchEmulation.wrap`** is a test-only decorator. The library instruments the
  emulated client from outside. `searchVectors` counts as one request with no
  `ConsumedCapacity` (AWS bills vector search in bytes, §8.4). The emulator's internal `scan`s
  go to the raw service and are not counted, because real `SearchVectors` does not scan. No
  change to the emulator.
- **Double instrumentation is impossible by construction.** Replacement clients are built from
  the raw service, never from an instrumented one, and the static guard enforces it. For
  defence in depth, `instrument` returns an already-instrumented service unchanged: the brand is
  a non-enumerable symbol, so a `{ ...instrumented }` spread does not copy it.

### 4.3 What one request records

For each request, on exit:

| Field | From |
|---|---|
| `requests` += 1, `requestsByCommand[cmd]` += 1 | always |
| table names | the **input**: `TableName`, `RequestItems` keys, `TransactItems[*].{Get,Put,Update,Delete,ConditionCheck}.TableName`. Recorded even when no capacity comes back. |
| capacity | `output.ConsumedCapacity` on success: one object (single-item ops, `Query`, `Scan`) or an array (`BatchGetItem`, `BatchWriteItem`, `TransactGetItems`, `TransactWriteItems`). On failure, `cause.ConsumedCapacity` if a client supplied one (§8). |
| `unreportedRequests` += 1 | when no capacity was found |
| vector bytes | `SearchVectorsOutput.ConsumedCapacity.VectorSearchRequestBytes`; `ConsumedCapacity.VectorIndexes[*].VectorWriteRequestBytes` on writes |

Each `ConsumedCapacity` element is summed into its table's `TableCapacity` and into the scope
totals:

- `capacityUnits += CapacityUnits ?? (ReadCapacityUnits ?? 0) + (WriteCapacityUnits ?? 0)`.
- **read / write split.** DynamoDB's explicit `ReadCapacityUnits` / `WriteCapacityUnits` are
  used when present. When absent (DynamoDB Local always omits them, §11.1, and so does AWS in
  `TOTAL` mode for most commands), `CapacityUnits` goes to the command's side:
  - `GetItem`, `Query`, `Scan`, `BatchGetItem` and `TransactGetItems` are reads;
  - `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem` and `TransactWriteItems` are
    writes. A `ConditionCheck` inside `TransactWriteItems` is billed inside that write request
    and attributed to it.

  So `capacityUnits` is exactly what DynamoDB reported, and the split is exact whenever
  DynamoDB gives one.
- With `level: "indexes"`, `Table`, `GlobalSecondaryIndexes` and `LocalSecondaryIndexes` are
  summed per table and per index name. The same three-way split rule applies to each `Capacity`.

The record is a synchronous mutation of the scope's plain accumulator. JavaScript runs one
fiber step at a time, so concurrent child fibers (`Effect.forEach` with `concurrency`) can add
to one accumulator safely. No `Ref` is needed.

---

## 5. Spans

### 5.1 When and how

When reporting is on and `spans !== false`, every operation scope (§6), root or nested, runs in
`Effect.withSpan(name, { kind: "client", attributes: <static> })`. Its totals are added with
`Effect.annotateCurrentSpan` in the scope's exit handler, which runs inside the span. Failure
status comes from `withSpan` as usual.

- **Span name:** `effect-dynamodb.<operation>`, for example `effect-dynamodb.Entity.get` or
  `effect-dynamodb.EventStream.append`.
- **When reporting is off, no span is created.** The library creates no spans today, and
  decision 1 rules out any change when off.

### 5.2 Attributes

| Attribute | Type | When | Meaning |
|---|---|---|---|
| `db.system.name` | string | start | `"aws.dynamodb"` (OTel semconv) |
| `effect_dynamodb.operation` | string | start | e.g. `"EventStream.readFrom"` |
| `effect_dynamodb.target` | string | start, if known | entity type / stream / aggregate / collection name |
| `effect_dynamodb.index` | string | start, if known | logical index or accessor name |
| `effect_dynamodb.nested` | boolean | start | `true` when inside another library operation (§6) |
| `aws.dynamodb.table_names` | string[] | end | OTel semconv; every table a request named |
| **`aws.dynamodb.consumed_capacity.total`** | number | end, **always** | Σ capacity units (0 when nothing was reported) |
| `aws.dynamodb.consumed_capacity.read` | number | end, always | Σ RCU |
| `aws.dynamodb.consumed_capacity.write` | number | end, always | Σ WCU |
| `effect_dynamodb.request_count` | int | end, always | requests (pages, for a read) |
| `effect_dynamodb.unreported_requests` | int | end, if > 0 | requests with no capacity in their outcome |
| `effect_dynamodb.vector.search_request_bytes` / `.write_request_bytes` | int | end, if > 0 | vector index usage |

Span totals are **inclusive**: a span's totals include its nested operations, just as span
durations do (§6.2).

The OTel semconv attribute `aws.dynamodb.consumed_capacity` (a string[] of per-request JSON) is
**not** emitted. It grows with every page of a long read. The per-table breakdown is in the
observer report instead.

**Namespace note.** OTel naming rules say a name must not be both an attribute and a
namespace. `aws.dynamodb.consumed_capacity.total` (owner decision 2) makes
`aws.dynamodb.consumed_capacity` a namespace while semconv defines it as an attribute. That
conflict is deliberate (owner decision; the semconv attribute is not emitted, so no backend
sees both). `.read` / `.write` sit beside `.total` in the same, already-chosen namespace.
Everything else the library invents (`request_count`, `unreported_requests`, vector bytes)
lives under `effect_dynamodb.*`, so a future semconv release cannot redefine it under us
(S26).

---

## 6. Operations, scopes and nesting

### 6.1 Operation scopes

`withOperation(name, opts)` and its stream form are the only way to open a scope. They work
like this:

1. If `Reporting` is off, return the effect unchanged. The only cost is one reference read at
   run time.
2. Read `CurrentOperation`, an internal `Context.Reference<Scope | "suppressed" | undefined>`,
   default `undefined`. `"suppressed"` (set only while an observer runs, §6.5) means "run the
   effect unchanged". A scope that has already **closed** is treated as absent: a request or
   operation that finds a closed scope current (a client built inside an operation and kept, a
   fiber that outlived its operation) becomes a root of its own instead of nesting under a
   dead scope and being lost.
3. Create `scope = { name, opts, parent: current, totals, children }` and run the effect with
   `CurrentOperation = scope`. Child fibers inherit it.
4. On exit (success, failure, interruption), freeze the totals, annotate the span, and, **if
   `parent === undefined`**, build the `OperationReport` and call `onOperation` (§6.5 for
   where it runs).

A request records into its scope **and every ancestor** (walking `parent`). So each scope's
totals are inclusive.

### 6.2 The rule

> **A request is charged to every library operation that encloses it. The observer receives one
> report per *root* operation, the outermost library operation on the fiber, so summing
> `onOperation` reports never double counts. Nested operations get their own spans (inclusive,
> `effect_dynamodb.nested = true`) and appear in the root report's `nested` breakdown.**

Examples:

- `commandHandler(...)` runs its load (`readLatest` on a snapshot-configured stream, `read`
  otherwise, or the application's `loadState`), then `append`. The observer gets **one**
  report, `EventStore.commandHandler`, whose totals are the load plus the append. Its `nested`
  lists the load (`EventStream.read` / `EventStream.readLatest`) and `EventStream.append` with
  their own (inclusive) totals. The trace shows three spans.
- `Aggregate.update` reads the aggregate and writes the diffed edges. One report,
  `Aggregate.update`. Any entity ops it composes appear as nested children.
- `Transaction.transactWrite([Users.update(...), ...])` plans each op (its real reads count) and
  sends one `TransactWriteItems`. One report, `Transaction.transactWrite`. Planning runs
  unwrapped cores, so entity ops planned this way open no nested scopes (§4.2).
- **User code inside a library operation is part of that operation.** This covers a
  `commandHandler` `loadState`, a projection `drain`'s `deliver`, and an observer-free
  `withOperation` the application wraps. Library calls it makes are nested and charged to the
  enclosing root. That is what "what did this command cost" means. An application that wants
  them reported separately runs them outside the library operation.

**For dashboards that sum spans:** sum only spans with `effect_dynamodb.nested = false`. The
guide says this.

### 6.3 `nested` breakdown

`nested` lists the root's **direct** children, grouped by operation name. Each entry has a
`calls` count and inclusive totals. Grandchildren are already inside their child's totals and
are not listed again, so the entries never double count *among themselves*. They do not
necessarily add up to the root total: the root may also send requests itself, as
`commandHandler` does not but `Entity.update` with a cascade does. The breakdown is bounded by
the number of distinct child operation names.

### 6.4 Delegates do not nest: `Query` terminals

`Query.collect`, `Query.execute`, `Query.paginate` and `Query.count` are both public functions
and the execution engine every library read delegates to: `BoundQuery`, `Collection`,
`EventStream.read` / `readFrom` / `currentVersion` / `readIndex`, `Aggregate.list` and geo
`nearby`. A nested `Query.collect` span under `Entity.query` would only repeat its parent. So:

> **A `Query` terminal opens a scope only when no operation is current.**

Run directly (for example `Query.collect(Orders.query.events(id))`), it is a root `Query.collect`
whose target and index come from the query descriptor's entity types / index. Run by a library
accessor, it adds its requests to the accessor's scope.

This is the only delegate rule. Every other entry point always opens a scope.

### 6.5 The observer runs outside reporting

`onOperation` runs with `CurrentOperation = "suppressed"`. Both the instrumented client and
`withOperation` check for it **before** reading `Reporting`, so library operations the
observer itself performs (writing a metrics row to DynamoDB, say) are neither charged to the
operation just reported nor reported themselves — and this holds even when the observer writes
through a client bound under an enabled layer. Turning `Reporting` off for the observer would
not be enough: a bound client's captured `Reporting` wins over the run-time one (§3.3), so an
observer writing through such a client would open a new root, report again, and loop forever.
The sentinel cannot be overridden that way because no bind ever captures `CurrentOperation`
(§6.6). Observer failures and defects are caught, logged with `Effect.logWarning` (with the
cause), and dropped.

**Where it runs.** On success or failure the observer runs after the operation's effect has
finished, in the operation's fiber, as ordinary **interruptible** code: a slow observer under
`Effect.timeout` is interrupted with the call and its report is dropped. Only when the
operation itself is interrupted does the report go out from an exit finalizer, which is
uninterruptible as all finalizers are; the guide advises forking inside the observer when it
does slow I/O.

### 6.6 No stale scopes

- **Bind-time capture.** Every site that captures `Effect.context()` for later use —
  `makeFromConfig`, `Entity.bind`, `EventStore.bind`, `Aggregate.bind`, `bindProjection`
  (`EventStore.ts`), and geo's `GeoIndex.bind` — passes it through `detachContext` (§3.1),
  which omits `CurrentOperation` **and `Tracer.ParentSpan`**. Without the first, a client
  bound inside an operation would pin later calls to that operation's scope (and
  `makeFromConfig → Entity.bind` re-captures the caller's context, so omitting it in
  `makeFromConfig` alone is not enough). Without the second, every span of a bound operation
  would hang off the span that was current at bind time (an application-lifetime span),
  not the caller's request span. The geo package calls the public `detachContext`.
- **Closed scopes are absent** (§6.1, step 2), as a backstop for any capture this misses.
- **Forked fibers.** The change feed (`change-feed/ChangeFeed.ts`) forks long-lived fibers
  with `Effect.forkIn`: the lease-renewal loop and the per-shard lifecycles. They are started
  with `CurrentOperation` cleared, so each `CheckpointStore.*` call they make is a root
  operation reported on its own, not a child of whatever scope (an application
  `withOperationStream` around the consumer) was current when the feed started. Everything
  else in `src/` fans out with `concurrency:` and joins.

---

## 7. Paginated and multi-request reads

### 7.1 Collecting terminals

`collect` / `count` loop pages inside one scope. Every page is a request: `requests` and
`requestsByCommand.Query` / `.Scan` count pages, and capacity sums over them. `maxPages`,
`limit` and `pageSize` change how many pages are sent, never how they are counted. Here is what
the issue asks for, "the number of pages (requests) a read made", for each kind of read:

| Read | Pages reported |
|---|---|
| `fetch()` / `Query.execute` | one or more requests: without `limit`, one; with `limit`, as many as it takes to fill it (a `filter` or client-side predicate can reject rows), bounded by `maxPages` and the key range. A hydrated read adds a `BatchGetItem` per page. |
| `EventStream.read` over a 3-page stream | `requests: 3`, `requestsByCommand: { Query: 3 }` |
| `readLatest` in steady state | 1 |

### 7.2 Fan-out reads

These are summed into one scope, with every table listed:

- a **Collection** query over members on several tables;
- **geo `nearby`**, which runs N cell queries concurrently;
- a **`"keys"` stream index read**, which runs a `Query` and then a `BatchGetItem` per page;
- **ref hydration** (`BatchGetItem`) during an entity write.

### 7.3 Streams (`.paginate()`, `Query.paginate`, `Entity.paginate`)

`withOperationStream` wraps the stream itself, not the effect that builds it:

- **The scope opens when the stream starts** (first pull), via `Stream.unwrap` of the scope's
  creation. Each run of the stream is a separate operation.
- **The settings are resolved once, at that start, inside the bound client's provided context**
  (a bound stream terminal is `Stream.unwrap(provide(Capacity.operationStream(...)))`, so the
  read of `Reporting` sees the captured value). The resolved `Reporting` and the scope are then
  provided to the stream (`Stream.provideService`), because pages are pulled later, from the
  consumer's fiber, outside `provide`. Reporting for a stream therefore follows exactly the
  bind-time / run-time rule of §3.3, like every effect terminal.
- **Every page request in the run records into it**, through the provided `CurrentOperation`.
- **It closes with a finalizer of the run's scope** (`Effect.addFinalizer` inside the scoped
  `unwrap`; as implemented). So a stream's report, unlike an effect's, always goes out from a
  finalizer, uninterruptibly: the advice to fork slow observer I/O (§6.5) applies to every
  stream run. On normal completion the outcome is `"success"`. When a
  consumer stops early (`Stream.take`, `runHead`), the stream completes from its own side, the
  outcome is `"success"`, and the report covers **the pages actually read**. On failure it is
  `"failure"`, and on interruption `"interrupted"`.
- The span is made with `Effect.makeSpanScoped` in the same scoped `unwrap`, so it lives exactly
  as long as the stream run. `Stream.withParentSpan` makes the per-page spans its children.

`BoundQuery.paginate()` today does `Stream.unwrap(provide(Query.paginate(q)))`. The scope wraps
that stream, inside `provide`, so the entity accessor's name (`Entity.query`) is the root and
the inner `Query.paginate` is a delegate (§6.4). For effect terminals the scope likewise sits
inside `provide` (`provide(withOperation(...))`), never outside it.

### 7.4 Batch and transaction arrays

- `BatchGetItem` / `BatchWriteItem` return one `ConsumedCapacity` per table. Each element goes
  to its table.
- Chunking (100 / 25) and **retries of `UnprocessedKeys` / `UnprocessedItems`** are separate
  requests, and each is counted and summed. DynamoDB charges only for processed items, and its
  per-request capacity reflects that.
- `TransactGetItems` / `TransactWriteItems` return one element per table. Transactional reads
  and writes cost 2×, and DynamoDB's numbers already include that (Local: a 1-item transact
  put reports 2 units, §11.1).

---

## 8. Error paths

### 8.1 What carries `ConsumedCapacity`

Checked against `@aws-sdk/client-dynamodb` **3.1111.0**: `dist-types/models/errors.d.ts`, and
the schema-based deserializer in `dist-cjs/index.js`. Rule: **no error shape models
`ConsumedCapacity`.**

| Error | Modeled members | Capacity consumed? | Reported? |
|---|---|---|---|
| `ConditionalCheckFailedException` | `message`, `Item` | **Yes.** The AWS Developer Guide ("Working with items", *Capacity units consumed by conditional writes*) says: "If a `ConditionExpression` evaluates to false during a conditional write, DynamoDB still consumes write capacity from the table … (or a minimum of 1)", and "A failed conditional write returns a `ConditionalCheckFailedException`. When this occurs, you don't receive any information in the response about the write capacity that was consumed." | **No.** Not in the response. |
| `TransactionCanceledException` | `Message`, `CancellationReasons` | Not stated in the API model. This design makes no claim about how AWS bills a cancelled transaction. | **No.** Not in the response. |
| `ProvisionedThroughputExceededException`, `ThrottlingException`, `RequestLimitExceeded` | `message` (+ `ThrottlingReasons`) | No: the request is rejected. | n/a |
| `ItemCollectionSizeLimitExceededException`, `TransactionConflictException`, `ValidationException`, `ResourceNotFoundException`, `InternalServerError` | `message` | No / unknown | **No.** |

The SDK error classes are built from a schema that lists only modeled members, for example
`ConditionalCheckFailedException$ = [-3, n0, _CCFE, …, [_m, _I], …]`. So **even if DynamoDB
put `ConsumedCapacity` in an error body, the SDK would drop it.** Verified against DynamoDB
Local, with `ReturnConsumedCapacity: "TOTAL"` set:

- a failed conditional `PutItem` throws with keys
  `$fault, $retryable, $metadata, name, Item, message, __type`;
- a cancelled transaction throws with `…, CancellationReasons, message, __type`;
- neither has `ConsumedCapacity`.

### 8.2 Behaviour

- **A failed request is still a request.** It increments `requests` and
  `requestsByCommand`, records its tables, and, having no capacity, increments
  `unreportedRequests`.
- **The capacity read is defensive:** `cause.ConsumedCapacity` (the classified error's `cause`
  is the SDK exception) is read if present. A custom client, or a future SDK that models the
  field, then reports it with no change here.
- **Expected control flow is reported like any other outcome.** A `create` that fails
  `ConditionalCheckFailed`, or an `append` that fails `VersionConflict`, still produces the
  operation's span and observer report: `outcome: "failure"`, `unreportedRequests ≥ 1`. The
  guide states that the conditional write's cost is real, invisible to the API, and visible only
  in CloudWatch `ConsumedWriteCapacityUnits`.
- **Recovery reads are included.** Paths that recover and read again, such as a
  `ConditionalCheckFailed` followed by a diagnostic `GetItem` or an idempotency replay probe,
  report those reads in the same operation. An op that recovers and succeeds reports
  `outcome: "success"` with `unreportedRequests ≥ 1`, which honestly says part of its cost is
  unknown.
- **SDK-internal retries are invisible.** The SDK retries throttled attempts inside one `send`.
  Throttled attempts consume nothing, and the final attempt's capacity is what comes back, so
  totals are right; `requests` counts library-level requests, not SDK attempts.
  `$metadata.attempts` is not reported (§13 S21, out).

### 8.3 Local failures that were never sent

Some failures happen without a request ever being sent:

- `TransactPlan`'s recorded writes;
- `refuseEmptyParts`, which fails before the client is called;
- emulator validation failures.

The first two never reach the instrumented method, or are marked "not sent", and are not
counted. `TransactPlan`'s `record()` failure carries an internal `NotSent` marker on its
`DynamoError` cause, and the instrumentation skips failures that carry it. The emulator
rejects locally, but the call did go through a client, so it counts as an unreported request.
That is acceptable for a test-only path.

### 8.4 `SearchVectors`

`SearchVectorsOutput.ConsumedCapacity` is a `VectorCapacity` (`VectorSearchRequestBytes`), not
capacity units, and has no `TableName`. Vector search is one request, the table comes from the
input, and the bytes go to `vectorSearchRequestBytes`. It is not counted as unreported when the
bytes are present.

---

## 9. Coverage

Every operation below opens a scope at its entry point, and everything it sends is summed by
the choke point (§4). "Unbound + bound" means the wrapper sits in the op itself, so both
`yield* Users.get(k)` under layers and `db.entities.Users.get(k)` report.

### 9.1 effect-dynamodb

| Operation (report `operation`) | Entry point | Requests it can make | Notes |
|---|---|---|---|
| `Entity.get` | `EntityGetImpl._exec` (unbound + bound; `asEffect`, `asRecord` / `asNative` / … too) — **not** `_run` (§4.2) | GetItem | target = entity type |
| `Entity.put` / `Entity.create` / `Entity.upsert` | `EntityPutImpl._exec`, name from `_putKind` | PutItem, or TransactWriteItems (unique sentinels, retain snapshots); BatchGetItem (ref hydration) | |
| `Entity.update` / `Entity.patch` | `EntityUpdateImpl._exec` | UpdateItem, GetItem (read-first paths), TransactWriteItems (unique / retain / transactional cascade), Query + UpdateItem fan-out (eventual cascade) | cascade fan-out included |
| `Entity.delete` / `Entity.deleteIfExists` | `EntityDeleteImpl.asEffect` (the core moves to an unwrapped `_core()`) | DeleteItem, GetItem, TransactWriteItems (sentinels, soft delete, retain) | |
| `Entity.append` (time series) | bound `append` builder (`BoundAppend.asEffect`) | TransactWriteItems, follow-up GetItem | |
| `Entity.getVersion`, `Entity.versions`, `Entity.restore`, `Entity.purge`, `Entity.deleted.get`, `Entity.deleted.list` | each lifecycle function | GetItem, Query, TransactWriteItems, BatchWriteItem (purge chunks + retries), DeleteItem | |
| `Entity.query` | `BoundQuery` terminals `collect` / `fetch` / `paginate` / `count` | Query (pages); BatchGetItem for keys-only projections | index = accessor name |
| `Entity.scan` | `BoundQuery` in scan mode; `Entity.scanFetch` | Scan (pages) | |
| `Entity.history` | `BoundQuery` from `.history(key)` | Query (pages) | |
| `Entity.collect` / `Entity.fetch` / `Entity.paginate` | bound query-execution helpers | Query / Scan | |
| `Entity.vectorSearch` | `BoundVectorQuery.collect` | SearchVectors (+ hydration reads) | vector bytes |
| `Entity.reembed` | bound `reembed` | Scan (pages) + UpdateItem per item | |
| `Query.collect` / `.execute` / `.paginate` / `.count` | `Query.ts` terminals, **delegate rule** (§6.4) | Query / Scan | root only when run directly |
| `Collection.query` | `CollectionQuery` terminals (`collect` / `fetch` / `paginate` / `count`) | Query per member table (parallel) | target = collection name |
| `Batch.get` / `Batch.write` | `Batch.ts` | BatchGetItem / BatchWriteItem chunks + retries; TransactWriteItems (unique sentinels) | |
| `Transaction.transactGet` / `Transaction.transactWrite` | `Transaction.ts` | TransactGetItems / TransactWriteItems; planning reads (§4.2) | |
| `Aggregate.get` / `.create` / `.update` / `.delete` / `.list` | `Aggregate.ts` operation functions (`bind` delegates) | Query (collection read), TransactWriteItems, BatchWriteItem (orphan edge cleanup), GetItem (ref hydration) | target = aggregate name (its root `entityType`) |
| `EventStream.append` | `append` | TransactWriteItems or PutItem; GetItem (idempotency replay, head probes); inline / after-append snapshot write | |
| `EventStream.read` / `.readFrom` / `.currentVersion` / `.readLatest` / `.readIndex` | each method (`Query` inside is a delegate) | Query pages; BatchGetItem (`"keys"` index) | target = stream name |
| `EventStream.readSnapshot` / `.writeSnapshot` | each method | GetItem / PutItem | |
| `EventStream.query.events` / `.query.index` | the returned `Query` descriptor, run by a `Query` terminal | Query | root `Query.*`, target = stream |
| `EventStore.commandHandler` | the handler invocation | load (readLatest / read / loadState) + append (+ additional items) | nested children (§6.2) |
| `Projection.apply` / `.applyBatch` / `.catchUp` / `.rebuild` / `.processBatch` / `.drain` / `.drainPending` | `EventProjection` / `MultiProjection` methods (`bindProjection` delegates) | GetItem, PutItem, UpdateItem, DeleteItem, Query, TransactWriteItems (ProjectionEngine) | target = projection entity type; multi-projection uses `MultiProjection.*` |
| `CheckpointStore.load` / `.commit` / `.acquireLease` / `.renewLease` / `.releaseLease` | `CheckpointStore.makeDynamoDB` methods | GetItem, PutItem, UpdateItem, DeleteItem, Query | the change feed's DynamoDB Streams calls report no capacity (§9.3) |

Two operations are deliberately absent:

- `EventStream.measureAppend`, `measureSnapshot`, `decodeStreamImage` and `parseStreamId` send
  no requests, so they open no scope.
- **`appendOp`** is not an operation of its own. Its items are sent in the outer append's
  `TransactWriteItems`, already counted there.

### 9.2 effect-dynamodb-geo

| Operation | Entry point | Requests | Notes |
|---|---|---|---|
| `GeoIndex.put` | **bound** `GeoIndex.bind(...).put` wraps the put with `ConsumedCapacity.withOperation("GeoIndex.put", { target })` | as `Entity.put` | the inner `Entity.put` is a nested child. The **unbound** `GeoIndex.make(...).put` returns the entity's put builder (`P`) so it stays pipeable with entity combinators; wrapping it would change its type, so it reports as `Entity.put` (S28). |
| `GeoIndex.nearby` | `GeoSearch.nearby` wrapped with `withOperation("GeoIndex.nearby", { target, index })` | N concurrent cell Queries (pages) | inner `Query.collect`s are delegates (§6.4) |

### 9.3 Out

- **Table management:** create, delete, describe, update, backups, PITR, TTL, tags, export, and
  the vector index add / remove / wait (`db.tables.*`, `Table` helpers). These consume no
  capacity and are passed through untouched.
- **The raw `DynamoClient` service used directly by applications** (`yield* DynamoClient` then
  `putItem`). It stays a thin SDK pass-through, and the application sets
  `ReturnConsumedCapacity` itself if it wants it. Only library operations are reported.
- **DynamoDB Streams API calls** (`DynamoStreamsClient`). There is no `ConsumedCapacity` in
  that API.

---

## 10. Implementation map

| File | Change |
|---|---|
| `src/ConsumedCapacity.ts` (new) | public API §3: `Reporting`, `make`, `layer`, `layerEffect`, `disabled`, `withOperation`, `withOperationStream`, `Attributes`, report types |
| `src/internal/Capacity.ts` (new) | `client` accessor, `instrument`, the `CurrentOperation` reference, scope accumulator, extraction / summing (§4.3), report building, observer invocation (§6.5), `NotSent` marker |
| `src/index.ts` | `export * as ConsumedCapacity` |
| `Entity.ts`, `EventStore.ts`, `Aggregate.ts`, `Query.ts`, `Batch.ts`, `Transaction.ts`, `internal/ProjectionEngine.ts`, `internal/BoundVectorQuery.ts`, `change-feed/CheckpointStore.ts` | `yield* DynamoClient` becomes `yield* Capacity.client` (45 sites) |
| `internal/EntityOps.ts`, `internal/BoundCrud.ts`, `internal/BoundQuery.ts`, `DynamoClient.ts` (CollectionQuery, bound helpers), `Batch.ts`, `Transaction.ts`, `Aggregate.ts`, `EventStore.ts` (stream methods, commandHandler), `internal/EventProjection.ts`, `internal/MultiProjection.ts`, `change-feed/CheckpointStore.ts`, `Query.ts` (delegate terminals) | entry-point `withOperation` / `withOperationStream` with names per §9 |
| `internal/TransactPlan.ts` | `NotSent` marker on recorded-write failures (and on the synthetic missing-row `ConditionalCheckFailed`); planning uses unwrapped cores |
| `internal/EntityOps.ts`, `internal/EntityCombinators.ts`, `internal/BoundCrud.ts` | `_exec(mode)` on each op class (scope on public terminals only, §4.2) |
| `DynamoClient.ts` `makeFromConfig`, `Entity.bind`, `EventStore.bind` / `bindProjection`, `Aggregate.bind`, geo `GeoIndex.bind` | `detachContext` on the captured context: omits `CurrentOperation` and `Tracer.ParentSpan` (§6.6) |
| `change-feed/ChangeFeed.ts` | `forkIn` sites start their fibers with `CurrentOperation` cleared (§6.6) |
| `packages/effect-dynamodb-geo/src/GeoIndex.ts` | `put` / `nearby` wrapped (§9.2) |
| `DESIGN.md` | new §16 "Consumed capacity" (summary of §3–§8 + the nesting rule) |
| `CLAUDE.md` | module structure + dependencies (`ConsumedCapacity`, `internal/Capacity`); a behavioural note under "Entity Operations" |

No new error codes are needed. If implementation finds one, it takes the next free code in this
issue's reserved block, EDD-9100..9109.

---

## 11. Testing

### 11.1 DynamoDB Local returns `ConsumedCapacity` (verified)

This was probed against `amazon/dynamodb-local:latest` on the branch's container (port 8174),
with a table carrying one GSI. Every data-plane command returns `ConsumedCapacity` with
`TableName` + `CapacityUnits` only, never a read / write split:

| Request | TOTAL | INDEXES |
|---|---|---|
| PutItem, ~3 KB item, written to the GSI too | `CapacityUnits: 6` | `Table: 3`, `GSI gsi1: 3` |
| GetItem, eventually consistent / consistent | 0.5 / 1 | `Table: 0.5` / `Table: 1` |
| Query on the table / on the GSI | 0.5 / 0.5 | GSI query: `Table: 0`, `gsi1: 0.5` |
| Scan | 0.5 | `Table: 0.5` |
| UpdateItem (item in GSI) | 6 | `Table: 3`, `gsi1: 3` |
| BatchGetItem / BatchWriteItem (1 item) | `[0.5]` / `[1]` (arrays) | per-table `Table` |
| TransactGetItems (1 get) / TransactWriteItems (put + ConditionCheck) | `[2]` / `[2]` | per-table `Table` |
| DeleteItem | 1 | `Table: 1` |
| Failed conditional PutItem, cancelled TransactWriteItems | no `ConsumedCapacity` on the error (§8.1) | — |

Measured while writing the connected suite: a `TransactWriteItems` of two small puts reports
`CapacityUnits: 2` on Local, so Local does not apply the transactional doubling to writes.

So the **connected suite asserts real values**. Because Local never splits read from write, it
exercises the command-kind attribution in §4.3. The explicit-split path is covered by unit
tests with mocked responses.

### 11.2 Unit: `test/ConsumedCapacity.test.ts` (mocked `DynamoClient` via `Layer.succeed`)

1. **Off by default.**
   - No `ConsumedCapacity` layer: every data-plane input reaches the mock **without** a
     `ReturnConsumedCapacity` key (`Object.hasOwn` is false), and the very input object is
     passed.
   - Outputs are returned by identity.
   - A test `Tracer` records **zero** spans from the library.
2. **Request flag.** `level` `"total"` sends `TOTAL` and `"indexes"` sends `INDEXES`, on each of
   the 11 data-plane commands. Table-management calls are untouched. An explicit caller value
   is kept.
3. **Summing.**
   - Single object; array (batch, transact) across two tables.
   - Missing `CapacityUnits` with an explicit split, and an explicit split overriding the
     command-kind fallback.
   - `INDEXES` breakdown summed per table and per index.
   - Vector bytes.
4. **Pagination.**
   - A 3-page `Entity.query` `collect` reports `requests: 3` and `{ Query: 3 }`, with the sum.
   - `fetch()` without `limit` reports one request; `fetch()` with `limit` and a `filter` that
     crosses pages reports each page.
   - `paginate()` consumed with `Stream.take` stops after page 1: the report is sent once, with
     1 request, `"success"`.
   - A stream failing on page 2: `"failure"`, 2 requests.
   - Running the same stream twice produces two reports.
5. **Batch retries.** Unprocessed items on the first response mean 2 requests, both summed.
   Chunks over 25 / 100 are counted per chunk.
6. **Errors.**
   - `ConditionalCheckFailed` on `create`: `outcome: "failure"`, `requests: 1`,
     `unreportedRequests: 1`, and the span has error status.
   - A mock error whose cause carries `ConsumedCapacity` is counted.
   - A recovered op (CCF then diagnostic `GetItem`): `"success"`, 2 requests, 1 unreported.
   - `TransactPlan` recorded writes are not counted.
7. **Nesting.**
   - `commandHandler` gives one observer call (`EventStore.commandHandler`), whose `nested`
     holds the load (`EventStream.read`, or `.readLatest` with snapshots; 1 call) and
     `EventStream.append` (1 call). The root totals
     equal the sum of all requests. Three spans, the two children with `nested: true`.
   - `Aggregate.update` and `Transaction.transactWrite` give one observer call each.
   - Geo-style concurrent fan-out under one `withOperation` sums correctly.
   - A `Query.collect` run directly is a root; run under `Entity.query` it is no extra scope.
8. **Decorated / mocked clients.**
   - A user decorator layer (`Layer.effect(DynamoClient, Effect.map(DynamoClient, decorate))`)
     is instrumented and counted once.
   - A decorator that drops `ReturnConsumedCapacity` gives requests counted, all unreported.
   - `VectorSearchEmulation.layer`: `searchVectors` is one request, and its internal scans are
     not counted.
9. **Context capture.**
   - Enabled at bind time applies to calls without run-time provision — on `collect`, `fetch`,
     `count` **and `paginate`**; enabled at run time only also reports on all four; a client
     bound under `disabled` does not report `paginate` under a run-time enabled layer.
   - A client built with `DynamoClient.make` inside an operation does not pin later calls to
     it: each later call is its own root (§6.6).
   - Bind under span A, call under span B: the library span's parent is B.
   - A planned missing-row update in `transactWrite` opens no `Entity.create` scope.
10. **Observer isolation.**
    - An observer that runs a library operation does not recurse and is not reported —
      including when it writes through a client **bound under the enabled layer**.
    - An observer defect is logged and the op result is unchanged.
    - A slow observer is interrupted by `Effect.timeout` around the operation.
    - `spans: false` produces observer calls and no spans.
11. **Types.** `expectTypeOf` that bound ops' `R` is still `never` and that return types are
    unchanged with and without the layer. `ConsumedCapacity.layer()` is `Layer<never>`.
12. **Coverage matrix** (`test/ConsumedCapacity.coverage.test.ts`). Every operation in §9 is
    driven once against a mock that answers every command with a fixed `ConsumedCapacity`.
    Assert:
    - the report's `operation` name is as in §9;
    - **no** implicit `DynamoClient.<Command>` root appears.

    A new operation added without an entry point fails here.
13. **Static guard** (`test/capacity-guard.test.ts`). No raw `DynamoClient` resolution outside
    the allowlist (§4.1), in both `packages/effect-dynamodb/src` and
    `packages/effect-dynamodb-geo/src`.

Geo has its own unit test (`packages/effect-dynamodb-geo/test/ConsumedCapacity.test.ts`):
`nearby` with N cells gives one `GeoIndex.nearby` report with N requests, and `put` gives
`GeoIndex.put` with `Entity.put` nested.

### 11.3 Connected: `test/connected.consumed-capacity.test.ts`

This runs against `DYNAMODB_ENDPOINT` through `Config`, with the default `http://localhost:8000`
as the existing suites use. Values are asserted exactly, from §11.1's measured rules:

- `Entity.put` of a known-size item with one GSI under `"indexes"`: table and GSI units.
- `Entity.get`, eventual vs `consistentRead`: 0.5 vs 1.
- `Entity.query` over a partition forced to 3 pages with `pageSize`: `requests: 3`, and units
  summed.
- `Batch.write` of 30 items: 2 requests, units = item count.
- `Transaction.transactWrite`: one request, one unit per small item. DynamoDB Local does **not**
  double transactional writes (two puts report 2; real DynamoDB charges 4), so the connected
  suite asserts Local's values and the unit suite covers summing whatever the service returns.
- Entity create with a unique constraint (sentinel transaction).
- `EventStream.append` + `read` + `commandHandler` nesting (one observer call, inclusive totals).
- `Aggregate.create`.
- A failed `create` (`ConditionalCheckFailed`): `unreportedRequests: 1`.
- Geo `nearby` (in the geo package's connected suite).

### 11.4 Quality gates

All of CLAUDE.md's gates, including `pnpm --filter effect-dynamodb test:connected` (this
touches Entity, Query, Collection, Transaction, Aggregate, EventStore and the `internal/` entity
helpers), the geo connected tests, `pnpm --filter @effect-dynamodb/doctest test`, and
`test:connected` for doctest (new example). All run against the branch's container on
port 8174.

---

## 12. Docs

- **Example file:** `packages/effect-dynamodb/examples/guide-consumed-capacity.ts`. It runs
  against DynamoDB Local, reads the endpoint via `Config`, and has no `process`. Its regions:
  - `enable`: `ConsumedCapacity.layer()`;
  - `observer`: `layerEffect` with an observer collecting reports;
  - `report`: one `Entity.get`, with its report printed and asserted (0.5 units, 1 request);
  - `pagination`: a multi-page query's `requests`;
  - `nesting`: `commandHandler` gives one report plus `nested`;
  - `custom-operation`: `withOperation("placeOrder", …)` grouping several calls;
  - `failure`: a failed `create` with `unreportedRequests`.

  Domain: orders and accounts.
- **Guide:** `packages/docs/src/content/docs/guides/consumed-capacity.mdx`, added to the
  sidebar in `astro.config.mjs` next to "Testing". It covers:
  - enabling, and why it is off by default (one extra response field; no change when off);
  - the span attribute table (§5.2), and the "sum only `nested = false`" note;
  - the report fields;
  - the nesting rule (§6.2);
  - pagination and streams (§7);
  - what failures cannot report and where to look (CloudWatch);
  - decorated and mocked clients (§4.1);
  - bind-time vs run-time provision (§3.3).

  Every code fence is backed by a region.
- **`guides/testing.mdx`:** one paragraph on returning `ConsumedCapacity` from a mock to test
  an application's observer. Illustrative only: no region needed unless code is added.

---

## 13. Scoping decisions

Each item of the issue, plus the decisions this design adds, marked **in**, **out** or
**changed**.

| # | Item | Decision | Reason |
|---|---|---|---|
| S1 | "an opt-in way to receive each call's consumed capacity" | **In** | `ConsumedCapacity.layer` / `layerEffect` (§3). Off by default (owner decision 1). |
| S2 | "without changing return types" | **In** | No return, error or `R` type changes (§3, test §11.2-11). |
| S3 | "a service the application provides (an observer in context) that, when present, makes every command set ReturnConsumedCapacity" | **Changed** | Enabling is a `Context.Reference` set by `ConsumedCapacity.layer`. The observer is an optional part of it, so reporting can be on with spans only (owner decision 2). The application's own dependencies come through `layerEffect`. |
| S4 | "per library operation: the operation (`EventStream.read`, `readFrom`, `append`, `Entity.get`, `Query`, …)" | **In** | Names in §9. The issue's bare `Query` becomes `Entity.query` / `Collection.query`, or `Query.collect` etc. when a `Query` terminal is run directly. |
| S5 | "… and table" | **In** | `tables` (all tables, from the inputs) plus the per-table `byTable`, and the `aws.dynamodb.table_names` span attribute. |
| S6 | "total read and write capacity units, summed over every request the operation made" | **In** | `readCapacityUnits` / `writeCapacityUnits` plus `capacityUnits` (§4.3). The split falls back to command kind when DynamoDB omits it (documented). |
| S7 | "the number of pages (requests) a read made" | **In** | `requests` plus `requestsByCommand` (§7). |
| S8 | "An application can then put these on its own spans or metrics" | **In, extended** | The library also puts them on its own per-operation spans (owner decision 2), with `aws.dynamodb.consumed_capacity.total` always present. |
| S9 | "Returning them in results … would work too" | **Out** | It would change return types (S2, owner decision 1). Spans plus the observer cover the use case. |
| S10 | "… or a per-call option, would work too" | **Out** | A per-call option on every builder is a large API surface, and the issue's use case is blanket tracing. Per-subtree control exists: `ConsumedCapacity.layer` / `disabled` provided around any effect, subject to §3.3's bind-time rule. |
| S11 | Coverage: all library operations in one release | **In** | §9, including geo, projections, the checkpoint store, lifecycle and unique paths. |
| S12 | Table-management calls | **Out** | They consume no capacity (owner decision 3). |
| S13 | Raw `DynamoClient` service used directly by applications | **Out** | It stays a thin SDK pass-through. Only library operations are reported (§9.3). |
| S14 | DynamoDB Streams API calls (change feed) | **Out** | The API returns no capacity. The checkpoint store's table calls are **in**. |
| S15 | Failed calls | **In, as far as DynamoDB allows** | Counted as requests, with `unreportedRequests`. No SDK error carries capacity, and the gaps are documented (§8). |
| S16 | `level: "indexes"` (per-table / per-index breakdown) | **In (added)** | One-line request change. It answers "which GSI costs what" from the same feature. Default stays `"total"`. |
| S17 | `spans: false` option | **In (added)** | For observer-only users who do not want extra spans. One condition. |
| S18 | Public `withOperation` / `withOperationStream` | **In (added)** | The geo package needs it (it can only use public exports). Applications can group a unit of work into one report. |
| S19 | `nested` breakdown in the root report | **In (added)** | Makes nesting explicit in the observer without double counting (§6.3). It could be dropped without affecting anything else. |
| S20 | Vector search bytes | **In (added)** | `SearchVectors` bills bytes, not RCU, and leaving it out would report vector search as free. |
| S21 | SDK attempt counts (`$metadata.attempts`) | **Out** | Throttled attempts consume nothing, so totals are unaffected. A possible follow-up for throttling visibility. |
| S22 | Operation duration in the report | **Out** | Spans carry duration. The observer can time itself if it needs to. |
| S23 | OTel semconv `aws.dynamodb.consumed_capacity` (per-request JSON string[]) | **Out** | Unbounded on long reads. The per-table data is in the observer report (§5.2). |
| S24 | Spans when reporting is off | **Out** | Owner decision 1 ("no change at all when off"). The library emits no spans today. |
| S25 | `VectorSearchEmulation` reporting synthetic capacity | **Out** | AWS reports bytes it cannot know. It counts as one unreported request (§4.2). |
| S26 | Attribute namespace for library-invented attributes | **Changed (review)** | `request_count`, `unreported_requests` and vector bytes move from `aws.dynamodb.*` to `effect_dynamodb.*`. `aws.dynamodb.consumed_capacity.{total,read,write}` stay: `.total` is owner-mandated and deliberately conflicts with the semconv attribute of the same stem (§5.2). |
| S27 | Public `ConsumedCapacity.detachContext` | **In (added, review)** | Every bind site must strip the current scope and parent span from what it captures (§6.6); the geo package can only call public API. |
| S28 | Unbound `GeoIndex.make(...).put` reporting as `GeoIndex.put` | **Out (review)** | It returns the entity's put builder so entity combinators still apply; wrapping it would change its return type (owner decision 1). It reports as `Entity.put`; the bound `put` reports as `GeoIndex.put`. |
| S29 | Bind-time capture of `Tracer.ParentSpan` | **Changed (review)** | Pre-existing: every bind captured the parent span current at bind time and re-provided it on every call. `detachContext` now omits it, so bound operations (and any user code they run) parent to the caller's span. |

---

## 14. Open questions

1. **Span name format.** This design uses `effect-dynamodb.<operation>`, for example
   `effect-dynamodb.Entity.get`. An alternative is the bare `<operation>` with the library
   identified by `effect_dynamodb.operation` and `db.system.name`.
2. **Span kind.** This design uses `"client"`, following the OTel DB-client convention for
   logical operations that issue requests. `"internal"` is the alternative, if the application's
   backend treats client spans as remote calls.
3. **Observer timing.** The observer runs synchronously in the operation's fiber, before the
   operation returns. That is the simplest and deterministic for tests, but it adds the
   observer's latency to the call. The alternative is to fork it as a daemon, at the cost of
   determinism. The design keeps it synchronous and documents "fork inside the observer if it
   is slow".
4. **Module name.** `ConsumedCapacity` shadows the SDK's type of the same name if both are
   imported unqualified. `Capacity` is the alternative.

---

## 15. Adversarial review (resolutions)

Every finding was checked against the code; all eleven were real. How each is resolved:

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R1 | blocker | An observer writing through a client bound with reporting on recursed forever (captured `Reporting` beats a run-time "off"). | **Accepted.** The observer runs under `CurrentOperation = "suppressed"`, checked before `Reporting`; no bind captures `CurrentOperation` (§6.5, §6.6). Test §11.2-10 uses a client bound under the enabled layer. |
| R2 | major | Bind sites capture `Tracer.ParentSpan`, so bound spans parent to the bind-time span. | **Accepted.** `detachContext` omits it at every bind site (§6.6, S29). Test: bind under span A, call under B, parent is B. |
| R3 | major | `Entity.bind` (and `EventStore.ts` `bindProjection`) was missing from the omit list; `makeFromConfig → Entity.bind` re-captures; geo could not omit an internal reference. | **Accepted.** All six capture sites use `detachContext`, which is public for geo; closed scopes are treated as absent as a backstop (§6.1, §6.6). |
| R4 | major | `paginate` read the run-time `Reporting` while effect terminals read the captured one. | **Accepted.** Stream settings resolve at start inside `provide` and are provided to the pulls (§7.3, §3.3). Tests on all four terminals for bind-only and run-only enablement. |
| R5 | major | Scopes on `_run` made internal compositions (`updateOrCreate → create._run`, the no-op re-read) open nested scopes inside planning. | **Accepted.** Scopes sit on public terminals via `_exec`; `_run` stays unwrapped (§4.2, §9.1). |
| R6 | minor | Wrapping the unbound `GeoIndex.put` would change its return type. | **Accepted.** Only the bound `put` reports as `GeoIndex.put` (§9.2, S28). |
| R7 | minor | `src/` does fork (change feed `forkIn`), so checkpoint ops could nest under a stale scope. | **Accepted.** Claim corrected; the forked fibers start with `CurrentOperation` cleared (§6.6). |
| R8 | minor | `fetch()` is not always one request. | **Accepted.** §7.1 corrected; unit case added (§11.2-4). |
| R9 | minor | The static guard missed `Effect.map(DynamoClient, …)`, `DynamoClient.use`, `Context.get(ctx, DynamoClient)`. | **Accepted.** The guard matches any value use of `DynamoClient` outside the allowlist (§4.1). |
| R10 | minor | The observer, run from an exit finalizer, could not be interrupted. | **Partly accepted.** Success and failure reports run after the effect, interruptibly; only an interrupted operation reports from a finalizer (uninterruptible by nature), and the guide says to fork slow observers (§6.5). |
| R11 | minor | `aws.dynamodb.consumed_capacity.*` turns a semconv attribute into a namespace; other custom names squat in `aws.dynamodb.*`. | **Partly accepted.** The `.total` conflict is the owner's call and is documented; `.read` / `.write` stay beside it; the other invented names move to `effect_dynamodb.*` (§5.2, S26). |
