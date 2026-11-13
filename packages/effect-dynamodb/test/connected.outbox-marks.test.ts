/**
 * Outbox items' marks on DynamoDB Local (#237), against what the published 1.40.0 did on DynamoDB
 * Local (`helpers/OutboxScenarios.ts`, `fixtures/outbox-mark-names-1.40.0.json`,
 * `fixtures/outbox-rolling-1.40.0.json`):
 *
 * - Where `__edd_rm__` is a key attribute where a read model's outbox items are written, this
 *   release sends, stores and delivers exactly what 1.40.0 did.
 * - The items this release writes (marks, items beside another's) are the ones 1.40.0's drainers
 *   were given and delivered, and this release's drainer sends the requests 1.40.0's did.
 * - Two projections of one read model at one revision: the second's item beside the first's,
 *   from DynamoDB's own cancellation reasons; one held beside too is refused (`EDD-9145`) with
 *   nothing written; an item without a mark of the same event is replaced (the `sameEvent`
 *   condition, as DynamoDB parses it).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { markOf } from "./helpers/OutboxMarks.js"
import {
  definitions,
  layoutOf,
  names,
  POSITIONS,
  type Position,
  type Ran,
  type Rolling,
  rolling,
  type Tables,
} from "./helpers/OutboxScenarios.js"

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

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const lib = { DynamoSchema, Table, Entity, EventStore, DynamoClient }
type Stored = Record<string, Record<string, unknown>>
const read = <A>(name: string): A =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as A
const namesFixture = read<
  Record<string, Ran & { readonly items: Readonly<Record<string, ReadonlyArray<Stored>>> }>
>("outbox-mark-names-1.40.0.json")
const rollingFixture = read<{
  readonly scenarios: Record<
    Rolling,
    { readonly items: ReadonlyArray<Stored>; readonly drainPending: Ran; readonly drain: Ran }
  >
}>("outbox-rolling-1.40.0.json")

const sorted = (items: ReadonlyArray<Stored>) =>
  items
    .map((item) => Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
const asJson = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A

let made = 0
/** Fresh tables in `position`'s layout, dropped after `use`. */
const withTables = <A>(
  position: Position,
  use: (tables: Tables) => Effect.Effect<A, unknown, any>,
) =>
  Effect.gen(function* () {
    const ddb = yield* DynamoClient
    const stamp = `${Date.now()}-${made++}`
    const tables = { events: `om-e-${stamp}`, read: `om-r-${stamp}`, outbox: `om-o-${stamp}` }
    const layout = layoutOf(position)
    for (const [name, physical] of Object.entries(tables)) {
      const t = layout[name as keyof Tables]
      const attributes = new Set([t.pk, t.sk])
      const global: Array<any> = []
      const local: Array<any> = []
      for (const [index, keys] of Object.entries(t.indexes)) {
        attributes.add(keys.pk).add(keys.sk)
        const entry = {
          IndexName: index,
          KeySchema: [
            { AttributeName: keys.pk, KeyType: "HASH" as const },
            { AttributeName: keys.sk, KeyType: "RANGE" as const },
          ],
          Projection: { ProjectionType: "ALL" as const },
        }
        if (keys.local === true) local.push(entry)
        else global.push(entry)
      }
      yield* ddb.createTable({
        TableName: physical,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [...attributes].map((name) => ({
          AttributeName: name,
          AttributeType: "S" as const,
        })),
        KeySchema: [
          { AttributeName: t.pk, KeyType: "HASH" },
          { AttributeName: t.sk, KeyType: "RANGE" },
        ],
        ...(global.length > 0 && { GlobalSecondaryIndexes: global }),
        ...(local.length > 0 && { LocalSecondaryIndexes: local }),
      })
    }
    return yield* use(tables).pipe(
      Effect.ensuring(
        Effect.forEach(
          Object.values(tables),
          (name) => ddb.deleteTable({ TableName: name }).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )
  })
const scan = (table: string) =>
  Effect.gen(function* () {
    const ddb = yield* DynamoClient
    const page = yield* ddb.scan({ TableName: table, ConsistentRead: true })
    return (page.Items ?? []) as unknown as ReadonlyArray<Stored>
  })

describeConnected("outbox items' marks on DynamoDB Local (#237)", () => {
  for (const position of POSITIONS) {
    for (const projections of [1, 2] as const) {
      for (const escapeKeys of [false, true]) {
        const at = `${position}/${projections}/${escapeKeys ? "on" : "off"}`
        it.effect(`__edd_rm__ a key attribute (${at}): 1.40.0's requests, items and effects`, () =>
          withTables(position, (tables) =>
            Effect.gen(function* () {
              const ran = yield* names(lib, tables, position, { projections, escapeKeys }).run(
                ClientLayer,
              )
              const fixture = namesFixture[at]!
              expect(
                asJson({ sent: ran.sent, delivered: ran.delivered, result: ran.result }),
              ).toEqual(
                asJson({
                  sent: fixture.sent,
                  delivered: fixture.delivered,
                  result: fixture.result,
                }),
              )
              for (const name of ["events", "read", "outbox"] as const) {
                const ledger = (yield* scan(tables[name])).filter((item) =>
                  String((item.__edd_e__ as { S?: string })?.S).startsWith("Ledger"),
                )
                expect(sorted(ledger)).toEqual(fixture.items[name])
              }
            }),
          ).pipe(Effect.provide(ClientLayer)),
        )
      }
    }
  }

  for (const scenario of ["single", "twoProjections", "rowLost"] as const) {
    const fixture = rollingFixture.scenarios[scenario]
    it.effect(`${scenario}: the items 1.40.0's drainers were given, drained as 1.40.0 did`, () =>
      Effect.gen(function* () {
        for (const how of ["drainPending", "drain"] as const) {
          yield* withTables("none", (tables) =>
            Effect.gen(function* () {
              const s = rolling(lib, tables, scenario)
              yield* s.write(ClientLayer)
              expect(sorted(yield* scan(tables.outbox))).toEqual(fixture.items)
              const own = yield* s[how](ClientLayer)
              expect(asJson(own.sent)).toEqual(asJson(fixture[how].sent))
              expect(asJson(own.delivered)).toEqual(asJson(fixture[how].delivered))
              expect(yield* scan(tables.outbox)).toEqual([])
            }),
          )
        }
      }).pipe(Effect.provide(ClientLayer)),
    )
  }

  it.effect("the key beside held too: EDD-9145, from DynamoDB's own reasons, nothing written", () =>
    withTables("none", (tables) =>
      Effect.gen(function* () {
        const d = definitions(lib, "none", { projections: 2 })
        const ddb = yield* DynamoClient
        const program = Effect.gen(function* () {
          yield* d.bind
          const [events] = yield* d.append
          yield* d.projections[0].apply(events![0])
          const [plain] = yield* scan(tables.outbox)
          const mark = markOf(d.Ledgers, plain as never, 1)
          const beside = `${(plain!.osk as { S: string }).S}#${mark}`
          yield* ddb.putItem({
            TableName: tables.outbox,
            Item: {
              ...(plain as any),
              osk: { S: beside },
              obsk: { S: `${(plain!.opk as { S: string }).S}#${beside}` },
              __edd_rm__: { S: "zzz.0" },
            },
          })
          const before = {
            read: sorted(yield* scan(tables.read)),
            outbox: sorted(yield* scan(tables.outbox)),
          }
          const failed = (yield* Effect.flip(
            d.projections[1].apply(events![0]) as Effect.Effect<unknown, unknown>,
          )) as { readonly _tag: string; readonly cause: Error }
          expect(failed._tag).toBe("ValidationError")
          expect(failed.cause.message).toContain("[EDD-9145]")
          expect(failed.cause.message).toContain(JSON.stringify(beside))
          expect(failed.cause.message).toContain('an item of "Ledger#outbox" marked "zzz.0"')
          expect({
            read: sorted(yield* scan(tables.read)),
            outbox: sorted(yield* scan(tables.outbox)),
          }).toEqual(before)
        })
        yield* program.pipe(Effect.provide(d.layer(tables)))
      }),
    ).pipe(Effect.provide(ClientLayer)),
  )

  it.effect("an item without a mark of the same event: replaced, delivered once", () =>
    withTables("none", (tables) =>
      Effect.gen(function* () {
        const d = definitions(lib, "none", { projections: 1 })
        const ddb = yield* DynamoClient
        const program = Effect.gen(function* () {
          yield* d.bind
          const [events] = yield* d.append
          yield* d.projections[0].apply(events![0])
          // As 1.40.0 wrote it: no mark. Then the row is lost, and the event applied again.
          for (const item of yield* scan(tables.outbox)) {
            const { __edd_rm__: _, ...unmarked } = item
            yield* ddb.putItem({ TableName: tables.outbox, Item: unmarked as any })
          }
          for (const row of yield* scan(tables.read)) {
            yield* ddb.deleteItem({
              TableName: tables.read,
              Key: { pk: row.pk as any, sk: row.sk as any },
            })
          }
          yield* d.projections[0].apply(events![0])
          const items = yield* scan(tables.outbox)
          expect(items).toHaveLength(1)
          expect(items[0]!.__edd_rm__).toEqual({ S: markOf(d.Ledgers, items[0] as never) })
          const seen: Array<unknown> = []
          const result = yield* d.projections[0].drainPending((effect: unknown) =>
            Effect.sync(() => void seen.push(effect)),
          )
          expect(result.delivered).toBe(1)
          expect(seen).toEqual([{ total: 2 }])
        })
        yield* program.pipe(Effect.provide(d.layer(tables)))
      }),
    ).pipe(Effect.provide(ClientLayer)),
  )
})
