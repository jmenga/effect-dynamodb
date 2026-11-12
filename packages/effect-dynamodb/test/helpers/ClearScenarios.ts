/**
 * Clearing a field (#177, #178): `.set({ field: undefined })` is `.remove([field])`, a field
 * no row can be without can't be cleared, and an update can't address what isn't a model field.
 * These scenarios run on a recording table (`Entity.clears.test.ts`, `IndexPolicyV3.test.ts`) and
 * on DynamoDB Local (`connected.clears.test.ts`, `connected.test.ts`), through a {@link Harness}.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { indexesOf } from "./DynamoExpressions.js"
import { makeRecordingTable } from "./RecordingTable.js"

export const schema = DynamoSchema.make({ name: "clears", version: 1 })

export type StoredRow = Record<string, AttributeValue>

export interface World {
  readonly Rows: any
  readonly MainTable: any
}

export interface Probe {
  /** Every stored row, as DynamoDB holds it. */
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>
  /** The rows a secondary index holds, as DynamoDB holds them (a row with both its keys). */
  readonly inIndex: (index: string) => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>
  /** Requests the library has sent so far. */
  readonly sent: () => number
}

/** What a scenario needs of a table. */
export interface Harness {
  readonly on: <A, E>(
    world: World,
    body: (db: any, probe: Probe) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

export interface Scenario {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

export const clientOf = (world: World) =>
  DynamoClient.make({
    entities: { Rows: world.Rows },
    tables: { MainTable: world.MainTable },
  } as never) as Effect.Effect<any, never, any>

const physicalIndexes = (world: World) => indexesOf(Table.definition(world.MainTable))

/** An in-memory table: everything sent is seen. */
export const recordingHarness: Harness = {
  on: (world, body) => {
    const indexes = physicalIndexes(world)
    const table = makeRecordingTable({ indexes })
    const rows = () => Effect.sync(() => structuredClone([...table.items.values()]) as StoredRow[])
    return Effect.gen(function* () {
      const db = yield* clientOf(world)
      return yield* body(db, {
        rows,
        inIndex: (index) =>
          rows().pipe(
            Effect.map((found) =>
              found.filter(
                (row) =>
                  row[indexes[index]!.pk as string] !== undefined &&
                  row[indexes[index]!.sk as string] !== undefined,
              ),
            ),
          ),
        sent: () => table.requests.length,
      })
    }).pipe(Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" })))) as never
  },
}

let connectedTables = 0

/** DynamoDB at `endpoint`, a fresh table per scenario: its indexes are the real thing. */
export const connectedHarness = (endpoint: string): Harness => {
  const ClientLayer = DynamoClient.layer({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  })
  return {
    on: (world, body) => {
      const tableName = `clears-${Date.now()}-${connectedTables++}`
      let sent = 0
      return Effect.gen(function* () {
        const raw = yield* DynamoClient
        const counting = new Proxy(raw, {
          get: (target, property, receiver) => {
            const value = Reflect.get(target, property, receiver)
            return typeof value === "function"
              ? (...args: ReadonlyArray<unknown>) => {
                  sent++
                  return value.apply(target, args)
                }
              : value
          },
        })
        const scan = (index?: string) =>
          Effect.gen(function* () {
            const found: Array<StoredRow> = []
            let start: StoredRow | undefined
            do {
              const page = yield* raw.scan({
                TableName: tableName,
                ...(index === undefined ? { ConsistentRead: true } : { IndexName: index }),
                ...(start === undefined ? {} : { ExclusiveStartKey: start }),
              })
              found.push(...((page.Items ?? []) as Array<StoredRow>))
              start = page.LastEvaluatedKey as StoredRow | undefined
            } while (start !== undefined)
            return found
          })
        return yield* Effect.acquireUseRelease(
          raw.createTable({
            TableName: tableName,
            BillingMode: "PAY_PER_REQUEST",
            ...Table.definition(world.MainTable),
          }),
          () =>
            Effect.gen(function* () {
              const db = yield* clientOf(world)
              return yield* body(db, {
                rows: () => scan(),
                inIndex: (index) => scan(index),
                sent: () => sent,
              })
            }).pipe(
              Effect.provide(
                Layer.merge(
                  Layer.succeed(DynamoClient, counting),
                  world.MainTable.layer({ name: tableName }),
                ),
              ),
            ),
          () => raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore),
        )
      }).pipe(Effect.provide(ClientLayer)) as never
    },
  }
}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

export const key = { id: "1" }

export const worldOf = (model: unknown, options: Record<string, unknown> = {}): World => {
  const Rows = Entity.make({
    model,
    entityType: "Row",
    primaryKey,
    ...options,
  } as never) as any
  return { Rows, MainTable: Table.make({ schema, entities: { Rows } }) }
}

/** The row an operation addresses, leaving out sentinels, snapshots and tombstones. */
export const live = (rows: ReadonlyArray<StoredRow>, id = "1"): StoredRow | undefined =>
  rows.find((row) => row.id?.S === id && row.__edd_e__?.S === "Row" && row.sk?.S?.endsWith("#row"))

// ---------------------------------------------------------------------------
// The model behind the refusals and the table in the issue
// ---------------------------------------------------------------------------

class Inner extends Schema.Class<Inner>("Inner")({
  must: Schema.String,
  may: Schema.optional(Schema.String),
}) {}

class Item extends Schema.Class<Item>("Item")({
  id: Schema.String,
  /** Required: no row can be without it. */
  note: Schema.String,
  /** Optional, and a unique constraint of its own. */
  code: Schema.optional(Schema.String),
  /** Optional, stored as `g`, and composes `byRegion`. */
  region: Schema.optional(Schema.String),
  /** Optional, and immutable. */
  fixed: Schema.optional(Schema.String),
  /** The key is required; its value may be empty. */
  nullable: Schema.NullOr(Schema.String),
  /** A unique constraint over two fields. */
  first: Schema.optional(Schema.String),
  second: Schema.optional(Schema.String),
  count: Schema.optional(Schema.Number),
  /** Read back as its default when it's missing. */
  defaulted: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("d"))),
  address: Schema.Struct({ city: Schema.String, zip: Schema.optional(Schema.String) }),
  maybeAddress: Schema.optional(Schema.Struct({ city: Schema.String })),
  inner: Inner,
  labels: Schema.Record(Schema.String, Schema.String),
  list: Schema.Array(Schema.String),
}) {}

const configured = DynamoModel.configure(Item, {
  region: { field: "g" },
  fixed: { immutable: true },
})

const seed = {
  ...key,
  note: "n",
  code: "C1",
  region: "west",
  fixed: "f",
  nullable: "v",
  first: "a",
  second: "b",
  count: 1,
  defaulted: "stored",
  address: { city: "c", zip: "z" },
  maybeAddress: { city: "m" },
  inner: { must: "m", may: "y" },
  labels: { x: "1" },
  list: ["a", "b"],
}

const definition = {
  indexes: {
    byRegion: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", composite: ["id"] },
    },
  },
  unique: { code: ["code"], pair: ["first", "second"] },
  timestamps: true,
} as const

const LIFECYCLES: ReadonlyArray<{
  readonly name: string
  readonly options: Record<string, unknown>
}> = [
  { name: "versioned", options: { versioned: true } },
  { name: "retained versions", options: { versioned: { retain: true } } },
  { name: "soft delete", options: { versioned: true, softDelete: { ttl: "30 days" } } },
]

const stored = (name: string) => new RegExp(`"${name}" is the attribute "region" is stored in`)
const INDEX_KEY = /a key attribute of index "byRegion"/
const LIBRARY = /managed by the library/
const THE_LIBRARYS = /an attribute the library manages/
const REQUIRED = (name: string) => new RegExp(`the model requires "${name}"`)
const IMMUTABLE = /immutable/
const IDENTIFIES = /identifies the item/

type Op = (update: any) => any
const pathValue = (head: string) => ({ segments: [head], value: "x", isPath: false })

/** Operations no row could survive, or that name what isn't the model's: one row each. */
const REFUSED: ReadonlyArray<{
  readonly name: string
  readonly op: Op
  readonly says: RegExp
  /** The planner can't take this one, or any like it, for its own reason. */
  readonly standaloneOnly?: boolean
}> = [
  // A field a row can't lack.
  {
    name: ".set({ note: undefined })",
    op: (u) => u.set({ note: undefined }),
    says: REQUIRED("note"),
  },
  { name: '.remove(["note"])', op: (u) => u.remove(["note"]), says: REQUIRED("note") },
  { name: 'pathRemove(["note"])', op: (u) => u.pathRemove(["note"]), says: REQUIRED("note") },
  {
    name: ".set({ nullable: undefined })",
    op: (u) => u.set({ nullable: undefined }),
    says: REQUIRED("nullable"),
  },
  { name: '.remove(["nullable"])', op: (u) => u.remove(["nullable"]), says: REQUIRED("nullable") },
  { name: '.remove(["inner"])', op: (u) => u.remove(["inner"]), says: REQUIRED("inner") },
  // Below it.
  {
    name: 'pathRemove(["address", "city"])',
    op: (u) => u.pathRemove(["address", "city"]),
    says: /"address\.city": the model requires it/,
  },
  {
    name: 'pathRemove(["maybeAddress", "city"])',
    op: (u) => u.pathRemove(["maybeAddress", "city"]),
    says: /"maybeAddress\.city": the model requires it/,
  },
  {
    name: 'pathRemove(["inner", "must"]), a class',
    op: (u) => u.pathRemove(["inner", "must"]),
    says: /"inner\.must": the model requires it/,
  },
  // What identifies the row.
  { name: ".set({ id: undefined })", op: (u) => u.set({ id: undefined }), says: IDENTIFIES },
  { name: '.remove(["id"])', op: (u) => u.remove(["id"]), says: IDENTIFIES },
  { name: 'pathRemove(["id"])', op: (u) => u.pathRemove(["id"]), says: IDENTIFIES },
  { name: ".add({ id: 1 })", op: (u) => u.add({ id: 1 }), says: IDENTIFIES },
  { name: '.remove(["pk"])', op: (u) => u.remove(["pk"]), says: IDENTIFIES },
  // Another field's stored name.
  { name: '.remove(["g"])', op: (u) => u.remove(["g"]), says: stored("g") },
  { name: 'pathRemove(["g"])', op: (u) => u.pathRemove(["g"]), says: stored("g") },
  { name: 'pathRemove(["g", "x"])', op: (u) => u.pathRemove(["g", "x"]), says: stored("g") },
  { name: "pathSet g", op: (u) => u.pathSet(pathValue("g")), says: stored("g") },
  { name: ".add({ g: 1 })", op: (u) => u.add({ g: 1 }), says: stored("g") },
  { name: ".subtract({ g: 1 })", op: (u) => u.subtract({ g: 1 }), says: stored("g") },
  { name: ".append({ g })", op: (u) => u.append({ g: ["x"] }), says: stored("g") },
  { name: ".deleteFromSet({ g })", op: (u) => u.deleteFromSet({ g: ["x"] }), says: stored("g") },
  {
    name: "pathAppend g",
    op: (u) => u.pathAppend({ segments: ["g"], value: ["x"] }),
    says: stored("g"),
  },
  { name: "pathAdd g", op: (u) => u.pathAdd({ segments: ["g"], value: 1 }), says: stored("g") },
  {
    name: "pathSubtract g",
    op: (u) => u.pathSubtract({ segments: ["g"], value: 1 }),
    says: stored("g"),
  },
  {
    name: "pathPrepend g",
    op: (u) => u.pathPrepend({ segments: ["g"], value: ["x"] }),
    says: stored("g"),
  },
  {
    name: "pathIfNotExists g",
    op: (u) => u.pathIfNotExists({ segments: ["g"], value: "x" }),
    says: stored("g"),
  },
  {
    name: "pathDelete g",
    op: (u) => u.pathDelete({ segments: ["g"], value: new Set(["x"]) }),
    says: stored("g"),
  },
  // A secondary index's key attribute.
  { name: '.remove(["gsi1pk"])', op: (u) => u.remove(["gsi1pk"]), says: INDEX_KEY },
  { name: '.remove(["gsi1sk"])', op: (u) => u.remove(["gsi1sk"]), says: INDEX_KEY },
  { name: 'pathRemove(["gsi1pk"])', op: (u) => u.pathRemove(["gsi1pk"]), says: INDEX_KEY },
  { name: "pathSet gsi1pk", op: (u) => u.pathSet(pathValue("gsi1pk")), says: INDEX_KEY },
  { name: ".add({ gsi1pk: 1 })", op: (u) => u.add({ gsi1pk: 1 }), says: INDEX_KEY },
  // The library's own attributes.
  { name: '.remove(["__edd_e__"])', op: (u) => u.remove(["__edd_e__"]), says: THE_LIBRARYS },
  { name: 'pathRemove(["__edd_e__"])', op: (u) => u.pathRemove(["__edd_e__"]), says: THE_LIBRARYS },
  { name: "pathSet __edd_e__", op: (u) => u.pathSet(pathValue("__edd_e__")), says: THE_LIBRARYS },
  { name: ".add({ __edd_e__: 1 })", op: (u) => u.add({ __edd_e__: 1 }), says: THE_LIBRARYS },
  { name: '.remove(["__edd_i__"])', op: (u) => u.remove(["__edd_i__"]), says: THE_LIBRARYS },
  {
    name: '.remove(["__edd_v_search__"]), a vector',
    op: (u) => u.remove(["__edd_v_search__"]),
    says: THE_LIBRARYS,
  },
  { name: '.remove(["version"])', op: (u) => u.remove(["version"]), says: LIBRARY },
  { name: 'pathRemove(["version"])', op: (u) => u.pathRemove(["version"]), says: LIBRARY },
  { name: ".add({ version: 1 })", op: (u) => u.add({ version: 1 }), says: LIBRARY },
  { name: ".subtract({ version: 1 })", op: (u) => u.subtract({ version: 1 }), says: LIBRARY },
  { name: "pathSet version", op: (u) => u.pathSet(pathValue("version")), says: LIBRARY },
  { name: '.remove(["createdAt"])', op: (u) => u.remove(["createdAt"]), says: LIBRARY },
  { name: 'pathRemove(["updatedAt"])', op: (u) => u.pathRemove(["updatedAt"]), says: LIBRARY },
  { name: "pathSet createdAt", op: (u) => u.pathSet(pathValue("createdAt")), says: LIBRARY },
  // Immutable.
  { name: ".set({ fixed: undefined })", op: (u) => u.set({ fixed: undefined }), says: /"fixed"/ },
  { name: '.remove(["fixed"])', op: (u) => u.remove(["fixed"]), says: IMMUTABLE },
  { name: 'pathRemove(["fixed"])', op: (u) => u.pathRemove(["fixed"]), says: IMMUTABLE },
  { name: "pathSet fixed", op: (u) => u.pathSet(pathValue("fixed")), says: IMMUTABLE },
  { name: ".add({ fixed: 1 })", op: (u) => u.add({ fixed: 1 }), says: IMMUTABLE },
]

/** The row and everything sent are what they were: the refusal came first. */
export const refused = (
  db: any,
  probe: Probe,
  failing: () => Effect.Effect<unknown, unknown, any>,
  says: RegExp,
) =>
  Effect.gen(function* () {
    const before = yield* probe.rows()
    const sent = probe.sent()
    const error: any = yield* failing().pipe(Effect.flip)
    expect(error._tag).toBe("ValidationError")
    expect(String(error.cause)).toMatch(says)
    expect(probe.sent()).toBe(sent)
    expect(yield* probe.rows()).toEqual(before)
    // It's still the row it was, and still readable.
    yield* db.entities.Rows.get(key)
  })

const refusalsOn = (
  name: string,
  options: Record<string, unknown>,
  surface: { readonly name: string; readonly run: (db: any, world: World, op: Op) => any },
): ReadonlyArray<Scenario> =>
  REFUSED.map(({ name: row, op, says }) => ({
    name: `${name}, ${surface.name}: ${row}`,
    run: (h: Harness) => {
      const world = worldOf(configured, { ...definition, ...options })
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* refused(db, probe, () => surface.run(db, world, op), says)
        }),
      )
    },
  }))

const STANDALONE = {
  name: "standalone",
  run: (db: any, _world: World, op: Op) => op(db.entities.Rows.update(key)).asEffect(),
}

const TRANSACTION = {
  name: "in a transaction",
  run: (db: any, _world: World, op: Op) =>
    Transaction.transactWrite([op(db.entities.Rows.update(key))]),
}

export const refusalScenarios: ReadonlyArray<Scenario> = LIFECYCLES.flatMap(({ name, options }) => [
  ...refusalsOn(name, options, STANDALONE),
  ...refusalsOn(name, options, TRANSACTION),
])

/** Only an entity configuring them has these. */
export const conditionalNameScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a TTL's attribute, on an entity with a soft-delete TTL",
    run: (h) => {
      const world = worldOf(configured, {
        ...definition,
        versioned: true,
        softDelete: { ttl: "30 days" },
      })
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.update(key).remove(["_ttl"]).asEffect(),
            LIBRARY,
          )
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.update(key).pathRemove(["deletedAt"]).asEffect(),
            LIBRARY,
          )
        }),
      )
    },
  },
  {
    name: "a TTL's attribute, on an entity with a retained-version TTL",
    run: (h) => {
      const world = worldOf(configured, {
        ...definition,
        versioned: { retain: true, ttl: "30 days" },
      })
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.update(key).remove(["_ttl"]).asEffect(),
            LIBRARY,
          )
        }),
      )
    },
  },
  {
    name: "the same names mean nothing to an entity that doesn't use them, and stay allowed",
    run: (h) => {
      const world = worldOf(configured, definition)
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* db.entities.Rows.update(key).pathSet(pathValue("_ttl")).asEffect()
          yield* db.entities.Rows.update(key).pathSet(pathValue("deletedAt")).asEffect()
          expect(live(yield* probe.rows())?._ttl).toBeDefined()
          yield* db.entities.Rows.update(key).remove(["_ttl", "deletedAt", "version"]).asEffect()
          const row = live(yield* probe.rows())!
          expect(row._ttl).toBeUndefined()
          expect(row.deletedAt).toBeUndefined()
        }),
      )
    },
  },
]

/** A model field declared under a library-managed name is still the library's. */
export const collidingScenarios: ReadonlyArray<Scenario> = (() => {
  class Colliding extends Schema.Class<Colliding>("Colliding")({
    id: Schema.String,
    version: Schema.Number,
    createdAt: Schema.DateTimeUtcFromString,
    updatedAt: Schema.DateTimeUtcFromString,
    note: Schema.optional(Schema.String),
  }) {}
  const world = () => worldOf(Colliding, { timestamps: true, versioned: true })
  class Owned extends Schema.Class<Owned>("Owned")({
    id: Schema.String,
    createdAt: Schema.optional(Schema.String),
    note: Schema.optional(Schema.String),
  }) {}
  return [
    {
      name: "a colliding version or createdAt can't be cleared, by either form",
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", note: "n" }).asEffect()
            for (const field of ["version", "createdAt"]) {
              yield* refused(
                db,
                probe,
                () =>
                  db.entities.Rows.update(key)
                    .set({ [field]: undefined })
                    .asEffect(),
                new RegExp(`"${field}"`),
              )
              yield* refused(
                db,
                probe,
                () => db.entities.Rows.update(key).remove([field]).asEffect(),
                LIBRARY,
              )
            }
          }),
        ),
    },
    {
      name: "`undefined` on a colliding updatedAt still means generate it",
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", note: "n" }).asEffect()
            yield* db.entities.Rows.update(key).set({ updatedAt: undefined, note: "m" }).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.updatedAt).toBeDefined()
            expect(row.note).toEqual({ S: "m" })
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.update(key).remove(["updatedAt"]).asEffect(),
              LIBRARY,
            )
          }),
        ),
    },
    {
      name: "a field the library yields to the model (a non-date createdAt) is the model's to clear",
      run: (h: Harness) =>
        h.on(worldOf(Owned, { timestamps: true }), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", createdAt: "2026", note: "n" }).asEffect()
            yield* db.entities.Rows.update(key).remove(["createdAt"]).asEffect()
            expect(live(yield* probe.rows())!.createdAt).toBeUndefined()
          }),
        ),
    },
  ]
})()

// ---------------------------------------------------------------------------
// What a clear does
// ---------------------------------------------------------------------------

export const FORMS: ReadonlyArray<{
  readonly name: string
  readonly clear: (field: string, also?: Record<string, unknown>) => Op
}> = [
  {
    name: ".set({ field: undefined })",
    clear: (field, also) => (u) => u.set({ ...also, [field]: undefined }),
  },
  {
    name: ".remove([field])",
    clear: (field, also) => (u) => (also ? u.set(also) : u).remove([field]),
  },
  {
    name: "pathRemove([field])",
    clear: (field, also) => (u) => (also ? u.set(also) : u).pathRemove([field]),
  },
]

export const clearScenarios: ReadonlyArray<Scenario> = LIFECYCLES.flatMap((lifecycle) =>
  FORMS.flatMap((form) => [
    {
      name: `${lifecycle.name}, ${form.name}: a unique field's sentinel is released (#177)`,
      run: (h: Harness) => {
        const world = worldOf(configured, { ...definition, ...lifecycle.options })
        return h.on(world, (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(seed).asEffect()
            yield* form.clear("code")(db.entities.Rows.update(key)).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.code).toBeUndefined()
            expect(row.version).toEqual({ N: "2" })
            yield* db.entities.Rows.create({
              ...seed,
              id: "2",
              first: "other",
              code: "C1",
            }).asEffect()
          }),
        )
      },
    },
    {
      name: `${lifecycle.name}, ${form.name}: one field of a two-field constraint`,
      run: (h: Harness) => {
        const world = worldOf(configured, { ...definition, ...lifecycle.options })
        return h.on(world, (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(seed).asEffect()
            yield* form.clear("first")(db.entities.Rows.update(key)).asEffect()
            expect(live(yield* probe.rows())!.first).toBeUndefined()
            // The pair is free again, and the row can take it back.
            yield* db.entities.Rows.create({ ...seed, id: "2", code: "C2" }).asEffect()
            const taken: any = yield* db.entities.Rows.update(key)
              .set({ first: "a" })
              .asEffect()
              .pipe(Effect.flip)
            expect(taken._tag).toBe("UniqueConstraintViolation")
            yield* db.entities.Rows.update(key).set({ first: "z" }).asEffect()
          }),
        )
      },
    },
    {
      name: `${lifecycle.name}, ${form.name}: a renamed composite leaves the row and the index`,
      run: (h: Harness) => {
        const world = worldOf(configured, { ...definition, ...lifecycle.options })
        return h.on(world, (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(seed).asEffect()
            expect(yield* db.entities.Rows.byRegion({ region: "west" }).collect()).toHaveLength(1)
            yield* form.clear("region")(db.entities.Rows.update(key)).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.g).toBeUndefined()
            expect(row.gsi1pk).toBeUndefined()
            expect(yield* db.entities.Rows.byRegion({ region: "west" }).collect()).toHaveLength(0)
            expect((yield* db.entities.Rows.get(key)).region).toBeUndefined()
          }),
        )
      },
    },
    {
      name: `${lifecycle.name}, ${form.name}: in a transaction, the sentinel goes with it`,
      run: (h: Harness) => {
        const world = worldOf(configured, { ...definition, ...lifecycle.options })
        return h.on(world, (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(seed).asEffect()
            yield* Transaction.transactWrite([form.clear("code")(db.entities.Rows.update(key))])
            expect(live(yield* probe.rows())!.code).toBeUndefined()
            yield* db.entities.Rows.create({
              ...seed,
              id: "2",
              first: "other",
              code: "C1",
            }).asEffect()
          }),
        )
      },
    },
  ]),
)

/** A retained version and a tombstone hold what the row held before the clear. */
export const lifecycleScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a retained snapshot keeps the cleared value",
    run: (h) => {
      const world = worldOf(configured, { ...definition, versioned: { retain: true } })
      return h.on(world, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* db.entities.Rows.update(key).set({ code: undefined }).asEffect()
          expect((yield* db.entities.Rows.get(key)).code).toBeUndefined()
          expect((yield* db.entities.Rows.getVersion(key, 1)).code).toBe("C1")
        }),
      )
    },
  },
  {
    name: "a soft delete and restore after a clear brings back the row without it",
    run: (h) => {
      const world = worldOf(configured, { ...definition, versioned: true, softDelete: true })
      return h.on(world, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* db.entities.Rows.update(key).set({ code: undefined }).asEffect()
          yield* db.entities.Rows.delete(key).asEffect()
          yield* db.entities.Rows.restore(key)
          const row = yield* db.entities.Rows.get(key)
          expect(row.code).toBeUndefined()
          expect(row.note).toBe("n")
          // Nothing holds the value it no longer has.
          yield* db.entities.Rows.create({
            ...seed,
            id: "2",
            first: "other",
            code: "C1",
          }).asEffect()
        }),
      )
    },
  },
  {
    name: "a field a read defaults can be cleared, and reads back as its default",
    run: (h) => {
      const world = worldOf(configured, { ...definition, versioned: true })
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* db.entities.Rows.update(key).set({ defaulted: undefined }).asEffect()
          expect(live(yield* probe.rows())!.defaulted).toBeUndefined()
          expect((yield* db.entities.Rows.get(key)).defaulted).toBe("d")
        }),
      )
    },
  },
  {
    name: "a defaulted index composite isn't dropped, by either form: the default is stored, and the key follows it",
    run: (h) =>
      Effect.gen(function* () {
        class Levelled extends Schema.Class<Levelled>("Levelled")({
          id: Schema.String,
          level: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("info"))),
        }) {}
        for (const form of FORMS) {
          const world = worldOf(Levelled, {
            indexes: {
              byLevel: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["level"] },
                sk: { field: "gsi1sk", composite: ["id"] },
              },
            },
          })
          yield* h.on(world, (db, probe) =>
            Effect.gen(function* () {
              yield* db.entities.Rows.put({ id: "1", level: "high" }).asEffect()
              yield* form.clear("level")(db.entities.Rows.update(key)).asEffect()
              expect(live(yield* probe.rows())!.level).toEqual({ S: "info" })
              expect(yield* db.entities.Rows.byLevel({ level: "high" }).collect()).toHaveLength(0)
              expect(yield* db.entities.Rows.byLevel({ level: "info" }).collect()).toHaveLength(1)
            }),
          )
        }
      }),
  },
  {
    name: "what a schema leaves open stays open below a field: optional, record key, list element",
    run: (h) => {
      const world = worldOf(configured, { ...definition, versioned: true })
      return h.on(world, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* db.entities.Rows.update(key).pathRemove(["address", "zip"]).asEffect()
          yield* db.entities.Rows.update(key).pathRemove(["inner", "may"]).asEffect()
          yield* db.entities.Rows.update(key).pathRemove(["labels", "x"]).asEffect()
          yield* db.entities.Rows.update(key).pathRemove(["list", 0]).asEffect()
          const row = yield* db.entities.Rows.get(key)
          expect(row.address).toEqual({ city: "c" })
          expect(row.inner.may).toBeUndefined()
          expect(row.labels).toEqual({})
          expect(row.list).toEqual(["b"])
        }),
      )
    },
  },
  {
    name: "an attribute the model doesn't declare stays removable, both ways",
    run: (h) => {
      const world = worldOf(configured, { ...definition, versioned: true })
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(seed).asEffect()
          yield* db.entities.Rows.update(key).pathSet(pathValue("legacy")).asEffect()
          expect(live(yield* probe.rows())!.legacy).toEqual({ S: "x" })
          yield* db.entities.Rows.update(key).remove(["legacy"]).asEffect()
          expect(live(yield* probe.rows())!.legacy).toBeUndefined()
          yield* db.entities.Rows.update(key).pathSet(pathValue("legacy")).asEffect()
          yield* db.entities.Rows.update(key).pathRemove(["legacy"]).asEffect()
          expect(live(yield* probe.rows())!.legacy).toBeUndefined()
          yield* db.entities.Rows.get(key)
        }),
      )
    },
  },
]

// ---------------------------------------------------------------------------
// `null` and the empty values of a transformation
// ---------------------------------------------------------------------------

class Empties extends Schema.Class<Empties>("Empties")({
  id: Schema.String,
  /** Required key, nullable value: `null` is stored. */
  nullable: Schema.NullOr(Schema.String),
  /** None encodes to `null`: stored. */
  noneIsNull: Schema.OptionFromNullOr(Schema.String),
  /** Optional and nullable: `null` removes, as it always has. */
  optionalNullable: Schema.optional(Schema.NullOr(Schema.String)),
  /** None encodes to nothing at all: it clears. */
  noneIsMissing: Schema.OptionFromOptional(Schema.String),
  noneIsMissingKey: Schema.OptionFromOptionalKey(Schema.String),
  uniqueOption: Schema.OptionFromOptional(Schema.String),
}) {}

const emptiesSeed = {
  id: "1",
  nullable: "v",
  noneIsNull: Option.some("v"),
  optionalNullable: "v",
  noneIsMissing: Option.some("v"),
  noneIsMissingKey: Option.some("v"),
  uniqueOption: Option.some("U1"),
}

export const emptyValueScenarios: ReadonlyArray<Scenario> = [
  { name: "an update", options: { versioned: true } },
  { name: "a retained update", options: { versioned: { retain: true } } },
].flatMap(({ name, options }) => {
  const world = () => worldOf(Empties, { ...options, unique: { u: ["uniqueOption"] } })
  return [
    {
      name: `${name}: \`null\` on a field a row can't lack is stored, and reads back`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(emptiesSeed).asEffect()
            yield* db.entities.Rows.update(key).set({ nullable: null }).asEffect()
            yield* db.entities.Rows.update(key).set({ noneIsNull: Option.none() }).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.nullable).toEqual({ NULL: true })
            expect(row.noneIsNull).toEqual({ NULL: true })
            const read = yield* db.entities.Rows.get(key)
            expect(read.nullable).toBeNull()
            expect(Option.isNone(read.noneIsNull)).toBe(true)
          }),
        ),
    },
    {
      name: `${name}: \`null\` on a field a row can lack removes it`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(emptiesSeed).asEffect()
            yield* db.entities.Rows.update(key).set({ optionalNullable: null }).asEffect()
            expect(live(yield* probe.rows())!.optionalNullable).toBeUndefined()
            expect((yield* db.entities.Rows.get(key)).optionalNullable).toBeUndefined()
          }),
        ),
    },
    {
      name: `${name}: a value that encodes to nothing clears, and releases its sentinel`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(emptiesSeed).asEffect()
            yield* db.entities.Rows.update(key)
              .set({
                noneIsMissing: Option.none(),
                noneIsMissingKey: Option.none(),
                uniqueOption: Option.none(),
              })
              .asEffect()
            const row = live(yield* probe.rows())!
            expect(row.noneIsMissing).toBeUndefined()
            expect(row.noneIsMissingKey).toBeUndefined()
            expect(row.uniqueOption).toBeUndefined()
            const read = yield* db.entities.Rows.get(key)
            expect(Option.isNone(read.noneIsMissing)).toBe(true)
            yield* db.entities.Rows.create({ ...emptiesSeed, id: "2" }).asEffect()
          }),
        ),
    },
    {
      name: `${name}: a value that encodes to something is written`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ ...emptiesSeed, uniqueOption: Option.none() }).asEffect()
            yield* db.entities.Rows.update(key)
              .set({ noneIsMissing: Option.some("w"), uniqueOption: Option.some("U2") })
              .asEffect()
            const row = live(yield* probe.rows())!
            expect(row.noneIsMissing).toEqual({ S: "w" })
            expect(row.uniqueOption).toEqual({ S: "U2" })
          }),
        ),
    },
  ]
})

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

class Team extends Schema.Class<Team>("Team")({
  teamId: Schema.String,
  name: Schema.String,
}) {}
const Teams = Entity.make({
  model: DynamoModel.configure(Team, { teamId: { identifier: true } }),
  entityType: "Team",
  primaryKey: { pk: { field: "pk", composite: ["teamId"] }, sk: { field: "sk", composite: [] } },
})
class Member extends Schema.Class<Member>("Member")({
  id: Schema.String,
  team: Schema.optionalKey(Team.pipe(DynamoModel.ref)),
}) {}

export const refScenarios: ReadonlyArray<Scenario> = (() => {
  const Rows = Entity.make({
    model: Member,
    entityType: "Row",
    primaryKey,
    refs: { team: { entity: Teams } },
  } as never) as any
  const world: World = {
    Rows,
    MainTable: Table.make({ schema, entities: { Rows, Teams } as never }),
  }
  const seeded = (db: any) =>
    Effect.gen(function* () {
      const teams = yield* DynamoClient.make({
        entities: { Teams },
        tables: { MainTable: world.MainTable },
      } as never) as Effect.Effect<any, never, any>
      yield* teams.entities.Teams.put({ teamId: "t", name: "T" }).asEffect()
      yield* db.entities.Rows.put({ id: "1", teamId: "t" }).asEffect()
    })
  const ROWS: ReadonlyArray<readonly [string, Op, RegExp]> = [
    ['.remove(["team"])', (u) => u.remove(["team"]), /"team" is a ref/],
    ['pathRemove(["team"])', (u) => u.pathRemove(["team"]), /"team" is a ref/],
    [".set({ team: undefined })", (u) => u.set({ team: undefined }), /"team" is a ref/],
    [".set({ teamId: undefined })", (u) => u.set({ teamId: undefined }), /"team" is a ref/],
    ['.remove(["teamId"])', (u) => u.remove(["teamId"]), /the id of the ref "team"/],
  ]
  return ROWS.map(([name, op, says]) => ({
    name: `a ref: ${name}`,
    run: (h: Harness) =>
      h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* seeded(db)
          yield* refused(db, probe, () => op(db.entities.Rows.update(key)).asEffect(), says)
        }),
      ),
  }))
})()

// ---------------------------------------------------------------------------
// A sparse map
// ---------------------------------------------------------------------------

class Tagged extends Schema.Class<Tagged>("Tagged")({
  id: Schema.String,
  tags: Schema.Record(Schema.String, Schema.Number),
}) {}

export const sparseScenarios: ReadonlyArray<Scenario> = [
  { name: "an update", options: {} },
  { name: "a retained update", options: { versioned: { retain: true } } },
].flatMap(({ name, options }) => {
  const world = () =>
    worldOf(DynamoModel.configure(Tagged, { tags: { storedAs: DynamoModel.SparseMap() } }), options)
  const seeded = (db: any) => db.entities.Rows.put({ id: "1", tags: { a: 1, b: 2 } }).asEffect()
  return [
    {
      name: `${name}: \`undefined\` merges nothing, leaving the entries`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* seeded(db)
            yield* db.entities.Rows.update(key).set({ tags: undefined }).asEffect()
            expect(live(yield* probe.rows())!["tags#a"]).toEqual({ N: "1" })
          }),
        ),
    },
    {
      name: `${name}: .remove of the map is refused, naming what clears it`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* seeded(db)
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.update(key).remove(["tags"]).asEffect(),
              /\.clearMap\("tags"\)/,
            )
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.update(key).pathRemove(["tags"]).asEffect(),
              /\.clearMap\("tags"\)/,
            )
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.update(key).add({ tags: 1 }).asEffect(),
              /\.clearMap\("tags"\)/,
            )
          }),
        ),
    },
    {
      name: `${name}: .remove of an entry by its stored name names .removeEntries`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* seeded(db)
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.update(key).remove(["tags#a"]).asEffect(),
              /\.removeEntries\("tags", \["a"\]\)/,
            )
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.update(key).pathRemove(["tags#a"]).asEffect(),
              /\.removeEntries\("tags", \["a"\]\)/,
            )
          }),
        ),
    },
    {
      name: `${name}: the entry's own operations still work, the counter's path too`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* seeded(db)
            yield* db.entities.Rows.update(key)
              .pathAdd({ segments: ["tags#a"], value: 1 })
              .asEffect()
            expect(live(yield* probe.rows())!["tags#a"]).toEqual({ N: "2" })
            yield* db.entities.Rows.update(key).removeEntries("tags", ["a"]).asEffect()
            expect(live(yield* probe.rows())!["tags#a"]).toBeUndefined()
            yield* db.entities.Rows.update(key).clearMap("tags").asEffect()
            expect(live(yield* probe.rows())!["tags#b"]).toBeUndefined()
            expect((yield* db.entities.Rows.get(key)).tags).toEqual({})
          }),
        ),
    },
  ]
})

// ---------------------------------------------------------------------------
// An update that creates what it names
// ---------------------------------------------------------------------------

class Simple extends Schema.Class<Simple>("Simple")({
  id: Schema.String,
  note: Schema.String,
  extra: Schema.optional(Schema.String),
}) {}

export const createOnMissingScenarios: ReadonlyArray<Scenario> = FORMS.slice(0, 2).map((form) => ({
  name: `a complete payload creates a missing row, with ${form.name} beside it`,
  run: (h: Harness) =>
    h.on(worldOf(Simple), (db, probe) =>
      Effect.gen(function* () {
        yield* form.clear("extra", { id: "1", note: "n" })(db.entities.Rows.update(key)).asEffect()
        const row = live(yield* probe.rows())!
        expect(row.note).toEqual({ S: "n" })
        expect(row.extra).toBeUndefined()
        expect((yield* db.entities.Rows.get(key)).note).toBe("n")
      }),
    ),
}))

// ---------------------------------------------------------------------------
// append's .remove
// ---------------------------------------------------------------------------

class Reading extends Schema.Class<Reading>("Reading")({
  id: Schema.String,
  at: Schema.Number,
  reading: Schema.Number,
  alert: Schema.optional(Schema.String),
  /** Stored as `lvl`, and an index composite that a read defaults. */
  level: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("info"))),
  enrichment: Schema.optional(Schema.String),
}) {}

export const appendScenarios: ReadonlyArray<Scenario> = (() => {
  const world = () =>
    worldOf(DynamoModel.configure(Reading, { alert: { field: "a" } }), {
      indexes: {
        byAlert: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["id"] },
          sk: { field: "gsi1sk", composite: ["alert"] },
          indexPolicy: { pk: "preserve", sk: "preserve" },
        },
        byLevel: {
          name: "gsi2",
          pk: { field: "gsi2pk", composite: ["level"] },
          sk: { field: "gsi2sk", composite: ["id"] },
        },
      },
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          reading: Schema.Number,
          alert: Schema.optional(Schema.String),
          level: Schema.optional(Schema.String),
        }),
      },
    })
  const event = (at: number) => ({ id: "1", at, reading: 1 })
  const ROWS: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["a required field", "reading", /the model requires "reading"/],
    ["the clock", "at", /orderBy clock/],
    ["a primary-key composite", "id", /primary-key composite|identifies the item/],
    ["another field's stored name", "a", /"a" is the attribute "alert" is stored in/],
    ["an index key attribute", "gsi1sk", /a key attribute of index "byAlert"/],
    ["the discriminator", "__edd_e__", /an attribute the library manages/],
    ["a field outside appendInput", "enrichment", /not declared in appendInput/],
  ]
  return [
    ...ROWS.map(([name, field, says]) => ({
      name: `append's .remove refuses ${name}`,
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.append({ ...event(1), alert: "on" }).asEffect()
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.append(event(2)).remove([field]).asEffect(),
              says,
            )
          }),
        ),
    })),
    {
      name: "append's .remove clears a field a row can lack, by its model name, key and all",
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.append({ ...event(1), alert: "on" }).asEffect()
            yield* db.entities.Rows.append(event(2)).remove(["alert"]).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.a).toBeUndefined()
            expect(row.gsi1sk).toBeUndefined()
            expect((yield* db.entities.Rows.get(key)).alert).toBeUndefined()
          }),
        ),
    },
    {
      name: "an `undefined` in append's payload isn't a clear: the attribute stays",
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.append({ ...event(1), alert: "on" }).asEffect()
            yield* db.entities.Rows.append({ ...event(2), alert: undefined }).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.a).toEqual({ S: "on" })
            expect(row.gsi1sk).toBeDefined()
          }),
        ),
    },
    {
      name: "append's .remove of a defaulted composite stores the default, and the key follows it",
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.append({ ...event(1), level: "high" }).asEffect()
            expect(yield* db.entities.Rows.byLevel({ level: "high" }).collect()).toHaveLength(1)
            yield* db.entities.Rows.append(event(2)).remove(["level"]).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.level).toEqual({ S: "info" })
            expect((yield* db.entities.Rows.get(key)).level).toBe("info")
            expect(yield* db.entities.Rows.byLevel({ level: "high" }).collect()).toHaveLength(0)
            expect(yield* db.entities.Rows.byLevel({ level: "info" }).collect()).toHaveLength(1)
          }),
        ),
    },
    {
      name: "append's .remove of a defaulted composite the payload also sets is refused",
      run: (h: Harness) =>
        h.on(world(), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.append({ ...event(1), level: "high" }).asEffect()
            yield* refused(
              db,
              probe,
              () =>
                db.entities.Rows.append({ ...event(2), level: "low" })
                  .remove(["level"])
                  .asEffect(),
              /appears in both/,
            )
          }),
        ),
    },
  ]
})()

// ---------------------------------------------------------------------------
// The canonical GSI-composite shapes, through both forms
// ---------------------------------------------------------------------------

class Shaped extends Schema.Class<Shaped>("Shaped")({
  channel: Schema.String,
  deviceId: Schema.String,
  // Shape 1: a half for each writer.
  enrichment: Schema.optional(Schema.String),
  alertState: Schema.optional(Schema.String),
  // Shapes 3 and 4: a hierarchy, with a hole.
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
  // Shape 5.
  a: Schema.optional(Schema.String),
  b: Schema.optional(Schema.String),
  // Shape 6.
  deviceBinding: Schema.optional(Schema.String),
  // Shapes 7 and 8: Z-order.
  price: Schema.optional(Schema.Number),
  bedrooms: Schema.optional(Schema.Number),
  live: Schema.optional(Schema.Literals(["draft", "live"])),
  agencyId: Schema.optional(Schema.String),
  officeId: Schema.optional(Schema.String),
  // An attribute no index reads.
  note: Schema.optional(Schema.String),
}) {}

export const shapedKey = { channel: "ch", deviceId: "d" }
export const shapedSeed = {
  ...shapedKey,
  enrichment: "e",
  alertState: "on",
  region: "r",
  country: "c",
  city: "t",
  site: "s",
  a: "a1",
  b: "b1",
  deviceBinding: "db",
  price: 10,
  bedrooms: 2,
  live: "draft",
  agencyId: "ag",
  officeId: "of",
  note: "n",
}
const dimensions = [
  { field: "price", min: 0, max: 1000 },
  { field: "bedrooms", min: 0, max: 15 },
]

/** What a half's key attribute holds after the clear, against what it held before it. */
type Outcome = "kept" | "gone" | "changed"

/** Same under both policies, because the clear is an explicit removal: the cascade overrides. */
export const SHAPES: ReadonlyArray<{
  readonly name: string
  readonly index: Record<string, unknown>
  readonly clear: string
  readonly also?: Record<string, unknown>
  readonly pk: Outcome
  readonly sk: Outcome
}> = [
  {
    name: "shape 1, multi-writer",
    index: {
      pk: { field: "gpk", composite: ["enrichment"] },
      sk: { field: "gsk", composite: ["alertState"] },
    },
    clear: "alertState",
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 2, primary-key composites only, on an unrelated clear (#43)",
    index: {
      pk: { field: "gpk", composite: ["channel"] },
      sk: { field: "gsk", composite: ["deviceId"] },
    },
    clear: "note",
    pk: "kept",
    sk: "kept",
  },
  {
    name: "shape 3, hierarchical: the parents given truncate it",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", composite: ["country", "city", "site"] },
    },
    clear: "site",
    also: { country: "c", city: "t" },
    pk: "kept",
    sk: "changed",
  },
  {
    name: "shape 4, a hole",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", composite: ["country", "city"] },
    },
    clear: "country",
    also: { city: "t2" },
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 5, all mutable",
    index: {
      pk: { field: "gpk", composite: ["a"] },
      sk: { field: "gsk", composite: ["b"] },
    },
    clear: "b",
    also: { a: "a2" },
    pk: "changed",
    sk: "gone",
  },
  {
    name: "shape 6, an empty half stays (#46)",
    index: {
      pk: { field: "gpk", composite: ["deviceBinding"] },
      sk: { field: "gsk", composite: [] },
    },
    clear: "deviceBinding",
    pk: "gone",
    sk: "kept",
  },
  {
    name: "shape 7, Z-order, never truncated",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", zorder: dimensions },
    },
    clear: "bedrooms",
    also: { price: 20 },
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 7a, a single-bit dimension",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", zorder: ["live"] },
    },
    clear: "live",
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 7b, an empty partition key half beside Z-order",
    index: {
      pk: { field: "gpk", composite: [] },
      sk: { field: "gsk", zorder: dimensions },
    },
    clear: "bedrooms",
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 8, a Z-order prefix cleared",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", prefix: ["agencyId"], zorder: dimensions },
    },
    clear: "agencyId",
    also: { price: 20, bedrooms: 3 },
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 8, a dimension cleared under a prefix",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", prefix: ["agencyId"], zorder: dimensions },
    },
    clear: "price",
    also: { agencyId: "ag" },
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 8a, every Z-order field a primary-key composite, on an unrelated clear (#43)",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", prefix: ["channel"], zorder: [{ field: "deviceId", bytes: 4 }] },
    },
    clear: "note",
    pk: "kept",
    sk: "kept",
  },
  {
    name: "shape 8b, a prefix owned by one writer, cleared by it alone",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", prefix: ["agencyId"], zorder: dimensions },
    },
    clear: "agencyId",
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 8c, a hierarchical prefix's leaf: never a truncated key",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", prefix: ["agencyId", "officeId"], zorder: dimensions },
    },
    clear: "officeId",
    also: { agencyId: "ag", price: 20, bedrooms: 3 },
    pk: "kept",
    sk: "gone",
  },
  {
    name: "shape 9, a sharded half's `by` cleared",
    index: {
      pk: { field: "gpk", composite: ["region"] },
      sk: { field: "gsk", composite: ["country", "city"] },
      shards: { count: 4, by: ["city"] },
    },
    clear: "city",
    also: { region: "r", country: "c" },
    pk: "gone",
    sk: "changed",
  },
]

export const SHAPE_PATHS: ReadonlyArray<{
  readonly name: string
  readonly options: Record<string, unknown>
  readonly write: (db: any, world: World, op: Op) => Effect.Effect<unknown, unknown, any>
}> = [
  {
    name: "an update",
    options: {},
    write: (db, _world, op) => op(db.entities.Rows.update(shapedKey)).asEffect(),
  },
  {
    name: "a retained update",
    options: { versioned: { retain: true } },
    write: (db, _world, op) => op(db.entities.Rows.update(shapedKey)).asEffect(),
  },
  {
    name: "a transaction's update",
    options: {},
    write: (db, _world, op) => Transaction.transactWrite([op(db.entities.Rows.update(shapedKey))]),
  },
]

export const shapedWorld = (
  index: Record<string, unknown>,
  policy: string,
  options: Record<string, unknown>,
): World => {
  const Rows = Entity.make({
    model: Shaped,
    entityType: "Row",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      it: { name: "gsi", indexPolicy: { pk: policy, sk: policy }, ...index },
    },
    ...options,
  } as never) as any
  return { Rows, MainTable: Table.make({ schema, entities: { Rows } }) }
}

const shapedRow = (rows: ReadonlyArray<StoredRow>): StoredRow =>
  rows.find((row) => row.deviceId?.S === "d" && row.sk?.S?.endsWith("_d")) ??
  rows.find((row) => row.deviceId?.S === "d" && !/#v#|#deleted#/.test(row.sk?.S ?? ""))!

const outcomeOf = (
  before: AttributeValue | undefined,
  after: AttributeValue | undefined,
): Outcome =>
  after === undefined
    ? "gone"
    : JSON.stringify(after) === JSON.stringify(before)
      ? "kept"
      : "changed"

export const shapeScenarios: ReadonlyArray<Scenario> = SHAPES.flatMap((shape) =>
  (["sparse", "preserve"] as const).flatMap((policy) =>
    SHAPE_PATHS.flatMap((path) =>
      FORMS.slice(0, 2).map((form) => ({
        name: `${shape.name}, ${policy}, ${path.name}: ${form.name}`,
        run: (h: Harness) => {
          const world = shapedWorld(shape.index, policy, path.options)
          return h.on(world, (db, probe) =>
            Effect.gen(function* () {
              yield* db.entities.Rows.put(shapedSeed).asEffect()
              const before = shapedRow(yield* probe.rows())
              yield* path.write(db, world, form.clear(shape.clear, shape.also))
              const after = shapedRow(yield* probe.rows())
              expect(after[shape.clear]).toBeUndefined()
              expect(outcomeOf(before.gpk, after.gpk)).toBe(shape.pk)
              expect(outcomeOf(before.gsk, after.gsk)).toBe(shape.sk)
              // The index holds the row exactly when the row holds both of its keys.
              expect(yield* probe.inIndex("gsi")).toHaveLength(
                after.gpk !== undefined && after.gsk !== undefined ? 1 : 0,
              )
              // The row still reads, whatever the index made of it.
              const read = yield* db.entities.Rows.get(shapedKey)
              expect(read[shape.clear]).toBeUndefined()
            }),
          )
        },
      })),
    ),
  ),
)

/** Shapes 2 and 8a, cleared themselves: those composites identify the row. */
export const primaryCompositeShapeScenarios: ReadonlyArray<Scenario> = SHAPES.filter((shape) =>
  /shape (2|8a)/.test(shape.name),
).flatMap((shape) =>
  (["sparse", "preserve"] as const).flatMap((policy) =>
    FORMS.slice(0, 2).map((form) => ({
      name: `${shape.name}, ${policy}: ${form.name} of its own composite is refused`,
      run: (h: Harness) =>
        h.on(shapedWorld(shape.index, policy, {}), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(shapedSeed).asEffect()
            const before = yield* probe.rows()
            const sent = probe.sent()
            const error: any = yield* form
              .clear("deviceId")(db.entities.Rows.update(shapedKey))
              .asEffect()
              .pipe(Effect.flip)
            expect(error._tag).toBe("ValidationError")
            expect(String(error.cause)).toMatch(IDENTIFIES)
            expect(probe.sent()).toBe(sent)
            expect(yield* probe.rows()).toEqual(before)
          }),
        ),
    })),
  ),
)

export const allScenarios = {
  refusalScenarios,
  conditionalNameScenarios,
  collidingScenarios,
  clearScenarios,
  lifecycleScenarios,
  emptyValueScenarios,
  refScenarios,
  sparseScenarios,
  createOnMissingScenarios,
  appendScenarios,
}
