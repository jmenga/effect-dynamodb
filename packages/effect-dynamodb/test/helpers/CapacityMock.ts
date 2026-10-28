/**
 * Test helpers for consumed-capacity reporting (#174).
 *
 * - {@link withConsumedCapacity} decorates any mock `DynamoClientService` so
 *   each data-plane response carries `ConsumedCapacity` — but only when the
 *   request asked for it, as DynamoDB does — and records every request sent.
 * - {@link recordingTracer} captures the spans the library creates.
 * - {@link collectReports} is an observer that keeps every report.
 */

import type { ConsumedCapacity as SdkConsumedCapacity } from "@aws-sdk/client-dynamodb"
import { Effect, Layer, Option, Tracer } from "effect"
import type { OperationReport } from "../../src/ConsumedCapacity.js"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"

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

const READS = new Set<Command>(["GetItem", "Query", "Scan", "BatchGetItem", "TransactGetItems"])

/** Every table a request names. */
export const tablesOf = (input: Record<string, any>): Array<string> => {
  const names = new Set<string>()
  if (typeof input.TableName === "string") names.add(input.TableName)
  for (const name of Object.keys(input.RequestItems ?? {})) names.add(name)
  for (const item of input.TransactItems ?? []) {
    for (const part of Object.values(item as Record<string, any>)) {
      if (typeof part?.TableName === "string") names.add(part.TableName)
    }
  }
  return [...names]
}

/** Default units per table: 0.5 for a read, 1 for a write, doubled in a transaction. */
export const defaultUnits = (command: Command): number =>
  (READS.has(command) ? 0.5 : 1) * (command.startsWith("Transact") ? 2 : 1)

export interface Sent {
  readonly command: Command
  readonly input: Record<string, any>
}

export interface CapacityOptions {
  /**
   * The `ConsumedCapacity` to answer with; `undefined` answers none. Default:
   * {@link defaultUnits} per table — one object, or an array for batch and
   * transaction commands.
   */
  readonly capacity?: (command: Command, input: Record<string, any>) => unknown
}

const defaultCapacity = (command: Command, input: Record<string, any>): unknown => {
  if (command === "SearchVectors") return { VectorSearchRequestBytes: 128 }
  const units = defaultUnits(command)
  const each = tablesOf(input).map(
    (TableName): SdkConsumedCapacity => ({ TableName, CapacityUnits: units }),
  )
  return command.startsWith("Batch") || command.startsWith("Transact") ? each : each[0]
}

/**
 * Decorate `service` so its data-plane responses carry `ConsumedCapacity`
 * when asked for, and record what was sent.
 */
export const withConsumedCapacity = (
  service: DynamoClientService,
  options?: CapacityOptions,
): { readonly service: DynamoClientService; readonly sent: Array<Sent> } => {
  const sent: Array<Sent> = []
  const capacity = options?.capacity ?? defaultCapacity
  const decorated: Record<string, unknown> = { ...service }
  for (const [method, command] of DATA_PLANE) {
    const raw = service[method] as (input: any) => Effect.Effect<any, any>
    decorated[method] = (input: Record<string, any>) => {
      sent.push({ command, input })
      return Effect.map(raw(input), (output) => {
        if (input.ReturnConsumedCapacity === undefined || output === undefined) return output
        const consumed = capacity(command, input)
        return consumed === undefined ? output : { ...output, ConsumedCapacity: consumed }
      })
    }
  }
  return { service: decorated as unknown as DynamoClientService, sent }
}

/** Resolve the `DynamoClientService` a layer provides (a mock's). */
export const serviceOf = (layer: Layer.Layer<DynamoClient>): DynamoClientService =>
  Effect.runSync(Effect.service(DynamoClient).pipe(Effect.provide(layer)))

/** A `DynamoClient` layer of `service`. */
export const clientLayer = (service: DynamoClientService): Layer.Layer<DynamoClient> =>
  Layer.succeed(DynamoClient, service)

/** A tracer that keeps every span it creates. */
export const recordingTracer = (): {
  readonly tracer: Tracer.Tracer
  readonly spans: Array<Tracer.NativeSpan>
  readonly layer: Layer.Layer<never>
  readonly named: (prefix?: string) => Array<Tracer.NativeSpan>
} => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  return {
    tracer,
    spans,
    layer: Layer.succeed(Tracer.Tracer, tracer),
    named: (prefix = "effect-dynamodb.") => spans.filter((s) => s.name.startsWith(prefix)),
  }
}

/** The parent span's name, if any. */
export const parentName = (span: Tracer.NativeSpan): string | undefined => {
  const parent = Option.getOrUndefined(span.parent)
  return parent !== undefined && parent._tag === "Span" ? parent.name : undefined
}

/** An observer that keeps every report. */
export const collectReports = (): {
  readonly reports: Array<OperationReport>
  readonly onOperation: (report: OperationReport) => Effect.Effect<void>
} => {
  const reports: Array<OperationReport> = []
  return {
    reports,
    onOperation: (report) =>
      Effect.sync(() => {
        reports.push(report)
      }),
  }
}
