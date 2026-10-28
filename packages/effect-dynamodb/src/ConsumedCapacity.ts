/**
 * ConsumedCapacity — opt-in reporting of what each library operation cost (#174).
 *
 * Off by default: with no `ConsumedCapacity.layer` in context, no request or
 * response is touched and no span is created. Turned on, every library
 * operation (`Entity.get`, `EventStream.read`, `Batch.write`, …):
 *
 * - asks DynamoDB for `ConsumedCapacity` on every data-plane request it sends,
 *   and sums it — with the number of requests (pages, for a read) and the
 *   tables they named — over the whole operation;
 * - runs in a span (`effect-dynamodb.<operation>`) carrying those totals as
 *   attributes, `aws.dynamodb.consumed_capacity.total` always among them;
 * - delivers one {@link OperationReport} per ROOT operation to the optional
 *   `onOperation` observer. A library operation that runs inside another one
 *   (a `commandHandler`'s read and append) is charged to it and listed in its
 *   report's `nested` breakdown, so summing reports never double counts.
 *
 * The instrumentation wraps whatever `DynamoClient` is in context, so it works
 * with the built-in layer, a decorated client and a mock alike.
 *
 * @example
 * ```ts
 * const AppLayer = Layer.mergeAll(
 *   DynamoClient.layer({ region: "us-east-1" }),
 *   ConsumedCapacity.layer({
 *     onOperation: (report) =>
 *       Effect.logInfo(`${report.operation}: ${report.capacityUnits} units`),
 *   }),
 * )
 * ```
 */

import { type Context, Effect, Function, Layer, Stream } from "effect"
import * as Capacity from "./internal/Capacity.js"

export type {
  CapacityTotals,
  Command,
  IndexCapacity,
  Level,
  NestedOperation,
  OperationOptions,
  OperationReport,
  Options,
  Settings,
  TableCapacity,
} from "./internal/Capacity.js"

/**
 * The reporting setting, a `Context.Reference` whose default is "off". Use
 * {@link layer} / {@link disabled}, or provide it directly:
 * `Effect.provideService(ConsumedCapacity.Reporting, ConsumedCapacity.make(options))`.
 */
export const Reporting: Context.Reference<Capacity.Settings> = Capacity.Reporting

/** Build an enabled setting from options. */
export const make: (options?: Capacity.Options) => Capacity.Settings = Capacity.make

/**
 * Turn reporting on for everything run under this layer.
 *
 * Read at run time from the operation's fiber — but a client bound with
 * `DynamoClient.make` (or `EventStore.bind`, …) while this layer was in
 * context keeps it for every call through that client.
 */
export const layer = (options?: Capacity.Options): Layer.Layer<never> =>
  Layer.succeed(Capacity.Reporting, Capacity.make(options))

/** {@link layer}, with the options built in an effect (when the observer needs services). */
export const layerEffect = <E, R>(
  options: Effect.Effect<Capacity.Options, E, R>,
): Layer.Layer<never, E, R> =>
  Layer.effect(
    Capacity.Reporting,
    Effect.map(options, (o) => Capacity.make(o)),
  )

/** Turn reporting off for a subtree (a test, a noisy maintenance job). */
export const disabled: Layer.Layer<never> = Layer.succeed(Capacity.Reporting, Capacity.off)

/**
 * Run an effect as a named operation: its library calls are summed into one
 * report (and one span), with the library operations inside it listed as
 * `nested`. With reporting off it runs the effect unchanged.
 *
 * @example
 * ```ts
 * const placeOrder = (order: Order) =>
 *   Effect.gen(function* () {
 *     yield* db.entities.Orders.put(order)
 *     yield* db.entities.Accounts.update({ accountId: order.accountId }).add({ orders: 1 })
 *   }).pipe(ConsumedCapacity.withOperation("placeOrder", { target: "Order" }))
 * ```
 */
export const withOperation: {
  (
    name: string,
    options?: Capacity.OperationOptions,
  ): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    name: string,
    options?: Capacity.OperationOptions,
  ): Effect.Effect<A, E, R>
} = Function.dual(
  (args) => Effect.isEffect(args[0]),
  <A, E, R>(
    self: Effect.Effect<A, E, R>,
    name: string,
    options?: Capacity.OperationOptions,
  ): Effect.Effect<A, E, R> => Capacity.operation(name, options, self),
)

/**
 * The stream form of {@link withOperation}: each run of the stream is one
 * operation, from its start to its end (or the consumer stopping early).
 */
export const withOperationStream: {
  (
    name: string,
    options?: Capacity.OperationOptions,
  ): <A, E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>
  <A, E, R>(
    self: Stream.Stream<A, E, R>,
    name: string,
    options?: Capacity.OperationOptions,
  ): Stream.Stream<A, E, R>
} = Function.dual(
  (args) => Stream.isStream(args[0]),
  <A, E, R>(
    self: Stream.Stream<A, E, R>,
    name: string,
    options?: Capacity.OperationOptions,
  ): Stream.Stream<A, E, R> => Stream.unwrap(Capacity.operationStream(name, options, self)),
)

/** Span attribute names, so applications and tests need no string literals. */
export const Attributes = Capacity.Attributes

/** The span name of an operation: `effect-dynamodb.<operation>`. */
export const spanName: (operation: string) => string = Capacity.spanName

/**
 * Strip per-call state from a context captured for later use — the current
 * operation and the tracer's parent span — so later calls through it neither
 * nest under the operation that was running at capture time nor parent their
 * spans to the span that was current then. Every bind site of the library
 * uses it; it is public for packages and applications that write their own.
 */
export const detachContext: <R>(context: Context.Context<R>) => Context.Context<R> =
  Capacity.detachContext
