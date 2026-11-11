/**
 * What published 1.39.0 did, replayed: the table, the steps and the comparison shared by the
 * scenarios that pin a behaviour 1.39.0 had (`OptionalShardAppend.ts`, `StoredNaNKeys.ts`,
 * `AggregateCreateStamps.ts`). Each fixture holds, for a scenario, every step's outcome and the
 * table's rows after it (and, in `tuple-clears`, the requests it sent), as a scratch script
 * captured them from the published 1.39.0 against
 * DynamoDB Local. A scenario runs the same steps here, on a recording table (`Kept139.test.ts`)
 * and on DynamoDB Local (`connected.kept-1.39.0.test.ts`), and compares.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { Cause, DateTime, Duration, Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"
import { makeRecordingTable } from "./RecordingTable.js"

export type Row = Record<string, AttributeValue>

/** A step's outcome as the fixtures hold it: what it returned, or the failure's tag and EDD code. */
export type Outcome =
  | { readonly ok: unknown }
  | { readonly fail: string; readonly code?: string; readonly message?: string }
  | { readonly die: string; readonly code?: string; readonly message?: string }
  | { readonly throws: string }

export interface Step {
  readonly step: string
  readonly outcome: Outcome
  readonly rows: ReadonlyArray<Row>
  /** The requests the step sent, where the fixture keeps them. */
  readonly requests?: ReadonlyArray<unknown>
}

/** A fixture captured from the published 1.39.0: `fixtures/<name>-1.39.0.json`. */
export const fixtureOf = <Scenarios>(
  name: string,
): { readonly generatedFrom: string; readonly clock: number; readonly scenarios: Scenarios } =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}-1.39.0.json`, import.meta.url), "utf8"))

/** A table a scenario runs on. */
export interface ScenarioTable {
  readonly name: string
  readonly layer: Layer.Layer<DynamoClient>
  readonly rows: Effect.Effect<ReadonlyArray<Row>>
  readonly close: Effect.Effect<void>
}

/** Opens an empty table of `MainTable`'s definition. */
export type OpenTable = (MainTable: Table.Table) => Effect.Effect<ScenarioTable>

/** A recording table with `MainTable`'s secondary indexes. */
export const openRecordingTable: OpenTable = (MainTable) =>
  Effect.sync(() => {
    const indexes = Object.fromEntries(
      (Table.definition(MainTable).GlobalSecondaryIndexes ?? []).map((index) => [
        index.IndexName!,
        {
          pk: index.KeySchema!.find((key) => key.KeyType === "HASH")!.AttributeName!,
          sk: index.KeySchema!.find((key) => key.KeyType === "RANGE")!.AttributeName!,
        },
      ]),
    )
    const table = makeRecordingTable({ indexes, refuseInvalidUpdates: true })
    return {
      name: "t",
      layer: table.layer,
      rows: Effect.sync(() => [...table.items.values()] as ReadonlyArray<Row>),
      close: Effect.void,
    }
  })

/**
 * A value as the fixtures hold it: a non-finite number as `{ number }`, a bigint as `{ bigint }`, a
 * date as `{ date }`.
 */
const plain = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(value, function (this: Record<string, unknown>, key, encoded) {
          const held = this[key]
          if (held instanceof Date) return { date: held.getTime() }
          if (held !== null && typeof held === "object" && DateTime.isDateTime(held)) {
            return { date: DateTime.toEpochMillis(held) }
          }
          if (typeof encoded === "number" && !Number.isFinite(encoded)) {
            return { number: String(encoded) }
          }
          if (typeof encoded === "bigint") return { bigint: String(encoded) }
          return encoded
        }),
      )

const codeOf = (message: string): string | undefined => /\[?(EDD-\d{4})\]?/.exec(message)?.[1]

const outcomeOf = (exit: Exit.Exit<unknown, unknown>, map: (value: any) => unknown): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: map(exit.value) ?? null }
  const squashed = Cause.squash(exit.cause) as any
  const message = String(
    squashed?.cause?.message ?? squashed?.message ?? squashed?.cause ?? squashed,
  )
  const code = codeOf(message)
  const tag = String(squashed?._tag ?? squashed?.name ?? "Error")
  const detail = code === undefined ? { message: message.split("\n")[0]!.slice(0, 120) } : { code }
  return Cause.hasFails(exit.cause) ? { fail: tag, ...detail } : { die: tag, ...detail }
}

const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`

/** Rows by key, each attribute by name, and the incarnation token (a UUID per put) set aside. */
export const sortedRows = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  [...rows]
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
    .map((row) =>
      Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((name) => [name, name === "__edd_i__" ? { S: "<token>" } : row[name]!]),
      ),
    )

/** A step: its name, the effect (built when its turn comes), and what of its result is kept. */
export type StepOf = readonly [
  name: string,
  make: () => Effect.Effect<unknown, unknown, any>,
  map?: (value: any) => unknown,
]

/**
 * Each step's outcome and the table's rows after it, and with `requests` (which hands over what was
 * sent since it was last asked), what the step sent. A step that throws when built is `throws`.
 */
export const runSteps = (
  table: ScenarioTable,
  steps: ReadonlyArray<StepOf>,
  requests?: () => ReadonlyArray<unknown>,
) =>
  Effect.gen(function* () {
    const out: Array<Step> = []
    for (const [step, make, map = plain] of steps) {
      let outcome: Outcome
      try {
        outcome = outcomeOf(yield* Effect.exit(make()), map)
      } catch (error) {
        const message = String((error as Error)?.message)
        outcome = { throws: codeOf(message) ?? message.slice(0, 120) }
      }
      const rows = sortedRows(yield* table.rows)
      out.push(
        requests === undefined
          ? { step, outcome, rows }
          : { step, outcome, rows, requests: requests() },
      )
    }
    return out
  })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A request as the fixtures hold it: the table's name and each UUID (a row's token) set aside. */
const plainRequest = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(plainRequest)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([name, held]) => [
            name,
            name === "TableName" ? "<table>" : plainRequest(held),
          ]),
        )
      : typeof value === "string" && UUID.test(value)
        ? "<uuid>"
        : value

/** `open`, with every request sent to its tables kept in `log`, as `{ [operation]: input }`. */
export const recordingRequests =
  (open: OpenTable, log: Array<unknown>): OpenTable =>
  (MainTable) =>
    Effect.map(open(MainTable), (table) => ({
      ...table,
      layer: Layer.effect(
        DynamoClient,
        Effect.gen(function* () {
          const client = yield* DynamoClient
          return Object.fromEntries(
            Object.entries(client).map(([name, operation]) => [
              name,
              typeof operation === "function"
                ? (input: unknown) =>
                    Effect.suspend(() => {
                      log.push({ [name]: plainRequest(JSON.parse(JSON.stringify(input ?? null))) })
                      return operation.call(client, input)
                    })
                : operation,
            ]),
          ) as unknown as DynamoClientService
        }),
      ).pipe(Layer.provide(table.layer)),
    }))

/**
 * Run `body` against a client over `members` on an empty table of `MainTable`, with the clock at
 * the instant the fixture was captured at.
 */
export const onTable = <A>(
  open: OpenTable,
  clock: number,
  MainTable: Table.Table,
  members: { readonly entities: Record<string, any>; readonly aggregates?: Record<string, any> },
  body: (db: any, table: ScenarioTable) => Effect.Effect<A, unknown, any>,
): Effect.Effect<A, unknown> =>
  Effect.acquireUseRelease(
    open(MainTable),
    (table) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(Duration.millis(clock))
        const db = yield* DynamoClient.make({ ...members, tables: { MainTable } } as never)
        return yield* body(db, table)
      }).pipe(
        Effect.provide(MainTable.layer({ name: table.name })),
        Effect.provide(table.layer),
      ) as Effect.Effect<A, unknown>,
    (table) => table.close,
  )
