/**
 * Aggregate concurrency (#168, `docs/designs/aggregate-concurrency.md`) against DynamoDB Local,
 * the concurrent write injected through a decorated `DynamoClient` (`gatedClient`) over the real
 * one, each case on a table of its own:
 *
 * - **The reproductions** (`helpers/AggregateRaces.ts`, also run over the recording table by
 *   `Issue168.races.test.ts`): lost updates on the root and on two lines of one group, a torn
 *   aggregate (interleaved and by a failed group), a non-library conditional `UpdateItem`
 *   between the read and the save, an update after a delete, a failed create, a delete racing
 *   a new line (unfenced and fenced), and the `ownsRows` cleanup.
 * - **Past one transaction:** a fenced update of 121 rows is two requests, the second carrying
 *   the fence; a writer landing between them fails the second, the error naming what the first
 *   committed.
 * - **`versioned`:** create writes version 1 and a token; a root written before the option is
 *   adopted by its first update; two updates on one read, one `OptimisticLockError`; an If-Match
 *   compared before the mutation; a delete and re-create seen through the token.
 * - **Lighter guards:** a unit over 4 MB only because of its guards goes in one request.
 * - **The guide's retry:** two updates on one read both commit.
 *
 * `DYNAMODB_ENDPOINT` (default `http://localhost:8000`) is read through `Config`; the suite is
 * skipped when nothing answers there.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ConcurrentModification, OptimisticLockError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Config, Effect, Exit, Layer, ManagedRuntime, Schedule, Schema } from "effect"
import { afterAll, describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { Main, type MakeRaceTable, type Row, racesSuite, schema } from "./helpers/AggregateRaces.js"
import { type Around, gatedClient } from "./helpers/GatedClient.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

const dynamoAvailable = await fetch(ENDPOINT, {
  method: "POST",
  signal: AbortSignal.timeout(1000),
})
  .then(() => true)
  .catch(() => false)

const runtime = ManagedRuntime.make(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
)
const raw: DynamoClientService = dynamoAvailable
  ? await runtime.runPromise(Effect.service(DynamoClient))
  : (undefined as never)

const made: Array<string> = []
let count = 0

afterAll(async () => {
  if (dynamoAvailable) {
    await Effect.runPromise(
      Effect.forEach(made, (name) => raw.deleteTable({ TableName: name }).pipe(Effect.ignore), {
        discard: true,
      }),
    )
  }
  await runtime.dispose()
})

/**
 * A fresh `pk` / `sk` table with `aggregate` bound on it as `Matches`, under `table` (`Main` by
 * default), with a GSI `gsi1` keyed `pk` / `gsi1sk` when `gsiOnTablePk`, or `tableName` reused.
 */
const makeTableWith = async (
  aggregate: unknown,
  options: {
    readonly table?: { readonly layer: (config: { name: string }) => Layer.Layer<any> }
    readonly gsiOnTablePk?: boolean
    readonly tableName?: string
  } = {},
): Promise<Awaited<ReturnType<MakeRaceTable>>> => {
  const tableDef: any = options.table ?? Main
  const tableName = options.tableName ?? `agg-168-${Date.now()}-${count++}`
  if (options.tableName === undefined) {
    made.push(tableName)
    await Effect.runPromise(
      raw.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          ...(options.gsiOnTablePk === true
            ? [{ AttributeName: "gsi1sk", AttributeType: "S" }]
            : []),
        ],
        ...(options.gsiOnTablePk === true && {
          GlobalSecondaryIndexes: [
            {
              IndexName: "gsi1",
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "gsi1sk", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
      } as never),
    )
  }
  return {
    tableName,
    client: raw,
    run: (body, around) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Matches: aggregate },
            tables: { Main: tableDef },
          } as never)
          return yield* body(db)
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(DynamoClient, around === undefined ? raw : gatedClient(raw, around)),
              tableDef.layer({ name: tableName }),
            ) as never,
          ),
          Effect.exit,
        ) as never,
      ),
    rows: async () => {
      const found: Array<Row> = []
      let start: Row | undefined
      do {
        const page = await Effect.runPromise(
          raw.scan({
            TableName: tableName,
            ConsistentRead: true,
            ...(start === undefined ? {} : { ExclusiveStartKey: start }),
          } as never),
        )
        found.push(...((page.Items ?? []) as Array<Row>))
        start = page.LastEvaluatedKey as Row | undefined
      } while (start !== undefined)
      return found.sort((a, b) => `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`))
    },
  }
}

const makeTable: MakeRaceTable = (aggregate) => makeTableWith(aggregate)

racesSuite(makeTable, { skip: !dynamoAvailable })

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

const Line = Schema.Struct({ lid: Schema.String, text: Schema.String, copy: Schema.String })
const TeamModel = Schema.Struct({ tag: Schema.String, lines: Schema.Array(Line) })
const MatchModel = Schema.Struct({
  id: Schema.String,
  tag: Schema.String,
  status: Schema.String,
  note: Schema.String,
  team1: TeamModel,
  team2: TeamModel,
})
const Team = Aggregate.make(TeamModel, {
  root: { entityType: "Team" },
  edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
} as any)

const matches = (
  extra: Record<string, unknown>,
  model: Schema.Top = MatchModel,
  on: { readonly schema: unknown; readonly table: unknown } = { schema, table: Main },
): unknown =>
  Aggregate.make(
    model as never,
    {
      table: on.table,
      schema: on.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "matches" },
      root: { entityType: "Match" },
      edges: {
        team1: (Team as any).with({ discriminator: { teamNumber: 1 } }),
        team2: (Team as any).with({ discriminator: { teamNumber: 2 } }),
      },
      ...extra,
    } as any,
  )

const lines = (prefix: string, n: number, text = "t0") =>
  Array.from({ length: n }, (_, i) => ({
    lid: `${prefix}${String(i).padStart(3, "0")}`,
    text,
    copy: "c0",
  }))

const initial = {
  id: "m1",
  tag: "v0",
  status: "scheduled",
  note: "n0",
  team1: {
    tag: "v0",
    lines: [
      { lid: "a", text: "a0", copy: "c0" },
      { lid: "b", text: "b0", copy: "c0" },
    ],
  },
  team2: { tag: "v0", lines: [{ lid: "c", text: "c0", copy: "c0" }] },
}

const world = async (aggregate: unknown, options?: Parameters<typeof makeTableWith>[1]) => {
  const table = await makeTableWith(aggregate, options)
  const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
    return exit.value
  }
  const failed = <A, E>(exit: Exit.Exit<A, E>): E => {
    if (Exit.isSuccess(exit)) throw new Error("expected a failure")
    const error = Cause.findErrorOption(exit.cause)
    if (error._tag === "None") throw new Error(Cause.pretty(exit.cause))
    return error.value
  }
  const rowAt = async (suffix: string) =>
    (await table.rows()).find((row) => String(row.sk?.S).endsWith(suffix))
  const sent: Array<number> = []
  return {
    ...table,
    ok,
    failed,
    rowAt,
    sent,
    create: async (value: unknown = initial) =>
      ok(await table.run((db) => db.aggregates.Matches.create(value))),
    get: async (): Promise<any> =>
      ok(await table.run((db) => db.aggregates.Matches.get({ id: "m1" }))),
    delete: (around?: Around) =>
      table.run<any, unknown>((db) => db.aggregates.Matches.delete({ id: "m1" }), around),
    /** An update, every transaction's item count kept in `sent`, through `around` when given. */
    updateThrough: (fn: (c: any) => unknown, around?: Around, options?: unknown) =>
      table.run<any, unknown>(
        (db) => db.aggregates.Matches.update({ id: "m1" }, fn, options),
        (command, input, send) => {
          if (command === "transactWriteItems") sent.push(input.TransactItems.length)
          return around === undefined ? send : around(command, input, send)
        },
      ),
    rawSet: (row: Row, name: string, value: AttributeValue) =>
      raw.updateItem({
        TableName: table.tableName,
        Key: { pk: row.pk!, sk: row.sk! },
        UpdateExpression: "SET #a = :v",
        ExpressionAttributeNames: { "#a": name },
        ExpressionAttributeValues: { ":v": value },
      } as never),
  }
}

const text = (row: Row | undefined, name: string) => (row?.[name] as { S?: string } | undefined)?.S

const latch = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
  return { open, wait: Effect.promise(() => Promise.race([opened, timeout])) }
}

/** The first `n` `Query` answers come back only once `n` queries were answered. */
const readersMeet = (n: number): Around => {
  const met = latch()
  let answered = 0
  let taken = 0
  return (command, _input, send) => {
    if (command !== "query" || taken >= n) return send
    taken++
    return Effect.gen(function* () {
      const result = yield* send
      answered++
      if (answered >= n) met.open()
      yield* met.wait
      return result
    })
  }
}

/** `after` once, after the first `Query` was answered. */
const afterFirstRead = (after: () => Effect.Effect<unknown, unknown>): Around => {
  let done = false
  return (command, _input, send) => {
    if (command !== "query" || done) return send
    done = true
    return send.pipe(Effect.tap(() => after()))
  }
}

const editLine =
  (team: "team1" | "team2", lid: string, change: Record<string, string>) => (c: any) => ({
    ...c.state,
    [team]: {
      ...c.state[team],
      lines: c.state[team].lines.map((line: any) =>
        line.lid === lid ? { ...line, ...change } : line,
      ),
    },
  })

const everyLine = (c: any, change: Record<string, string>) => ({
  ...c.state,
  status: "live",
  team1: { ...c.state.team1, lines: c.state.team1.lines.map((l: any) => ({ ...l, ...change })) },
  team2: { ...c.state.team2, lines: c.state.team2.lines.map((l: any) => ({ ...l, ...change })) },
})

describe.skipIf(!dynamoAvailable)("aggregate concurrency end to end (#168)", () => {
  it("past one transaction, fenced: a writer between the requests fails the second, naming what the first committed", async () => {
    const w = await world(matches({ fence: true }))
    await w.create({
      ...initial,
      team1: { tag: "v0", lines: lines("a", 60) },
      team2: { tag: "v0", lines: lines("b", 60) },
    })
    // Uncontended: the root with team1's rows, then team2's rows with the fence.
    w.ok(await w.updateThrough((c) => everyLine(c, { text: "A" })))
    expect(w.sent.splice(0)).toEqual([61, 61])
    const b000 = (await w.rowAt("#b000"))!
    let requests = 0
    const exit = await w.updateThrough(
      (c) => everyLine(c, { text: "B" }),
      (command, _input, send) => {
        if (command !== "transactWriteItems") return send
        requests++
        return requests === 2 ? Effect.andThen(w.rawSet(b000, "copy", { S: "X" }), send) : send
      },
    )
    const error = w.failed(exit) as ConcurrentModification
    expect(error).toBeInstanceOf(ConcurrentModification)
    expect(error.attributes).toEqual(["team2.lines[b000].copy"])
    expect(error.committed?.length).toBeGreaterThan(0)
    // The first request's rows stayed (named limit: past one transaction a write isn't atomic).
    expect(text(await w.rowAt("#a000"), "text")).toBe("B")
    expect(text(await w.rowAt("#b001"), "text")).toBe("A")
  })

  it("fenced: an update adding a row after a delete fails, leaving nothing", async () => {
    const w = await world(matches({ fence: true }))
    await w.create()
    const exit = await w.updateThrough(
      (c) => ({
        ...c.state,
        team1: {
          ...c.state.team1,
          lines: [...c.state.team1.lines, { lid: "z", text: "z", copy: "c0" }],
        },
      }),
      afterFirstRead(() =>
        Effect.promise(() => w.run((db) => db.aggregates.Matches.delete({ id: "m1" }))),
      ),
    )
    expect((w.failed(exit) as { _tag: string })._tag).toBe("AggregateAssemblyError")
    expect(await w.rows()).toEqual([])
  })

  it("versioned: create, a root written before the option, two updates on one read, If-Match, a re-create", async () => {
    const w = await world(matches({ versioned: true }))
    await w.create()
    // A root written before the option holds neither the version nor a token.
    const root = (await w.rowAt("#match"))!
    expect(root.version).toEqual({ N: "1" })
    expect(text(root, "__edd_i__")).toMatch(/^[0-9a-f-]{36}$/)
    await Effect.runPromise(
      raw.updateItem({
        TableName: w.tableName,
        Key: { pk: root.pk!, sk: root.sk! },
        UpdateExpression: "REMOVE #v, #i",
        ExpressionAttributeNames: { "#v": "version", "#i": "__edd_i__" },
      } as never),
    )
    const seen: Array<number | undefined> = []
    w.ok(
      await w.updateThrough((c) => {
        seen.push(c.version)
        return editLine("team1", "a", { text: "A" })(c)
      }),
    )
    expect(seen).toEqual([0])
    expect((await w.rowAt("#match"))!.version).toEqual({ N: "1" })
    const token = text(await w.rowAt("#match"), "__edd_i__")
    expect(token).toMatch(/^[0-9a-f-]{36}$/)

    // Two updates on one read: one commits, the other is told the version moved.
    const around = readersMeet(2)
    const exits = await Promise.all([
      w.updateThrough(editLine("team1", "a", { text: "A2" }), around),
      w.updateThrough(editLine("team2", "c", { text: "B2" }), around),
    ])
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
    const lost = w.failed(exits.find(Exit.isFailure)!) as OptimisticLockError
    expect(lost).toBeInstanceOf(OptimisticLockError)
    expect([lost.expectedVersion, lost.actualVersion]).toEqual([1, 2])

    // If-Match: compared before the mutation runs.
    let ran = 0
    const stale = w.failed(
      await w.updateThrough(
        (c) => {
          ran++
          return c.state
        },
        undefined,
        { expectedVersion: 1 },
      ),
    ) as OptimisticLockError
    expect([stale.expectedVersion, stale.actualVersion, ran]).toEqual([1, 2, 0])
    w.ok(
      await w.updateThrough((c) => ({ ...c.state, note: "x" }), undefined, { expectedVersion: 2 }),
    )
    expect((await w.rowAt("#match"))!.version).toEqual({ N: "3" })

    // A delete and re-create between the read and the write: the token differs.
    const recreated = w.failed(
      await w.updateThrough(
        editLine("team1", "a", { text: "late" }),
        afterFirstRead(() =>
          Effect.promise(async () => {
            w.ok(await w.run((db) => db.aggregates.Matches.delete({ id: "m1" })))
            await w.create()
          }),
        ),
      ),
    ) as OptimisticLockError
    expect(recreated).toBeInstanceOf(OptimisticLockError)
    expect([recreated.expectedVersion, recreated.actualVersion]).toEqual([3, 1])
    expect(text(await w.rowAt("#a"), "text")).toBe("a0")
    expect(text(await w.rowAt("#match"), "__edd_i__")).not.toBe(token)
  })

  it("a unit over 4 MB only because of its guards is one request, its large values compared by size", async () => {
    const w = await world(matches({ context: ["status"] }))
    await w.create({ ...initial, team1: { tag: "v0", lines: lines("a", 50, "x".repeat(50_000)) } })
    // A context change rewrites every row: 2.5 MB of rows, over 4 MB with whole-row guards.
    w.ok(await w.updateThrough((c) => ({ ...c.state, status: "live" })))
    expect(w.sent.splice(0)).toHaveLength(1)
    expect((await w.rows()).every((row) => text(row, "status") === "live")).toBe(true)
    // A small attribute changed by another writer is still seen.
    const a001 = (await w.rowAt("#a001"))!
    const exit = await w.updateThrough(
      (c) => ({ ...c.state, status: "done" }),
      afterFirstRead(() => w.rawSet(a001, "copy", { S: "c1" })),
    )
    expect((w.failed(exit) as ConcurrentModification).attributes).toEqual([
      "team1.lines[a001].copy",
    ])
  })

  it("the guide's retry: two updates on one read both commit", async () => {
    const w = await world(matches({ versioned: true }))
    await w.create()
    const around = readersMeet(2)
    const retried = (fn: (c: any) => unknown) =>
      w.run(
        (db) =>
          Effect.suspend(() => db.aggregates.Matches.update({ id: "m1" }, fn)).pipe(
            Effect.retry({
              while: (error) => {
                const tag = (error as { readonly _tag?: string })._tag
                return tag === "ConcurrentModification" || tag === "OptimisticLockError"
              },
              schedule: Schedule.exponential("10 millis").pipe(Schedule.jittered),
              times: 5,
            }),
          ) as Effect.Effect<unknown, unknown, never>,
        around,
      )
    const [a, b] = await Promise.all([
      retried((c) => ({ ...c.state, status: "A" })),
      retried((c) => ({ ...c.state, note: "B" })),
    ])
    w.ok(a)
    w.ok(b)
    const stored = await w.get()
    expect([stored.status, stored.note]).toEqual(["A", "B"])
    expect((await w.rowAt("#match"))!.version).toEqual({ N: "3" })
  })

  const wide = {
    ...initial,
    team1: { tag: "v0", lines: lines("a", 60) },
    team2: { tag: "v0", lines: lines("b", 60) },
  }

  it("versioned, past one transaction: each later request checks the version; a writer between them fails it, naming the version read", async () => {
    const w = await world(matches({ versioned: true }))
    await w.create(wide)
    w.ok(
      await w.updateThrough((c) => everyLine(c, { text: "A" }), undefined, { expectedVersion: 1 }),
    )
    expect(w.sent.splice(0)).toEqual([61, 61])
    expect((await w.rowAt("#match"))!.version).toEqual({ N: "2" })
    let requests = 0
    const exit = await w.updateThrough(
      (c) => everyLine(c, { text: "B" }),
      (command, _input, send) => {
        if (command !== "transactWriteItems") return send
        requests++
        // Another versioned update commits once the first request has: the version moves to 4.
        return requests === 2
          ? Effect.andThen(
              Effect.promise(async () =>
                w.ok(
                  await w.run((db) =>
                    db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
                      ...c.state,
                      note: "other",
                    })),
                  ),
                ),
              ),
              send,
            )
          : send
      },
      { expectedVersion: 2 },
    )
    const error = w.failed(exit) as OptimisticLockError
    expect(error).toBeInstanceOf(OptimisticLockError)
    expect([error.expectedVersion, error.actualVersion]).toEqual([2, 4])
    expect(error.committed?.length).toBeGreaterThan(0)
    expect(text(await w.rowAt("#b001"), "text")).toBe("A")
  })

  it("fenced: a create landing after delete's root went keeps its aggregate", async () => {
    const w = await world(matches({ fence: true }))
    await w.create()
    let created = false
    w.ok(
      await w.delete((command, _input, send) =>
        command === "query" && !created
          ? Effect.andThen(
              Effect.promise(async () => {
                created = true
                await w.create({ ...initial, note: "new" })
              }),
              send,
            )
          : send,
      ),
    )
    expect((await w.get()).note).toBe("new")
    expect(await w.rows()).toHaveLength(6)
  })

  it("a GSI keyed on the table's partition key: update and delete read it as consistentRead says", async () => {
    const Row = Entity.make({
      model: Schema.Struct({ rid: Schema.String }),
      entityType: "Row",
      primaryKey: {
        pk: { field: "pk", composite: ["rid"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const Keyed = Table.make({ schema, entities: { Row } })
    for (const fence of [true, false]) {
      const w = await world(
        matches(
          {
            fence,
            collection: { name: "matches", index: "gsi1", sk: { field: "gsi1sk", composite: [] } },
          },
          MatchModel,
          { schema, table: Keyed },
        ),
        { table: Keyed as never, gsiOnTablePk: true },
      )
      await w.create()
      w.ok(await w.updateThrough((c) => ({ ...c.state, note: "x" })))
      expect((await w.rowAt("#match"))!.note).toEqual({ S: "x" })
      w.ok(await w.delete())
      expect(await w.rows()).toEqual([])
    }
  })

  it("a root of members: an optional attribute another writer added since the read is guarded absent", async () => {
    const member = (kind: string) =>
      Schema.Struct({
        kind: Schema.Literal(kind),
        ...MatchModel.fields,
        note: Schema.optionalKey(Schema.String),
      })
    for (const model of [
      Schema.Union([member("a"), member("b")]),
      Schema.suspend(() => member("a")),
    ]) {
      const w = await world(matches({}, model))
      const { note: _, ...withoutNote } = initial
      await w.create({ ...withoutNote, kind: "a" })
      const exit = await w.updateThrough(
        (c) => ({ ...c.state, status: "live" }),
        afterFirstRead(() =>
          Effect.promise(async () =>
            w.ok(
              await w.run((db) =>
                db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
                  ...c.state,
                  note: "added",
                })),
              ),
            ),
          ),
        ),
      )
      expect((w.failed(exit) as ConcurrentModification).attributes).toEqual(["note"])
      expect(text(await w.rowAt("#match"), "note")).toBe("added")
      expect(text(await w.rowAt("#match"), "status")).toBe("scheduled")
    }
  })

  it("rekey of a versioned aggregate moved to a new partition keeps its version and token", async () => {
    const plain = DynamoSchema.make({ name: "m168", version: 1, escapeKeys: false })
    const escaped = DynamoSchema.make({ name: "m168", version: 1, escapeKeys: true })
    const PlainMain = Table.make({ schema: plain, entities: {} })
    const EscapedMain = Table.make({ schema: escaped, entities: {} })
    const VersionedModel = Schema.Struct({ ...MatchModel.fields, version: Schema.Number })
    const key = { id: "a#b" }
    for (const model of [MatchModel, VersionedModel]) {
      const before = await world(
        matches({ versioned: true }, model, { schema: plain, table: PlainMain }),
        { table: PlainMain as never },
      )
      before.ok(
        await before.run((db) => db.aggregates.Matches.create({ ...initial, ...key, version: 0 })),
      )
      before.ok(
        await before.run((db) =>
          db.aggregates.Matches.update(key, (c: any) => ({ ...c.state, note: "x" })),
        ),
      )
      const oldRoot = (await before.rowAt("#match"))!
      expect(oldRoot.version).toEqual({ N: "2" })
      const after = await world(
        matches({ versioned: true }, model, { schema: escaped, table: EscapedMain }),
        { table: EscapedMain as never, tableName: before.tableName },
      )
      after.ok(await after.run((db) => db.tables.Main.rekey()))
      const moved = (await after.rowAt("#match"))!
      expect(moved.pk!.S).not.toBe(oldRoot.pk!.S)
      expect(moved.version).toEqual({ N: "2" })
      expect(moved.__edd_i__).toEqual(oldRoot.__edd_i__)
      after.ok(
        await after.run((db) =>
          db.aggregates.Matches.update(key, (c: any) => ({ ...c.state, note: "y" }), {
            expectedVersion: 2,
          }),
        ),
      )
      expect((await after.rowAt("#match"))!.version).toEqual({ N: "3" })
    }
  })
})
