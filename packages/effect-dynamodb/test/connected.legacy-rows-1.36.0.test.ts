/**
 * #171 rows the published 1.36.0 wrote, at keys two values share — connected
 * tests against DynamoDB Local.
 *
 * `fixtures/legacy-rows-1.36.0.json` holds the items `effect-dynamodb@1.36.0`
 * (with `@effect-dynamodb/schema@1.36.0` and `effect@4.0.0`) wrote for the
 * models below, captured ONCE by a scratch script run against the published
 * packages installed outside the repo (never a dependency of this repo). The
 * fixture's `generated` field says the same. Do not regenerate it from this
 * repo: its whole point is that the bytes came from 1.36.0.
 *
 * 1.37 escapes the space in a sort key value, so `a%20b`'s 1.36 key text is
 * `a b`'s current key text. What 1.36 left there:
 *
 * - **Pending effects.** `a%20b`'s row has effects pending at revisions 2 and
 *   3 — on the read table (with an outbox index) and on an outbox table of
 *   its own (without one) — under `a b`'s current key; `a b`'s row, at
 *   revision 1, under its 1.36 key. `a b`'s next effects (revisions 2 and 3)
 *   move `a%20b`'s out of their way, and `drain(key)` delivers each value its
 *   own effects, in order.
 * - **A tombstone.** `r s` was removed with an effect pending: an event that
 *   enqueues no effect writes its row again, and leaves no tombstone at
 *   `r%20s`'s 1.36 key; `r%20s` starts afresh.
 * - **Retained history.** `a%20b` (at version 5) keeps versions 1–4 under
 *   `a b`'s current history prefix; `a b` (at version 2) keeps version 1
 *   under its 1.36 one. Each lists its own versions only, and `a b`'s writes
 *   move `a%20b`'s snapshots out of their way.
 * - **`rekey`** moves what is left without a conflict; a rerun moves nothing.
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
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
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

const AppSchema = DynamoSchema.make({ name: "legacy-fix", version: 1 })
const suffix = Date.now()
const tableNames = {
  events: `legacy-fix-events-${suffix}`,
  read: `legacy-fix-read-${suffix}`,
  outbox: `legacy-fix-outbox-${suffix}`,
} as const

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

const EventsTable = Table.make({ schema: AppSchema, entities: {} })
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
const ReadTable = Table.make({ schema: AppSchema, entities: { Tallies, Ledgers, Rems, Pages } })
const OutboxTable = Table.make({ schema: AppSchema, entities: {} })

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

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(
  ClientLayer,
  EventsTable.layer({ name: tableNames.events }),
  ReadTable.layer({ name: tableNames.read }),
  OutboxTable.layer({ name: tableNames.outbox }),
)
const provide = Effect.provide(TestLayer)

const makeDb = DynamoClient.make({
  entities: { Tallies, Ledgers, Rems, Pages },
  tables: { ReadTable, OutboxTable },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

/** `entityType`'s row key for `account` now, and as 1.36 composed it. */
const keysOf = (entity: typeof Tallies | typeof Ledgers | typeof Rems, account: string) => {
  const record = ROWS[account]!
  const primary = entity.indexes.primary
  return {
    current: KeyComposer.composeIndexKeys(
      AppSchema,
      entity.entityType,
      1,
      primary,
      record,
    ) as Record<string, string>,
    old: KeyText136.composeIndexKeys(AppSchema, entity.entityType, 1, primary, record) as Record<
      string,
      string
    >,
  }
}
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

/** Where the rows of `type` are, by key — `KT` when marked as written under their current key. */
const placed = (tableName: string, type: string) =>
  Effect.map(items(tableName), (all) =>
    all
      .filter((item) => item.__edd_e__ === type)
      .map((item) => `${item.pk}|${item.sk}${item.__edd_kt__ === 1 ? " KT" : ""}`)
      .sort(),
  )

const append = (account: string, events: ReadonlyArray<AccountEvent>, expected: number) =>
  Effect.gen(function* () {
    yield* Accounts.append({ account }, events, expected)
    return (yield* Accounts.read({ account })).slice(expected)
  })

const collect = () => {
  const delivered: Array<string> = []
  const deliver = (effect: typeof Notice.Type) =>
    Effect.sync(() => void delivered.push(`${effect.account}:${effect.total}`))
  return { delivered, deliver }
}

/** A page's versions, as `body@version`, in version order (the 1.36 pass is read first, G20). */
const versionsOf = (title: string) =>
  Effect.gen(function* () {
    const db = yield* makeDb
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("#171 rows 1.36.0 wrote at keys two values share — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const KeySchema = [
          { AttributeName: "pk", KeyType: "HASH" as const },
          { AttributeName: "sk", KeyType: "RANGE" as const },
        ]
        const AttributeDefinitions = [
          { AttributeName: "pk", AttributeType: "S" as const },
          { AttributeName: "sk", AttributeType: "S" as const },
        ]
        for (const TableName of [tableNames.events, tableNames.outbox]) {
          yield* client.createTable({
            TableName,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema,
            AttributeDefinitions,
          })
        }
        yield* client.createTable({
          TableName: tableNames.read,
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
        // The items as 1.36.0 wrote them.
        for (const [role, TableName] of Object.entries(tableNames)) {
          for (const Item of fixture.tables[role as keyof typeof tableNames]) {
            yield* client.putItem({ TableName, Item })
          }
        }
      }).pipe(provide),
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of Object.values(tableNames)) {
          yield* client.deleteTable({ TableName })
        }
      }).pipe(
        provide,
        Effect.catch(() => Effect.void),
      ),
    )
  }, 30_000)

  it.live(
    "`a b`'s effects move `a%20b`'s pending ones out of their way, and each drain delivers its own in order",
    () =>
      Effect.gen(function* () {
        const escaped = keysOf(Tallies, "esc")
        const spaced = keysOf(Tallies, "sp")
        // The precondition: `a%20b`'s 1.36 key is `a b`'s current key.
        expect(escaped.old).toEqual(spaced.current)
        expect(yield* placed(tableNames.read, "Tally#outbox")).toContain(
          at(spaced.current, "#outbox#000000000002#0000"),
        )

        for (const event of yield* append(
          "sp",
          [new Added({ amount: 5 }), new Added({ amount: 7 })],
          2,
        )) {
          yield* Notifying.apply(event)
          yield* Remote.apply(event)
        }
        for (const event of yield* append("esc", [new Added({ amount: 1 })], 3)) {
          yield* Notifying.apply(event)
          yield* Remote.apply(event)
        }

        // Each value's row and effects under its own current key, marked.
        const rows = (entity: typeof Tallies | typeof Ledgers, account: string) =>
          Effect.gen(function* () {
            const db = yield* makeDb
            const found = yield* (entity === Tallies ? db.entities.Tallies : db.entities.Ledgers)
              .get(ROWS[account]!)
              .asEffect()
            return { total: found.total, rev: found.rev }
          })
        expect(yield* rows(Tallies, "sp")).toEqual({ total: 22, rev: 3 })
        expect(yield* rows(Tallies, "esc")).toEqual({ total: 6, rev: 4 })
        expect(yield* rows(Ledgers, "sp")).toEqual({ total: 22, rev: 3 })
        expect(yield* rows(Ledgers, "esc")).toEqual({ total: 6, rev: 4 })
        expect(yield* placed(tableNames.read, "Tally#outbox")).toEqual(
          [
            at(spaced.current, "#outbox#000000000002#0000 KT"),
            at(spaced.current, "#outbox#000000000003#0000 KT"),
            at(escaped.current, "#outbox#000000000002#0000 KT"),
            at(escaped.current, "#outbox#000000000003#0000 KT"),
            at(escaped.current, "#outbox#000000000004#0000 KT"),
            at(keysOf(Tallies, "gone").old, "#outbox#000000000001#0000"),
          ].sort(),
        )
        const ledgerEscaped = keysOf(Ledgers, "esc")
        const ledgerSpaced = keysOf(Ledgers, "sp")
        expect(yield* placed(tableNames.outbox, "Ledger#outbox")).toEqual(
          [
            at(ledgerSpaced.current, "#outbox#000000000002#0000 KT"),
            at(ledgerSpaced.current, "#outbox#000000000003#0000 KT"),
            at(ledgerEscaped.current, "#outbox#000000000002#0000 KT"),
            at(ledgerEscaped.current, "#outbox#000000000003#0000 KT"),
            at(ledgerEscaped.current, "#outbox#000000000004#0000 KT"),
          ].sort(),
        )

        for (const projection of [Notifying, Remote]) {
          const spDrain = collect()
          yield* projection.drain(ROWS.sp!, spDrain.deliver)
          expect(spDrain.delivered).toEqual(["sp:15", "sp:22"])
          const escDrain = collect()
          yield* projection.drain(ROWS.esc!, escDrain.deliver)
          expect(escDrain.delivered).toEqual(["esc:2", "esc:5", "esc:6"])
        }
        expect(yield* placed(tableNames.outbox, "Ledger#outbox")).toEqual([])
      }).pipe(provide),
  )

  it.live(
    "an event with no effect writes `r s`'s row again over its 1.36 tombstone; `r%20s` starts afresh",
    () =>
      Effect.gen(function* () {
        const gone = keysOf(Tallies, "gone")
        expect(yield* placed(tableNames.read, "Tally#tombstone")).toEqual([at(gone.old)])
        const [reopened] = yield* append("gone", [new Opened()], 3)
        const result = yield* Notifying.apply(reopened!)
        expect(result.applied.map((event) => event.version)).toEqual([4])
        expect(Option.getOrThrow(result.state)).toMatchObject({ total: 0, version: 4, rev: 2 })
        const removing = yield* Removing.apply(reopened!)
        expect(Option.getOrThrow(removing.state)).toMatchObject({ total: 0, version: 4, rev: 2 })
        // No tombstone is left — none at `r%20s`'s 1.36 key, which is `r s`'s current key.
        expect(yield* placed(tableNames.read, "Tally#tombstone")).toEqual([])
        expect(yield* placed(tableNames.read, "Rem#tombstone")).toEqual([])
        // The effect 1.36 left pending is still delivered, once.
        const { delivered, deliver } = collect()
        yield* Notifying.drain(ROWS.gone!, deliver)
        expect(delivered).toEqual(["gone:3"])

        const fresh = yield* append("gone2", [new Opened(), new Added({ amount: 5 })], 0)
        expect((yield* Notifying.applyBatch(fresh)).outcomes.map((o) => o._tag)).toEqual([
          "Applied",
        ])
        expect((yield* Removing.applyBatch(fresh)).outcomes.map((o) => o._tag)).toEqual(["Applied"])
        for (const [entity, type] of [
          [Tallies, "Tally"],
          [Rems, "Rem"],
        ] as const) {
          const both = [keysOf(entity, "gone").current, keysOf(entity, "gone2").current]
          expect(
            (yield* placed(tableNames.read, type)).filter((row) => row.includes("#name_r")),
          ).toEqual(both.map((keys) => at(keys)).sort())
        }
        const again = collect()
        yield* Notifying.drain(ROWS.gone2!, again.deliver)
        expect(again.delivered).toEqual(["gone2:5"])
      }).pipe(provide),
  )

  it.effect("`a b` and `a%20b` each list and keep their own retained versions", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const escaped = ["esc v1@1", "esc v2@2", "esc v3@3", "esc v4@4"]
      expect(yield* versionsOf("a b")).toEqual(["sp v1@1"])
      expect(yield* versionsOf("a%20b")).toEqual(escaped)

      // Each write of `a b` snapshots a version whose key under `a b`'s
      // current prefix holds `a%20b`'s 1.36 snapshot: it moves first.
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

      const own = yield* versionsOf("a b")
      expect(own.slice(0, 4)).toEqual(["sp v1@1", "sp v2@2", "sp v3@3", "sp v4@4"])
      expect(own.every((entry) => entry.startsWith("sp "))).toBe(true)
      expect(yield* versionsOf("a%20b")).toEqual(escaped)
      const current = yield* db.entities.Pages.get({ owner: "o", title: "a%20b" }).asEffect()
      expect(current).toMatchObject({ body: "esc v5", version: 5 })
    }).pipe(provide),
  )

  it.effect("rekey moves what is left without a conflict; a rerun moves nothing", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const report = yield* db.tables.ReadTable.rekey()
      expect(report.conflicts).toEqual([])
      expect(report.moved.snapshot).toBeGreaterThan(0)
      expect((yield* db.tables.OutboxTable.rekey()).conflicts).toEqual([])
      const again = yield* db.tables.ReadTable.rekey()
      expect(again.moved).toEqual(ZERO)
      expect(again.conflicts).toEqual([])
      expect((yield* db.tables.OutboxTable.rekey()).moved).toEqual(ZERO)
      // Each value's history is its own still.
      const own = yield* versionsOf("a b")
      expect(own.every((entry) => entry.startsWith("sp "))).toBe(true)
      expect(yield* versionsOf("a%20b")).toEqual(["esc v1@1", "esc v2@2", "esc v3@3", "esc v4@4"])
    }).pipe(provide),
  )
})
