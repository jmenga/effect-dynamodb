/**
 * @internal Consumed-capacity reporting (#174) — the choke point and the
 * operation scopes. The public surface is `ConsumedCapacity.ts`.
 *
 * - {@link client} is how every library code path gets the DynamoDB client: an
 *   instrumented view ({@link instrument}) of whatever `DynamoClient` is in
 *   context — the built-in layer, a decorator, a mock. With reporting off the
 *   view calls the underlying method with the very same input and nothing else
 *   happens; with it on, each data-plane request asks for `ConsumedCapacity`
 *   and records what came back into the current operation scope.
 * - {@link operation} / {@link operationStream} open a named scope at a
 *   library operation's entry point. Requests record into their scope and
 *   every enclosing one; the outermost (root) scope delivers one report to the
 *   observer, so reports never double count. See
 *   `docs/designs/consumed-capacity.md`.
 */

import type {
  Capacity as SdkCapacity,
  ConsumedCapacity as SdkConsumedCapacity,
} from "@aws-sdk/client-dynamodb"
import { Cause, Context, Effect, Exit, Stream, Tracer } from "effect"
import { DynamoClient, type DynamoClientService } from "../DynamoClient.js"

// ---------------------------------------------------------------------------
// Public types (re-exported by ConsumedCapacity.ts)
// ---------------------------------------------------------------------------

/** How much detail DynamoDB is asked for. `"indexes"` adds the per-table / per-index breakdown. */
export type Level = "total" | "indexes"

/** The DynamoDB data-plane commands that can report capacity. */
export type Command =
  | "GetItem"
  | "PutItem"
  | "UpdateItem"
  | "DeleteItem"
  | "Query"
  | "Scan"
  | "BatchGetItem"
  | "BatchWriteItem"
  | "TransactGetItems"
  | "TransactWriteItems"
  | "SearchVectors"

/** Capacity and request totals, summed over every request of an operation. */
export interface CapacityTotals {
  /** Σ CapacityUnits over every request (what DynamoDB bills, in RCU + WCU). */
  readonly capacityUnits: number
  /** Σ read capacity units — DynamoDB's split when it gives one, else by command kind. */
  readonly readCapacityUnits: number
  /** Σ write capacity units — DynamoDB's split when it gives one, else by command kind. */
  readonly writeCapacityUnits: number
  /** Data-plane requests sent, including retries of unprocessed batch items. For a read, the pages. */
  readonly requests: number
  /** Requests whose outcome carried no ConsumedCapacity: failures, or a client that does not return it. */
  readonly unreportedRequests: number
}

/** Capacity of one table or index (level `"indexes"`). */
export interface IndexCapacity {
  readonly capacityUnits: number
  readonly readCapacityUnits: number
  readonly writeCapacityUnits: number
}

/** Per-table sums; with level `"indexes"`, also the table / per-index breakdown. */
export interface TableCapacity extends CapacityTotals {
  readonly tableName: string
  readonly table?: IndexCapacity | undefined
  readonly globalSecondaryIndexes?: Readonly<Record<string, IndexCapacity>> | undefined
  readonly localSecondaryIndexes?: Readonly<Record<string, IndexCapacity>> | undefined
}

/** A direct child operation of a root, grouped by name. Totals are inclusive. */
export interface NestedOperation extends CapacityTotals {
  readonly operation: string
  readonly calls: number
}

/** One report per root library operation. */
export interface OperationReport extends CapacityTotals {
  /** `"Entity.get"`, `"EventStream.read"`, … */
  readonly operation: string
  /** Low-cardinality subject: an entity type, stream, aggregate or collection name. */
  readonly target: string | undefined
  /** Logical index / accessor name, for query operations. */
  readonly index: string | undefined
  /** Every table a request named, sorted. */
  readonly tables: ReadonlyArray<string>
  /** Requests per DynamoDB command: `{ Query: 3, GetItem: 1 }`. */
  readonly requestsByCommand: Readonly<Partial<Record<Command, number>>>
  /** Per-table sums, sorted by table name. */
  readonly byTable: ReadonlyArray<TableCapacity>
  /** Vector index usage (billed in bytes, not capacity units). 0 when none. */
  readonly vectorSearchRequestBytes: number
  readonly vectorWriteRequestBytes: number
  /** Direct child operations, grouped by name. Their totals are INCLUDED above. */
  readonly nested: ReadonlyArray<NestedOperation>
  readonly outcome: "success" | "failure" | "interrupted"
}

/** Options for {@link make}. */
export interface Options {
  /** Default `"total"` (ReturnConsumedCapacity: TOTAL). `"indexes"` sends INDEXES. */
  readonly level?: Level | undefined
  /** Default `true`: every library operation runs in a span carrying its totals. */
  readonly spans?: boolean | undefined
  /**
   * Called once per ROOT library operation, after it completes, fails or is
   * interrupted. Library operations it runs itself are not reported. A failure
   * or defect is logged at warning level and never changes the operation's result.
   */
  readonly onOperation?: ((report: OperationReport) => Effect.Effect<void>) | undefined
}

/** Optional subject of an operation. */
export interface OperationOptions {
  /** Low-cardinality subject: an entity type, stream name, aggregate or collection name. */
  readonly target?: string | undefined
  /** Logical index / accessor name, for query operations. */
  readonly index?: string | undefined
}

/** The resolved reporting setting. Build with {@link make}. */
export interface Settings {
  readonly enabled: boolean
  readonly level: Level
  readonly spans: boolean
  readonly onOperation: ((report: OperationReport) => Effect.Effect<void>) | undefined
}

/** The "off" setting — the default. */
export const off: Settings = Object.freeze({
  enabled: false,
  level: "total",
  spans: false,
  onOperation: undefined,
})

/** Build an enabled setting. */
export const make = (options?: Options): Settings => ({
  enabled: true,
  level: options?.level ?? "total",
  spans: options?.spans ?? true,
  onOperation: options?.onOperation,
})

/** The reporting setting. Default: off. */
export const Reporting: Context.Reference<Settings> = Context.Reference<Settings>(
  "effect-dynamodb/ConsumedCapacity/Reporting",
  { defaultValue: () => off },
)

// ---------------------------------------------------------------------------
// Span attribute names
// ---------------------------------------------------------------------------

export const Attributes = {
  /** `"aws.dynamodb"` (OTel semconv). */
  dbSystem: "db.system.name",
  operation: "effect_dynamodb.operation",
  target: "effect_dynamodb.target",
  index: "effect_dynamodb.index",
  /** `true` when the operation runs inside another library operation. */
  nested: "effect_dynamodb.nested",
  /** OTel semconv: every table a request named. */
  tableNames: "aws.dynamodb.table_names",
  /** Σ capacity units — always present when reporting is on. */
  total: "aws.dynamodb.consumed_capacity.total",
  read: "aws.dynamodb.consumed_capacity.read",
  write: "aws.dynamodb.consumed_capacity.write",
  requestCount: "effect_dynamodb.request_count",
  unreportedRequests: "effect_dynamodb.unreported_requests",
  vectorSearchRequestBytes: "effect_dynamodb.vector.search_request_bytes",
  vectorWriteRequestBytes: "effect_dynamodb.vector.write_request_bytes",
} as const

/** Span name of an operation: `effect-dynamodb.<operation>`. */
export const spanName = (operation: string): string => `effect-dynamodb.${operation}`

// ---------------------------------------------------------------------------
// Operation scopes
// ---------------------------------------------------------------------------

interface MutableTotals {
  capacityUnits: number
  readCapacityUnits: number
  writeCapacityUnits: number
  requests: number
  unreportedRequests: number
}

interface MutableIndexCapacity {
  capacityUnits: number
  readCapacityUnits: number
  writeCapacityUnits: number
}

interface TableAccumulator extends MutableTotals {
  table: MutableIndexCapacity | undefined
  gsi: Map<string, MutableIndexCapacity> | undefined
  lsi: Map<string, MutableIndexCapacity> | undefined
}

/** @internal A live operation scope. */
export interface OperationScope {
  readonly name: string
  readonly target: string | undefined
  readonly index: string | undefined
  /**
   * The enclosing open scope. Invariant: while this scope is open, its parent
   * is open or `undefined` — a scope that closes first hands its open children
   * to its own parent (re-rooting them when it was the root).
   */
  parent: OperationScope | undefined
  readonly settings: Settings
  closed: boolean
  outcome: OperationReport["outcome"]
  // What this scope reports — to its parent's `nested`, or to the observer as
  // a root. Cleared when an enclosing scope closes first: what was recorded up
  // to then is already in that scope's totals (see {@link handOver}).
  readonly totals: MutableTotals
  readonly byCommand: Partial<Record<Command, number>>
  readonly tables: Map<string, TableAccumulator>
  vectorSearchRequestBytes: number
  vectorWriteRequestBytes: number
  readonly children: Map<string, { calls: number; totals: MutableTotals }>
  /** What was cleared from the fields above. The span carries both: it covers the scope's whole life. */
  readonly carried: {
    readonly totals: MutableTotals
    readonly tables: Set<string>
    vectorSearchRequestBytes: number
    vectorWriteRequestBytes: number
  }
  /** Child scopes still open. */
  readonly openChildren: Set<OperationScope>
  span: Tracer.Span | undefined
}

/** Set only while an observer runs: everything inside it runs unreported. */
export const SUPPRESSED = "suppressed" as const

/**
 * The operation the current fiber is inside. Never captured by a bind site
 * ({@link detachContext}), so a bound client cannot override it.
 */
export const CurrentOperation: Context.Reference<OperationScope | typeof SUPPRESSED | undefined> =
  Context.Reference<OperationScope | typeof SUPPRESSED | undefined>(
    "effect-dynamodb/ConsumedCapacity/CurrentOperation",
    { defaultValue: () => undefined },
  )

const zeroTotals = (): MutableTotals => ({
  capacityUnits: 0,
  readCapacityUnits: 0,
  writeCapacityUnits: 0,
  requests: 0,
  unreportedRequests: 0,
})

const addTotals = (into: MutableTotals, from: MutableTotals): void => {
  into.capacityUnits += from.capacityUnits
  into.readCapacityUnits += from.readCapacityUnits
  into.writeCapacityUnits += from.writeCapacityUnits
  into.requests += from.requests
  into.unreportedRequests += from.unreportedRequests
}

/**
 * The nearest open scope at or above `current`. A fiber that outlived its
 * operation still finds the operation's enclosing scope when that one is
 * open; `undefined` only when every enclosing scope has closed (the work
 * then reports as a root of its own).
 */
const liveScope = (
  current: OperationScope | typeof SUPPRESSED | undefined,
): OperationScope | undefined => {
  if (current === SUPPRESSED) return undefined
  let s = current
  while (s?.closed) s = s.parent
  return s
}

const newScope = (
  name: string,
  options: OperationOptions | undefined,
  settings: Settings,
  parent: OperationScope | undefined,
): OperationScope => {
  const scope: OperationScope = {
    name,
    target: options?.target,
    index: options?.index,
    parent,
    settings,
    closed: false,
    outcome: "success",
    totals: zeroTotals(),
    byCommand: {},
    tables: new Map(),
    vectorSearchRequestBytes: 0,
    vectorWriteRequestBytes: 0,
    children: new Map(),
    carried: {
      totals: zeroTotals(),
      tables: new Set(),
      vectorSearchRequestBytes: 0,
      vectorWriteRequestBytes: 0,
    },
    openChildren: new Set(),
    span: undefined,
  }
  parent?.openChildren.add(scope)
  return scope
}

const startAttributes = (scope: OperationScope): Record<string, unknown> => ({
  [Attributes.dbSystem]: "aws.dynamodb",
  [Attributes.operation]: scope.name,
  ...(scope.target !== undefined && { [Attributes.target]: scope.target }),
  ...(scope.index !== undefined && { [Attributes.index]: scope.index }),
  [Attributes.nested]: scope.parent !== undefined,
})

/** The span covers the scope's whole life: what it reports plus what was cleared from it. */
const annotateEnd = (span: Tracer.Span, scope: OperationScope): void => {
  const { carried } = scope
  const totals = zeroTotals()
  addTotals(totals, scope.totals)
  addTotals(totals, carried.totals)
  const vectorSearch = scope.vectorSearchRequestBytes + carried.vectorSearchRequestBytes
  const vectorWrite = scope.vectorWriteRequestBytes + carried.vectorWriteRequestBytes
  span.attribute(
    Attributes.tableNames,
    [...new Set([...carried.tables, ...scope.tables.keys()])].sort(),
  )
  span.attribute(Attributes.total, totals.capacityUnits)
  span.attribute(Attributes.read, totals.readCapacityUnits)
  span.attribute(Attributes.write, totals.writeCapacityUnits)
  span.attribute(Attributes.requestCount, totals.requests)
  if (totals.unreportedRequests > 0)
    span.attribute(Attributes.unreportedRequests, totals.unreportedRequests)
  if (vectorSearch > 0) span.attribute(Attributes.vectorSearchRequestBytes, vectorSearch)
  if (vectorWrite > 0) span.attribute(Attributes.vectorWriteRequestBytes, vectorWrite)
}

const freezeTotals = (t: MutableTotals): CapacityTotals => ({
  capacityUnits: t.capacityUnits,
  readCapacityUnits: t.readCapacityUnits,
  writeCapacityUnits: t.writeCapacityUnits,
  requests: t.requests,
  unreportedRequests: t.unreportedRequests,
})

const freezeIndex = (c: MutableIndexCapacity): IndexCapacity => ({
  capacityUnits: c.capacityUnits,
  readCapacityUnits: c.readCapacityUnits,
  writeCapacityUnits: c.writeCapacityUnits,
})

const freezeIndexes = (
  m: Map<string, MutableIndexCapacity> | undefined,
): Readonly<Record<string, IndexCapacity>> | undefined =>
  m === undefined
    ? undefined
    : Object.fromEntries([...m.entries()].map(([name, c]) => [name, freezeIndex(c)]))

/** @internal Build the observer report of a (closed) scope. */
export const buildReport = (scope: OperationScope): OperationReport => ({
  operation: scope.name,
  target: scope.target,
  index: scope.index,
  ...freezeTotals(scope.totals),
  tables: [...scope.tables.keys()].sort(),
  requestsByCommand: { ...scope.byCommand },
  byTable: [...scope.tables.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tableName, acc]) => ({
      tableName,
      ...freezeTotals(acc),
      ...(acc.table !== undefined && { table: freezeIndex(acc.table) }),
      ...(acc.gsi !== undefined && { globalSecondaryIndexes: freezeIndexes(acc.gsi) }),
      ...(acc.lsi !== undefined && { localSecondaryIndexes: freezeIndexes(acc.lsi) }),
    })),
  vectorSearchRequestBytes: scope.vectorSearchRequestBytes,
  vectorWriteRequestBytes: scope.vectorWriteRequestBytes,
  nested: [...scope.children.entries()].map(([operation, child]) => ({
    operation,
    calls: child.calls,
    ...freezeTotals(child.totals),
  })),
  outcome: scope.outcome,
})

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): OperationReport["outcome"] =>
  Exit.isSuccess(exit) ? "success" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure"

/**
 * Clear what `scope` (and every open scope under it) reports, moving it to
 * the span-only `carried` totals. Called when an enclosing scope closes while
 * `scope` is still running: everything recorded so far is already in that
 * scope's totals, so only later work may be reported again.
 */
const clearReported = (scope: OperationScope): void => {
  const { carried } = scope
  addTotals(carried.totals, scope.totals)
  for (const name of scope.tables.keys()) carried.tables.add(name)
  carried.vectorSearchRequestBytes += scope.vectorSearchRequestBytes
  carried.vectorWriteRequestBytes += scope.vectorWriteRequestBytes
  Object.assign(scope.totals, zeroTotals())
  for (const command of Object.keys(scope.byCommand)) delete scope.byCommand[command as Command]
  scope.tables.clear()
  scope.vectorSearchRequestBytes = 0
  scope.vectorWriteRequestBytes = 0
  scope.children.clear()
  for (const child of scope.openChildren) clearReported(child)
}

/**
 * A scope is closing while some of its children still run (forked into an
 * outer scope, or detached): hand them to its parent — or, when it is the
 * root, make each a root of its own. Their later requests are then charged to
 * the nearest open scope, and late work under a closed root is reported in a
 * later root report instead of being lost.
 */
const handOver = (scope: OperationScope): void => {
  const parent = scope.parent
  parent?.openChildren.delete(scope)
  for (const child of scope.openChildren) {
    child.parent = parent
    parent?.openChildren.add(child)
    clearReported(child)
  }
  scope.openChildren.clear()
}

/**
 * Close a scope: annotate its span, hand over its still-running children,
 * add it to its parent's `nested` breakdown, and — for a root — deliver the
 * report. The observer runs with everything it does suppressed; its failures
 * are logged and dropped.
 */
const finish = (scope: OperationScope, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (scope.closed) return Effect.void
    scope.closed = true
    scope.outcome = outcomeOf(exit)
    if (scope.span !== undefined) annotateEnd(scope.span, scope)
    handOver(scope)
    const parent = scope.parent
    if (parent !== undefined) {
      const entry = parent.children.get(scope.name)
      if (entry === undefined) {
        const totals = zeroTotals()
        addTotals(totals, scope.totals)
        parent.children.set(scope.name, { calls: 1, totals })
      } else {
        entry.calls++
        addTotals(entry.totals, scope.totals)
      }
      return Effect.void
    }
    const observer = scope.settings.onOperation
    if (observer === undefined) return Effect.void
    const report = buildReport(scope)
    return Effect.suspend(() => observer(report)).pipe(
      Effect.provideService(CurrentOperation, SUPPRESSED),
      Effect.exit,
      Effect.flatMap((observed) =>
        Exit.isFailure(observed) && !Cause.hasInterruptsOnly(observed.cause)
          ? Effect.logWarning(
              `effect-dynamodb: the ConsumedCapacity observer failed for ${scope.name}; the report was dropped`,
              observed.cause,
            )
          : Effect.void,
      ),
    )
  })

const runScope = <A, E, R>(
  name: string,
  options: OperationOptions | undefined,
  settings: Settings,
  parent: OperationScope | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const scope = newScope(name, options, settings, parent)
  const body = Effect.provideService(effect, CurrentOperation, scope)
  // Success and failure report after the effect, as ordinary (interruptible)
  // code; only an interrupted operation reports from the exit finalizer.
  const finished: Effect.Effect<A, E, R> = Effect.onExit(
    Effect.flatMap(Effect.exit(body), (exit) => Effect.flatMap(finish(scope, exit), () => exit)),
    (exit) => (scope.closed ? Effect.void : finish(scope, exit)),
  )
  if (!settings.spans) return finished
  return Effect.useSpan(
    spanName(name),
    { kind: "client", attributes: startAttributes(scope) },
    (span) => {
      scope.span = span
      return Effect.withParentSpan(finished, span)
    },
  ) as Effect.Effect<A, E, R>
}

/**
 * Run `effect` as the named library operation. With reporting off — or
 * inside an observer — `effect` runs unchanged.
 */
export const operation = <A, E, R>(
  name: string,
  options: OperationOptions | undefined,
  effect: Effect.Effect<A, E, R>,
  /**
   * The setting a bound client captured, for an operation that composes bound
   * calls but does not itself run inside the bound `provide` (a bound stream's
   * command handler). It wins over the run-time one, as captured settings do.
   */
  captured?: Settings | undefined,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const settings = captured ?? fiber.getRef(Reporting)
    if (!settings.enabled) return effect
    const current = fiber.getRef(CurrentOperation)
    if (current === SUPPRESSED) return effect
    return runScope(name, options, settings, liveScope(current), effect)
  })

/**
 * Like {@link operation}, but only when no operation is current: a delegate
 * (a `Query` terminal run by a library accessor) adds its requests to the
 * accessor's scope rather than opening one of its own.
 */
export const delegate = <A, E, R>(
  name: string,
  options: OperationOptions | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const settings = fiber.getRef(Reporting)
    if (!settings.enabled) return effect
    const current = fiber.getRef(CurrentOperation)
    if (current === SUPPRESSED || liveScope(current) !== undefined) return effect
    return runScope(name, options, settings, undefined, effect)
  })

/**
 * The stream form, as an effect to run where the stream is BUILT — inside a
 * bound client's `provide`, so the captured setting is the one read. The
 * returned stream decides at its start whether to open a scope (a delegate
 * does not when an operation is already current there), opens it for that
 * run (each run is one operation), and carries the resolved setting and
 * scope to every page pull, which happens later from the consumer's fiber.
 */
export const operationStream = <A, E, R>(
  name: string,
  options: OperationOptions | undefined,
  stream: Stream.Stream<A, E, R>,
  mode: "operation" | "delegate" = "operation",
): Effect.Effect<Stream.Stream<A, E, R>> =>
  Effect.withFiber((fiber) => {
    const settings = fiber.getRef(Reporting)
    if (!settings.enabled) return Effect.succeed(Stream.provideService(stream, Reporting, settings))
    return Effect.succeed(
      Stream.unwrap(
        Effect.withFiber((startFiber) => {
          const current = startFiber.getRef(CurrentOperation)
          const withSettings = Stream.provideService(stream, Reporting, settings)
          if (current === SUPPRESSED)
            return Effect.succeed(Stream.provideService(withSettings, CurrentOperation, SUPPRESSED))
          const parent = liveScope(current)
          if (mode === "delegate" && parent !== undefined)
            return Effect.succeed(Stream.provideService(withSettings, CurrentOperation, parent))
          return Effect.gen(function* () {
            const scope = newScope(name, options, settings, parent)
            let scoped = Stream.provideService(withSettings, CurrentOperation, scope)
            if (settings.spans) {
              const span = yield* Effect.makeSpanScoped(spanName(name), {
                kind: "client",
                attributes: startAttributes(scope),
              })
              scope.span = span
              scoped = Stream.provideService(scoped, Tracer.ParentSpan, span)
            }
            // Added after the span, so it runs first: the span is annotated
            // before it ends.
            yield* Effect.addFinalizer((exit) => finish(scope, exit))
            return scoped
          })
        }),
      ),
    )
  })

/**
 * Strip per-call state from a context captured for later use: the current
 * operation scope and the tracer's parent span.
 */
export const detachContext = <R>(context: Context.Context<R>): Context.Context<R> =>
  Context.omit(CurrentOperation, Tracer.ParentSpan)(context) as Context.Context<R>

/**
 * `(name, fn)` → `fn` as the operation `<prefix>.<name>` with `target`, for
 * the methods of an object whose every method is an operation.
 */
export const namedOperation =
  (prefix: string, target: string | undefined) =>
  <Args extends ReadonlyArray<any>, A, E, R>(
    name: string,
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ): ((...args: Args) => Effect.Effect<A, E, R>) =>
  (...args) =>
    operation(`${prefix}.${name}`, { target }, fn(...args))

/** The setting stored in a captured context, if one was provided there (no default). */
export const capturedSettings = (context: Context.Context<never>): Settings | undefined =>
  Context.getOrUndefined(context, Reporting)

/** Where a bound object keeps the setting captured at bind time. */
export const CapturedReporting: unique symbol = Symbol.for(
  "effect-dynamodb/Capacity/CapturedReporting",
)

/** Run `effect` outside any current operation (a long-lived forked fiber). */
export const detached = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) =>
    fiber.getRef(CurrentOperation) === SUPPRESSED
      ? effect
      : Effect.provideService(effect, CurrentOperation, undefined),
  )

// ---------------------------------------------------------------------------
// Recording one request
// ---------------------------------------------------------------------------

const READ_COMMANDS: ReadonlySet<Command> = new Set([
  "GetItem",
  "Query",
  "Scan",
  "BatchGetItem",
  "TransactGetItems",
  "SearchVectors",
])

/** Failures of requests that were never sent (a transaction plan's recorded write). */
const notSentErrors = new WeakSet<object>()

/** @internal Mark a client failure as local: no request reached DynamoDB. */
export const markNotSent = <A extends object>(error: A): A => {
  notSentErrors.add(error)
  return error
}

const tablesOf = (command: Command, input: Record<string, unknown>): ReadonlyArray<string> => {
  const names = new Set<string>()
  if (typeof input.TableName === "string") names.add(input.TableName)
  if (command === "BatchGetItem" || command === "BatchWriteItem") {
    const requestItems = input.RequestItems
    if (requestItems !== null && typeof requestItems === "object")
      for (const name of Object.keys(requestItems)) names.add(name)
  }
  if (command === "TransactGetItems" || command === "TransactWriteItems") {
    const items = input.TransactItems
    if (Array.isArray(items))
      for (const item of items) {
        if (item === null || typeof item !== "object") continue
        for (const part of Object.values(item as Record<string, unknown>)) {
          const name = (part as { readonly TableName?: unknown } | undefined)?.TableName
          if (typeof name === "string") names.add(name)
        }
      }
  }
  return [...names]
}

const toCapacityList = (value: unknown): ReadonlyArray<SdkConsumedCapacity> | undefined => {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) return value as ReadonlyArray<SdkConsumedCapacity>
  if (typeof value === "object") return [value as SdkConsumedCapacity]
  return undefined
}

/** `ConsumedCapacity` from a failure: on the error, or on the SDK exception it wraps. */
const capacityOfError = (error: unknown): unknown => {
  if (error === null || typeof error !== "object") return undefined
  const direct = (error as { readonly ConsumedCapacity?: unknown }).ConsumedCapacity
  if (direct !== undefined) return direct
  const cause = (error as { readonly cause?: unknown }).cause
  if (cause === null || typeof cause !== "object") return undefined
  return (cause as { readonly ConsumedCapacity?: unknown }).ConsumedCapacity
}

interface Split {
  readonly units: number
  readonly read: number
  readonly write: number
}

const split = (command: Command, c: SdkCapacity | SdkConsumedCapacity): Split => {
  const explicit = c.ReadCapacityUnits !== undefined || c.WriteCapacityUnits !== undefined
  const units = c.CapacityUnits ?? (c.ReadCapacityUnits ?? 0) + (c.WriteCapacityUnits ?? 0)
  if (explicit) return { units, read: c.ReadCapacityUnits ?? 0, write: c.WriteCapacityUnits ?? 0 }
  return READ_COMMANDS.has(command)
    ? { units, read: units, write: 0 }
    : { units, read: 0, write: units }
}

const addSplit = (into: MutableIndexCapacity, s: Split): void => {
  into.capacityUnits += s.units
  into.readCapacityUnits += s.read
  into.writeCapacityUnits += s.write
}

const addIndexes = (
  existing: Map<string, MutableIndexCapacity> | undefined,
  command: Command,
  indexes: Record<string, SdkCapacity> | undefined,
): Map<string, MutableIndexCapacity> | undefined => {
  if (indexes === undefined) return existing
  const map = existing ?? new Map<string, MutableIndexCapacity>()
  for (const [name, capacity] of Object.entries(indexes)) {
    let acc = map.get(name)
    if (acc === undefined) {
      acc = { capacityUnits: 0, readCapacityUnits: 0, writeCapacityUnits: 0 }
      map.set(name, acc)
    }
    addSplit(acc, split(command, capacity))
  }
  return map
}

const tableAccumulator = (scope: OperationScope, name: string): TableAccumulator => {
  let acc = scope.tables.get(name)
  if (acc === undefined) {
    acc = { ...zeroTotals(), table: undefined, gsi: undefined, lsi: undefined }
    scope.tables.set(name, acc)
  }
  return acc
}

/** What one request contributes, computed once and applied to every enclosing scope. */
interface RequestRecord {
  readonly command: Command
  readonly tables: ReadonlyArray<string>
  readonly capacities: ReadonlyArray<SdkConsumedCapacity>
  readonly reported: boolean
  readonly vectorSearchRequestBytes: number
  readonly vectorWriteRequestBytes: number
}

const describeRequest = (
  command: Command,
  input: Record<string, unknown>,
  exit: Exit.Exit<unknown, unknown>,
): RequestRecord | undefined => {
  let raw: unknown
  if (Exit.isSuccess(exit)) {
    raw = (exit.value as { readonly ConsumedCapacity?: unknown } | undefined)?.ConsumedCapacity
  } else {
    const error = Cause.findErrorOption(exit.cause)
    if (error._tag === "Some") {
      if (typeof error.value === "object" && error.value !== null && notSentErrors.has(error.value))
        return undefined
      raw = capacityOfError(error.value)
    }
  }
  const tables = tablesOf(command, input)
  if (command === "SearchVectors") {
    const bytes = (raw as { readonly VectorSearchRequestBytes?: unknown } | undefined)
      ?.VectorSearchRequestBytes
    const searchBytes = typeof bytes === "number" ? bytes : 0
    return {
      command,
      tables,
      capacities: [],
      reported: typeof bytes === "number",
      vectorSearchRequestBytes: searchBytes,
      vectorWriteRequestBytes: 0,
    }
  }
  const capacities = toCapacityList(raw) ?? []
  let writeBytes = 0
  for (const c of capacities)
    for (const v of Object.values(c.VectorIndexes ?? {}))
      writeBytes += v.VectorWriteRequestBytes ?? 0
  return {
    command,
    tables,
    capacities,
    reported: capacities.length > 0,
    vectorSearchRequestBytes: 0,
    vectorWriteRequestBytes: writeBytes,
  }
}

const applyRequest = (scope: OperationScope, record: RequestRecord): void => {
  const { command } = record
  scope.totals.requests++
  scope.byCommand[command] = (scope.byCommand[command] ?? 0) + 1
  if (!record.reported) scope.totals.unreportedRequests++
  scope.vectorSearchRequestBytes += record.vectorSearchRequestBytes
  scope.vectorWriteRequestBytes += record.vectorWriteRequestBytes
  for (const name of record.tables) {
    const acc = tableAccumulator(scope, name)
    acc.requests++
    if (!record.reported) acc.unreportedRequests++
  }
  for (const c of record.capacities) {
    const s = split(command, c)
    scope.totals.capacityUnits += s.units
    scope.totals.readCapacityUnits += s.read
    scope.totals.writeCapacityUnits += s.write
    const tableName =
      c.TableName ?? (record.tables.length === 1 ? record.tables[0] : undefined) ?? "unknown"
    const acc = tableAccumulator(scope, tableName)
    addSplit(acc, s)
    if (c.Table !== undefined) {
      acc.table ??= { capacityUnits: 0, readCapacityUnits: 0, writeCapacityUnits: 0 }
      addSplit(acc.table, split(command, c.Table))
    }
    acc.gsi = addIndexes(acc.gsi, command, c.GlobalSecondaryIndexes)
    acc.lsi = addIndexes(acc.lsi, command, c.LocalSecondaryIndexes)
  }
}

/**
 * Charge one request to the nearest open scope at or above the one it was
 * sent in, and every ancestor of that (all open, by the parent invariant).
 * When every one of them has closed while the request was in flight, the
 * request is reported as an implicit root of its own, so it is never lost.
 */
const record = (
  scope: OperationScope,
  command: Command,
  input: Record<string, unknown>,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const described = describeRequest(command, input, exit)
    if (described === undefined) return Effect.void
    const open = liveScope(scope)
    if (open === undefined) {
      // No span: the request ran under the (now ended) span of its operation.
      const late = newScope(`DynamoClient.${command}`, undefined, scope.settings, undefined)
      applyRequest(late, described)
      return finish(late, exit)
    }
    for (let s: OperationScope | undefined = open; s !== undefined; s = s.parent) {
      if (!s.closed) applyRequest(s, described)
    }
    return Effect.void
  })

// ---------------------------------------------------------------------------
// The choke point
// ---------------------------------------------------------------------------

/** The data-plane methods and their command names. Table management passes through. */
export const DATA_PLANE: ReadonlyArray<readonly [keyof DynamoClientService, Command]> = [
  ["getItem", "GetItem"],
  ["putItem", "PutItem"],
  ["updateItem", "UpdateItem"],
  ["deleteItem", "DeleteItem"],
  ["query", "Query"],
  ["scan", "Scan"],
  ["batchGetItem", "BatchGetItem"],
  ["batchWriteItem", "BatchWriteItem"],
  ["transactGetItems", "TransactGetItems"],
  ["transactWriteItems", "TransactWriteItems"],
  ["searchVectors", "SearchVectors"],
]

const InstrumentedTypeId: unique symbol = Symbol.for("effect-dynamodb/Capacity/Instrumented")

const instrumentedCache = new WeakMap<DynamoClientService, DynamoClientService>()

type AnyMethod = (input: Record<string, unknown>) => Effect.Effect<unknown, unknown>

const send = (command: Command, raw: AnyMethod, input: Record<string, unknown>) =>
  Effect.withFiber((fiber) => {
    const settings = fiber.getRef(Reporting)
    if (!settings.enabled) return raw(input)
    const current = fiber.getRef(CurrentOperation)
    if (current === SUPPRESSED) return raw(input)
    const flagged =
      input.ReturnConsumedCapacity !== undefined
        ? input
        : { ...input, ReturnConsumedCapacity: settings.level === "indexes" ? "INDEXES" : "TOTAL" }
    const recorded = Effect.withFiber((inner) => {
      const scope = liveScope(inner.getRef(CurrentOperation))
      return raw(flagged).pipe(
        Effect.onExit((exit) =>
          scope !== undefined ? record(scope, command, input, exit) : Effect.void,
        ),
      )
    })
    // A request outside every operation is an implicit root, named after the
    // command: its cost is still reported, under a name that shows the gap.
    return liveScope(current) !== undefined
      ? recorded
      : runScope(`DynamoClient.${command}`, undefined, settings, undefined, recorded)
  })

/**
 * The instrumented view of a client: the data-plane methods record their
 * capacity, everything else is the client's own. Memoised per client; an
 * already-instrumented client is returned as is.
 */
export const instrument = (service: DynamoClientService): DynamoClientService => {
  if ((service as unknown as Record<symbol, unknown>)[InstrumentedTypeId] === true) return service
  const cached = instrumentedCache.get(service)
  if (cached !== undefined) return cached
  // Prototype-backed, so a class-based client keeps its other members.
  const view = Object.create(service) as Record<string, unknown>
  for (const [method, command] of DATA_PLANE) {
    if (typeof (service as unknown as Record<string, unknown>)[method] !== "function") continue
    // Looked up per call, so a client whose methods are swapped later is honoured.
    const raw: AnyMethod = (input) =>
      ((service as unknown as Record<string, AnyMethod>)[method] as AnyMethod).call(service, input)
    view[method] = (input: Record<string, unknown>) => send(command, raw, input)
  }
  Object.defineProperty(view, InstrumentedTypeId, { value: true, enumerable: false })
  const instrumented = view as unknown as DynamoClientService
  instrumentedCache.set(service, instrumented)
  return instrumented
}

/** The client every library code path uses: the instrumented view of the one in context. */
export const client: Effect.Effect<DynamoClientService, never, DynamoClient> = Effect.suspend(() =>
  Effect.map(Effect.service(DynamoClient), instrument),
)

// ---------------------------------------------------------------------------
// Operation names carried by op builders
// ---------------------------------------------------------------------------

const OperationNameTypeId: unique symbol = Symbol.for("effect-dynamodb/Capacity/OperationName")

/**
 * Name the operation an entity op builder implements (`Entity.getVersion`
 * on a get-shaped op). The name travels with the builder function, so the
 * combinators that rebuild an op from its builder keep it.
 */
export const nameBuilder = <F extends object>(builder: F, name: string): F => {
  Object.defineProperty(builder, OperationNameTypeId, { value: name, enumerable: false })
  return builder
}

/** The name {@link nameBuilder} gave a builder, if any. */
export const builderName = (builder: object): string | undefined =>
  (builder as Record<symbol, string | undefined>)[OperationNameTypeId]

/** The `target` of an entity op: its entity type. */
export const entityTarget = (entity: object): OperationOptions => ({
  target: (entity as { readonly entityType?: string }).entityType,
})
