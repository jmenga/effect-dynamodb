/**
 * #171: sort key conditions that stay inside what the caller named — connected
 * tests against DynamoDB Local, where DynamoDB's own byte order of the stored
 * keys is what's under test.
 *
 * - An accessor given every sort key composite matches the complete key with
 *   `=` (E7): `seq: 3` returns neither 3.14 nor 3.5, whose key text extends
 *   3's, on the primary key, a GSI, an isolated collection index and a
 *   clustered one; a bigint of 1e38 returns neither 1.2e38 nor 1.5e38; a name
 *   `a` returns neither `ab` nor `a b`.
 * - `Aggregate.list` applies the same rule to its list sort key.
 * - `.history(key).where()` keeps every bound inside the item's own events,
 *   over negative and fractional orderBy values, beside a sibling item's.
 * - A `NaN` composite fails with a `ValidationError` (`[EDD-9096]`).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
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
// Model
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "pinned-conn", version: 1 })
const tableName = `pinned-conn-${Date.now()}`

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  seq: Schema.Number,
  tag: Schema.String,
  name: Schema.String,
  level: Schema.BigInt,
}) {}

/** One accessor per index shape the complete-key rule applies to. */
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId"] },
    sk: { field: "sk", composite: ["seq"] },
  },
  indexes: {
    byTag: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["sensorId"] },
      sk: { field: "gsi1sk", composite: ["tag", "seq"] },
    },
    feed: {
      name: "gsi2",
      collection: "feed",
      pk: { field: "gsi2pk", composite: ["sensorId"] },
      sk: { field: "gsi2sk", composite: ["seq"] },
    },
    site: {
      name: "gsi3",
      collection: ["site", "feed"],
      type: "clustered",
      pk: { field: "gsi3pk", composite: ["sensorId"] },
      sk: { field: "gsi3sk", composite: ["seq"] },
    },
    byLevel: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["sensorId"] },
      sk: { field: "gsi4sk", composite: ["level"] },
    },
    byName: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["sensorId"] },
      sk: { field: "gsi5sk", composite: ["name"] },
    },
  },
  softDelete: true,
})

class Tick extends Schema.Class<Tick>("Tick")({
  deviceId: Schema.String,
  channel: Schema.String,
  at: Schema.Number,
  v: Schema.Number,
}) {}

const Ticks = Entity.make({
  model: Tick,
  entityType: "Tick",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["channel"] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      deviceId: Schema.String,
      channel: Schema.String,
      at: Schema.Number,
      v: Schema.Number,
    }),
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Readings, Ticks } })

// Aggregates whose list sort key is a number, a string and a bigint. Their
// list partitions share `gsi1` with `Readings.byTag`, under their own names.
class Ledger extends Schema.Class<Ledger>("Ledger")({
  book: Schema.String,
  rate: Schema.Number,
  title: Schema.String,
}) {}
const Ledgers = Aggregate.make(Ledger, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["book", "rate"] },
  collection: { name: "ledger" },
  list: {
    index: "gsi1",
    name: "ledgerlist",
    pk: { field: "gsi1pk", composite: ["book"] },
    sk: { field: "gsi1sk", composite: ["rate"] },
  },
  root: { entityType: "LedgerRoot" },
  edges: {},
})

class Member extends Schema.Class<Member>("Member")({
  team: Schema.String,
  owner: Schema.String,
  title: Schema.String,
}) {}
const Members = Aggregate.make(Member, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["team", "owner"] },
  collection: { name: "member" },
  list: {
    index: "gsi1",
    name: "memberlist",
    pk: { field: "gsi1pk", composite: ["team"] },
    sk: { field: "gsi1sk", composite: ["owner"] },
  },
  root: { entityType: "MemberRoot" },
  edges: {},
})

class Vault extends Schema.Class<Vault>("Vault")({
  bank: Schema.String,
  level: Schema.BigInt,
  title: Schema.String,
}) {}
const Vaults = Aggregate.make(Vault, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["bank", "level"] },
  collection: { name: "vault" },
  list: {
    index: "gsi1",
    name: "vaultlist",
    pk: { field: "gsi1pk", composite: ["bank"] },
    sk: { field: "gsi1sk", composite: ["level"] },
  },
  root: { entityType: "VaultRoot" },
  edges: {},
})

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)

const makeDb = DynamoClient.make({
  entities: { Readings, Ticks },
  aggregates: { Ledgers, Members, Vaults },
  tables: { MainTable },
})

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const SENSOR = "s-1"
/** Seqs whose key text extends 3's or -3's, or sorts beside them. */
const SEQS = [-3.5, -3.14, -3, -0.3, 0.3, 3, 3.14, 3.5, 30, 300]
/** Levels whose `:` form text extends 1e38's: 1.2e38, 1.5e38. */
const LEVELS = [-(10n ** 38n), 10n ** 38n - 1n, 10n ** 38n, 12n * 10n ** 37n, 15n * 10n ** 37n]
const NAMES = ["a", "ab", "a b", "aa", "b"]

const READINGS = SEQS.map(
  (seq, i) =>
    new Reading({
      sensorId: SENSOR,
      seq,
      tag: "t",
      name: NAMES[i % NAMES.length]!,
      level: LEVELS[i % LEVELS.length]!,
    }),
)

/** orderBy values across the numeric key forms, appended in order to two channels. */
const ATS = [-100.5, -10, -3.14, -3.1, -3, -0.5, -1e-7, 0, 1e-7, 0.5, 3, 3.1, 3.14, 10, 10.5]
const CHANNELS = ["a", "b"]

const RATES = [-3.5, -3, 3, 3.5, 30]
const OWNERS = ["alice", "alicex", "alice b", "bob"]

type Bound =
  | { readonly op: "eq" | "lt" | "lte" | "gt" | "gte" | "beginsWith"; readonly a: number }
  | { readonly op: "between"; readonly a: number; readonly b: number }

const holds = (bound: Bound, at: number): boolean => {
  switch (bound.op) {
    case "eq":
    case "beginsWith":
      return at === bound.a
    case "lt":
      return at < bound.a
    case "lte":
      return at <= bound.a
    case "gt":
      return at > bound.a
    case "gte":
      return at >= bound.a
    case "between":
      return at >= bound.a && at <= bound.b
  }
}

describeConnected("#171 sort key conditions stay inside what the caller named — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
        const db = yield* makeDb
        yield* Effect.forEach(READINGS, (reading) => db.entities.Readings.put(reading).asEffect(), {
          concurrency: 8,
        })
        for (const channel of CHANNELS) {
          for (const at of ATS) {
            yield* db.entities.Ticks.append({ deviceId: "d-1", channel, at, v: at }).asEffect()
          }
        }
        for (const rate of RATES) {
          yield* db.aggregates.Ledgers.create({ book: "b-1", rate, title: `rate ${rate}` })
        }
        for (const owner of OWNERS) {
          yield* db.aggregates.Members.create({ team: "t-1", owner, title: owner })
        }
        for (const level of LEVELS) {
          yield* db.aggregates.Vaults.create({ bank: "k-1", level, title: String(level) })
        }
      }).pipe(provide),
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  it.effect("a pinned seq returns only itself on every index shape, forward and reverse", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const accessors = {
        primary: (seq: number) => db.entities.Readings.primary({ sensorId: SENSOR, seq }),
        byTag: (seq: number) => db.entities.Readings.byTag({ sensorId: SENSOR, tag: "t", seq }),
        feed: (seq: number) => db.entities.Readings.feed({ sensorId: SENSOR, seq }),
        site: (seq: number) => db.entities.Readings.site({ sensorId: SENSOR, seq }),
      }
      for (const [name, accessor] of Object.entries(accessors)) {
        for (const seq of [3, -3, 0.3, 30]) {
          const forward = yield* accessor(seq).collect()
          const reverse = yield* accessor(seq).reverse().collect()
          expect(
            forward.map((r) => r.seq),
            `${name} ${seq}`,
          ).toEqual([seq])
          expect(
            reverse.map((r) => r.seq),
            `${name} ${seq} reversed`,
          ).toEqual([seq])
        }
      }
    }).pipe(provide),
  )

  it.effect("a pinned bigint of 1e38 returns neither 1.2e38 nor 1.5e38", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const want = READINGS.filter((r) => r.level === 10n ** 38n).map((r) => r.level)
      for (const reverse of [false, true]) {
        const query = db.entities.Readings.byLevel({ sensorId: SENSOR, level: 10n ** 38n })
        const got = yield* (reverse ? query.reverse() : query).collect()
        expect(got.map((r) => r.level)).toEqual(want)
      }
    }).pipe(provide),
  )

  it.effect('a pinned name "a" returns neither "ab", "aa" nor "a b"', () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const got = yield* db.entities.Readings.byName({ sensorId: SENSOR, name: "a" }).collect()
      expect(got.length).toBeGreaterThan(0)
      expect(new Set(got.map((r) => r.name))).toEqual(new Set(["a"]))
    }).pipe(provide),
  )

  it.effect(".where(beginsWith) on a numeric composite is eq", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      for (const seq of [3, -3]) {
        const got = yield* db.entities.Readings.primary({ sensorId: SENSOR })
          .where((t, { beginsWith }) => beginsWith(t.seq, seq))
          .collect()
        expect(got.map((r) => r.seq)).toEqual([seq])
      }
    }).pipe(provide),
  )

  it.effect("the primary accessor given the channel returns the current row, not its events", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const got = yield* db.entities.Ticks.primary({ deviceId: "d-1", channel: "a" }).collect()
      expect(got.map((t) => `${t.channel}:${t.at}`)).toEqual([`a:${ATS.at(-1)}`])
    }).pipe(provide),
  )

  it.effect(".history() returns negative and fractional orderBy values in numeric order", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      for (const channel of CHANNELS) {
        const forward = yield* db.entities.Ticks.history({ deviceId: "d-1", channel }).collect()
        expect(forward.map((t) => `${t.channel}:${t.at}`)).toEqual(
          ATS.map((at) => `${channel}:${at}`),
        )
        const reverse = yield* db.entities.Ticks.history({ deviceId: "d-1", channel })
          .reverse()
          .collect()
        expect(reverse.map((t) => t.at)).toEqual([...ATS].reverse())
      }
    }).pipe(provide),
  )

  it.effect(".history().where() keeps every operator inside the item's own events", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const operands = [-1000, -10, -3.14, -3.05, -3, -1e-7, 0, 0.5, 3, 3.05, 3.14, 10.5, 1000]
      const bounds: Array<Bound> = []
      for (const a of operands) {
        for (const op of ["eq", "lt", "lte", "gt", "gte", "beginsWith"] as const) {
          bounds.push({ op, a })
        }
      }
      for (const [a, b] of [
        [-3.14, 3],
        [-1000, -3.05],
        [-0.5, 0.5],
        [3.05, 1000],
      ] as const) {
        bounds.push({ op: "between", a, b })
      }
      for (const bound of bounds) {
        const want = ATS.filter((at) => holds(bound, at)).map((at) => `a:${at}`)
        for (const reverse of [false, true]) {
          const query = db.entities.Ticks.history({ deviceId: "d-1", channel: "a" }).where(
            (t, ops) =>
              bound.op === "between"
                ? ops.between(t.at, bound.a, bound.b)
                : ops[bound.op](t.at, bound.a),
          )
          const got = yield* (reverse ? query.reverse() : query).collect()
          expect(
            got.map((t) => `${t.channel}:${t.at}`),
            `${JSON.stringify(bound)}${reverse ? " reversed" : ""}`,
          ).toEqual(reverse ? [...want].reverse() : want)
        }
      }
    }).pipe(provide),
  )

  it.effect("Aggregate.list: a numeric filter of 3 returns neither 3.5 nor 30", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const all = yield* db.aggregates.Ledgers.list({ book: "b-1" })
      expect(all.data.map((l) => l.rate)).toEqual(RATES)
      for (const rate of [3, -3]) {
        const got = yield* db.aggregates.Ledgers.list({ book: "b-1", rate })
        expect(got.data.map((l) => l.rate)).toEqual([rate])
      }
    }).pipe(provide),
  )

  it.effect('Aggregate.list: a string filter "alice" returns neither "alicex" nor "alice b"', () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const got = yield* db.aggregates.Members.list({ team: "t-1", owner: "alice" })
      expect(got.data.map((m) => m.owner)).toEqual(["alice"])
    }).pipe(provide),
  )

  it.effect("Aggregate.list: a bigint filter of 1e38 returns neither 1.2e38 nor 1.5e38", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const got = yield* db.aggregates.Vaults.list({ bank: "k-1", level: 10n ** 38n })
      expect(got.data.map((v) => v.level)).toEqual([10n ** 38n])
    }).pipe(provide),
  )

  it.effect("[EDD-9096] get, upsert and restore of a NaN key fail with ValidationError", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { sensorId: SENSOR, seq: Number.NaN }
      const reading = { ...key, tag: "t", name: "n", level: 1n }
      const failures = [
        yield* Effect.flip(db.entities.Readings.get(key).asEffect()),
        yield* Effect.flip(db.entities.Readings.upsert(reading).asEffect()),
        yield* Effect.flip(db.entities.Readings.restore(key)),
      ]
      for (const error of failures) {
        expect(error._tag).toBe("ValidationError")
        expect(String((error as { readonly cause: unknown }).cause)).toContain("[EDD-9096]")
      }
    }).pipe(provide),
  )
})
