/**
 * One partition served the way DynamoDB serves a `Query` (#171) — for tests
 * that assert how many requests a query sends, with what `Limit`, and what
 * each one examined. Every row is in the queried partition: the partition key
 * condition is not evaluated.
 *
 * - Sort keys are ordered by their bytes, as DynamoDB orders them: an `S` key
 *   by its UTF-8 bytes (not JavaScript's UTF-16 `<`), a `B` key (#171) by its
 *   bytes, unsigned. Rows with the same sort key — a secondary index's, say —
 *   are ordered by the other key fields, which `ExclusiveStartKey` carries.
 * - The key condition the library sends on `#sk` — `=`, `<`, `<=`, `>`, `>=`,
 *   `BETWEEN :sk1 AND :sk2`, `begins_with(#sk, :sk)` — selects the rows, in
 *   `ScanIndexForward` order, from after `ExclusiveStartKey`. A zero-length
 *   operand is rejected (a defect), as DynamoDB rejects one (`EmptyKeyBound`).
 * - A request examines rows until `Limit` of them, or until the rows examined
 *   reach `pageBytes` (DynamoDB's 1 MB) when the partition gives rows a size.
 *   Stopping early returns a `LastEvaluatedKey`, even when no row is left —
 *   DynamoDB's contract, so the next page may be empty.
 * - `filter` stands in for the `FilterExpression` (no expression is parsed):
 *   it decides which examined rows are returned, for a request that sends
 *   one — a skip-scan probe sends none. With `evaluateFilter`, the
 *   `FilterExpression` itself is evaluated instead (`InMemoryTables`'
 *   evaluator). `Count` is the rows returned, `ScannedCount` the rows
 *   examined; `Select: "COUNT"` returns no `Items`.
 * - `ProjectionExpression: "#sk"` (a probe's) returns the sort key alone; any
 *   other projection is not applied.
 * - `ExpressionAttributeNames` is validated as DynamoDB validates it: a name
 *   an expression uses but doesn't declare, or one declared but unused, is
 *   rejected (a defect).
 *
 * `test/helpers/InMemoryTables.ts` is the store for write paths; this is the
 * read side, and only one partition of it.
 */

import type {
  AttributeValue,
  QueryCommandInput,
  QueryCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
} from "@aws-sdk/client-dynamodb"
import { Effect, type Layer } from "effect"
import type { DynamoClient } from "../../src/DynamoClient.js"
import { holds } from "./InMemoryTables.js"
import { mockDynamoClientLayer, mockOutput } from "./MockDynamoClient.js"

export type Row = Record<string, AttributeValue>

/** DynamoDB's page cap: rows examined stop once their sizes reach 1 MB. */
export const ONE_MB = 1024 * 1024

export interface PartitionOptions {
  /** The partition's rows, in any order. */
  readonly rows: ReadonlyArray<Row>
  /** The partition key attribute (default `"pk"`), for `LastEvaluatedKey`. */
  readonly pkField?: string | undefined
  /** The sort key attribute (default `"sk"`). */
  readonly skField?: string | undefined
  /**
   * The attributes of a `LastEvaluatedKey` (default `[pkField, skField]`) — for
   * a secondary index, its key and the table key.
   */
  readonly keyFields?: ReadonlyArray<string> | undefined
  /** Stands in for the `FilterExpression`: which examined rows are returned. */
  readonly filter?: ((row: Row) => boolean) | undefined
  /** Evaluate the `FilterExpression` sent, rather than a `filter` stand-in. */
  readonly evaluateFilter?: boolean | undefined
  /** A row's size in bytes, for the page cap. Without it, pages are capped by `Limit` only. */
  readonly rowBytes?: ((row: Row) => number) | undefined
  /** The page cap in bytes (default {@link ONE_MB}); needs `rowBytes`. */
  readonly pageBytes?: number | undefined
  /** Leave `ScannedCount` out of responses, as some mocks and older emulators do. */
  readonly omitScannedCount?: boolean | undefined
}

export interface Partition {
  /** A `DynamoClient.query`: serves the partition. */
  readonly query: (input: QueryCommandInput) => Effect.Effect<QueryCommandOutput, never>
  /** A `DynamoClient.scan`: the partition read whole, in sort key order. */
  readonly scan: (input: ScanCommandInput) => Effect.Effect<ScanCommandOutput, never>
  /** A `DynamoClient` layer serving `query` and `scan`. */
  readonly layer: Layer.Layer<DynamoClient>
  /** Every request received, in order (query and scan). */
  readonly inputs: Array<QueryCommandInput | ScanCommandInput>
  /** What each request received examined and returned, in order. */
  readonly responses: Array<{ readonly scannedCount: number; readonly count: number }>
  /** The `Limit` of every request received, in order. */
  readonly limits: () => Array<number | undefined>
  /** Rows examined across every request received. */
  readonly scanned: () => number
  /** Forget the requests received. */
  readonly clear: () => void
}

const encoder = new TextEncoder()

/** The bytes a key value sorts by: an `S` value's UTF-8, a `B` value's own. */
const keyBytes = (value: AttributeValue | undefined): Uint8Array => {
  if (value?.S !== undefined) return encoder.encode(value.S)
  if (value?.B !== undefined) return value.B
  throw new Error(`PartitionMock: unsupported key value ${JSON.stringify(value)}`)
}

/** A key condition operand: DynamoDB rejects a zero-length one (`EmptyKeyBound`). */
const operandBytes = (value: AttributeValue | undefined): Uint8Array => {
  const bytes = keyBytes(value)
  if (bytes.length === 0) {
    throw new Error(
      "PartitionMock: ValidationException — one or more parameter values are not valid: " +
        "a key condition operand is an empty string or binary value (EmptyKeyBound).",
    )
  }
  return bytes
}

/** Compare two byte strings as DynamoDB does: unsigned, byte by byte, shorter first on a tie. */
export const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

const startsWith = (value: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.length <= value.length && compareBytes(value.subarray(0, prefix.length), prefix) === 0

/**
 * The rows a key condition on `#sk` selects, as a predicate over a row's sort
 * key bytes. A condition without `#sk` selects every row; one on `#sk` in a
 * form not listed in the module doc throws, rather than select every row and
 * hide a wrong key condition.
 */
const keyCondition = (
  expression: string | undefined,
  values: Record<string, AttributeValue>,
): ((sk: Uint8Array) => boolean) => {
  if (expression === undefined || !expression.includes("#sk")) return () => true
  const operand = (name: string) => operandBytes(values[name])
  const between = /#sk BETWEEN (:\w+) AND (:\w+)/.exec(expression)
  if (between) {
    const [low, high] = [operand(between[1]!), operand(between[2]!)]
    return (sk) => compareBytes(sk, low) >= 0 && compareBytes(sk, high) <= 0
  }
  const prefix = /begins_with\(#sk, (:\w+)\)/.exec(expression)
  if (prefix) {
    const p = operand(prefix[1]!)
    return (sk) => startsWith(sk, p)
  }
  const comparison = /#sk (<=|>=|=|<|>) (:\w+)/.exec(expression)
  if (comparison) {
    const v = operand(comparison[2]!)
    switch (comparison[1]) {
      case "=":
        return (sk) => compareBytes(sk, v) === 0
      case "<":
        return (sk) => compareBytes(sk, v) < 0
      case "<=":
        return (sk) => compareBytes(sk, v) <= 0
      case ">":
        return (sk) => compareBytes(sk, v) > 0
      default:
        return (sk) => compareBytes(sk, v) >= 0
    }
  }
  throw new Error(`PartitionMock: unsupported sort key condition ${JSON.stringify(expression)}`)
}

/**
 * DynamoDB's validation of `ExpressionAttributeNames`: every `#name` an
 * expression uses must be declared, and every one declared must be used.
 */
const checkNames = (input: QueryCommandInput | ScanCommandInput): void => {
  const expressions = [
    "KeyConditionExpression" in input ? input.KeyConditionExpression : undefined,
    input.FilterExpression,
    input.ProjectionExpression,
  ]
  const used = new Set(expressions.flatMap((text) => text?.match(/#\w+/g) ?? []))
  const declared = Object.keys(input.ExpressionAttributeNames ?? {})
  const undeclared = [...used].filter((name) => !declared.includes(name))
  const unused = declared.filter((name) => !used.has(name))
  if (undeclared.length > 0 || unused.length > 0) {
    throw new Error(
      "PartitionMock: ValidationException — " +
        (undeclared.length > 0
          ? `an expression attribute name is not defined: ${undeclared.join(", ")}`
          : `ExpressionAttributeNames unused in expressions: ${unused.join(", ")}`),
    )
  }
}

/** Serve one partition (see the module doc). */
export const makePartition = (options: PartitionOptions): Partition => {
  const pkField = options.pkField ?? "pk"
  const skField = options.skField ?? "sk"
  const keyFields = options.keyFields ?? [pkField, skField]
  const pageBytes = options.pageBytes ?? ONE_MB
  // Ties on the sort key are ordered by the other key fields.
  const tieFields = keyFields.filter((field) => field !== skField && field !== pkField)
  const tieOf = (row: Row): Uint8Array =>
    encoder.encode(JSON.stringify(tieFields.map((field) => row[field] ?? null)))
  const order = (a: { sk: Uint8Array; tie: Uint8Array }, b: { sk: Uint8Array; tie: Uint8Array }) =>
    compareBytes(a.sk, b.sk) || compareBytes(a.tie, b.tie)
  const sorted = [...options.rows]
    .map((row) => ({ row, sk: keyBytes(row[skField]), tie: tieOf(row) }))
    .sort(order)
  const inputs: Array<QueryCommandInput | ScanCommandInput> = []
  const responses: Array<{ readonly scannedCount: number; readonly count: number }> = []
  let scannedTotal = 0

  const serve = (
    input: QueryCommandInput | ScanCommandInput,
    forward: boolean,
    matches: (sk: Uint8Array) => boolean,
  ) => {
    inputs.push(input)
    const ordered = (forward ? sorted : [...sorted].reverse()).filter((entry) => matches(entry.sk))
    const startKey = input.ExclusiveStartKey
    const start =
      startKey?.[skField] === undefined
        ? undefined
        : { sk: keyBytes(startKey[skField]), tie: tieOf(startKey) }
    const from =
      start === undefined
        ? ordered
        : ordered.filter((entry) => {
            const placed = order(entry, start)
            return forward ? placed > 0 : placed < 0
          })
    const examined: Array<Row> = []
    let bytes = 0
    let stoppedEarly = false
    for (const entry of from) {
      examined.push(entry.row)
      bytes += options.rowBytes?.(entry.row) ?? 0
      const limitReached = input.Limit !== undefined && examined.length >= input.Limit
      const sizeReached = options.rowBytes !== undefined && bytes >= pageBytes
      if (limitReached || sizeReached) {
        stoppedEarly = true
        break
      }
    }
    scannedTotal += examined.length
    const filtered =
      input.FilterExpression === undefined
        ? examined
        : options.evaluateFilter === true
          ? examined.filter((row) =>
              holds(
                input.FilterExpression,
                row,
                input.ExpressionAttributeNames ?? {},
                input.ExpressionAttributeValues ?? {},
              ),
            )
          : options.filter === undefined
            ? examined
            : examined.filter(options.filter)
    const returned =
      input.ProjectionExpression === "#sk"
        ? filtered.map((row) => ({ [skField]: row[skField]! }))
        : filtered
    responses.push({ scannedCount: examined.length, count: returned.length })
    const last = examined[examined.length - 1]
    const lastEvaluatedKey =
      stoppedEarly && last !== undefined
        ? Object.fromEntries(
            keyFields.flatMap((field) => (last[field] === undefined ? [] : [[field, last[field]]])),
          )
        : undefined
    return {
      ...(input.Select === "COUNT" ? {} : { Items: returned }),
      Count: returned.length,
      ...(options.omitScannedCount === true ? {} : { ScannedCount: examined.length }),
      ...(lastEvaluatedKey === undefined ? {} : { LastEvaluatedKey: lastEvaluatedKey }),
    }
  }

  const query = (input: QueryCommandInput) =>
    Effect.sync(() => {
      checkNames(input)
      const values = input.ExpressionAttributeValues ?? {}
      return mockOutput<QueryCommandOutput>(
        serve(
          input,
          input.ScanIndexForward !== false,
          keyCondition(input.KeyConditionExpression, values),
        ),
      )
    })
  const scan = (input: ScanCommandInput) =>
    Effect.sync(() => {
      checkNames(input)
      return mockOutput<ScanCommandOutput>(serve(input, true, () => true))
    })

  return {
    query,
    scan,
    layer: mockDynamoClientLayer({ query, scan }),
    inputs,
    responses,
    limits: () => inputs.map((input) => input.Limit),
    scanned: () => scannedTotal,
    clear: () => {
      inputs.length = 0
      responses.length = 0
      scannedTotal = 0
    },
  }
}
