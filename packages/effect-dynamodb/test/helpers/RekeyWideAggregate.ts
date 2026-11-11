/**
 * An aggregate row too wide to guard whole, with no `updatedAt`: 160 small attributes and a
 * 360,000-byte payload. `rekey` reads it, and an ordinary `Aggregate.update` under the old key text
 * then changes the payload. On 1.39.0 the move's guard named 149 of its attributes and not the
 * payload, so the move put the stale payload at the new key and deleted the updated row, with no
 * conflict. With writes going on the aggregate, nothing of which has moved, is now left as it is,
 * reported `unguarded`, and the update kept; with writes stopped it moves.
 *
 * Run on a recording table (`RekeyWideAggregate.test.ts`) and on DynamoDB Local
 * (`connected.rekey-wide-aggregate.test.ts`).
 */
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"

const fields = Object.fromEntries(
  Array.from({ length: 160 }, (_, i) => [`a${String(i).padStart(3, "0")}`, Schema.String]),
)
const values = Object.fromEntries(Object.keys(fields).map((name) => [name, "x"]))
const Line = Schema.Struct({ ...fields, lid: Schema.String, zzPayload: Schema.String })
const Root = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })

const PAYLOAD = "x".repeat(360_000)
const UPDATED = "y".repeat(360_000)

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "wide213", version: 1, escapeKeys })
  const Main = Table.make({ schema, entities: {} } as never) as any
  const A = (Aggregate.make as any)(Root, {
    schema,
    table: Main,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "roots" },
    root: { entityType: "Root" },
    edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } }) },
  })
  return {
    Main,
    client: DynamoClient.make({ entities: {}, aggregates: { A }, tables: { Main } } as never),
  }
}

type World = ReturnType<typeof world>

const on =
  (w: World, tableName: string, client: DynamoClientService) =>
  <A>(body: (db: any) => Effect.Effect<A, unknown, any>): Effect.Effect<A, unknown> =>
    Effect.gen(function* () {
      const db: any = yield* w.client
      return yield* body(db)
    }).pipe(
      Effect.provide(w.Main.layer({ name: tableName })),
      Effect.provide(Layer.succeed(DynamoClient, client)),
    ) as Effect.Effect<A, unknown>

const WRITES = ["putItem", "deleteItem", "updateItem", "transactWriteItems", "batchWriteItem"]

/**
 * Write the aggregate under one key text, then `rekey` to the other (`toEscaped`) on `client`, a
 * table named `tableName` holding nothing else.
 */
export const wideAggregatePin = (options: {
  readonly client: DynamoClientService
  readonly tableName: string
  readonly toEscaped: boolean
  readonly writesStopped: boolean
}) =>
  Effect.gen(function* () {
    const { client, tableName, toEscaped, writesStopped } = options
    const before = on(world(!toEscaped), tableName, client)
    yield* before((db) =>
      db.aggregates.A.create({
        id: "p q",
        lines: [{ ...values, lid: "leaf", zzPayload: PAYLOAD }],
      }),
    )
    const rows = () =>
      Effect.map(client.scan({ TableName: tableName, ConsistentRead: true }), (page) =>
        (page.Items ?? [])
          .map((row) => ({ pk: row.pk?.S, sk: row.sk?.S, payload: row.zzPayload?.S?.[0] }))
          .sort((a, b) => (`${a.pk}|${a.sk}` < `${b.pk}|${b.sk}` ? -1 : 1)),
      )
    const old = yield* rows()
    const line = old.find((row) => row.payload !== undefined)!

    // With writes going on, an update lands just after rekey reads the aggregate's partition.
    let landed = false
    const sent: Array<string> = []
    const rekeying: DynamoClientService = new Proxy(client, {
      get: (target, property) => {
        const method = Reflect.get(target, property)
        if (typeof method !== "function" || typeof property !== "string") return method
        return (input: any) => {
          sent.push(property)
          const answer = method.call(target, input) as Effect.Effect<any, any>
          if (property !== "query" || writesStopped) return answer
          return Effect.tap(answer, (page: any) =>
            landed || !(page.Items ?? []).some((row: any) => row.zzPayload !== undefined)
              ? Effect.void
              : Effect.suspend(() => {
                  landed = true
                  return before((db) =>
                    db.aggregates.A.update({ id: "p q" }, ({ state }: any) => ({
                      ...state,
                      lines: state.lines.map((l: any) => ({ ...l, zzPayload: UPDATED })),
                    })),
                  )
                }),
          )
        }
      },
    })
    const after = on(world(toEscaped), tableName, rekeying)

    if (!writesStopped) {
      for (const dryRun of [true, false]) {
        sent.length = 0
        const report: any = yield* after((db) => db.tables.Main.rekey({ dryRun }))
        expect(landed).toBe(true)
        expect(report.moved.aggregate).toBe(0)
        expect(report.conflicts).toEqual([
          expect.objectContaining({
            member: "Root",
            kind: "aggregate",
            reason: "unguarded",
            key: { pk: line.pk, sk: line.sk },
          }),
        ])
        // Nothing of the aggregate was written: its rows are where they were, the update kept.
        expect(sent.filter((command) => WRITES.includes(command))).toEqual([])
        expect(yield* rows()).toEqual(
          old.map((row) => (row === line ? { ...row, payload: "y" } : row)),
        )
        const kept: any = yield* before((db) => db.aggregates.A.get({ id: "p q" }))
        expect(kept.lines[0].zzPayload).toBe(UPDATED)
      }
      return
    }

    const report: any = yield* after((db) => db.tables.Main.rekey({ writesStopped: true }))
    expect(report.conflicts).toEqual([])
    expect(report.moved.aggregate).toBe(2)
    const moved = yield* rows()
    expect(moved.map((row) => row.pk)).not.toContain(line.pk)
    expect(moved).toHaveLength(2)
    const found: any = yield* after((db) => db.aggregates.A.get({ id: "p q" }))
    expect(found.lines[0].zzPayload).toBe(PAYLOAD)
    const again: any = yield* after((db) => db.tables.Main.rekey())
    expect(again.moved.aggregate).toBe(0)
    expect(again.conflicts).toEqual([])
  })

export const CASES: ReadonlyArray<
  readonly [name: string, toEscaped: boolean, writesStopped: boolean]
> = [true, false].flatMap((toEscaped) =>
  [false, true].map(
    (writesStopped) =>
      [
        `${toEscaped ? "to on" : "to off"}, ${writesStopped ? "writes stopped: it moves" : "writes going on: left as it is, unguarded, the update kept"}`,
        toEscaped,
        writesStopped,
      ] as const,
  ),
)
