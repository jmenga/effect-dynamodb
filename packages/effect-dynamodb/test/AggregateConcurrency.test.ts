/**
 * Aggregate concurrency (#168, with #132's aggregate items; `docs/designs/aggregate-concurrency.md`):
 * the write plan (one transaction when it fits, whole groups past it, the fence on each request
 * without the root), the guard on each item, the rows a write sends (only those that changed), the
 * verdict on a cancelled request, `versioned` with its incarnation token and `expectedVersion`,
 * the `fence` setting, `delete`'s order and its consistent reads, and the lighter guard of a unit
 * over 4 MB only because of its guards.
 *
 * Every test runs over a recording in-memory table that answers as DynamoDB Local does
 * (`RecordingTable`), a concurrent write forced between a read and a write by `gatedClient`.
 * `Issue168.races.test.ts` holds the issue's reproductions; `connected.aggregate-concurrency.test.ts`
 * runs the same races against DynamoDB Local.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  AggregateAssemblyError,
  ConcurrentModification,
  OptimisticLockError,
  TransactionCancelled,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Layer, Schedule, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { classifyError, DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { sizeOperand } from "../src/internal/ExpressionLimits.js"
import { TRANSACT_WRITE_MAX_BYTES, transactionBytes } from "../src/internal/ItemSize.js"
import * as Table from "../src/Table.js"
import { type Around, gatedClient } from "./helpers/GatedClient.js"
import { awsTransactionCanceled } from "./helpers/MockDynamoClient.js"
import { type IndexKeys, makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

// ---------------------------------------------------------------------------
// The aggregates
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
type Match = typeof MatchModel.Type

const Team = Aggregate.make(TeamModel, {
  root: { entityType: "Team" },
  edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
} as any)

const schemaOf = (escapeKeys = false) => DynamoSchema.make({ name: "c168", version: 1, escapeKeys })
const schema = schemaOf()
const Main = Table.make({ schema, entities: {} })

/** The match aggregate with `extra` config (`versioned`, `fence`, `timestamps`, `context`, ...). */
const matches = (
  extra: Record<string, unknown> = {},
  model: Schema.Top = MatchModel,
  on: { readonly schema: DynamoSchema.DynamoSchema; readonly table: unknown } = {
    schema,
    table: Main,
  },
): any =>
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

const initial: Match = {
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

const TABLE = "c168"

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const world = (
  aggregate: unknown = matches(),
  options: {
    readonly indexes?: Readonly<Record<string, IndexKeys>>
    readonly table?: { readonly layer: (config: { name: string }) => Layer.Layer<any> }
  } = {},
) => {
  const table = makeRecordingTable({ indexes: options.indexes })
  const tableDef: any = options.table ?? Main
  const run = <A, E>(
    body: (agg: any, db: any) => Effect.Effect<A, E, never>,
    around?: Around,
  ): Promise<Exit.Exit<A, E>> => {
    const client = around === undefined ? table.client : gatedClient(table.client, around)
    return Effect.runPromise(
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Matches: aggregate },
          tables: { Main: tableDef },
        } as never)
        return yield* body(db.aggregates.Matches, db)
      }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(DynamoClient, client),
            tableDef.layer({ name: TABLE }),
          ) as never,
        ),
        Effect.exit,
      ) as Effect.Effect<Exit.Exit<A, E>>,
    )
  }
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
  const rows = (): ReadonlyArray<Row> =>
    [...table.items.values()].sort((a, b) =>
      `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`),
    )
  const rowAt = (suffix: string): Row | undefined =>
    rows().find((row) => String(row.sk?.S).endsWith(suffix))
  return {
    table,
    run,
    ok,
    failed,
    rows,
    rowAt,
    client: table.client as DynamoClientService,
    take: (): Array<Request> => table.take(),
    create: async (value: unknown = initial): Promise<any> =>
      ok(await run((agg) => agg.create(value))),
    get: async (): Promise<any> => ok(await run((agg) => agg.get({ id: "m1" }))),
    update: (fn: (c: any) => unknown, around?: Around, options?: unknown) =>
      run<any, unknown>((agg) => agg.update({ id: "m1" }, fn, options), around),
  }
}

// ---------------------------------------------------------------------------
// Interleaving tools
// ---------------------------------------------------------------------------

const latch = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
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

/** Run `after` once, after the first `Query` was answered. */
const afterFirstRead =
  (after: () => Effect.Effect<unknown, unknown>): Around =>
  (command, _input, send) => {
    if (command !== "query" || fired.has(after)) return send
    fired.add(after)
    return send.pipe(Effect.tap(() => after()))
  }
const fired = new WeakSet<object>()

/** Run `before` once, before the request `when` picks is sent. */
const beforeRequest =
  (
    when: (command: string, input: any) => boolean,
    before: () => Effect.Effect<unknown, unknown>,
  ): Around =>
  (command, input, send) => {
    if (!when(command, input) || fired.has(before)) return send
    fired.add(before)
    return Effect.andThen(before(), send)
  }

const transactions = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.command === "TransactWriteItems")
    .map((request) => request.input.TransactItems as ReadonlyArray<any>)

const text = (row: Row | undefined, name: string): string | undefined =>
  (row?.[name] as { S?: string } | undefined)?.S

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

const rawSet = (
  client: DynamoClientService,
  row: Row,
  name: string,
  value: AttributeValue,
): Effect.Effect<unknown, unknown> =>
  client.updateItem({
    TableName: TABLE,
    Key: { pk: row.pk!, sk: row.sk! },
    UpdateExpression: "SET #a = :v",
    ExpressionAttributeNames: { "#a": name },
    ExpressionAttributeValues: { ":v": value },
  } as never)

const ROOT_SK = "$c168#v1#match"

// ---------------------------------------------------------------------------
// The write plan
// ---------------------------------------------------------------------------

describe("the write plan (D3, D16)", () => {
  it("a create of three groups is one TransactWriteItems, the root first with its guard", async () => {
    const w = world()
    await w.create()
    const sent = transactions(w.take())
    expect(sent).toHaveLength(1)
    expect(sent[0]![0].Put.Item.sk.S).toBe(ROOT_SK)
    expect(sent[0]![0].Put.ConditionExpression).toBe("attribute_not_exists(#pk)")
    expect(sent[0]!.slice(1).every((item: any) => item.Put.ConditionExpression === undefined)).toBe(
      true,
    )
  })

  it("an update changing every group is one TransactWriteItems of the rows that changed", async () => {
    const w = world()
    await w.create()
    w.take()
    w.ok(
      await w.update((c) => ({
        ...c.state,
        tag: "A",
        team1: { ...c.state.team1, tag: "A" },
        team2: { ...c.state.team2, tag: "A" },
      })),
    )
    const sent = transactions(w.take())
    expect(sent).toHaveLength(1)
    // The root and each team's own row; no line changed, so none is sent.
    expect(sent[0]!.map((item: any) => item.Put.Item.__edd_e__.S)).toEqual([
      "Match",
      "Team",
      "Team",
    ])
  })

  it("past one transaction: whole groups, the root's first; fenced, each later request checks the root", async () => {
    const w = world(matches({ fence: true }))
    await w.create({
      ...initial,
      team1: { tag: "v0", lines: lines("a", 60) },
      team2: { tag: "v0", lines: lines("b", 60) },
    })
    w.take()
    w.ok(
      await w.update((c) => ({
        ...c.state,
        status: "live",
        team1: {
          ...c.state.team1,
          lines: c.state.team1.lines.map((l: any) => ({ ...l, text: "A" })),
        },
        team2: {
          ...c.state.team2,
          lines: c.state.team2.lines.map((l: any) => ({ ...l, text: "A" })),
        },
      })),
    )
    const sent = transactions(w.take())
    // The root (1) with team1's lines (60); then team2's (60) with the fence.
    expect(sent.map((items) => items.length)).toEqual([61, 61])
    expect(sent[0]!.some((item: any) => item.ConditionCheck !== undefined)).toBe(false)
    expect(sent[0]![0].Put.Item.sk.S).toBe(ROOT_SK)
    const fence = sent[1]!.at(-1)
    expect(fence.ConditionCheck.Key.sk.S).toBe(ROOT_SK)
    expect(fence.ConditionCheck.ConditionExpression).toBe("attribute_exists(#pk)")
    expect((await w.get()).team2.lines.every((l: any) => l.text === "A")).toBe(true)
  })

  it("fenced: 99 rows and the fence fit one request; a 100th row goes in the next", async () => {
    const w = world(matches({ fence: true }))
    await w.create({
      ...initial,
      team1: { tag: "v0", lines: lines("a", 99) },
      team2: { tag: "v0", lines: lines("b", 1) },
    })
    w.take()
    const all = (c: any, team: "team1" | "team2") => ({
      ...c.state[team],
      lines: c.state[team].lines.map((l: any) => ({ ...l, text: "A" })),
    })
    w.ok(await w.update((c) => ({ ...c.state, team1: all(c, "team1") })))
    expect(transactions(w.take()).map((items) => items.length)).toEqual([100])
    w.ok(
      await w.update((c) => ({
        ...c.state,
        team1: {
          ...all(c, "team1"),
          lines: all(c, "team1").lines.map((l: any) => ({ ...l, copy: "c1" })),
        },
        team2: all(c, "team2"),
      })),
    )
    // 99 + 1 rows: never 100 rows and then the fence, a 101st item.
    const sent = transactions(w.take())
    expect(sent.map((items) => items.length)).toEqual([100, 2])
    for (const items of sent) expect(items.at(-1).ConditionCheck).toBeDefined()
  })

  it("a conflict in a later request names what the earlier ones committed (D9)", async () => {
    const w = world(matches({ fence: true }))
    await w.create({
      ...initial,
      team1: { tag: "v0", lines: lines("a", 60) },
      team2: { tag: "v0", lines: lines("b", 60) },
    })
    let requests = 0
    const around: Around = (command, _input, send) => {
      if (command !== "transactWriteItems") return send
      requests++
      // Another writer changes one of team2's lines once the first request has committed.
      return requests === 2
        ? Effect.andThen(rawSet(w.client, w.rowAt("#b000")!, "copy", { S: "X" }), send)
        : send
    }
    const error = w.failed(
      await w.update(
        (c) => ({
          ...c.state,
          status: "live",
          team1: {
            ...c.state.team1,
            lines: c.state.team1.lines.map((l: any) => ({ ...l, text: "A" })),
          },
          team2: {
            ...c.state.team2,
            lines: c.state.team2.lines.map((l: any) => ({ ...l, text: "A" })),
          },
        }),
        around,
      ),
    ) as ConcurrentModification
    expect(error).toBeInstanceOf(ConcurrentModification)
    expect(error.attributes).toEqual(["team2.lines[b000].copy"])
    expect(error.committed?.length).toBeGreaterThan(0)
    // The first request's rows stayed: past one transaction the write is not atomic (named limit).
    expect(text(w.rowAt("#match"), "status")).toBe("live")
    expect(text(w.rowAt("#b001"), "text")).toBe("t0")
  })

  const everyLine = (c: any) => ({
    ...c.state,
    status: "live",
    team1: { ...c.state.team1, lines: c.state.team1.lines.map((l: any) => ({ ...l, text: "A" })) },
    team2: { ...c.state.team2, lines: c.state.team2.lines.map((l: any) => ({ ...l, text: "A" })) },
  })
  const wide = { ...initial, team1: { tag: "v0", lines: lines("a", 60) } }
  const widened = { ...wide, team2: { tag: "v0", lines: lines("b", 60) } }

  it("versioned, past one transaction: the root's version in the first request, each later one checks it", async () => {
    const w = world(matches({ versioned: true }))
    await w.create(widened)
    w.take()
    w.ok(await w.update(everyLine, undefined, { expectedVersion: 1 }))
    const sent = transactions(w.take())
    expect(sent.map((items) => items.length)).toEqual([61, 61])
    expect(sent[0]![0].Put.Item.sk.S).toBe(ROOT_SK)
    expect(sent[0]![0].Put.Item.version).toEqual({ N: "2" })
    const fence = sent[1]!.at(-1)
    expect(fence.ConditionCheck.ConditionExpression).toBe("#ver = :v1 AND #inc = :inc")
    expect(fence.ConditionCheck.ExpressionAttributeValues[":v1"]).toEqual({ N: "2" })
    expect(w.rowAt("#match")!.version).toEqual({ N: "2" })
    expect((await w.get()).team2.lines.every((l: any) => l.text === "A")).toBe(true)
  })

  it("versioned, past one transaction: another update between the requests fails the later one, naming the version read", async () => {
    const w = world(matches({ versioned: true }))
    await w.create(widened)
    let requests = 0
    const around: Around = (command, _input, send) => {
      if (command !== "transactWriteItems") return send
      requests++
      // Another versioned update commits once the first request has: the version moves to 3.
      return requests === 2
        ? Effect.andThen(
            Effect.promise(() => w.update((c) => ({ ...c.state, note: "other" })).then(w.ok)),
            send,
          )
        : send
    }
    const error = w.failed(
      await w.update(everyLine, around, { expectedVersion: 1 }),
    ) as OptimisticLockError
    expect(error).toBeInstanceOf(OptimisticLockError)
    // The version this update read (and was given), not the one its own first request wrote.
    expect([error.expectedVersion, error.actualVersion]).toEqual([1, 3])
    expect(error.committed?.length).toBeGreaterThan(0)
    expect(w.rowAt("#match")!.version).toEqual({ N: "3" })
    expect(text(w.rowAt("#b001"), "text")).toBe("t0")
  })
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe("the guard on each item (D1, D14)", () => {
  it("a row read is put while it is as read, a new row while nothing is there, a dropped row deleted as read", async () => {
    const w = world()
    await w.create()
    w.take()
    w.ok(
      await w.update((c) => ({
        ...c.state,
        team1: {
          ...c.state.team1,
          lines: [
            { ...c.state.team1.lines[0], text: "A" },
            { lid: "z", text: "z", copy: "c0" },
          ],
        },
      })),
    )
    const [items] = transactions(w.take())
    const put = (suffix: string) => items!.find((item: any) => item.Put?.Item.sk.S.endsWith(suffix))
    expect(put("#a").Put.ConditionExpression).toMatch(/^attribute_exists\(#gpk\) AND #g0 = :g0/)
    expect(put("#a").Put.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
    expect(put("#z").Put.ConditionExpression).toBe("attribute_not_exists(#pk)")
    const removed = items!.find((item: any) => item.Delete !== undefined)
    expect(removed.Delete.Key.sk.S).toMatch(/#b$/)
    expect(removed.Delete.ConditionExpression).toMatch(/^attribute_exists\(#gpk\)/)
    expect(removed.Delete.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
    // Unfenced, unversioned: no item on the root but its own row.
    expect(items!.some((item: any) => item.ConditionCheck !== undefined)).toBe(false)
  })

  it("a row too wide for a whole-row guard is guarded on `updatedAt` first, then what fits", async () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, Schema.String]))
    const Model = Schema.Struct({ ...MatchModel.fields, ...wide })
    const w = world(matches({ timestamps: true }, Model))
    const value = {
      ...initial,
      ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, `v${i}`])),
    }
    await w.create(value)
    w.take()
    w.ok(await w.update((c) => ({ ...c.state, note: "changed" })))
    const [items] = transactions(w.take())
    const root = items![0].Put
    expect(root.ExpressionAttributeNames["#g0"]).toBe("updatedAt")
    expect(root.ConditionExpression.length).toBeLessThanOrEqual(4096)
    // A non-library writer changing an attribute the guard holds is seen.
    const exit = await w.update(
      (c) => ({ ...c.state, note: "again" }),
      afterFirstRead(() => rawSet(w.client, w.rowAt("#match")!, "updatedAt", { S: "x" })),
    )
    expect(w.failed(exit)).toBeInstanceOf(ConcurrentModification)
  })

  it("is built from the row as stored: a number with more digits than a JS number holds still matches", async () => {
    const w = world()
    await w.create()
    // An attribute outside the model, written by another service: 0.12345678901234567891 reads
    // back as 0.12345678901234568 through a JS number.
    const exact = { N: "0.12345678901234567891" }
    await Effect.runPromise(rawSet(w.client, w.rowAt("#b")!, "score", exact))
    w.take()
    w.ok(await w.update(editLine("team1", "b", { text: "B" })))
    const [items] = transactions(w.take())
    const guard = items![0].Put
    const values = Object.values(guard.ExpressionAttributeValues as Record<string, AttributeValue>)
    expect(values).toContainEqual(exact)
  })
})

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

describe("the rows a write sends (D2)", () => {
  it("one changed line sends that line alone; the rest of its group isn't rewritten", async () => {
    const w = world(matches({ timestamps: true }))
    await w.create()
    const before = w.rows()
    w.take()
    w.ok(await w.update(editLine("team1", "a", { text: "A" })))
    const [items] = transactions(w.take())
    expect(items!.map((item: any) => item.Put.Item.sk.S.split("#").at(-1))).toEqual(["a"])
    // Every other row as stored, its `updatedAt` included.
    const unchanged = (rows: ReadonlyArray<Row>) =>
      rows.filter((row) => !String(row.sk?.S).endsWith("#a"))
    expect(unchanged(w.rows())).toEqual(unchanged(before))
  })

  it("a context field changed sends every row; a no-op sends nothing", async () => {
    const w = world(matches({ context: ["status"] }))
    await w.create()
    w.take()
    w.ok(await w.update((c) => c.state))
    expect(w.take().map((request) => request.command)).toEqual(["Query"])
    w.ok(await w.update((c) => ({ ...c.state, status: "live" })))
    const [items] = transactions(w.take())
    expect(items).toHaveLength(w.rows().length)
    expect(w.rows().every((row) => text(row, "status") === "live")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

describe("the verdict on a cancelled request (D13, D15)", () => {
  it("a row changed since the read: ConcurrentModification naming it by member path, nothing written", async () => {
    const w = world()
    await w.create()
    const exit = await w.update(
      (c) => ({ ...editLine("team1", "b", { text: "B" })(c), note: "mine" }),
      afterFirstRead(() => rawSet(w.client, w.rowAt("#b")!, "copy", { S: "c1" })),
    )
    const error = w.failed(exit) as ConcurrentModification
    expect(error).toBeInstanceOf(ConcurrentModification)
    expect(error.entityType).toBe("Match")
    expect(error.key).toEqual({ id: "m1" })
    expect(error.attributes).toEqual(["team1.lines[b].copy"])
    expect(error.committed).toBeUndefined()
    // All or nothing: the root's change wasn't written either.
    expect(text(w.rowAt("#match"), "note")).toBe("n0")
  })

  it("a root attribute is named by its attribute alone", async () => {
    const w = world()
    await w.create()
    const exit = await w.update(
      (c) => ({ ...c.state, status: "live" }),
      afterFirstRead(() => rawSet(w.client, w.rowAt("#match")!, "note", { S: "x" })),
    )
    expect((w.failed(exit) as ConcurrentModification).attributes).toEqual(["note"])
  })

  it("the retry the guide shows reads again and commits", async () => {
    const w = world()
    await w.create()
    const around = readersMeet(2)
    const retried = (fn: (c: any) => unknown) =>
      w.run(
        (agg) =>
          Effect.suspend(() => agg.update({ id: "m1" }, fn)).pipe(
            Effect.retry({
              while: (error: any) =>
                error._tag === "ConcurrentModification" || error._tag === "OptimisticLockError",
              schedule: Schedule.exponential("1 millis").pipe(Schedule.jittered),
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
  })

  it("the guide's retry also retries a TransactionConflict cancellation", async () => {
    const w = world()
    await w.create()
    let refused = 0
    const around: Around = (command, _input, send) =>
      command === "transactWriteItems" && refused++ === 0
        ? Effect.fail(
            classifyError("TransactWriteItems")(
              awsTransactionCanceled([{ Code: "TransactionConflict" }]),
            ),
          )
        : send
    const exit = await w.run(
      (agg) =>
        Effect.suspend(() =>
          agg.update({ id: "m1" }, (c: any) => ({ ...c.state, note: "x" })),
        ).pipe(
          Effect.retry({
            while: (error: any) =>
              error._tag === "ConcurrentModification" ||
              (error._tag === "TransactionCancelled" &&
                error.reasons.some((reason: any) => reason.code === "TransactionConflict")),
            schedule: Schedule.exponential("1 millis").pipe(Schedule.jittered),
            times: 4,
          }),
        ) as Effect.Effect<unknown, unknown, never>,
      around,
    )
    w.ok(exit)
    expect(refused).toBe(2)
    expect((await w.get()).note).toBe("x")
  })

  it("a cancellation with no failed condition (TransactionConflict) stays TransactionCancelled", async () => {
    const w = world()
    await w.create()
    const around: Around = (command, _input, send) =>
      command === "transactWriteItems"
        ? Effect.fail(
            classifyError("TransactWriteItems")(
              awsTransactionCanceled([{ Code: "TransactionConflict" }]),
            ),
          )
        : send
    expect(w.failed(await w.update((c) => ({ ...c.state, note: "x" }), around))).toBeInstanceOf(
      TransactionCancelled,
    )
  })

  it("the aggregate deleted between the read and the write: unfenced, the rewritten row is refused", async () => {
    const w = world()
    await w.create()
    const exit = await w.update(
      editLine("team1", "a", { text: "A" }),
      afterFirstRead(() => Effect.promise(() => w.run((agg) => agg.delete({ id: "m1" })))),
    )
    expect(w.failed(exit)).toBeInstanceOf(ConcurrentModification)
    expect(w.rows()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

describe("fence (D4 as decided: opt-in)", () => {
  const addLine = (c: any) => ({
    ...c.state,
    team1: {
      ...c.state.team1,
      lines: [...c.state.team1.lines, { lid: "z", text: "z", copy: "c0" }],
    },
  })

  it("off (the default): an update adding only a row commits after a delete, leaving a root-less row (named limit)", async () => {
    const w = world()
    await w.create()
    w.ok(
      await w.update(
        addLine,
        afterFirstRead(() => Effect.promise(() => w.run((agg) => agg.delete({ id: "m1" })))),
      ),
    )
    expect(w.rows().map((row) => String(row.sk?.S).split("#").at(-1))).toEqual(["z"])
    // `get` refuses it, and a delete removes it.
    expect(w.failed(await w.run((agg) => agg.get({ id: "m1" })))).toBeInstanceOf(
      AggregateAssemblyError,
    )
    w.ok(await w.run((agg) => agg.delete({ id: "m1" })))
    expect(w.rows()).toEqual([])
  })

  it("on: the same update fails as a key holding no aggregate, and writes nothing", async () => {
    const w = world(matches({ fence: true }))
    await w.create()
    const exit = await w.update(
      addLine,
      afterFirstRead(() => Effect.promise(() => w.run((agg) => agg.delete({ id: "m1" })))),
    )
    const error = w.failed(exit) as AggregateAssemblyError
    expect(error).toBeInstanceOf(AggregateAssemblyError)
    expect(error.reason).toBe("No items found for aggregate key")
    expect(w.rows()).toEqual([])
  })

  it("on: the fence is never in a request beside the root's own Put", async () => {
    const w = world(matches({ fence: true }))
    await w.create()
    w.take()
    w.ok(await w.update((c) => ({ ...addLine(c), note: "x" })))
    const [items] = transactions(w.take())
    expect(items!.some((item: any) => item.ConditionCheck !== undefined)).toBe(false)
    w.ok(await w.update(editLine("team1", "a", { text: "A" })))
    const [fenced] = transactions(w.take())
    expect(fenced!.filter((item: any) => item.ConditionCheck !== undefined)).toHaveLength(1)
  })

  it("the fence names the root's key under either escapeKeys setting", async () => {
    for (const escapeKeys of [false, true]) {
      const s = schemaOf(escapeKeys)
      const T = Table.make({ schema: s, entities: {} })
      const w = world(matches({ fence: true }, MatchModel, { schema: s, table: T }), { table: T })
      await w.create()
      w.take()
      w.ok(await w.update(editLine("team1", "a", { text: "A" })))
      const [items] = transactions(w.take())
      const fence = items!.find((item: any) => item.ConditionCheck !== undefined)
      expect(fence.ConditionCheck.Key.sk.S).toBe(ROOT_SK)
      expect(w.rowAt("#match")!.sk!.S).toBe(ROOT_SK)
    }
  })

  it("refuses a fence that isn't a boolean, and versioned with fence: false (EDD-9179)", () => {
    expect(() => matches({ fence: "yes" })).toThrow(/\[EDD-9179\].*`fence` takes `true` or `false`/)
    expect(() => matches({ versioned: true, fence: false })).toThrow(
      /\[EDD-9179\].*`versioned` with `fence: false`/,
    )
    expect(() => matches({ versioned: true, fence: true })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete (D8, D17)", () => {
  it("fenced: the root first, then one consistent read, then the rest", async () => {
    const w = world(matches({ fence: true }))
    await w.create()
    w.take()
    w.ok(await w.run((agg) => agg.delete({ id: "m1" })))
    const requests = w.take()
    expect(requests.map((request) => request.command)).toEqual([
      "DeleteItem",
      "Query",
      "BatchWriteItem",
    ])
    expect(requests[0]!.input.Key.sk.S).toBe(ROOT_SK)
    expect(requests[1]!.input.ConsistentRead).toBe(true)
    expect(w.rows()).toEqual([])
  })

  it("fenced: an update adding a line after the root went fails; one that committed before is deleted", async () => {
    const add = (lid: string) => (c: any) => ({
      ...c.state,
      team1: { ...c.state.team1, lines: [...c.state.team1.lines, { lid, text: lid, copy: "c0" }] },
    })
    // The update's write lands after the root's DeleteItem.
    const w = world(matches({ fence: true }))
    await w.create()
    const updated = latch()
    const [del, upd] = await Promise.all([
      w.run(
        (agg) => agg.delete({ id: "m1" }),
        (command, _input, send) =>
          command === "deleteItem"
            ? send.pipe(Effect.tap(() => Effect.andThen(Effect.sync(updated.open), Effect.void)))
            : command === "query"
              ? Effect.andThen(Effect.sleep("20 millis"), send)
              : send,
      ),
      w.run(
        (agg) => agg.update({ id: "m1" }, add("z")),
        (command, _input, send) =>
          command === "transactWriteItems" ? Effect.andThen(updated.wait, send) : send,
      ),
    ])
    w.ok(del)
    expect(w.failed(upd)).toBeInstanceOf(AggregateAssemblyError)
    expect(w.rows()).toEqual([])

    // The update's write lands before the root's DeleteItem: the consistent read finds it.
    const v = world(matches({ fence: true }))
    await v.create()
    v.ok(
      await v.run(
        (agg) => agg.delete({ id: "m1" }),
        beforeRequest(
          (command) => command === "deleteItem",
          () => Effect.promise(() => v.run((agg) => agg.update({ id: "m1" }, add("y"))).then(v.ok)),
        ),
      ),
    )
    expect(v.rows()).toEqual([])
  })

  it("fenced: a create landing after the root went keeps its aggregate", async () => {
    const w = world(matches({ fence: true }))
    await w.create()
    w.take()
    // The create's root guard passes once the root's DeleteItem has gone through, before the read.
    const exit = await w.run(
      (agg) => agg.delete({ id: "m1" }),
      beforeRequest(
        (command) => command === "query",
        () =>
          Effect.promise(() => w.run((agg) => agg.create({ ...initial, note: "new" })).then(w.ok)),
      ),
    )
    w.ok(exit)
    expect((await w.get()).note).toBe("new")
    expect(w.rows()).toHaveLength(6)
    expect(w.take().filter((request) => request.command === "BatchWriteItem")).toEqual([])
  })

  it("unfenced: the sweep read deletes a row added after the first read, unless it finds a root", async () => {
    const w = world()
    await w.create()
    w.take()
    // A create reusing the key once the batches have deleted the old aggregate.
    let batches = 0
    const exit = await w.run(
      (agg) => agg.delete({ id: "m1" }),
      (command, _input, send) => {
        if (command === "batchWriteItem") batches++
        if (command === "query" && batches > 0) {
          return Effect.andThen(
            Effect.promise(() =>
              w.run((agg) => agg.create({ ...initial, note: "new" })).then(w.ok),
            ),
            send,
          )
        }
        return send
      },
    )
    w.ok(exit)
    expect((await w.get()).note).toBe("new")
    expect(w.rows()).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// update's read
// ---------------------------------------------------------------------------

describe("update's read (D11 reversed, D6)", () => {
  it("is strongly consistent on a base-table collection, whatever consistentRead says", async () => {
    const w = world()
    await w.create()
    w.take()
    w.ok(await w.update((c) => ({ ...c.state, note: "x" })))
    const [query] = w.take()
    expect(query!.command).toBe("Query")
    expect(query!.input.ConsistentRead).toBe(true)
    // `get` keeps the aggregate's own setting.
    await w.get()
    expect(w.take()[0]!.input.ConsistentRead).toBeUndefined()
  })

  it("is eventually consistent on a GSI collection (named limit), If-Match included", async () => {
    const OnGsi = Aggregate.make(MatchModel, {
      table: Main,
      schema,
      pk: { field: "gsi1pk", composite: ["id"] },
      collection: { name: "matches", index: "gsi1", sk: { field: "pk", composite: ["id"] } },
      root: { entityType: "Match" },
      versioned: true,
      edges: {
        team1: (Team as any).with({ discriminator: { teamNumber: 1 } }),
        team2: (Team as any).with({ discriminator: { teamNumber: 2 } }),
      },
    } as any)
    const w = world(OnGsi, { indexes: { gsi1: { pk: "gsi1pk", sk: "sk" } } })
    await w.create()
    w.take()
    w.ok(await w.update((c) => ({ ...c.state, note: "x" }), undefined, { expectedVersion: 1 }))
    const [query] = w.take()
    expect(query!.input.IndexName).toBe("gsi1")
    expect(query!.input.ConsistentRead).toBeUndefined()
  })

  describe("a collection index keyed on the table's own partition key", () => {
    const Row = Entity.make({
      model: Schema.Struct({ rid: Schema.String }),
      entityType: "Row",
      primaryKey: {
        pk: { field: "pk", composite: ["rid"] },
        sk: { field: "sk", composite: [] },
      },
    })
    const Keyed = Table.make({ schema, entities: { Row } })
    const onIndex = (extra: Record<string, unknown> = {}) =>
      matches(
        {
          collection: { name: "matches", index: "gsi1", sk: { field: "gsi1sk", composite: [] } },
          ...extra,
        },
        MatchModel,
        { schema, table: Keyed },
      )

    it("a GSI there: update and delete read as consistentRead says, as on 1.43.0", async () => {
      const w = world(onIndex({ fence: true }), {
        table: Keyed as never,
        indexes: { gsi1: { pk: "pk", sk: "gsi1sk", kind: "global" } },
      })
      await w.create()
      w.take()
      w.ok(await w.update((c) => ({ ...c.state, note: "x" })))
      expect(w.take()[0]!.input.ConsistentRead).toBeUndefined()
      w.ok(await w.run((agg) => agg.delete({ id: "m1" })))
      const reads = w.take().filter((request) => request.command === "Query")
      expect(reads.map((request) => request.input.ConsistentRead)).toEqual([undefined])
      expect(w.rows()).toEqual([])
    })

    it("an LSI there: consistentRead: true makes update and delete read consistently", async () => {
      const w = world(onIndex({ consistentRead: true }), {
        table: Keyed as never,
        indexes: { gsi1: { pk: "pk", sk: "gsi1sk", kind: "local" } },
      })
      await w.create()
      w.take()
      w.ok(await w.update((c) => ({ ...c.state, note: "x" })))
      expect(w.take()[0]!.input.ConsistentRead).toBe(true)
      w.ok(await w.run((agg) => agg.delete({ id: "m1" })))
      const reads = w.take().filter((request) => request.command === "Query")
      expect(reads.map((request) => request.input.ConsistentRead)).toEqual([true, true])
    })
  })
})

// ---------------------------------------------------------------------------
// versioned
// ---------------------------------------------------------------------------

const VersionedModel = Schema.Struct({ ...MatchModel.fields, version: Schema.Number })

describe("versioned (D5, D6)", () => {
  it("create writes version 1 and an incarnation token on the root row only; a read strips both", async () => {
    const w = world(matches({ versioned: true }))
    const created = await w.create()
    const root = w.rowAt("#match")!
    expect(root.version).toEqual({ N: "1" })
    expect(text(root, "__edd_i__")).toMatch(/^[0-9a-f-]{36}$/)
    for (const row of w.rows().filter((r) => r !== root)) {
      expect(row.version).toBeUndefined()
      expect(row.__edd_i__).toBeUndefined()
    }
    expect(created).not.toHaveProperty("version")
    expect(await w.get()).not.toHaveProperty("version")
  })

  it("a root model declaring the field reads it; every sending update moves it, a no-op doesn't", async () => {
    const w = world(matches({ versioned: true }, VersionedModel))
    expect((await w.create({ ...initial, version: 41 })).version).toBe(1)
    const seen: Array<number | undefined> = []
    const updated = w.ok(
      await w.update((c) => {
        seen.push(c.version)
        return { ...c.state, note: "x", version: 99 }
      }),
    )
    expect(seen).toEqual([1])
    expect(updated.version).toBe(2)
    expect((await w.get()).version).toBe(2)
    w.take()
    expect(w.ok(await w.update((c) => c.state)).version).toBe(2)
    expect(w.take().map((request) => request.command)).toEqual(["Query"])
  })

  it("an update leaving the root as it was moves the version by an Update of the root, unstamped", async () => {
    const w = world(matches({ versioned: true, timestamps: true }))
    await w.create()
    const stamp = text(w.rowAt("#match"), "updatedAt")
    w.take()
    w.ok(await w.update(editLine("team1", "a", { text: "A" })))
    const [items] = transactions(w.take())
    const update = items![0].Update
    expect(update.Key.sk.S).toBe(ROOT_SK)
    expect(update.UpdateExpression).toBe("SET #ver = :v1, #inc = :inc")
    expect(update.ConditionExpression).toBe("attribute_exists(#pk) AND #ver = :v AND #inc = :inc")
    expect(w.rowAt("#match")!.version).toEqual({ N: "2" })
    expect(text(w.rowAt("#match"), "updatedAt")).toBe(stamp)
  })

  it("a root written before the option reads as 0, and its first update adds the version and a token", async () => {
    const w = world(matches({ versioned: true }))
    await world(matches(), {}).create()
    const plain = world()
    await plain.create()
    for (const row of plain.rows()) w.table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
    const seen: Array<number | undefined> = []
    w.take()
    w.ok(
      await w.update((c) => {
        seen.push(c.version)
        return editLine("team1", "a", { text: "A" })(c)
      }),
    )
    expect(seen).toEqual([0])
    const [items] = transactions(w.take())
    expect(items![0].Update.ConditionExpression).toBe(
      "attribute_exists(#pk) AND (attribute_not_exists(#ver) OR #ver = :v) AND attribute_not_exists(#inc)",
    )
    expect(w.rowAt("#match")!.version).toEqual({ N: "1" })
    expect(text(w.rowAt("#match"), "__edd_i__")).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("two updates on one read: the second fails OptimisticLockError, the version moved once", async () => {
    const w = world(matches({ versioned: true }))
    await w.create()
    const around = readersMeet(2)
    const [a, b] = await Promise.all([
      w.update(editLine("team1", "a", { text: "A" }), around),
      w.update(editLine("team2", "c", { text: "B" }), around),
    ])
    const exits = [a, b]
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
    const error = w.failed(exits.find(Exit.isFailure)!) as OptimisticLockError
    expect(error).toBeInstanceOf(OptimisticLockError)
    expect([error.expectedVersion, error.actualVersion]).toEqual([1, 2])
    expect(w.rowAt("#match")!.version).toEqual({ N: "2" })
  })

  it("a row changed without the version moving: OptimisticLockError with its attributes", async () => {
    const w = world(matches({ versioned: true }))
    await w.create()
    const exit = await w.update(
      editLine("team1", "b", { text: "B" }),
      afterFirstRead(() => rawSet(w.client, w.rowAt("#b")!, "copy", { S: "c1" })),
    )
    const error = w.failed(exit) as OptimisticLockError
    expect(error).toBeInstanceOf(OptimisticLockError)
    expect([error.expectedVersion, error.actualVersion]).toEqual([1, 1])
    expect(error.attributes).toEqual(["team1.lines[b].copy"])
  })

  it("expectedVersion is compared before the mutation runs, on a consistent read", async () => {
    const w = world(matches({ versioned: true }))
    await w.create()
    w.take()
    let ran = 0
    const exit = await w.update(
      (c) => {
        ran++
        return c.state
      },
      undefined,
      { expectedVersion: 5 },
    )
    const error = w.failed(exit) as OptimisticLockError
    expect(error).toBeInstanceOf(OptimisticLockError)
    expect([error.expectedVersion, error.actualVersion]).toEqual([5, 1])
    expect(ran).toBe(0)
    const requests = w.take()
    expect(requests.map((request) => request.command)).toEqual(["Query"])
    expect(requests[0]!.input.ConsistentRead).toBe(true)
    w.ok(await w.update((c) => ({ ...c.state, note: "x" }), undefined, { expectedVersion: 1 }))
    expect(w.rowAt("#match")!.version).toEqual({ N: "2" })
  })

  it("expectedVersion on an aggregate that isn't versioned is refused before anything is read (EDD-9178)", async () => {
    const w = world()
    await w.create()
    w.take()
    const error = w.failed(
      await w.update((c) => c.state, undefined, { expectedVersion: 1 }),
    ) as ValidationError
    expect(error).toBeInstanceOf(ValidationError)
    expect(String(error.cause)).toContain("[EDD-9178]")
    expect(w.take()).toEqual([])
  })

  it("a delete and re-create between the read and the write: the token differs, OptimisticLockError", async () => {
    const w = world(matches({ versioned: true }))
    await w.create()
    const recreate = () =>
      Effect.promise(async () => {
        w.ok(await w.run((agg) => agg.delete({ id: "m1" })))
        await w.create()
      })
    const exit = await w.update(editLine("team1", "a", { text: "A" }), afterFirstRead(recreate))
    const error = w.failed(exit) as OptimisticLockError
    expect(error).toBeInstanceOf(OptimisticLockError)
    expect([error.expectedVersion, error.actualVersion]).toEqual([1, 1])
    expect(text(w.rowAt("#a"), "text")).toBe("a0")
  })

  it("unversioned, the same re-create is not seen (named limit): rows equal by value pass their guards", async () => {
    const w = world()
    await w.create()
    const recreate = () =>
      Effect.promise(async () => {
        w.ok(await w.run((agg) => agg.delete({ id: "m1" })))
        await w.create()
      })
    w.ok(await w.update(editLine("team1", "a", { text: "A" }), afterFirstRead(recreate)))
    expect(text(w.rowAt("#a"), "text")).toBe("A")
  })

  it("refuses an option the version can't be kept under (EDD-9177)", () => {
    expect(() => matches({ versioned: { retain: true } })).toThrow(
      /\[EDD-9177\].*versioned\.retain/,
    )
    expect(() => matches({ versioned: { ttl: 5 } })).toThrow(/\[EDD-9177\].*versioned\.ttl/)
    expect(() => matches({ versioned: { field: "id" } })).toThrow(/\[EDD-9177\].*key composite/)
    expect(() => matches({ versioned: { field: "status" }, context: ["status"] })).toThrow(
      /\[EDD-9177\].*context field/,
    )
    expect(() => matches({ versioned: { field: "updatedAt" }, timestamps: true })).toThrow(
      /\[EDD-9177\].*timestamp field/,
    )
    expect(() => matches({ versioned: { field: "note" } })).toThrow(/\[EDD-9177\].*isn't a number/)
    expect(() => matches({ versioned: { field: "pk" } })).toThrow(/\[EDD-9177\].*key attribute/)
    expect(() => matches({ versioned: "yes" })).toThrow(/\[EDD-9177\]/)
    expect(() => matches({ versioned: { field: "rev" } })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Roots of members: a union, a suspended schema
// ---------------------------------------------------------------------------

describe("a root of members (a union, a suspended schema)", () => {
  const member = (kind: string) =>
    Schema.Struct({
      kind: Schema.Literal(kind),
      ...MatchModel.fields,
      note: Schema.optionalKey(Schema.String),
      version: Schema.Number,
    })
  const plainMember = (kind: string) =>
    Schema.Struct({
      kind: Schema.Literal(kind),
      ...MatchModel.fields,
      note: Schema.optionalKey(Schema.String),
    })
  const Union = Schema.Union([member("a"), member("b")])
  const Suspended = Schema.suspend(() => member("a"))
  const plain = {
    "a union": Schema.Union([plainMember("a"), plainMember("b")]),
    "a suspended schema": Schema.suspend(() => plainMember("a")),
  } as const
  const start = { ...initial, kind: "a" } as Record<string, unknown>
  const { note: _, ...withoutNote } = start

  for (const [name, model] of [
    ["a union", Union],
    ["a suspended schema", Suspended],
  ] as const) {
    it(`${name}: versioned, the declared version is the library's and reads back`, async () => {
      const w = world(matches({ versioned: true }, model))
      expect((await w.create({ ...start, version: 41 })).version).toBe(1)
      expect(w.rowAt("#match")!.version).toEqual({ N: "1" })
      expect((await w.get()).version).toBe(1)
      expect(w.ok(await w.update((c) => ({ ...c.state, status: "live" }))).version).toBe(2)
      expect((await w.get()).version).toBe(2)
    })

    it(`${name}: an optional attribute another writer added since the read is guarded absent`, async () => {
      const w = world(matches({}, plain[name]))
      await w.create(withoutNote)
      const exit = await w.update(
        (c) => ({ ...c.state, status: "live" }),
        afterFirstRead(() =>
          Effect.promise(() => w.update((c) => ({ ...c.state, note: "added" })).then(w.ok)),
        ),
      )
      expect((w.failed(exit) as ConcurrentModification).attributes).toEqual(["note"])
      expect(text(w.rowAt("#match"), "note")).toBe("added")
      expect(text(w.rowAt("#match"), "status")).toBe("scheduled")
    })
  }

  it("refuses a version field a member declares as anything but a number (EDD-9177)", () => {
    const Odd = Schema.Union([
      member("a"),
      Schema.Struct({ kind: Schema.Literal("b"), ...MatchModel.fields, version: Schema.String }),
    ])
    expect(() => matches({ versioned: true }, Odd)).toThrow(/\[EDD-9177\].*isn't a number/)
    // A field stored under the version's name: the row would hold two values under one name.
    const Renamed = Schema.Struct({ ...MatchModel.fields, rev: Schema.Number }).pipe(
      Schema.encodeKeys({ rev: "version" }),
    )
    expect(() => matches({ versioned: true }, Renamed)).toThrow(
      /\[EDD-9177\].*a root model field is stored under/,
    )
    expect(() => matches({ versioned: true }, Union)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// rekey of a versioned aggregate
// ---------------------------------------------------------------------------

describe("rekey of a versioned aggregate", () => {
  const escaped = schemaOf(true)
  const MainEscaped = Table.make({ schema: escaped, entities: {} })
  const key = { id: "a#b" }

  for (const [name, model] of [
    ["the version undeclared", MatchModel],
    ["the version declared", VersionedModel],
  ] as const) {
    it(`${name}: a move to a new partition keeps the version and the incarnation token`, async () => {
      const before = world(matches({ versioned: true }, model))
      before.ok(await before.run((agg) => agg.create({ ...initial, ...key, version: 0 })))
      before.ok(await before.run((agg) => agg.update(key, (c: any) => ({ ...c.state, note: "x" }))))
      const oldRoot = before.rows().find((row) => row.sk?.S === ROOT_SK)!
      expect(oldRoot.version).toEqual({ N: "2" })

      const after = world(
        matches({ versioned: true }, model, { schema: escaped, table: MainEscaped }),
        {
          table: MainEscaped as never,
        },
      )
      for (const row of before.rows()) after.table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
      after.ok(await after.run((_agg, db) => db.tables.Main.rekey()))
      const moved = after.rows().find((row) => row.sk?.S === ROOT_SK)!
      expect(moved.pk!.S).not.toBe(oldRoot.pk!.S)
      expect(moved.version).toEqual({ N: "2" })
      expect(moved.__edd_i__).toEqual(oldRoot.__edd_i__)
      after.ok(
        await after.run((agg) =>
          agg.update(key, (c: any) => ({ ...c.state, note: "y" }), { expectedVersion: 2 }),
        ),
      )
      expect(after.rows().find((row) => row.sk?.S === ROOT_SK)!.version).toEqual({ N: "3" })
    })
  }
})

// ---------------------------------------------------------------------------
// ownsRows cleanup (D10)
// ---------------------------------------------------------------------------

describe("ownsRows cleanup in the update's transaction (D10)", () => {
  const OrderLine = Schema.Struct({ lid: Schema.String, note: Schema.String })
  const SubModel = Schema.Struct({ lines: Schema.Array(OrderLine) })
  const Sub = Aggregate.make(SubModel, {
    root: { entityType: "Sub" },
    edges: {
      lines: Aggregate.many({
        entityType: "OrderLine",
        sk: { composite: ["lid"] },
        assemble: (rows) =>
          (rows as ReadonlyArray<typeof OrderLine.Type>).filter((line) => line.note !== "hidden"),
        decompose: (rows) => rows as ReadonlyArray<unknown>,
      }),
    },
  } as any)
  const Orders = Aggregate.make(
    Schema.Struct({ id: Schema.String, note: Schema.String, sub: SubModel }),
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "orders" },
      root: { entityType: "Order" },
      ownsRows: true,
      edges: { sub: (Sub as any).with({}) },
    } as any,
  )

  it("a hidden row is deleted in the same transaction as the group's rows, while gone or as read", async () => {
    const w = world(Orders)
    await w.create({
      id: "m1",
      note: "n",
      sub: {
        lines: [
          { lid: "x", note: "shown" },
          { lid: "h", note: "hidden" },
        ],
      },
    })
    w.take()
    w.ok(
      await w.update((c) => ({
        ...c.state,
        sub: { lines: c.state.sub.lines.map((l: any) => ({ ...l, note: `${l.note}!` })) },
      })),
    )
    const sent = transactions(w.take())
    expect(sent).toHaveLength(1)
    const cleanup = sent[0]!.find((item: any) => item.Delete !== undefined)
    expect(cleanup.Delete.Key.sk.S).toMatch(/#h$/)
    expect(cleanup.Delete.ConditionExpression).toMatch(/^attribute_not_exists\(#cpk\) OR \(/)
    expect(w.rowAt("#h")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// A unit over 4 MB only because of its guards (D18)
// ---------------------------------------------------------------------------

describe("a unit over 4 MB only because of its guards (D18)", () => {
  it("compares a string by size only when it is ASCII, where every count of its length agrees", () => {
    expect(sizeOperand({ S: "x".repeat(2000) })).toEqual({ N: "2000" })
    // UTF-8 bytes, UTF-16 code units and code points differ beyond ASCII: compared by value.
    expect(sizeOperand({ S: "é".repeat(2000) })).toBeUndefined()
    expect(sizeOperand({ S: `${"x".repeat(2000)}😀` })).toBeUndefined()
    expect(sizeOperand({ B: new Uint8Array(3) })).toEqual({ N: "3" })
  })

  it("compares its large attributes by size, and is sent in one request", async () => {
    const w = world(matches({ context: ["status"] }))
    const big = "x".repeat(50_000)
    await w.create({ ...initial, team1: { tag: "v0", lines: lines("a", 50, big) } })
    w.take()
    // A context change sends every row of every group: team1's group is 2.5 MB of rows.
    w.ok(await w.update((c) => ({ ...c.state, status: "live" })))
    const sent = transactions(w.take())
    expect(sent).toHaveLength(1)
    expect(transactionBytes(sent[0]! as never)).toBeLessThanOrEqual(TRANSACT_WRITE_MAX_BYTES)
    // Some large values compared by size, as many as needed to fit; the rest whole.
    const linePuts = sent[0]!.filter((item: any) => item.Put?.Item.__edd_e__.S === "Line")
    const bySize = linePuts.filter((item: any) => item.Put.ConditionExpression.includes("size("))
    expect(bySize.length).toBeGreaterThan(0)
    expect(bySize.length).toBeLessThan(linePuts.length)
    // The small attributes stay compared by value.
    expect(Object.values(bySize[0].Put.ExpressionAttributeValues)).toContainEqual({ S: "c0" })
    expect(w.rows().every((row) => text(row, "status") === "live")).toBe(true)
    // A non-library writer changing a small attribute is still seen.
    const exit = await w.update(
      (c) => ({ ...c.state, status: "done" }),
      afterFirstRead(() => rawSet(w.client, w.rowAt("#a001")!, "copy", { S: "c1" })),
    )
    expect((w.failed(exit) as ConcurrentModification).attributes).toEqual([
      "team1.lines[a001].copy",
    ])
  })
})
