/**
 * The key written is the key composed again from the row as it reads back, against DynamoDB Local,
 * over rows published 1.39.0 stored: the connected twin of `RekeyExactKinds`,
 * `AggregateDottedKeyJudge`, `AggregateRootKeyReadBack` and `HistoryWhereOperand`. Declarations and
 * rows: `helpers/ReadBackKeys.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Config, Effect, Exit, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  asGiven,
  byKey,
  conflictsByKey,
  dottedDefinitions,
  dottedParentRows,
  dottedShapes,
  exactKindCases,
  exactKindDefinitions,
  exactKindRows,
  historyDefinitions,
  historyMoved,
  historyRows,
  historyRowsNow,
  historyShapes,
  type Row,
  refusedConflicts,
  rootKeyDefinitions,
  rootKeyRows,
  rootKeyShapes,
  toNumber,
  x10,
} from "./helpers/ReadBackKeys.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const send = <A>(make: () => Promise<A>) =>
  Effect.tryPromise(make).pipe(Effect.orDie) as Effect.Effect<A>

let tables = 0

type Physical = {
  readonly name: string
  /** Every row, read consistently, in key order. */
  readonly rows: Effect.Effect<Array<Row>>
}

/** A fresh table (with `gsi1` when `list` is set) seeded with `seed`, dropped after `body`. */
const withTable = <A, E>(
  seed: ReadonlyArray<Row>,
  options: { readonly list?: boolean },
  body: (table: Physical) => Effect.Effect<A, E, any>,
) => {
  const TableName = `read-back-keys-${Date.now()}-${tables++}`
  const gsi = options.list === true
  return Effect.gen(function* () {
    yield* send(() =>
      raw.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            ...(gsi
              ? [
                  { AttributeName: "gsi1pk", AttributeType: "S" as const },
                  { AttributeName: "gsi1sk", AttributeType: "S" as const },
                ]
              : []),
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          ...(gsi
            ? {
                GlobalSecondaryIndexes: [
                  {
                    IndexName: "gsi1",
                    KeySchema: [
                      { AttributeName: "gsi1pk", KeyType: "HASH" as const },
                      { AttributeName: "gsi1sk", KeyType: "RANGE" as const },
                    ],
                    Projection: { ProjectionType: "ALL" as const },
                  },
                ],
              }
            : {}),
        }),
      ),
    )
    for (const Item of seed) yield* send(() => raw.send(new PutItemCommand({ TableName, Item })))
    const rows = Effect.map(
      send(() => raw.send(new ScanCommand({ TableName, ConsistentRead: true }))),
      (out) => byKey((out.Items ?? []) as unknown as ReadonlyArray<Row>),
    )
    return yield* body({ name: TableName, rows })
  }).pipe(
    Effect.ensuring(Effect.ignore(send(() => raw.send(new DeleteTableCommand({ TableName }))))),
  ) as Effect.Effect<A, unknown>
}

/** Bind `members` on `Main` against `table`, and run `body` with the client. */
const bound = <A, E>(
  table: Physical,
  Main: any,
  members: Record<string, unknown>,
  body: (db: any) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ ...members, tables: { Main } } as never) as Effect.Effect<
      any,
      never,
      any
    >
    return yield* body(db)
  }).pipe(
    Effect.provide(Main.layer({ name: table.name })),
    Effect.provide(ClientLayer),
  ) as Effect.Effect<A, unknown>

describeConnected("the key written is the key composed from the row read back (connected)", () => {
  describe("rekey leaves a row whose number the declared kind can't hold exactly", () => {
    for (const { name, Kind, kind, refused, read } of exactKindCases) {
      for (const dryRun of [true, false]) {
        it.effect(`declared ${name}${dryRun ? ", dry run" : ""}`, () =>
          withTable(exactKindRows, {}, (table) => {
            const { E, Main } = exactKindDefinitions(Kind)
            return bound(table, Main, { entities: { E } }, (db) =>
              Effect.gen(function* () {
                const report = yield* db.tables.Main.rekey(dryRun ? { dryRun: true } : undefined)
                expect(conflictsByKey(report.conflicts)).toEqual(refusedConflicts(refused, kind))
                expect(Object.values(report.moved).every((count) => count === 0)).toBe(true)
                expect(report.sentinelsMoved).toBe(0)
                expect(report.unchanged).toBe(read.length)
                expect(yield* table.rows).toEqual(byKey(exactKindRows))
              }),
            )
          }),
        )
      }
    }
  })

  describe("a dotted edge key under a transformed parent is judged through the parent", () => {
    for (const { optional, deep, shape, path, value, held } of dottedShapes) {
      const stored = dottedParentRows[shape]!
      const update = (aggregate: any) =>
        aggregate.update({ id: "x" }, ({ state }: any) => ({
          ...state,
          lines: state.lines.map((line: any) => ({ ...line, note: "after" })),
        }))

      it.effect(`${shape}: create stores the rows 1.39.0 stored, and they read and update`, () =>
        withTable([], {}, (table) => {
          const { Main, Roots } = dottedDefinitions(toNumber, optional, deep)
          return bound(table, Main, { entities: {}, aggregates: { Roots } }, (db) =>
            Effect.gen(function* () {
              const aggregate = db.aggregates.Roots
              yield* aggregate.create({ id: "x", lines: [{ nested: value, note: "before" }] })
              expect(yield* table.rows).toEqual(byKey(stored))
              yield* update(aggregate)
              expect((yield* aggregate.get({ id: "x" })).lines).toEqual([
                { nested: value, note: "after" },
              ])
              expect((yield* table.rows).map((row) => `${row.pk.S}|${row.sk.S}`)).toEqual(
                byKey(stored).map((row) => `${row.pk.S}|${row.sk.S}`),
              )
            }),
          )
        }),
      )

      it.effect(`${shape}: the rows 1.39.0 stored read and update`, () =>
        withTable(stored, {}, (table) => {
          const { Main, Roots } = dottedDefinitions(toNumber, optional, deep)
          return bound(table, Main, { entities: {}, aggregates: { Roots } }, (db) =>
            Effect.gen(function* () {
              const aggregate = db.aggregates.Roots
              expect((yield* aggregate.get({ id: "x" })).lines).toEqual([
                { nested: value, note: "before" },
              ])
              yield* update(aggregate)
              expect((yield* aggregate.get({ id: "x" })).lines).toEqual([
                { nested: value, note: "after" },
              ])
              expect((yield* table.rows).map((row) => `${row.pk.S}|${row.sk.S}`)).toEqual(
                byKey(stored).map((row) => `${row.pk.S}|${row.sk.S}`),
              )
            }),
          )
        }),
      )

      it.effect(`${shape}: a parent that keeps the kind read back is refused`, () =>
        withTable([], {}, (table) => {
          const { Main, Roots } = dottedDefinitions(asGiven, optional, deep)
          return bound(table, Main, { entities: {}, aggregates: { Roots } }, (db) =>
            Effect.gen(function* () {
              const created = yield* Effect.exit(
                db.aggregates.Roots.create({
                  id: "x",
                  lines: [{ nested: held, note: "before" }],
                }).pipe(Effect.asVoid),
              )
              expect(Exit.isFailure(created)).toBe(true)
              const message = JSON.stringify(created)
              expect(message).toContain("EDD-9128")
              expect(message).toContain(`Field \\"${path}\\" of \\"lines\\"`)
              expect(message).toContain("the bigint 5n would read back as a number")
              expect(yield* table.rows).toEqual([])
            }),
          )
        }),
      )
    }
  })

  describe("an aggregate's partition key composed from its stored root is the key create wrote", () => {
    for (const { name, Kind, n, text } of rootKeyShapes) {
      for (const escapeKeys of [false, true]) {
        it.effect(`${name}, escapeKeys ${escapeKeys}: get, list and rekey find it`, () =>
          withTable([], { list: true }, (table) => {
            const { Main, Roots } = rootKeyDefinitions(name, Kind, escapeKeys)
            return bound(table, Main, { entities: {}, aggregates: { Roots } }, (db) =>
              Effect.gen(function* () {
                const aggregate = db.aggregates.Roots
                yield* aggregate.create({ id: "a", n, note: "before" })
                const keys = [`$${name}#v1#roots#a#${text}`]
                expect((yield* table.rows).map((row) => row.pk.S)).toEqual(keys)
                expect((yield* aggregate.get({ id: "a", n })).n).toEqual(n)
                expect((yield* aggregate.list({})).data.map((root: any) => root.n)).toEqual([n])
                const report = yield* db.tables.Main.rekey()
                expect(report.conflicts).toEqual([])
                expect(report.skipped.unrecognizedKey).toBe(0)
                expect(report.moved.aggregate).toBe(0)
                expect((yield* table.rows).map((row) => row.pk.S)).toEqual(keys)
              }),
            )
          }),
        )
      }

      it.effect(`${name}: rekey moves it on an escapeKeys change, and get finds it there`, () =>
        withTable([], { list: true }, (table) =>
          Effect.gen(function* () {
            const before = rootKeyDefinitions(name, Kind, false)
            yield* bound(
              table,
              before.Main,
              { entities: {}, aggregates: { Roots: before.Roots } },
              (db) => db.aggregates.Roots.create({ id: "a#b", n, note: "before" }),
            )
            const after = rootKeyDefinitions(name, Kind, true)
            yield* bound(
              table,
              after.Main,
              { entities: {}, aggregates: { Roots: after.Roots } },
              (db) =>
                Effect.gen(function* () {
                  const report = yield* db.tables.Main.rekey()
                  expect(report.moved.aggregate).toBe(1)
                  expect(report.conflicts).toEqual([])
                  expect(report.skipped.unrecognizedKey).toBe(0)
                  expect((yield* table.rows).map((row) => row.pk.S)).toEqual([
                    `$${name}#v1#roots#a%23b#${text}`,
                  ])
                  expect((yield* db.aggregates.Roots.get({ id: "a#b", n })).note).toBe("before")
                  expect((yield* db.aggregates.Roots.list({})).data).toHaveLength(1)
                }),
            )
          }),
        ),
      )
    }

    it.effect(
      "the rows 1.39.0 stored: a transformation's are found, an Option of one's as on 1.39.0",
      () =>
        withTable(rootKeyRows, { list: true }, (table) =>
          Effect.gen(function* () {
            const plain = rootKeyDefinitions("x10", x10, false)
            yield* bound(
              table,
              plain.Main,
              { entities: {}, aggregates: { Roots: plain.Roots } },
              (db) =>
                Effect.gen(function* () {
                  expect((yield* db.aggregates.Roots.get({ id: "a", n: 50 })).n).toBe(50)
                  expect(
                    (yield* db.aggregates.Roots.list({})).data.map((root: any) => root.n),
                  ).toEqual([50])
                }),
            )
            const optional = rootKeyDefinitions("optionx10", Schema.Option(x10), false)
            yield* bound(
              table,
              optional.Main,
              { entities: {}, aggregates: { Roots: optional.Roots } },
              (db) =>
                Effect.gen(function* () {
                  expect(
                    (yield* db.aggregates.Roots.get({ id: "a", n: Option.some(50) })).n,
                  ).toEqual(Option.some(500))
                  expect((yield* db.aggregates.Roots.list({})).data).toEqual([])
                }),
            )
            expect(yield* table.rows).toEqual(byKey(rootKeyRows))
          }),
        ),
    )
  })

  describe("history .where() bounds compose as append composes the event key", () => {
    for (const { name, Kind, values } of historyShapes) {
      for (const escapeKeys of [false, true]) {
        // An `x10` orderBy's events with escaped keys are keyed by the value they store, where
        // `rekey` moves 1.39.0's (`historyMoved`).
        const { rows } = historyRowsNow(name, escapeKeys)
        const moved = historyMoved(name, escapeKeys)
        const { E, Main } = historyDefinitions(name, Kind, escapeKeys)

        if (moved) {
          it.effect(`${name}, escapeKeys ${escapeKeys}: rekey moves 1.39.0's events`, () =>
            withTable(historyRows(name, escapeKeys).rows, {}, (table) =>
              bound(table, Main, { entities: { E } }, (db) =>
                Effect.gen(function* () {
                  const report = yield* db.tables.Main.rekey()
                  expect(report.moved.event).toBe(values.length)
                  expect(report.conflicts).toEqual([])
                  expect(report.skipped.unrecognizedKey).toBe(0)
                  expect(yield* table.rows).toEqual(byKey(rows))
                }),
              ),
            ),
          )
        }

        it.effect(
          `${name}, escapeKeys ${escapeKeys}: append stores the rows 1.39.0 stored${moved ? ", keyed by the value it stores" : ""}`,
          () =>
            withTable([], {}, (table) =>
              bound(table, Main, { entities: { E } }, (db) =>
                Effect.gen(function* () {
                  if (values.length === 1) {
                    // An `Option` is stored as a map, and DynamoDB refuses append's ordering guard
                    // (`<`) on a map, as it did on 1.39.0: DynamoDB holds no such event. The
                    // refusal is diagnosed as `EDD-9163` (#242). The bounds are checked below on
                    // the rows the fixture puts directly.
                    const failed: any = yield* Effect.flip(
                      db.entities.E.append({ id: "x", n: values[0] }).asEffect(),
                    )
                    expect(failed._tag).toBe("ValidationError")
                    expect(String(failed.cause?.message)).toContain("[EDD-9163]")
                    expect(failed.cause?.cause?._tag).toBe("DynamoValidationError")
                    expect(yield* table.rows).toEqual([])
                    return
                  }
                  for (const n of values) yield* db.entities.E.append({ id: "x", n }).asEffect()
                  expect(yield* table.rows).toEqual(byKey(rows))
                }),
              ),
            ),
        )

        it.effect(`${name}, escapeKeys ${escapeKeys}: the bounds find what they say`, () =>
          withTable(rows, {}, (table) =>
            bound(table, Main, { entities: { E } }, (db) =>
              Effect.gen(function* () {
                const where = (f: (t: any, ops: any) => unknown) =>
                  Effect.map(db.entities.E.history({ id: "x" }).where(f).collect(), (found: any) =>
                    found.map((item: any) => item.n),
                  )
                for (const n of values) expect(yield* where((t, { eq }) => eq(t.n, n))).toEqual([n])
                if (values.length !== 2) return
                const [lo, hi] = values
                if (escapeKeys || name === "x10") {
                  expect(yield* where((t, { gte }) => gte(t.n, hi))).toEqual([hi])
                  expect(yield* where((t, { lt }) => lt(t.n, hi))).toEqual([lo])
                  expect(yield* where((t, { between }) => between(t.n, lo, hi))).toEqual([lo, hi])
                } else {
                  // Unescaped, "10" sorts before "9": DynamoDB rejects the reversed range, and the
                  // rejection names both bounds.
                  const failed: any = yield* Effect.flip(
                    where((t, { between }) => between(t.n, lo, hi)),
                  )
                  expect(failed._tag).toBe("ValidationError")
                  const { events } = historyRows(name, escapeKeys)
                  expect(String(failed.cause?.message)).toContain(
                    `between's lower bound ${JSON.stringify(events[0]!.sk.S)} sorts after its upper bound ${JSON.stringify(events[1]!.sk.S)}`,
                  )
                }
              }),
            ),
          ),
        )
      }
    }
  })
})
