/**
 * Issue #168's reproductions, run by `Issue168.races.test.ts` over a recording in-memory table and
 * by `connected.aggregate-concurrency.test.ts` against DynamoDB Local: `Aggregate.update` had no
 * compare-and-set, a change spanning several sub-aggregate groups was several transactions, and
 * `create`, `delete` and the `ownsRows` cleanup read then wrote without a guard. Each test injects
 * the concurrent write between the read and the write and asserts the CORRECT outcome.
 *
 * The aggregate is a match: a root, two team sub-aggregates (each its own transaction group,
 * holding `lines`). Every root and team row carries a `tag` naming the writer, so a torn aggregate
 * is one whose rows carry two writers' tags.
 *
 * A latch holds a request until the step the interleaving needs has happened (`gatedClient` for
 * the library's own writers; a raw `UpdateItem`, `Put` or delete for a writer outside the
 * library). "Correct" is serialisability: what is stored is what the writers would have left
 * running one after the other, and a writer that read stale state either fails or is not
 * reported as stored.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Exit, Schema } from "effect"
import { expect, it, describe as vitestDescribe } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import type { DynamoClientService } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"
import type { Around } from "./GatedClient.js"

export type Row = Record<string, AttributeValue>

// ---------------------------------------------------------------------------
// The aggregate
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

export const schema = DynamoSchema.make({ name: "m168", version: 1 })
export const Main = Table.make({ schema, entities: {} })
const Team = Aggregate.make(TeamModel, {
  root: { entityType: "Team" },
  edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
} as any)
export const Matches = Aggregate.make(MatchModel, {
  table: Main,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "matches" },
  root: { entityType: "Match" },
  edges: {
    team1: (Team as any).with({ discriminator: { teamNumber: 1 } }),
    team2: (Team as any).with({ discriminator: { teamNumber: 2 } }),
  },
} as any)

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

/** The aggregate a writer tagged `tag` produces from `state`: its tag on the root and each team. */
const tagged = (state: Match, tag: string): Match => ({
  ...state,
  tag,
  team1: { ...state.team1, tag },
  team2: { ...state.team2, tag },
})

// ---------------------------------------------------------------------------
// The world a suite runs in
// ---------------------------------------------------------------------------

/** A table holding nothing yet, and a way to run against it. */
export interface RaceTable {
  readonly tableName: string
  /** The table's client, ungated: a writer outside the library. */
  readonly client: DynamoClientService
  /** `body` with `aggregate` bound as `db.aggregates.Matches`, through `around` when given. */
  readonly run: <A, E>(
    body: (db: any) => Effect.Effect<A, E, never>,
    around?: Around,
  ) => Promise<Exit.Exit<A, E>>
  /** Every row, in key order. */
  readonly rows: () => Promise<ReadonlyArray<Row>>
}

/** A fresh table with `aggregate` bound on it. */
export type MakeRaceTable = (aggregate: unknown) => Promise<RaceTable>

const worldOf = (table: RaceTable) => {
  const ok = <A, E>(exit: Exit.Exit<A, E>): A => {
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
    return exit.value
  }
  const rowAt = async (suffix: string): Promise<Row | undefined> =>
    (await table.rows()).find((row) => String(row.sk?.S).endsWith(suffix))
  return {
    ...table,
    ok,
    rowAt,
    /** Every row deleted, by a writer outside the library. */
    deleteAll: () =>
      Effect.promise(() => table.rows()).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) =>
              table.client.deleteItem({
                TableName: table.tableName,
                Key: { pk: row.pk!, sk: row.sk! },
              } as never),
            { discard: true },
          ),
        ),
      ),
    create: async (value: unknown = initial) =>
      ok(await table.run((db) => db.aggregates.Matches.create(value))),
    get: async (): Promise<Match> =>
      ok(await table.run((db) => db.aggregates.Matches.get({ id: "m1" }))) as Match,
  }
}

// ---------------------------------------------------------------------------
// Interleaving tools
// ---------------------------------------------------------------------------

/** A step the interleaving waits for; gives up after a while so a broken order fails an assertion. */
const latch = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000))
  return { open, wait: Effect.promise(() => Promise.race([opened, timeout])) }
}

/** The first `n` `Query` answers come back only once `n` queries were answered: `n` readers read alike. */
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

/** Run `after` once, after the first `Query` was answered: a writer landing between read and write. */
const afterFirstRead =
  (after: () => Effect.Effect<unknown, unknown>): Around =>
  (command, _input, send) => {
    if (command !== "query" || fired.has(after)) return send
    fired.add(after)
    return send.pipe(Effect.tap(() => after()))
  }
const fired = new WeakSet<object>()

const text = (row: Row | undefined, name: string): string | undefined =>
  (row?.[name] as { S?: string } | undefined)?.S

const exitName = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? "succeeded" : "failed"

/** The entity types a transaction puts. */
const putTypes = (input: any): ReadonlyArray<string> =>
  (input?.TransactItems ?? []).flatMap((item: any) =>
    item.Put === undefined ? [] : [text(item.Put.Item, "__edd_e__") ?? "?"],
  )

/** The `tag` a transaction's rows carry: the writer that sent it. */
const writerOf = (input: any): string | undefined =>
  (input?.TransactItems ?? [])
    .map((item: any) => text(item.Put?.Item, "tag"))
    .find((tag: string | undefined) => tag !== undefined)

/** The tags the stored root and team rows carry. */
const storedTags = (rows: ReadonlyArray<Row>): ReadonlyArray<string> => [
  ...new Set(rows.flatMap((row) => (text(row, "tag") === undefined ? [] : [text(row, "tag")!]))),
]

/** The reproductions, each on a table of its own from `makeTable`. */
export const racesSuite = (
  makeTable: MakeRaceTable,
  options: { readonly skip?: boolean } = {},
): void => {
  const describe = vitestDescribe.skipIf(options.skip === true)
  const makeWorld = async (aggregate: unknown) => worldOf(await makeTable(aggregate))

  const failedWrite = () =>
    Effect.fail(new DynamoError({ operation: "transactWriteItems", cause: new Error("throttled") }))

  // ---------------------------------------------------------------------------

  describe("Issue #168: Aggregate.update has no compare-and-set", () => {
    it("lost update: A and B read the same aggregate, each changes a field of the root row; the second write overwrites the first's change", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const around = readersMeet(2)
      const [a, b] = await Promise.all([
        w.run(
          (db) =>
            db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
              ...c.state,
              status: "A:live",
            })),
          around,
        ),
        w.run(
          (db) =>
            db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
              ...c.state,
              note: "B:note",
            })),
          around,
        ),
      ])
      const stored = await w.get()
      // Each writer that was told it succeeded has its change stored.
      const lost = [
        ...(Exit.isSuccess(a) && stored.status !== "A:live"
          ? [`A's status (stored ${stored.status})`]
          : []),
        ...(Exit.isSuccess(b) && stored.note !== "B:note"
          ? [`B's note (stored ${stored.note})`]
          : []),
      ]
      expect(lost, `A ${exitName(a)}, B ${exitName(b)}`).toEqual([])
    })

    it("lost update: A and B read the same aggregate, A rewrites line a, B rewrites line b of one team; the later write puts the other's line back", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const around = readersMeet(2)
      const edit = (lid: string, text: string) => (c: any) => ({
        ...c.state,
        team1: {
          ...c.state.team1,
          lines: c.state.team1.lines.map((line: any) =>
            line.lid === lid ? { ...line, text } : line,
          ),
        },
      })
      const [a, b] = await Promise.all([
        w.run((db) => db.aggregates.Matches.update({ id: "m1" }, edit("a", "A:a")), around),
        w.run((db) => db.aggregates.Matches.update({ id: "m1" }, edit("b", "B:b")), around),
      ])
      const lines = (await w.get()).team1.lines
      const lost = [
        ...(Exit.isSuccess(a) && lines.find((l) => l.lid === "a")?.text !== "A:a"
          ? ["A's line a"]
          : []),
        ...(Exit.isSuccess(b) && lines.find((l) => l.lid === "b")?.text !== "B:b"
          ? ["B's line b"]
          : []),
      ]
      expect(lost, `A ${exitName(a)}, B ${exitName(b)}`).toEqual([])
    })

    it("torn aggregate: A's root lands, B writes all three groups, A's team groups land after; the stored aggregate holds two writers' rows", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const meet = readersMeet(2)
      const aRootLanded = latch()
      const bFinished = latch()
      const around: Around = (command, input, send) => {
        if (command === "query") return meet(command, input, send)
        if (command !== "transactWriteItems") return send
        const writer = writerOf(input)
        // B's first write waits until A's root group has landed.
        if (writer === "B") return aRootLanded.wait.pipe(Effect.andThen(send))
        if (writer === "A" && putTypes(input).includes("Match")) {
          return send.pipe(Effect.ensuring(Effect.sync(aRootLanded.open)))
        }
        // A's team groups wait until B has finished writing.
        if (writer === "A") return bFinished.wait.pipe(Effect.andThen(send))
        return send
      }
      const change = (tag: string) => (c: any) =>
        tagged({ ...c.state, status: `${tag}:status` }, tag)
      const [a, b] = await Promise.all([
        w.run((db) => db.aggregates.Matches.update({ id: "m1" }, change("A")), around),
        w
          .run((db) => db.aggregates.Matches.update({ id: "m1" }, change("B")), around)
          .finally(bFinished.open),
      ])
      const tags = storedTags(await w.rows())
      // One writer's aggregate, whole: the root and both teams carry the same tag.
      expect(
        tags.length === 1 && (tags[0] === "A" || tags[0] === "B"),
        `A ${exitName(a)}, B ${exitName(b)}, stored tags ${JSON.stringify(tags)}`,
      ).toBe(true)
    })

    it("torn aggregate: a team group's transaction fails after the root's committed; the failed update changed nothing", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const around: Around = (command, input, send) =>
        command === "transactWriteItems" && putTypes(input).includes("Team") ? failedWrite() : send
      const exit = await w.run(
        (db) => db.aggregates.Matches.update({ id: "m1" }, (c: any) => tagged(c.state, "A")),
        around,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      // Atomic: a failed update leaves the aggregate as it was, none of A's rows.
      expect(storedTags(await w.rows()), "rows carrying A's tag after the failed update").toEqual([
        "v0",
      ])
    })

    it("write by a non-aggregate writer: a per-row conditional UpdateItem on a line's denormalised copy lands between the read and the save; the save puts the stale copy back", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const lineB = (await w.rowAt("#b"))!
      const job = () =>
        w.client.updateItem({
          TableName: w.tableName,
          Key: { pk: lineB.pk!, sk: lineB.sk! },
          UpdateExpression: "SET #c = :new",
          ConditionExpression: "#c = :old",
          ExpressionAttributeNames: { "#c": "copy" },
          ExpressionAttributeValues: { ":old": { S: "c0" }, ":new": { S: "c1" } },
        } as never)
      // The scorer changes line a only; line b is in the same group, so its row is written too.
      const exit = await w.run(
        (db) =>
          db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
            ...c.state,
            team1: {
              ...c.state.team1,
              lines: c.state.team1.lines.map((line: any) =>
                line.lid === "a" ? { ...line, text: "A:a" } : line,
              ),
            },
          })),
        afterFirstRead(job),
      )
      // The job's correction survives, or the save was refused for reading before it.
      const copy = text(await w.rowAt("#b"), "copy")
      expect(
        Exit.isFailure(exit) || copy === "c1",
        `save ${exitName(exit)}, line b copy is ${copy}`,
      ).toBe(true)
    })

    it("update after a concurrent delete: the aggregate is deleted between the read and the save; the save leaves no rows behind", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const deleted = () => w.deleteAll()
      const exit = await w.run(
        (db) =>
          db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
            ...c.state,
            team1: {
              ...c.state.team1,
              lines: c.state.team1.lines.map((line: any) =>
                line.lid === "a" ? { ...line, text: "A:a" } : line,
              ),
            },
          })),
        afterFirstRead(deleted),
      )
      // A deleted aggregate is not brought back, as rows with no root: the update fails or writes nothing.
      expect(
        Exit.isFailure(exit) || (await w.rows()).length === 0,
        `update ${exitName(exit)}, ${(await w.rows()).length} row(s) stored`,
      ).toBe(true)
    })
  })

  describe("Issue #168: the other aggregate writes read then write without a guard", () => {
    it("create: a team group's transaction fails after the root's committed; the failed create stored nothing", async () => {
      const w = await makeWorld(Matches)
      const around: Around = (command, input, send) =>
        command === "transactWriteItems" && putTypes(input).includes("Team") ? failedWrite() : send
      const exit = await w.run((db) => db.aggregates.Matches.create(initial), around)
      expect(Exit.isFailure(exit)).toBe(true)
      // All or none: a half-created aggregate would also refuse the retry (the root guard finds the root).
      expect((await w.rows()).length, "rows stored by the failed create").toBe(0)
    })

    it("delete: a line is added between the read and the delete; the delete leaves no row of the aggregate behind", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const lineB = (await w.rowAt("#b"))!
      const added = () =>
        w.client.putItem({
          TableName: w.tableName,
          Item: { ...structuredClone(lineB), sk: { S: String(lineB.sk?.S).replace(/#b$/, "#z") } },
        } as never)
      const exit = await w.run(
        (db) => db.aggregates.Matches.delete({ id: "m1" }),
        afterFirstRead(added),
      )
      // The delete took the aggregate as it read it; a row written after is the aggregate's too.
      const left = await w.rows()
      expect(
        Exit.isFailure(exit) || left.length === 0,
        `delete ${exitName(exit)}, ${left.length} row(s) left: ${left.map((r) => text(r, "sk")).join(", ")}`,
      ).toBe(true)
    })
  })

  describe("Issue #168: delete with the fence, against an aggregate writer", () => {
    // With `fence: true` every update checks the root, so `delete` deletes the root first (design
    // §3.8): an update whose write lands after it fails, whatever it sends.
    const Fenced = Aggregate.make(MatchModel, {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "matches" },
      root: { entityType: "Match" },
      fence: true,
      edges: {
        team1: (Team as any).with({ discriminator: { teamNumber: 1 } }),
        team2: (Team as any).with({ discriminator: { teamNumber: 2 } }),
      },
    } as any)

    it("delete: an update adding a line lands after the root's delete; the delete leaves no row of the aggregate behind", async () => {
      const w = await makeWorld(Fenced)
      await w.create()
      const rootGone = latch()
      const [deleted, updated] = await Promise.all([
        w.run(
          (db) => db.aggregates.Matches.delete({ id: "m1" }),
          (command, _input, send) =>
            command === "deleteItem"
              ? send.pipe(Effect.ensuring(Effect.sync(rootGone.open)))
              : send,
        ),
        w.run(
          (db) =>
            db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
              ...c.state,
              team1: {
                ...c.state.team1,
                lines: [...c.state.team1.lines, { lid: "z", text: "z", copy: "c0" }],
              },
            })),
          (command, _input, send) =>
            command === "transactWriteItems" ? rootGone.wait.pipe(Effect.andThen(send)) : send,
        ),
      ])
      expect(Exit.isSuccess(deleted)).toBe(true)
      expect(
        Exit.isFailure(updated) && (await w.rows()).length === 0,
        `update ${exitName(updated)}, ${(await w.rows()).length} row(s) left`,
      ).toBe(true)
    })
  })

  describe("Issue #168: ownsRows cleanup deletes by entity type, not by what it read", () => {
    // An order whose lines sub-aggregate keeps only the lines not noted "hidden": a hidden line is a
    // row its decomposition never writes, which `ownsRows` takes for the aggregate's own and removes
    // when the lines change (DESIGN.md "Which rows in its partition are an aggregate's").
    const OrderLine = Schema.Struct({ lid: Schema.String, note: Schema.String })
    const SubModel = Schema.Struct({ lines: Schema.Array(OrderLine) })
    const Sub = Aggregate.make(SubModel, {
      root: { entityType: "Sub" },
      edges: {
        lines: Aggregate.many({
          entityType: "OrderLine",
          sk: { composite: ["lid"] },
          assemble: (lines) =>
            (lines as ReadonlyArray<typeof OrderLine.Type>).filter(
              (line) => line.note !== "hidden",
            ),
          decompose: (lines) => lines as ReadonlyArray<unknown>,
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

    it("update: another writer makes the hidden line visible between the read and the cleanup; the cleanup deletes the row it just wrote", async () => {
      const w = await makeWorld(Orders)
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
      const hidden = (await w.rowAt("#h"))!
      const unhide = () =>
        w.client.updateItem({
          TableName: w.tableName,
          Key: { pk: hidden.pk!, sk: hidden.sk! },
          UpdateExpression: "SET #n = :shown",
          ExpressionAttributeNames: { "#n": "note" },
          ExpressionAttributeValues: { ":shown": { S: "shown" } },
        } as never)
      const exit = await w.run(
        (db) =>
          db.aggregates.Matches.update({ id: "m1" }, (c: any) => ({
            ...c.state,
            sub: { lines: c.state.sub.lines.map((l: any) => ({ ...l, note: `${l.note}!` })) },
          })),
        afterFirstRead(unhide),
      )
      // The row the other writer made visible is still there, or the update was refused.
      const kept = (await w.rowAt("#h")) !== undefined
      expect(
        Exit.isFailure(exit) || kept,
        `update ${exitName(exit)}, row h ${kept ? "kept" : "deleted"}`,
      ).toBe(true)
    })
  })

  describe("Issue #168: controls, the same checks without an interleaving", () => {
    it("two updates one after the other keep both changes; a lone update leaves one writer's tags; a delete leaves no rows", async () => {
      const w = await makeWorld(Matches)
      await w.create()
      const set = (field: "status" | "note", value: string) => (c: any) => ({
        ...c.state,
        [field]: value,
      })
      w.ok(await w.run((db) => db.aggregates.Matches.update({ id: "m1" }, set("status", "A:live"))))
      w.ok(await w.run((db) => db.aggregates.Matches.update({ id: "m1" }, set("note", "B:note"))))
      const stored = await w.get()
      expect([stored.status, stored.note]).toEqual(["A:live", "B:note"])
      w.ok(
        await w.run((db) =>
          db.aggregates.Matches.update({ id: "m1" }, (c: any) => tagged(c.state, "A")),
        ),
      )
      expect(storedTags(await w.rows())).toEqual(["A"])
      w.ok(await w.run((db) => db.aggregates.Matches.delete({ id: "m1" })))
      expect((await w.rows()).length).toBe(0)
    })
  })
}
