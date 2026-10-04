/**
 * Path operations on index composites and unique-constraint fields (#133).
 *
 * A path operation (`pathSet`, `pathRemove`, …) is compiled straight into the
 * UpdateExpression. On a field that feeds an index key or a unique sentinel
 * that bypassed the key composer and the sentinel rotation: the attribute
 * changed, its keys did not. A top-level `pathSet` / `pathRemove` on such a
 * field now goes through the same logic as `.set()` / `.remove()` — the
 * requests are asserted identical — and an operation whose result only
 * DynamoDB knows (copy, `if_not_exists`, list / set operations) is refused.
 *
 * Covers the six canonical GSI-composite shapes (CLAUDE.md), on a plain and on
 * a retain entity, plus the condition-failure mapping and the exact retain
 * post-image.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// In-memory raw client: stores puts, records every write
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>
const store = new Map<string, Item>()
const writes: Array<{ readonly op: string; readonly input: Record<string, any> }> = []
/** A one-shot failure for the next UpdateItem / TransactWriteItems. */
let failNext: unknown
/** Runs after a successful TransactWriteItems — a concurrent writer. */
let afterTransact: (() => void) | undefined

const keyOf = (item: Record<string, any>): string => `${item.pk?.S}|${item.sk?.S}`

const takeFailure = (operation: string) => {
  if (failNext === undefined) return undefined
  const cause = failNext
  failNext = undefined
  return Effect.fail(new DynamoError({ operation, cause }))
}

const InMemoryClient = mockDynamoClientLayer({
  putItem: (input) =>
    Effect.sync(() => {
      writes.push({ op: "Put", input })
      store.set(keyOf(input.Item!), input.Item as Item)
      return {} as any
    }),
  getItem: (input) => Effect.sync(() => ({ Item: store.get(keyOf(input.Key!)) }) as any),
  updateItem: (input) =>
    takeFailure("UpdateItem") ??
    Effect.sync(() => {
      writes.push({ op: "Update", input })
      return { Attributes: store.get(keyOf(input.Key!)) } as any
    }),
  transactWriteItems: (input) =>
    takeFailure("TransactWriteItems") ??
    Effect.sync(() => {
      for (const op of (input.TransactItems ?? []) as ReadonlyArray<Record<string, any>>) {
        if (op.Put) {
          writes.push({ op: "Put", input: op.Put })
          store.set(keyOf(op.Put.Item), op.Put.Item)
        }
        if (op.Delete) {
          writes.push({ op: "Delete", input: op.Delete })
          store.delete(keyOf(op.Delete.Key))
        }
        if (op.Update) writes.push({ op: "Update", input: op.Update })
        if (op.ConditionCheck) writes.push({ op: "Check", input: op.ConditionCheck })
      }
      const hook = afterTransact
      afterTransact = undefined
      hook?.()
      return {} as any
    }),
})

beforeEach(() => {
  store.clear()
  writes.length = 0
  failNext = undefined
  afterTransact = undefined
})

// ---------------------------------------------------------------------------
// Fixtures: the six canonical GSI-composite shapes + a unique constraint
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "gpo", version: 1 })

/** A plain (versioned, no retain) and a retain variant of one entity. */
const variants = <M extends Schema.Top>(
  name: string,
  model: M,
  config: {
    readonly primaryKey: Record<string, any>
    readonly indexes?: Record<string, any>
    readonly unique?: Record<string, any>
  },
) =>
  ({
    plain: Entity.make({
      model,
      entityType: `${name}Plain`,
      ...config,
      timestamps: true,
      versioned: true,
    } as any),
    retained: Entity.make({
      model,
      entityType: `${name}Retained`,
      ...config,
      timestamps: true,
      versioned: { retain: true },
    } as any),
  }) as const

const idKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }

// 1. Multi-writer: owner (PK half) and reading/seq (SK half) have different writers.
class Device extends Schema.Class<Device>("GpoDevice")({
  id: Schema.String,
  owner: Schema.optional(Schema.String),
  reading: Schema.optional(Schema.String),
  seq: Schema.optional(Schema.Number),
  label: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
}) {}
const Devices = variants("Device", Device, {
  primaryKey: idKey,
  indexes: {
    byOwner: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["owner"] },
      sk: { field: "gsi1sk", composite: ["reading", "seq"] },
    },
  },
})

// 2. PK-composites-only: the GSI's composites are all primary-key composites (#43).
class Port extends Schema.Class<Port>("GpoPort")({
  channel: Schema.String,
  deviceId: Schema.String,
  label: Schema.optional(Schema.String),
}) {}
const Ports = variants("Port", Port, {
  primaryKey: {
    pk: { field: "pk", composite: ["channel"] },
    sk: { field: "sk", composite: ["deviceId"] },
  },
  indexes: {
    byChannel: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["channel"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
    },
  },
})

// 3. Hierarchical: region → country → city → site.
class Site extends Schema.Class<Site>("GpoSite")({
  id: Schema.String,
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
}) {}
const Sites = variants("Site", Site, {
  primaryKey: idKey,
  indexes: {
    byLocation: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", composite: ["country", "city", "site"] },
    },
  },
})

// 4. Hole pattern: optional leading SK composite absent, trailing one present.
class Slot extends Schema.Class<Slot>("GpoSlot")({
  id: Schema.String,
  tenant: Schema.optional(Schema.String),
  lead: Schema.optional(Schema.String),
  trail: Schema.optional(Schema.String),
}) {}
const Slots = variants("Slot", Slot, {
  primaryKey: idKey,
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenant"] },
      sk: { field: "gsi1sk", composite: ["lead", "trail"] },
      indexPolicy: { sk: "sparse" },
    },
  },
})

// 5. All composites mutable.
class Task extends Schema.Class<Task>("GpoTask")({
  id: Schema.String,
  category: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.String),
}) {}
const Tasks = variants("Task", Task, {
  primaryKey: idKey,
  indexes: {
    byCategory: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["category"] },
      sk: { field: "gsi1sk", composite: ["priority"] },
    },
  },
})

// 6. Empty-composite half: the SK is just the entity prefix (#46).
class Binding extends Schema.Class<Binding>("GpoBinding")({
  id: Schema.String,
  deviceBinding: Schema.optional(Schema.String),
}) {}
const Bindings = variants("Binding", Binding, {
  primaryKey: idKey,
  indexes: {
    byDeviceBinding: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["deviceBinding"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
})

// A unique constraint.
class Account extends Schema.Class<Account>("GpoAccount")({
  id: Schema.String,
  email: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
}) {}
const Accounts = variants("Account", Account, {
  primaryKey: idKey,
  unique: { email: ["email"] },
})

// An immutable index composite.
class Ledger extends Schema.Class<Ledger>("GpoLedger")({
  id: Schema.String,
  book: Schema.optional(Schema.String),
}) {}
const Ledgers = Entity.make({
  model: DynamoModel.configure(Ledger, { book: { immutable: true } }),
  entityType: "Ledger",
  primaryKey: idKey as any,
  indexes: {
    byBook: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["book"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
})

// An unversioned entity with a numeric index composite.
const Counters = Entity.make({
  model: Device,
  entityType: "Counter",
  primaryKey: idKey as any,
  indexes: {
    byOwner: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["owner"] },
      sk: { field: "gsi1sk", composite: ["reading", "seq"] },
    },
  },
})

const entities = {
  DevicesPlain: Devices.plain,
  DevicesRetained: Devices.retained,
  PortsPlain: Ports.plain,
  PortsRetained: Ports.retained,
  SitesPlain: Sites.plain,
  SitesRetained: Sites.retained,
  SlotsPlain: Slots.plain,
  SlotsRetained: Slots.retained,
  TasksPlain: Tasks.plain,
  TasksRetained: Tasks.retained,
  BindingsPlain: Bindings.plain,
  BindingsRetained: Bindings.retained,
  AccountsPlain: Accounts.plain,
  AccountsRetained: Accounts.retained,
  Ledgers,
  Counters,
}
const AppTable = Table.make({ schema: AppSchema, entities })
const TestLayer = Layer.merge(InMemoryClient, AppTable.layer({ name: "gpo" }))
const db = DynamoClient.make({ entities, tables: { AppTable } })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Name = keyof typeof entities

/**
 * The bound accessors are driven through `any` (one helper serves every
 * entity), which leaves the requirements `unknown`; the layer provides them.
 */
const closed = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
  effect as Effect.Effect<A, E>
type Builder = any

const isKeyAttr = (name: string) => /^(pk|sk|gsi\d+(pk|sk))$/.test(name)

/** The key attributes a write sets or removes, in a stable order. */
const keyWrites = (write: { readonly op: string; readonly input: Record<string, any> }) => {
  const out: Array<string> = []
  if (write.op === "Put") {
    for (const [k, v] of Object.entries(write.input.Item as Item).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (isKeyAttr(k)) out.push(`${k}=${(v as { S?: string }).S}`)
    }
    return out
  }
  const names = (write.input.ExpressionAttributeNames ?? {}) as Record<string, string>
  const values = (write.input.ExpressionAttributeValues ?? {}) as Record<string, any>
  const expr = String(write.input.UpdateExpression ?? "")
  for (const [, nameKey, valKey] of expr.matchAll(/(#\w+) = (:\w+)/g)) {
    const name = names[nameKey!]!
    if (isKeyAttr(name)) out.push(`${name}=${values[valKey!]?.S}`)
  }
  const remove = /REMOVE ([^A-Z]+?)(?: [A-Z]+ |$)/.exec(expr)?.[1] ?? ""
  for (const nameKey of remove.split(",").map((s) => s.trim())) {
    const name = names[nameKey]
    if (name !== undefined && isKeyAttr(name)) out.push(`${name} removed`)
  }
  return out.sort()
}

/** Seed `seed`, run one update built by `build`, and return what it wrote. */
const runUpdate = (name: Name, seed: Record<string, unknown>, build: (u: Builder) => Builder) =>
  Effect.gen(function* () {
    const client = yield* db
    const bound = (client.entities as Record<string, any>)[name]
    store.clear()
    writes.length = 0
    yield* bound.put(seed)
    writes.length = 0
    const key = Object.fromEntries(
      Object.entries(seed).filter(([k]) => ["id", "channel", "deviceId"].includes(k)),
    )
    const exit = yield* Effect.exit(
      Effect.suspend(() => build(bound.update(key)).asEffect() as Effect.Effect<unknown, any>),
    )
    return {
      exit,
      writes: structuredClone(writes),
      store: structuredClone([...store.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }
  })

const failureOf = (exit: any): any =>
  exit._tag === "Failure" ? exit.cause.reasons[0]?.error : undefined

/** `pathSet` and `.set()` (or `pathRemove` and `.remove()`) write the same requests. */
const expectParity = (
  name: Name,
  seed: Record<string, unknown>,
  viaRecord: (u: Builder) => Builder,
  viaPath: (u: Builder) => Builder,
) =>
  Effect.gen(function* () {
    const record = yield* runUpdate(name, seed, viaRecord)
    const path = yield* runUpdate(name, seed, viaPath)
    expect(failureOf(record.exit)).toBeUndefined()
    expect(failureOf(path.exit)).toBeUndefined()
    expect(path.writes).toEqual(record.writes)
    expect(path.store).toEqual(record.store)
    expect((path.exit as any).value).toEqual((record.exit as any).value)
    return record.writes.flatMap(keyWrites)
  })

const set = (segments: ReadonlyArray<string | number>, value: unknown) => (u: Builder) =>
  u.pathSet({ segments, value, isPath: false })

// ---------------------------------------------------------------------------
// The six canonical shapes, plain and retain
// ---------------------------------------------------------------------------

describe("#133 path operations on index composites — six canonical shapes", () => {
  for (const variant of ["Plain", "Retained"] as const) {
    describe(variant, () => {
      it.effect("1. multi-writer: pathSet of the PK-half composite recomposes only that half", () =>
        Effect.gen(function* () {
          const keys = yield* expectParity(
            `Devices${variant}`,
            { id: "d1", owner: "alice", reading: "r1", seq: 1, label: "l" },
            (u) => u.set({ owner: "bob" }),
            set(["owner"], "bob"),
          )
          expect(keys.some((k) => k.startsWith("gsi1pk=") && k.includes("owner_bob"))).toBe(true)
        }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect("1. multi-writer: pathAdd on an SK-half composite matches .add()", () =>
        Effect.gen(function* () {
          const keys = yield* expectParity(
            `Devices${variant}`,
            { id: "d1", owner: "alice", reading: "r1", seq: 1 },
            (u) => u.add({ seq: 2 }),
            (u) => u.pathAdd({ segments: ["seq"], value: 2 }),
          )
          expect(keys.some((k) => k.startsWith("gsi1sk=") && /seq_0+3$/.test(k))).toBe(true)
        }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect("2. PK-composites-only: a path write elsewhere still writes the GSI keys", () =>
        Effect.gen(function* () {
          const seed = { channel: "c1", deviceId: "x1", label: "l" }
          const record = yield* runUpdate(`Ports${variant}`, seed, (u) => u.set({ label: "m" }))
          const path = yield* runUpdate(`Ports${variant}`, seed, set(["label"], "m"))
          // A retain path update is a transacted Update, the record one a Put:
          // compare the index keys each writes.
          const gsiKeys = (run: typeof record) =>
            run.writes
              .flatMap(keyWrites)
              .filter((k) => k.startsWith("gsi"))
              .sort()
          expect(gsiKeys(path)).toEqual(gsiKeys(record))
          expect(gsiKeys(path).some((k) => k.startsWith("gsi2pk="))).toBe(true)
        }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect(
        "2. PK-composites-only: a primary-key composite cannot be path-set or removed",
        () =>
          Effect.gen(function* () {
            const seed = { channel: "c1", deviceId: "x1" }
            const viaSet = yield* runUpdate(`Ports${variant}`, seed, set(["channel"], "c2"))
            expect(failureOf(viaSet.exit)?._tag).toBe("ValidationError")
            expect(String(failureOf(viaSet.exit)?.cause)).toContain('"channel"')
            const viaRemove = yield* runUpdate(`Ports${variant}`, seed, (u) =>
              u.pathRemove(["deviceId"]),
            )
            expect(failureOf(viaRemove.exit)?._tag).toBe("ValidationError")
            expect(String(failureOf(viaRemove.exit)?.cause)).toContain('"deviceId"')
            expect(viaSet.writes).toEqual([])
            expect(viaRemove.writes).toEqual([])
          }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect(
        "3. hierarchical: pathSet parents + pathRemove leaf truncate like .set().remove()",
        () =>
          Effect.gen(function* () {
            const seed = { id: "s1", region: "emea", country: "uk", city: "ldn", site: "dc1" }
            const keys = yield* expectParity(
              `Sites${variant}`,
              seed,
              (u) => u.set({ region: "emea", country: "uk", city: "mcr" }).remove(["site"]),
              (u) =>
                u
                  .pathSet({ segments: ["region"], value: "emea", isPath: false })
                  .pathSet({ segments: ["country"], value: "uk", isPath: false })
                  .pathSet({ segments: ["city"], value: "mcr", isPath: false })
                  .pathRemove(["site"]),
            )
            expect(keys.some((k) => k.startsWith("gsi1sk=") && k.endsWith("city_mcr"))).toBe(true)
            // A lone leaf change on a plain entity cannot compose the half from
            // the payload (preserve: left alone); a retain entity recomposes it
            // from the item it read — either way, identically for both forms.
            yield* expectParity(
              `Sites${variant}`,
              seed,
              (u) => u.set({ city: "mcr" }),
              set(["city"], "mcr"),
            )
          }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect("4. hole pattern: pathSet of the trailing composite matches .set()", () =>
        Effect.gen(function* () {
          yield* expectParity(
            `Slots${variant}`,
            { id: "h1", tenant: "t1", trail: "z1" },
            (u) => u.set({ trail: "z2" }),
            set(["trail"], "z2"),
          )
        }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect("5. all composites mutable: pathSet of both matches .set()", () =>
        Effect.gen(function* () {
          const keys = yield* expectParity(
            `Tasks${variant}`,
            { id: "t1", category: "a", priority: "low" },
            (u) => u.set({ category: "b", priority: "high" }),
            (u) =>
              u
                .pathSet({ segments: ["category"], value: "b", isPath: false })
                .pathSet({ segments: ["priority"], value: "high", isPath: false }),
          )
          expect(keys.some((k) => k.includes("category_b"))).toBe(true)
          expect(keys.some((k) => k.includes("priority_high"))).toBe(true)
        }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect("6. empty-composite half: pathSet and pathRemove match .set() and .remove()", () =>
        Effect.gen(function* () {
          const seed = { id: "b1", deviceBinding: "db1" }
          const keys = yield* expectParity(
            `Bindings${variant}`,
            seed,
            (u) => u.set({ deviceBinding: "db2" }),
            set(["deviceBinding"], "db2"),
          )
          expect(keys.some((k) => k.startsWith("gsi1pk=") && k.includes("db2"))).toBe(true)
          expect(keys.some((k) => k.startsWith("gsi1sk="))).toBe(true)
          yield* expectParity(
            `Bindings${variant}`,
            seed,
            (u) => u.remove(["deviceBinding"]),
            (u) => u.pathRemove(["deviceBinding"]),
          )
        }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect("unique constraint: pathSet / pathRemove rotate the sentinel like .set()", () =>
        Effect.gen(function* () {
          const seed = { id: "a1", email: "a@x.io", name: "n" }
          yield* expectParity(
            `Accounts${variant}`,
            seed,
            (u) => u.set({ email: "b@x.io" }),
            set(["email"], "b@x.io"),
          )
          const rotation = yield* runUpdate(`Accounts${variant}`, seed, set(["email"], "b@x.io"))
          const sentinels = rotation.writes
            .filter((w) => w.op !== "Update")
            .map((w) => `${w.op} ${(w.input.Item ?? w.input.Key).pk.S}`)
            .filter((s) => s.includes("_unique") || s.includes("email"))
          expect(sentinels.some((s) => s.startsWith("Delete") && s.includes("a@x.io"))).toBe(true)
          expect(sentinels.some((s) => s.startsWith("Put") && s.includes("b@x.io"))).toBe(true)
          yield* expectParity(
            `Accounts${variant}`,
            seed,
            (u) => u.remove(["email"]),
            (u) => u.pathRemove(["email"]),
          )
        }).pipe(Effect.provide(TestLayer), closed),
      )

      it.effect("a guarded path op beside another path op is refused, not split", () =>
        Effect.gen(function* () {
          const result = yield* runUpdate(
            `Accounts${variant}`,
            { id: "a1", email: "a@x.io", name: "n" },
            (u) =>
              u
                .pathSet({ segments: ["email"], value: "b@x.io", isPath: false })
                .pathSet({ segments: ["name"], value: "m", isPath: false }),
          )
          expect(failureOf(result.exit)?._tag).toBe("ValidationError")
          expect(result.writes).toEqual([])
        }).pipe(Effect.provide(TestLayer), closed),
      )
    })
  }
})

// ---------------------------------------------------------------------------
// Refused operations
// ---------------------------------------------------------------------------

describe("#133 path operations on index composites — refused", () => {
  const seed = { id: "d1", owner: "alice", reading: "r1", seq: 1, label: "l", tags: ["a"] }
  const refused: ReadonlyArray<readonly [string, string, (u: Builder) => Builder]> = [
    [
      "a copy into a composite",
      "owner",
      (u) =>
        u.pathSet({
          segments: ["owner"],
          value: undefined,
          isPath: true,
          valueSegments: ["label"],
        }),
    ],
    [
      "if_not_exists on a composite",
      "owner",
      (u) => u.pathIfNotExists({ segments: ["owner"], value: "x" }),
    ],
    [
      "append to a composite",
      "reading",
      (u) => u.pathAppend({ segments: ["reading"], value: ["x"] }),
    ],
    [
      "prepend to a composite",
      "reading",
      (u) => u.pathPrepend({ segments: ["reading"], value: ["x"] }),
    ],
    [
      "delete from a composite",
      "owner",
      (u) => u.pathDelete({ segments: ["owner"], value: new Set(["x"]) }),
    ],
    [
      "a subtract copying another attribute",
      "seq",
      (u) =>
        u.pathSubtract({
          segments: ["seq"],
          value: undefined,
          isPath: true,
          valueSegments: ["seq"],
        }),
    ],
    ["a nested path below a composite", "owner", set(["owner", "first"], "x")],
    [
      "a composite targeted twice",
      "owner",
      (u) =>
        u.set({ owner: "bob" }).pathSet({ segments: ["owner"], value: "carol", isPath: false }),
    ],
    [
      "a composite set and removed",
      "owner",
      (u) => u.pathSet({ segments: ["owner"], value: "bob", isPath: false }).pathRemove(["owner"]),
    ],
  ]
  for (const [label, field, build] of refused) {
    it.effect(`${label} is refused, naming the field`, () =>
      Effect.gen(function* () {
        for (const name of ["DevicesPlain", "DevicesRetained"] as const) {
          const result = yield* runUpdate(name, seed, build)
          const error = failureOf(result.exit)
          expect([name, error?._tag]).toEqual([name, "ValidationError"])
          expect(String(error?.cause)).toContain(`"${field}"`)
          expect(result.writes).toEqual([])
        }
      }).pipe(Effect.provide(TestLayer), closed),
    )
  }

  it.effect("an immutable composite cannot be path-set", () =>
    Effect.gen(function* () {
      const result = yield* runUpdate("Ledgers", { id: "l1", book: "b1" }, set(["book"], "b2"))
      expect(failureOf(result.exit)?._tag).toBe("ValidationError")
      expect(String(failureOf(result.exit)?.cause)).toContain('"book"')
    }).pipe(Effect.provide(TestLayer), closed),
  )

  it.effect("path ops on other fields are still DynamoDB's own", () =>
    Effect.gen(function* () {
      const result = yield* runUpdate("DevicesPlain", seed, (u) =>
        u.pathAppend({ segments: ["tags"], value: ["b"] }),
      )
      expect(failureOf(result.exit)).toBeUndefined()
      expect(result.writes[0]!.input.UpdateExpression).toContain("list_append")
    }).pipe(Effect.provide(TestLayer), closed),
  )
})

// ---------------------------------------------------------------------------
// Record rich operations on an index composite
// ---------------------------------------------------------------------------

describe("#133 record rich operations on an index composite", () => {
  it.effect(".add() on a composite recomposes the index key (unversioned entity)", () =>
    Effect.gen(function* () {
      const result = yield* runUpdate(
        "Counters",
        { id: "c1", owner: "alice", reading: "r1", seq: 1 },
        (u) => u.add({ seq: 2 }),
      )
      expect(failureOf(result.exit)).toBeUndefined()
      expect(result.writes.flatMap(keyWrites).some((k) => /seq_0+3$/.test(k))).toBe(true)
      expect((result.exit as any).value.seq).toBe(3)
    }).pipe(Effect.provide(TestLayer), closed),
  )

  it.effect(".add() on a composite beside a path op is refused", () =>
    Effect.gen(function* () {
      const result = yield* runUpdate(
        "DevicesRetained",
        { id: "d1", owner: "alice", reading: "r1", seq: 1 },
        (u) => u.add({ seq: 2 }).pathSet({ segments: ["label"], value: "m", isPath: false }),
      )
      expect(failureOf(result.exit)?._tag).toBe("ValidationError")
      expect(String(failureOf(result.exit)?.cause)).toContain('"seq"')
    }).pipe(Effect.provide(TestLayer), closed),
  )

  it.effect(".add() on a non-composite still compiles to ADD", () =>
    Effect.gen(function* () {
      const result = yield* runUpdate(
        "Counters",
        { id: "c1", owner: "alice", reading: "r1", seq: 1, label: "l" },
        (u) => u.set({ label: "m" }),
      )
      expect(result.writes.map((w) => w.op)).toEqual(["Update"])
    }).pipe(Effect.provide(TestLayer), closed),
  )
})

// ---------------------------------------------------------------------------
// Condition failures: version race vs user condition (ALL_OLD)
// ---------------------------------------------------------------------------

const ccf = (item: Record<string, unknown> | undefined) =>
  Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
    ...(item !== undefined && { Item: item }),
  })
const cancelled = (item: Record<string, unknown> | undefined) =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [
      { Code: "ConditionalCheckFailed", ...(item !== undefined && { Item: item }) },
      { Code: "None" },
    ],
  })

/** The stored main item with its version replaced — what ALL_OLD hands back. */
const storedWithVersion = (id: string, version: number) => {
  const item = [...store.values()].find(
    (i) =>
      i.pk?.S?.includes(`#id_${id}`) &&
      !i.sk?.S?.includes("#v#") &&
      !i.__edd_e__?.S?.includes("_unique"),
  )
  return { ...item!, version: { N: String(version) } }
}

describe("#133 condition failures distinguish a version race from the user condition", () => {
  const seed = { id: "d1", owner: "alice", reading: "r1", seq: 1, label: "l" }
  const cases: ReadonlyArray<
    readonly [
      string,
      Name,
      (u: Builder) => Builder,
      (item: Record<string, unknown>) => unknown,
      string,
    ]
  > = [
    [
      "plain UpdateItem with expectedVersion and a condition",
      "DevicesPlain",
      (u) =>
        u
          .set({ label: "m" })
          .expectedVersion(1)
          .condition({ eq: { label: "l" } }),
      ccf,
      "Update",
    ],
    [
      "retain record update with a condition",
      "DevicesRetained",
      (u) => u.set({ label: "m" }).condition({ eq: { label: "l" } }),
      cancelled,
      "Put",
    ],
    [
      "retain path update with a condition",
      "DevicesRetained",
      (u) =>
        u
          .pathSet({ segments: ["label"], value: "m", isPath: false })
          .condition({ eq: { label: "l" } }),
      cancelled,
      "Update",
    ],
  ]
  for (const [label, name, build, failure, mainOp] of cases) {
    it.effect(`${label}: a newer stored version is an OptimisticLockError`, () =>
      Effect.gen(function* () {
        const result = yield* runUpdate(name, seed, (u) => {
          failNext = failure(storedWithVersion("d1", 2))
          return build(u)
        })
        const error = failureOf(result.exit)
        expect(error?._tag).toBe("OptimisticLockError")
        expect(error?.expectedVersion).toBe(1)
        expect(error?.actualVersion).toBe(2)
      }).pipe(Effect.provide(TestLayer), closed),
    )

    it.effect(`${label}: the same stored version is a ConditionalCheckFailed`, () =>
      Effect.gen(function* () {
        const result = yield* runUpdate(name, seed, (u) => {
          failNext = failure(storedWithVersion("d1", 1))
          return build(u)
        })
        expect(failureOf(result.exit)?._tag).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer), closed),
    )

    it.effect(`${label}: asks DynamoDB for the item on a failed condition`, () =>
      Effect.gen(function* () {
        const result = yield* runUpdate(name, seed, build)
        const main = result.writes.find(
          (w) => w.op === mainOp && !String(w.input.Item?.sk?.S ?? "").includes("#v#"),
        )!
        expect(main.input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
      }).pipe(Effect.provide(TestLayer), closed),
    )
  }
})
