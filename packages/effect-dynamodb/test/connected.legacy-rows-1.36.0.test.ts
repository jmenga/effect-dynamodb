/**
 * #183 rows the published 1.36.0 wrote — connected tests against DynamoDB Local.
 *
 * `fixtures/legacy-rows-1.36.0.json` holds the items `effect-dynamodb@1.36.0`
 * (with `@effect-dynamodb/schema@1.36.0` and `effect@4.0.0`) wrote for the
 * models below, captured ONCE by a scratch script run against the published
 * packages installed outside the repo (never a dependency of this repo). The
 * fixture's `generated` field says the same. Do not regenerate it from this
 * repo: its whole point is that the bytes came from 1.36.0.
 *
 * With `escapeKeys` off, which is the default for all of 1.x, these rows are where every read looks,
 * and `rekey` has nothing to do. With `escapeKeys: true`, `rekey` moves them first: `a%20b`'s rows
 * are at the key `a b`'s belong at, so each has to move out of the other's way. Either way:
 *
 * - **Pending effects.** `a%20b`'s row has effects pending at revisions 2 and 3, on the read table
 *   (with an outbox index) and on an outbox table of its own (without one); `a b`'s row is at
 *   revision 1. `drain(key)` delivers each value its own effects, in order.
 * - **A tombstone.** `r s` was removed with an effect pending: an event that enqueues no effect
 *   writes its row again over the tombstone; `r%20s` starts afresh.
 * - **Retained history.** `a%20b` (at version 5) keeps versions 1–4; `a b` (at version 2) keeps
 *   version 1. Each lists its own versions only.
 * - **`rekey`** moves them there and back to the exact bytes 1.36.0 wrote; a rerun moves nothing.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Models — as the fixture's script declared them
// ---------------------------------------------------------------------------

type Row = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/legacy-rows-1.36.0.json", import.meta.url)),
    "utf8",
  ),
) as { readonly tables: Record<"events" | "read" | "outbox", ReadonlyArray<Row>> }

const tableNames = {
  events: "legacy-fix-events",
  read: "legacy-fix-read",
  outbox: "legacy-fix-outbox",
} as const
let tablesMade = 0

class Opened extends Schema.TaggedClass<Opened>()("Opened", {}) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {}) {}
type AccountEvent = Opened | Added | Closed

const Tally = Schema.Struct({
  shop: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Tally = typeof Tally.Type
const Page = Schema.Struct({ owner: Schema.String, title: Schema.String, body: Schema.String })
const Notice = Schema.Struct({ account: Schema.String, total: Schema.Number })

/** Each account's row. `gone2` is new in these tests: 1.36 never wrote it. */
const ROWS: Record<string, { readonly shop: string; readonly name: string }> = {
  esc: { shop: "s1", name: "a%20b" },
  sp: { shop: "s1", name: "a b" },
  gone: { shop: "s1", name: "r s" },
  gone2: { shop: "s1", name: "r%20s" },
}
const key = (id: { readonly account: string }) => ROWS[id.account]!
const initial = (id: { readonly account: string }): Tally => ({
  ...key(id),
  total: 0,
  version: 0,
  rev: 0,
})
const add = (state: Tally, event: EventStore.StreamEvent<AccountEvent>) =>
  event.data._tag === "Added" ? { ...state, total: state.total + event.data.amount } : state
const effects = (event: EventStore.StreamEvent<AccountEvent>, next: Tally | undefined) =>
  event.data._tag === "Added" ? [{ account: event.streamId, total: next?.total ?? -1 }] : []

const worldOf = (schema: DynamoSchema.DynamoSchema) => {
  const EventsTable = Table.make({ schema, entities: {} })
  const Accounts = EventStore.makeStream({
    table: EventsTable,
    streamName: "Account",
    events: [Opened, Added, Closed],
    streamId: { composite: ["account"] },
  })

  const primaryKey = {
    pk: { field: "pk", composite: ["shop"] },
    sk: { field: "sk", composite: ["name"] },
  } as const
  const Tallies = Entity.make({ model: Tally, entityType: "Tally", primaryKey, timestamps: true })
  const Ledgers = Entity.make({ model: Tally, entityType: "Ledger", primaryKey })
  const Rems = Entity.make({ model: Tally, entityType: "Rem", primaryKey, timestamps: true })
  const Pages = Entity.make({
    model: Page,
    entityType: "Page",
    primaryKey: {
      pk: { field: "pk", composite: ["owner"] },
      sk: { field: "sk", composite: ["title"] },
    },
    versioned: { retain: true },
    softDelete: true,
    timestamps: true,
  })
  const ReadTable = Table.make({ schema, entities: { Tallies, Ledgers, Rems, Pages } })
  const OutboxTable = Table.make({ schema, entities: {} })

  const Notifying = EventStore.projection({
    stream: Accounts,
    readModel: Tallies,
    key,
    initial,
    evolve: (state, event) =>
      Effect.succeed(event.data._tag === "Closed" ? EventStore.removeRow : add(state, event)),
    checkpoint: "version",
    revision: "rev",
    removal: {},
    outbox: { schema: Notice, effects, index: { name: "outbox", pk: "obpk", sk: "obsk" } },
  })
  const Remote = EventStore.projection({
    stream: Accounts,
    readModel: Ledgers,
    key,
    initial,
    evolve: (state, event) => Effect.succeed(add(state, event)),
    checkpoint: "version",
    revision: "rev",
    outbox: { schema: Notice, effects, table: OutboxTable },
  })
  const Removing = EventStore.projection({
    stream: Accounts,
    readModel: Rems,
    key,
    initial,
    evolve: (state, event) =>
      Effect.succeed(event.data._tag === "Closed" ? EventStore.removeRow : add(state, event)),
    checkpoint: "version",
    revision: "rev",
    removal: {},
  })
  return {
    schema,
    EventsTable,
    ReadTable,
    OutboxTable,
    Accounts,
    Tallies,
    Ledgers,
    Rems,
    Pages,
    Notifying,
    Remote,
    Removing,
    db: DynamoClient.make({
      entities: { Tallies, Ledgers, Rems, Pages },
      tables: { ReadTable, OutboxTable },
    }),
  }
}
type World = ReturnType<typeof worldOf>

const Off = worldOf(DynamoSchema.make({ name: "legacy-fix", version: 1, escapeKeys: false }))
const On = worldOf(DynamoSchema.make({ name: "legacy-fix", version: 1, escapeKeys: true }))

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

type Names = { readonly events: string; readonly read: string; readonly outbox: string }

/** `entity`'s row key for `account` under `w`'s setting. */
const keysOf = (w: World, entity: "Tallies" | "Ledgers" | "Rems", account: string) =>
  KeyComposer.composeIndexKeys(
    w.schema,
    w[entity].entityType,
    1,
    w[entity].indexes.primary,
    ROWS[account]!,
  ) as Record<string, string>
const at = (keys: Record<string, string | undefined>, rest = "") => `${keys.pk}|${keys.sk}${rest}`

/** Every item of `tableName`, unmarshalled. */
const items = (tableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const out: Array<Record<string, unknown>> = []
    let start: Row | undefined
    do {
      const page = yield* client.scan({
        TableName: tableName,
        ConsistentRead: true,
        ...(start !== undefined && { ExclusiveStartKey: start }),
      })
      for (const item of page.Items ?? []) out.push(fromAttributeMap(item))
      start = page.LastEvaluatedKey
    } while (start !== undefined)
    return out
  })

/** Where the rows of `type` are, by key. */
const placed = (tableName: string, type: string) =>
  Effect.map(items(tableName), (all) =>
    all
      .filter((item) => item.__edd_e__ === type)
      .map((item) => `${item.pk}|${item.sk}`)
      .sort(),
  )

const append = (w: World, account: string, events: ReadonlyArray<AccountEvent>, expected: number) =>
  Effect.gen(function* () {
    yield* w.Accounts.append({ account }, events, expected)
    return (yield* w.Accounts.read({ account })).slice(expected)
  })

const collect = () => {
  const delivered: Array<string> = []
  const deliver = (effect: typeof Notice.Type) =>
    Effect.sync(() => void delivered.push(`${effect.account}:${effect.total}`))
  return { delivered, deliver }
}

/** A page's versions, as `body@version`, in version order. */
const versionsOf = (w: World, title: string) =>
  Effect.gen(function* () {
    const db = yield* w.db
    const pages = yield* db.entities.Pages.versions({ owner: "o", title }).collect()
    return pages
      .map((page) => {
        // Each snapshot's version, decoded with it.
        const { version } = page as typeof page & { readonly version: number }
        return { entry: `${page.body}@${version}`, version }
      })
      .sort((a, b) => a.version - b.version)
      .map(({ entry }) => entry)
  })

const rekeyAll = (w: World, options?: { readonly dryRun?: boolean }) =>
  Effect.gen(function* () {
    const db = yield* w.db
    const read: Table.RekeyReport = yield* db.tables.ReadTable.rekey(options)
    const outbox: Table.RekeyReport = yield* db.tables.OutboxTable.rekey(options)
    return { read, outbox }
  })

const KeySchema = [
  { AttributeName: "pk", KeyType: "HASH" as const },
  { AttributeName: "sk", KeyType: "RANGE" as const },
]
const AttributeDefinitions = [
  { AttributeName: "pk", AttributeType: "S" as const },
  { AttributeName: "sk", AttributeType: "S" as const },
]

/**
 * Run `body` over fresh tables holding the items as 1.36.0 wrote them, with both settings' members.
 */
const onFixture = <A, E>(body: (names: Names) => Effect.Effect<A, E, any>) => {
  const n = tablesMade++
  const names: Names = {
    events: `${tableNames.events}-${Date.now()}-${n}`,
    read: `${tableNames.read}-${Date.now()}-${n}`,
    outbox: `${tableNames.outbox}-${Date.now()}-${n}`,
  }
  const make = Effect.gen(function* () {
    const client = yield* DynamoClient
    for (const TableName of [names.events, names.outbox]) {
      yield* client.createTable({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema,
        AttributeDefinitions,
      })
    }
    yield* client.createTable({
      TableName: names.read,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema,
      AttributeDefinitions: [
        ...AttributeDefinitions,
        { AttributeName: "obpk", AttributeType: "S" },
        { AttributeName: "obsk", AttributeType: "S" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "outbox",
          KeySchema: [
            { AttributeName: "obpk", KeyType: "HASH" },
            { AttributeName: "obsk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    })
    for (const [role, TableName] of Object.entries(names)) {
      for (const Item of fixture.tables[role as keyof Names]) {
        yield* client.putItem({ TableName, Item })
      }
    }
  })
  const drop = Effect.gen(function* () {
    const client = yield* DynamoClient
    for (const TableName of Object.values(names)) yield* client.deleteTable({ TableName })
  }).pipe(Effect.ignore)
  return Effect.acquireUseRelease(
    make,
    () => body(names),
    () => drop,
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ClientLayer,
        ...[Off, On].flatMap((w) => [
          w.EventsTable.layer({ name: names.events }),
          w.ReadTable.layer({ name: names.read }),
          w.OutboxTable.layer({ name: names.outbox }),
        ]),
      ),
    ),
  ) as Effect.Effect<A, unknown>
}

/** What has to happen before `w` reads these rows. */
const SETTINGS: ReadonlyArray<readonly [string, World, Effect.Effect<unknown, unknown, any>]> = [
  ["the flag off: nothing to do", Off, Effect.void],
  ["the flag on, after rekey", On, rekeyAll(On)],
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected.each(SETTINGS)("#183 rows 1.36.0 wrote, %s", (_setting, w, prepare) => {
  it.live("each value's effects are its own, and each drain delivers its own in order", () =>
    onFixture((names) =>
      Effect.gen(function* () {
        yield* prepare
        const escaped = keysOf(w, "Tallies", "esc")
        const spaced = keysOf(w, "Tallies", "sp")
        for (const event of yield* append(
          w,
          "sp",
          [new Added({ amount: 5 }), new Added({ amount: 7 })],
          2,
        )) {
          yield* w.Notifying.apply(event)
          yield* w.Remote.apply(event)
        }
        for (const event of yield* append(w, "esc", [new Added({ amount: 1 })], 3)) {
          yield* w.Notifying.apply(event)
          yield* w.Remote.apply(event)
        }

        const db = yield* w.db
        const rowOf = (entity: "Tallies" | "Ledgers", account: string) =>
          Effect.map(db.entities[entity].get(ROWS[account]!).asEffect(), (found) => ({
            total: found.total,
            rev: found.rev,
          }))
        expect(yield* rowOf("Tallies", "sp")).toEqual({ total: 22, rev: 3 })
        expect(yield* rowOf("Tallies", "esc")).toEqual({ total: 6, rev: 4 })
        expect(yield* rowOf("Ledgers", "sp")).toEqual({ total: 22, rev: 3 })
        expect(yield* rowOf("Ledgers", "esc")).toEqual({ total: 6, rev: 4 })
        expect(yield* placed(names.read, "Tally#outbox")).toEqual(
          [
            at(spaced, "#outbox#000000000002#0000"),
            at(spaced, "#outbox#000000000003#0000"),
            at(escaped, "#outbox#000000000002#0000"),
            at(escaped, "#outbox#000000000003#0000"),
            at(escaped, "#outbox#000000000004#0000"),
            at(keysOf(w, "Tallies", "gone"), "#outbox#000000000001#0000"),
          ].sort(),
        )
        const ledgerEscaped = keysOf(w, "Ledgers", "esc")
        const ledgerSpaced = keysOf(w, "Ledgers", "sp")
        expect(yield* placed(names.outbox, "Ledger#outbox")).toEqual(
          [
            at(ledgerSpaced, "#outbox#000000000002#0000"),
            at(ledgerSpaced, "#outbox#000000000003#0000"),
            at(ledgerEscaped, "#outbox#000000000002#0000"),
            at(ledgerEscaped, "#outbox#000000000003#0000"),
            at(ledgerEscaped, "#outbox#000000000004#0000"),
          ].sort(),
        )

        for (const projection of [w.Notifying, w.Remote]) {
          const spDrain = collect()
          yield* projection.drain(ROWS.sp!, spDrain.deliver)
          expect(spDrain.delivered).toEqual(["sp:15", "sp:22"])
          const escDrain = collect()
          yield* projection.drain(ROWS.esc!, escDrain.deliver)
          expect(escDrain.delivered).toEqual(["esc:2", "esc:5", "esc:6"])
        }
        expect(yield* placed(names.outbox, "Ledger#outbox")).toEqual([])
      }),
    ),
  )

  it.live(
    "an event with no effect writes `r s`'s row again over its tombstone; `r%20s` starts afresh",
    () =>
      onFixture((names) =>
        Effect.gen(function* () {
          yield* prepare
          const gone = keysOf(w, "Tallies", "gone")
          expect(yield* placed(names.read, "Tally#tombstone")).toEqual([at(gone)])
          const [reopened] = yield* append(w, "gone", [new Opened()], 3)
          const result = yield* w.Notifying.apply(reopened!)
          expect(result.applied.map((event) => event.version)).toEqual([4])
          expect(Option.getOrThrow(result.state)).toMatchObject({ total: 0, version: 4, rev: 2 })
          const removing = yield* w.Removing.apply(reopened!)
          expect(Option.getOrThrow(removing.state)).toMatchObject({ total: 0, version: 4, rev: 2 })
          expect(yield* placed(names.read, "Tally#tombstone")).toEqual([])
          expect(yield* placed(names.read, "Rem#tombstone")).toEqual([])
          // The effect 1.36 left pending is still delivered, once.
          const { delivered, deliver } = collect()
          yield* w.Notifying.drain(ROWS.gone!, deliver)
          expect(delivered).toEqual(["gone:3"])

          const fresh = yield* append(w, "gone2", [new Opened(), new Added({ amount: 5 })], 0)
          expect((yield* w.Notifying.applyBatch(fresh)).outcomes.map((o) => o._tag)).toEqual([
            "Applied",
          ])
          expect((yield* w.Removing.applyBatch(fresh)).outcomes.map((o) => o._tag)).toEqual([
            "Applied",
          ])
          for (const [entity, type] of [
            ["Tallies", "Tally"],
            ["Rems", "Rem"],
          ] as const) {
            const both = [keysOf(w, entity, "gone"), keysOf(w, entity, "gone2")]
            expect(
              (yield* placed(names.read, type)).filter((row) => row.includes("#name_r")),
            ).toEqual(both.map((keys) => at(keys)).sort())
          }
          const again = collect()
          yield* w.Notifying.drain(ROWS.gone2!, again.deliver)
          expect(again.delivered).toEqual(["gone2:5"])
        }),
      ),
  )

  it.live("`a b` and `a%20b` each list and keep their own retained versions", () =>
    onFixture(() =>
      Effect.gen(function* () {
        yield* prepare
        const db = yield* w.db
        const escaped = ["esc v1@1", "esc v2@2", "esc v3@3", "esc v4@4"]
        expect(yield* versionsOf(w, "a b")).toEqual(["sp v1@1"])
        expect(yield* versionsOf(w, "a%20b")).toEqual(escaped)

        const page = { owner: "o", title: "a b" }
        /** The version a write returned the page at. */
        const versionOf = (written: object) => (written as { readonly version?: number }).version
        const put = yield* db.entities.Pages.put({ ...page, body: "sp v3" }).asEffect()
        expect(versionOf(put)).toBe(3)
        const updated = yield* db.entities.Pages.update(page).set({ body: "sp v4" }).asEffect()
        expect(versionOf(updated)).toBe(4)
        yield* db.entities.Pages.delete(page).asEffect()
        const restored = yield* db.entities.Pages.restore(page)
        expect(restored.body).toBe("sp v4")

        const own = yield* versionsOf(w, "a b")
        expect(own.slice(0, 4)).toEqual(["sp v1@1", "sp v2@2", "sp v3@3", "sp v4@4"])
        expect(own.every((entry) => entry.startsWith("sp "))).toBe(true)
        expect(yield* versionsOf(w, "a%20b")).toEqual(escaped)
        const current = yield* db.entities.Pages.get({ owner: "o", title: "a%20b" }).asEffect()
        expect(current).toMatchObject({ body: "esc v5", version: 5 })
      }),
    ),
  )
})

describeConnected("#183 rekey over the rows 1.36.0 wrote", () => {
  const rowsOf = (names: Names) =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      const all: Record<string, ReadonlyArray<Row>> = {}
      for (const [role, TableName] of Object.entries(names)) {
        const { Items = [] } = yield* client.scan({ TableName, ConsistentRead: true })
        all[role] = Items as ReadonlyArray<Row>
      }
      return all
    })
  const keysIn = (rows: ReadonlyArray<Row>) =>
    rows.map((row) => at({ pk: row.pk?.S, sk: row.sk?.S })).sort()

  it.live("with the flag off, they are where it reads: it moves nothing", () =>
    onFixture((names) =>
      Effect.gen(function* () {
        const before = yield* rowsOf(names)
        const { read, outbox } = yield* rekeyAll(Off)
        for (const report of [read, outbox]) {
          expect(report.moved).toEqual(ZERO)
          expect(report.indexKeysRewritten).toBe(0)
          expect(report.conflicts).toEqual([])
          expect(report.skipped.unrecognizedKey).toBe(0)
        }
        const after = yield* rowsOf(names)
        for (const role of Object.keys(names)) {
          expect(keysIn(after[role]!)).toEqual(keysIn(before[role]!))
        }
      }),
    ),
  )

  it.live("with the flag on, every row moves; a dry run agrees, and a rerun moves nothing", () =>
    onFixture(() =>
      Effect.gen(function* () {
        const dry = yield* rekeyAll(On, { dryRun: true })
        const { read, outbox } = yield* rekeyAll(On)
        expect(read.conflicts).toEqual([])
        expect(outbox.conflicts).toEqual([])
        expect(read.skipped.unrecognizedKey).toBe(0)
        expect(read.moved).toEqual(dry.read.moved)
        expect(outbox.moved).toEqual(dry.outbox.moved)
        expect(read.moved).toEqual({ ...ZERO, item: 6, snapshot: 5, tombstone: 2, outbox: 3 })
        const again = yield* rekeyAll(On)
        expect(again.read.moved).toEqual(ZERO)
        expect(again.read.conflicts).toEqual([])
        expect(again.outbox.moved).toEqual(ZERO)
      }),
    ),
  )

  it.live("back with the flag off, every row is at the key 1.36.0 wrote it at", () =>
    onFixture((names) =>
      Effect.gen(function* () {
        yield* rekeyAll(On)
        const { read, outbox } = yield* rekeyAll(Off)
        expect(read.conflicts).toEqual([])
        expect(outbox.conflicts).toEqual([])
        const after = yield* rowsOf(names)
        for (const role of Object.keys(names) as ReadonlyArray<keyof Names>) {
          expect(keysIn(after[role]!)).toEqual(keysIn(fixture.tables[role]))
        }
        for (const row of [...after.read!, ...after.outbox!]) {
          expect(row.__edd_kt__).toBeUndefined()
        }
      }),
    ),
  )
})
