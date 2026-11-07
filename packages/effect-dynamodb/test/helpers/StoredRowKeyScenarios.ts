/**
 * Keys composed from a row read back. A field stored as `N` whose Encoded side is a `bigint` comes
 * back from the unmarshaller as a number while it is a safe integer (past 2^53, as a `bigint`), so
 * every path composing a key, sentinel or partition from a stored row has to take it back to the
 * value `put` composed from. Each scenario puts an item, takes it through one such path and asserts
 * that every key the path leaves (primary, index, unique sentinel, vector partition, history
 * segment) is byte-identical to what the put wrote, and that the item reads back.
 *
 * Run on a recording table (`StoredRowKeys.test.ts`) and on DynamoDB Local
 * (`connected.stored-row-keys.test.ts`), through a {@link Harness}.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Cause, Effect, Exit, Layer, Option, Schema, SchemaGetter } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { makeRecordingTable } from "./RecordingTable.js"

export type StoredRow = Record<string, AttributeValue>

/** What a scenario needs of a table: one physical table, the layer to reach it, and its rows. */
export interface Harness {
  readonly on: <A, E>(
    definition: Table.Table,
    body: (
      name: string,
      rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown>,
    ) => Effect.Effect<A, E, DynamoClient>,
  ) => Effect.Effect<A, unknown>
}

export interface Scenario {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

/** An in-memory table: answered by the recording table, conditions evaluated. */
export const recordingHarness: Harness = {
  on: (_definition, body) => {
    const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
    const rows = () => Effect.sync(() => structuredClone([...table.items.values()]) as StoredRow[])
    return body("t", rows).pipe(Effect.provide(table.layer)) as never
  },
}

let connectedTables = 0

/** DynamoDB at `endpoint`, a fresh table per scenario. */
export const connectedHarness = (endpoint: string): Harness => {
  const ClientLayer = DynamoClient.layer({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  })
  return {
    on: (definition, body) => {
      const tableName = `stored-row-keys-${Date.now()}-${connectedTables++}`
      return Effect.gen(function* () {
        const raw = yield* DynamoClient
        const rows = () =>
          Effect.gen(function* () {
            const found: Array<StoredRow> = []
            let start: StoredRow | undefined
            do {
              const page = yield* raw.scan({
                TableName: tableName,
                ConsistentRead: true,
                ...(start === undefined ? {} : { ExclusiveStartKey: start }),
              })
              found.push(...((page.Items ?? []) as Array<StoredRow>))
              start = page.LastEvaluatedKey as StoredRow | undefined
            } while (start !== undefined)
            return found
          })
        // DynamoDB Local discards `VectorIndexes` and then rejects the attribute definitions only
        // they named, so both go: the vector partition is an attribute like any other here.
        const { VectorIndexes: _vectors, ...physical } = Table.definition(definition) as ReturnType<
          typeof Table.definition
        > & { readonly VectorIndexes?: unknown }
        const named = new Set(
          [
            ...(physical.KeySchema ?? []),
            ...(physical.GlobalSecondaryIndexes ?? []).flatMap((index) => index.KeySchema ?? []),
          ].map((element) => element.AttributeName),
        )
        return yield* Effect.acquireUseRelease(
          raw.createTable({
            TableName: tableName,
            BillingMode: "PAY_PER_REQUEST",
            ...physical,
            AttributeDefinitions: (physical.AttributeDefinitions ?? []).filter((attribute) =>
              named.has(attribute.AttributeName),
            ),
          }),
          () => body(tableName, rows),
          () => raw.deleteTable({ TableName: tableName }).pipe(Effect.ignore),
        )
      }).pipe(Effect.provide(ClientLayer)) as never
    },
  }
}

/** 2^60 + 1: past the safe integers, so the unmarshaller hands it back as a `bigint`. */
export const BIG = 2n ** 60n + 1n

/** A key composite's schema, and the value a caller gives for a `bigint`. */
interface Shape {
  readonly name: string
  readonly schema: Schema.Top
  readonly given: (value: bigint) => unknown
}

const SHAPES: ReadonlyArray<Shape> = [
  { name: "Schema.BigInt", schema: Schema.BigInt, given: (value) => value },
  {
    name: "OptionFromNullOr(BigInt)",
    schema: Schema.OptionFromNullOr(Schema.BigInt),
    given: (value) => Option.some(value),
  },
  {
    name: "a BigInt under a decoding default",
    schema: Schema.BigInt.pipe(Schema.withDecodingDefault(Effect.succeed(7n))),
    given: (value) => value,
  },
]

const VALUES: ReadonlyArray<readonly [string, bigint]> = [
  ["5", 5n],
  ["2^60+1", BIG],
]

/** A bigint carried through a struct: what a field no key reads may hold. */
const StepToStruct = Schema.BigInt.pipe(
  Schema.decodeTo(Schema.Struct({ y: Schema.BigInt }), {
    decode: SchemaGetter.transform((value: bigint) => ({ y: value })),
    encode: SchemaGetter.transform((value: { readonly y: bigint }) => value.y),
  }),
)

/** A bound op as an Effect: builders convert, an Effect is one already. */
const run = (op: any): Effect.Effect<any, unknown, any> =>
  typeof op?.asEffect === "function" ? op.asEffect() : op

const show = (value: unknown) =>
  JSON.stringify(value, (_, inner) => (typeof inner === "bigint" ? `${inner}n` : inner))

const isHistory = (sk: string) => /#v#|#deleted#|#e#/.test(sk)

/** The keys a type's rows hold: the live row's key attributes and its sentinels. */
const keysOf = (rows: ReadonlyArray<StoredRow>, type: string): Record<string, string> => {
  const keys: Record<string, string> = {}
  for (const row of rows) {
    const t = row.__edd_e__?.S ?? ""
    if (t === type && !isHistory(row.sk!.S!)) {
      for (const [attribute, value] of Object.entries(row)) {
        if (
          ["pk", "sk", "gsi1pk", "gsi1sk"].includes(attribute) ||
          attribute.startsWith("__edd_vp_")
        ) {
          keys[attribute] = value.S!
        }
      }
    } else if (t.startsWith(`${type}._unique.`)) {
      keys[t] = `${row.pk!.S}|${row.sk!.S}`
    }
  }
  return keys
}

/** Each history row of `type` carries the live sort key's composite part as its item segment. */
const expectSegments = (rows: ReadonlyArray<StoredRow>, type: string, liveSk: string) => {
  const item = liveSk.split("#").slice(3).join("#")
  for (const row of rows) {
    if (row.__edd_e__?.S !== type || !isHistory(row.sk!.S!)) continue
    const sk = row.sk!.S!
    expect(sk.includes(`#v#${item}#`) || sk.includes(`#deleted#${item}#`)).toBe(true)
  }
}

const shapeScenarios = (shape: Shape, label: string, value: bigint): ReadonlyArray<Scenario> => {
  const n = shape.given(value)
  const item = {
    id: "a",
    line: "l 1",
    n,
    o: Option.some(value),
    ok: Option.some(value),
    f: Option.some({ b: value }),
    st: { y: value },
    seq: 1,
  }
  const key = { id: "a", n }
  const Model = Schema.Struct({
    id: Schema.String,
    line: Schema.String,
    n: shape.schema,
    // Fields no key reads, each stored in a form a read takes back to its value.
    o: Schema.OptionFromNullOr(Schema.BigInt),
    ok: Schema.OptionFromOptionalKey(Schema.BigInt),
    f: Schema.OptionFromNullOr(Schema.Struct({ b: Schema.BigInt })),
    st: StepToStruct,
    note: Schema.optional(Schema.String),
    seq: Schema.NumberFromString,
  })
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: ["n"] },
  } as const
  const byN = {
    byN: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["id"] },
      sk: { field: "gsi1sk", composite: ["n"] },
    },
  } as const
  const entities = () => ({
    B: Entity.make({ model: Model, entityType: "B", primaryKey } as never) as any,
    D: Entity.make({
      model: Model,
      entityType: "D",
      primaryKey,
      indexes: byN,
      softDelete: true,
    } as never) as any,
    RD: Entity.make({
      model: Model,
      entityType: "RD",
      primaryKey,
      versioned: { retain: true },
      softDelete: true,
    } as never) as any,
    R: Entity.make({
      model: Model,
      entityType: "R",
      primaryKey,
      indexes: byN,
      versioned: { retain: true },
    } as never) as any,
    U: Entity.make({
      model: Model,
      entityType: "U",
      primaryKey,
      unique: { byN: ["n"] },
    } as never) as any,
    UR: Entity.make({
      model: Model,
      entityType: "UR",
      primaryKey,
      unique: { byN: ["n"] },
      versioned: { retain: true },
    } as never) as any,
    V: Entity.make({
      model: Model,
      entityType: "Vec",
      primaryKey,
      vectorIndexes: {
        byNote: {
          name: "vec1",
          dimensions: 2,
          distance: "cosine",
          // An update of one source field reads the item for the others.
          source: { fields: ["note", "line"] },
          partition: ["n"],
        },
      },
    } as never) as any,
    G: Entity.make({ model: Model, entityType: "G", primaryKey, indexes: byN } as never) as any,
    K: Entity.make({
      model: Model,
      entityType: "K",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: ["line", "n"] },
      },
    } as never) as any,
  })
  const plain = entities()
  const escaped = entities()
  // Unescaped whatever the run's default, so rekey has rows to move.
  const schema = DynamoSchema.make({ name: "srk", version: 1, escapeKeys: false })
  const Main = Table.make({ schema, entities: plain } as never) as Table.Table
  const Escaped = Table.make({
    schema: DynamoSchema.make({ name: "srk", version: 1, escapeKeys: true }),
    entities: escaped,
  } as never) as Table.Table
  const Line = Schema.Struct({ lineId: Schema.String, k: shape.schema })
  const Team = Schema.Struct({
    id: Schema.String,
    n: shape.schema,
    cust: Schema.String,
    note: Schema.optional(Schema.String),
    lines: Schema.Array(Line),
  })
  const Teams = (Aggregate.make as any)(Team, {
    table: Main,
    schema,
    pk: { field: "pk", composite: ["id", "n"] },
    collection: { name: "team" },
    list: {
      index: "gsi1",
      name: "teams",
      pk: { field: "gsi1pk", composite: ["cust"] },
      sk: { field: "gsi1sk", composite: ["n"] },
    },
    root: { entityType: "Team" },
    edges: { lines: Aggregate.many({ entityType: "TeamLine", sk: { composite: ["lineId"] } }) },
  })
  const embedder = Layer.succeed(Embedder, {
    dimensions: 2,
    embed: () => Effect.succeed([1, 0]),
  } as never)

  /** A typed client over `table`, at the harness's physical table. */
  const client = <A, E>(
    name: string,
    table: Table.Table,
    members: Record<string, unknown>,
    body: (db: any) => Effect.Effect<A, E, any>,
  ) =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: members,
        aggregates: { Teams },
        tables: { Main: table },
      } as never) as Effect.Effect<any, never, any>
      return yield* body(db)
    }).pipe(Effect.provide(Layer.merge(table.layer({ name }), embedder))) as Effect.Effect<
      A,
      E,
      DynamoClient
    >

  /** Every field reads back as it was put. */
  const readsBack = (got: any) => {
    expect(show(got.n)).toBe(show(n))
    expect(show(got.o)).toBe(show(item.o))
    expect(show(got.ok)).toBe(show(item.ok))
    expect(show(got.f)).toBe(show(item.f))
    expect(show(got.st)).toBe(show(item.st))
  }

  const at = `${shape.name}, ${label}`
  const scenario = (
    name: string,
    body: (
      db: any,
      rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown>,
      name: string,
    ) => Effect.Effect<void, unknown, any>,
  ): Scenario => ({
    name: `${at}: ${name}`,
    run: (h) =>
      h.on(Main, (table, rows) => client(table, Main, plain, (db) => body(db, rows, table))),
  })

  return [
    ...["D", "RD"].map((type) =>
      scenario(`restore (${type}) puts back the keys put wrote`, (db, rows) =>
        Effect.gen(function* () {
          const entity = db.entities[type]
          yield* entity.put(item).asEffect()
          const written = keysOf(yield* rows(), type)
          yield* entity.delete(key).asEffect()
          expectSegments(yield* rows(), type, written.sk!)
          yield* run(entity.restore(key))
          expect(keysOf(yield* rows(), type)).toEqual(written)
          expectSegments(yield* rows(), type, written.sk!)
          readsBack(yield* entity.get(key))
        }),
      ),
    ),
    scenario(
      "a retained update, patch and transactional update keep the keys put wrote",
      (db, rows) =>
        Effect.gen(function* () {
          yield* db.entities.R.put(item).asEffect()
          const written = keysOf(yield* rows(), "R")
          for (const write of [
            () => db.entities.R.update(key).set({ note: "u" }).asEffect(),
            () => db.entities.R.patch(key).set({ note: "p" }).asEffect(),
            () => Transaction.transactWrite([db.entities.R.update(key).set({ note: "t" })]),
          ]) {
            yield* write()
            expect(keysOf(yield* rows(), "R")).toEqual(written)
            expectSegments(yield* rows(), "R", written.sk!)
            readsBack(yield* db.entities.R.get(key))
          }
          const versions = yield* db.entities.R.versions(key).collect()
          expect(versions).toHaveLength(3)
          for (const version of versions) readsBack(version)
          const scanned = yield* db.entities.R.scan().collect()
          expect(scanned).toHaveLength(1)
          readsBack(scanned[0])
          const found = yield* db.entities.R.byN({ id: "a" })
            .where((t: any, { eq }: any) => eq(t.n, n))
            .collect()
          expect(found).toHaveLength(1)
        }),
    ),
    ...["U", "UR"].map((type) =>
      scenario(
        `a unique field's sentinel (${type}) stays where put wrote it, and a delete releases it`,
        (db, rows) =>
          Effect.gen(function* () {
            const entity = db.entities[type]
            yield* entity.put(item).asEffect()
            const written = keysOf(yield* rows(), type)
            expect(Object.keys(written).some((k) => k.startsWith(`${type}._unique.`))).toBe(true)
            yield* entity.update(key).set({ note: "u" }).asEffect()
            expect(keysOf(yield* rows(), type)).toEqual(written)
            yield* Transaction.transactWrite([entity.update(key).set({ note: "t" })])
            expect(keysOf(yield* rows(), type)).toEqual(written)
            readsBack(yield* entity.get(key))
            yield* entity.delete(key).asEffect()
            // The sentinel is released, not left holding the value.
            expect(keysOf(yield* rows(), type)).toEqual({})
            yield* entity.put(item).asEffect()
            expect(keysOf(yield* rows(), type)).toEqual(written)
          }),
      ),
    ),
    scenario("a vector partition is recomposed as put composed it", (db, rows) =>
      Effect.gen(function* () {
        yield* db.entities.V.put({ ...item, note: "x" }).asEffect()
        const written = keysOf(yield* rows(), "Vec")
        expect(Object.keys(written).some((k) => k.startsWith("__edd_vp_"))).toBe(true)
        yield* db.entities.V.update(key).set({ note: "y" }).asEffect()
        expect(keysOf(yield* rows(), "Vec")).toEqual(written)
        readsBack(yield* db.entities.V.get(key))
      }),
    ),
    scenario("Batch.get and transactGet find the item put wrote", (db) =>
      Effect.gen(function* () {
        yield* db.entities.B.put(item).asEffect()
        const [batched] = yield* Batch.get([db.entities.B.get(key)])
        readsBack(batched)
        const [transacted] = yield* Transaction.transactGet([db.entities.B.get(key)])
        readsBack(transacted)
      }),
    ),
    scenario(
      "an aggregate keeps its keys through update, and get, list and delete find it",
      (db, rows) =>
        Effect.gen(function* () {
          const team = { id: "a", n, cust: "c", lines: [{ lineId: "l1", k: n }] }
          const teamKeys = (found: ReadonlyArray<StoredRow>) =>
            found
              .filter((row) => row.__edd_e__?.S === "Team" || row.__edd_e__?.S === "TeamLine")
              .map((row) => [row.pk?.S, row.sk?.S, row.gsi1pk?.S, row.gsi1sk?.S].join("|"))
              .sort()
          yield* db.aggregates.Teams.create(team)
          const written = teamKeys(yield* rows())
          expect(written).toHaveLength(2)
          yield* db.aggregates.Teams.update({ id: "a", n }, ({ state }: any) => ({
            ...state,
            note: "u",
          }))
          expect(teamKeys(yield* rows())).toEqual(written)
          const got = yield* db.aggregates.Teams.get({ id: "a", n })
          expect(show(got.n)).toBe(show(n))
          expect(show(got.lines[0].k)).toBe(show(n))
          const listed = yield* db.aggregates.Teams.list({ cust: "c" })
          expect(listed.data).toHaveLength(1)
          expect(show(listed.data[0].n)).toBe(show(n))
          yield* db.aggregates.Teams.delete({ id: "a", n })
          expect(teamKeys(yield* rows())).toEqual([])
        }),
    ),
    {
      name: `${at}: rekey moves a row and puts back its index key, as put writes them`,
      run: (h) =>
        h.on(Main, (table, rows) =>
          Effect.gen(function* () {
            const gWritten = yield* client(table, Main, plain, (db) =>
              Effect.gen(function* () {
                yield* db.entities.G.put(item).asEffect()
                yield* db.entities.K.put(item).asEffect()
                return keysOf(yield* rows(), "G")
              }),
            )
            // Take the index key off G's row, as a writer before #185 could leave it.
            const {
              gsi1pk: _pk,
              gsi1sk: _sk,
              ...g
            } = (yield* rows()).find((row) => row.__edd_e__?.S === "G")!
            const raw = yield* DynamoClient
            yield* raw.putItem({ TableName: table, Item: g })
            yield* client(table, Escaped, escaped, (db) =>
              Effect.gen(function* () {
                const report = yield* db.tables.Main.rekey({ repairIndexKeys: true })
                expect(report.conflicts).toEqual([])
                expect(report.moved.item).toBe(1)
                expect(report.indexKeys.repaired).toBe(2)
                expect(keysOf(yield* rows(), "G")).toEqual(gWritten)
                const moved = keysOf(yield* rows(), "K")
                expect(moved.sk).toContain("line_l%201")
                // A put of the same item lands on the row rekey moved: the same key, byte for byte.
                yield* db.entities.K.put(item).asEffect()
                expect((yield* rows()).filter((row) => row.__edd_e__?.S === "K")).toHaveLength(1)
                expect(keysOf(yield* rows(), "K")).toEqual(moved)
                readsBack(yield* db.entities.K.get({ ...key, line: item.line }))
              }),
            )
          }),
        ),
    },
  ]
}

const shapes: ReadonlyArray<Scenario> = SHAPES.flatMap((shape) =>
  VALUES.flatMap(([label, value]) => shapeScenarios(shape, label, value)),
)

/** A row holding a composite no form of its schema takes: rekey reports it and leaves it. */
const uncomposable: Scenario = {
  name: "rekey reports a row whose composite has no key form, and leaves it where it is",
  run: (h) => {
    const Model = Schema.Struct({ id: Schema.String, n: Schema.OptionFromNullOr(Schema.BigInt) })
    const Rows = Entity.make({
      model: Model,
      entityType: "Row",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["n"] } },
      versioned: { retain: true },
      softDelete: true,
    } as never) as any
    const Main = Table.make({
      schema: DynamoSchema.make({ name: "srk", version: 1, escapeKeys: true }),
      entities: { Rows },
    } as never) as Table.Table
    const row = {
      pk: { S: "$srk#v1#row#id_a" },
      sk: { S: "$srk#v1#row#n_abc" },
      id: { S: "a" },
      n: { S: "abc" },
      __edd_e__: { S: "Row" },
    }
    // Its version snapshot and a tombstone hold the same value: each is reported as what it is.
    const snapshot = { ...row, sk: { S: "$srk#v1#row#v#n_abc#0000001" } }
    const tombstone = { ...row, sk: { S: "$srk#v1#row#deleted#n_abc#2026-01-01T00:00:00.000Z" } }
    return h.on(Main, (table, rows) =>
      Effect.gen(function* () {
        const raw = yield* DynamoClient
        for (const item of [row, snapshot, tombstone]) {
          yield* raw.putItem({ TableName: table, Item: item })
        }
        const before = yield* rows()
        const report: any = yield* Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Rows },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          return yield* db.tables.Main.rekey()
        }).pipe(Effect.provide(Main.layer({ name: table }))) as Effect.Effect<
          unknown,
          unknown,
          never
        >
        const conflict = (kind: string, stored: StoredRow) => ({
          member: "Row",
          kind,
          reason: "uncomposable",
          key: { pk: stored.pk!.S, sk: stored.sk!.S },
          target: undefined,
          message: expect.stringMatching(/^Its values compose no key: \[EDD-9050\] Composite "n"/),
        })
        expect(report.conflicts).toHaveLength(3)
        expect(report.conflicts).toEqual(
          expect.arrayContaining([
            conflict("item", row),
            conflict("snapshot", snapshot),
            conflict("tombstone", tombstone),
          ]),
        )
        expect(report.byMember.Row?.conflicts).toBe(3)
        expect(report.skipped.unrecognizedKey).toBe(0)
        expect(yield* rows()).toEqual(before)
      }),
    )
  },
}

/** The write failed with EDD-9050 naming `attribute`. */
const refused = (exit: Exit.Exit<unknown, unknown>, attribute: string) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(String(Cause.squash(exit.cause))).toContain(`[EDD-9050] Composite "${attribute}"`)
  }
}

/**
 * An attribute a key is composed from: an index's partition key composite, and those that aren't
 * a table or index composite (a unique field, a vector partition, a time-series `orderBy`).
 * Holding a value no form of its schema takes, it is refused like a sort key composite, never
 * composed as it is.
 */
const readers: ReadonlyArray<Scenario> = (() => {
  const Model = Schema.Struct({
    id: Schema.String,
    line: Schema.String,
    u: Schema.OptionFromNullOr(Schema.BigInt),
    at: Schema.BigIntFromString,
    note: Schema.optional(Schema.String),
  })
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const entities = () => ({
    Uq: Entity.make({
      model: Model,
      entityType: "Uq",
      primaryKey,
      unique: { byU: ["u"] },
      versioned: { retain: true },
    } as never) as any,
    Vp: Entity.make({
      model: Model,
      entityType: "Vp",
      primaryKey,
      vectorIndexes: {
        byNote: {
          name: "vec1",
          dimensions: 2,
          distance: "cosine",
          source: { fields: ["note", "line"] },
          partition: ["u"],
        },
      },
    } as never) as any,
    Ts: Entity.make({
      model: Model,
      entityType: "Ts",
      primaryKey,
      timeSeries: { orderBy: "at", appendInput: Model },
    } as never) as any,
    Gp: Entity.make({
      model: Model,
      entityType: "Gp",
      primaryKey,
      indexes: {
        byU: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["u"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
      versioned: { retain: true },
    } as never) as any,
  })
  const plain = entities()
  const escaped = entities()
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "srk", version: 1, escapeKeys: false }),
    entities: plain,
  } as never) as Table.Table
  const Escaped = Table.make({
    schema: DynamoSchema.make({ name: "srk", version: 1, escapeKeys: true }),
    entities: escaped,
  } as never) as Table.Table
  const item = { id: "a", line: "l", u: Option.some(5n), at: 1n, note: "x" }
  const embedder = Layer.succeed(Embedder, {
    dimensions: 2,
    embed: () => Effect.succeed([1, 0]),
  } as never)
  const client = <A, E>(
    name: string,
    table: Table.Table,
    members: Record<string, unknown>,
    body: (db: any) => Effect.Effect<A, E, any>,
  ) =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: members,
        tables: { Main: table },
      } as never) as Effect.Effect<any, never, any>
      return yield* body(db)
    }).pipe(Effect.provide(Layer.merge(table.layer({ name }), embedder))) as Effect.Effect<
      A,
      E,
      DynamoClient
    >
  /** Put the item, then store `attribute` as text no form of its schema takes. */
  const corrupt = (
    name: string,
    rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown>,
    type: string,
    attribute: string,
  ) =>
    Effect.gen(function* () {
      yield* client(name, Main, plain, (db) => db.entities[type].put(item).asEffect())
      const row = (yield* rows()).find((r) => r.__edd_e__?.S === type && !isHistory(r.sk!.S!))!
      const raw = yield* DynamoClient
      yield* raw.putItem({ TableName: name, Item: { ...row, [attribute]: { S: "abc" } } })
      return yield* rows()
    })
  return [
    ["Uq", "a unique field"],
    ["Vp", "a vector partition"],
    ["Gp", "an index's partition key composite"],
  ]
    .map(
      ([type, what]): Scenario => ({
        name: `${what} holding a value no form takes refuses the update, writing nothing`,
        run: (h) =>
          h.on(Main, (name, rows) =>
            Effect.gen(function* () {
              const before = yield* corrupt(name, rows, type!, "u")
              const exit = yield* Effect.exit(
                client(name, Main, plain, (db) =>
                  db.entities[type!].update({ id: "a" }).set({ note: "y" }).asEffect(),
                ),
              )
              refused(exit, "u")
              expect(yield* rows()).toEqual(before)
            }),
          ),
      }),
    )
    .concat({
      name: "a time-series orderBy holding a value no form takes is a row rekey can't compose",
      run: (h) =>
        h.on(Main, (name, rows) =>
          Effect.gen(function* () {
            const current = yield* corrupt(name, rows, "Ts", "at")
            // An event under the item, holding the same value.
            const item = current.find((r) => r.__edd_e__?.S === "Ts")!
            const raw = yield* DynamoClient
            yield* raw.putItem({
              TableName: name,
              Item: { ...item, sk: { S: `${item.sk!.S}#e#abc` } },
            })
            const before = yield* rows()
            const report: any = yield* client(name, Escaped, escaped, (db) =>
              db.tables.Main.rekey(),
            )
            const conflict = (kind: string) =>
              expect.objectContaining({
                member: "Ts",
                kind,
                reason: "uncomposable",
                message: expect.stringContaining('[EDD-9050] Composite "at"'),
              })
            expect(report.conflicts).toHaveLength(2)
            expect(report.conflicts).toEqual(
              expect.arrayContaining([conflict("item"), conflict("event")]),
            )
            expect(yield* rows()).toEqual(before)
          }),
        ),
    })
})()

/** An index added after the entity first asked which attributes keys are composed from. */
const injectedIndex: Scenario = {
  name: "an index added later: its partition key composite is refused too",
  run: (h) => {
    const Model = Schema.Struct({
      id: Schema.String,
      u: Schema.OptionFromNullOr(Schema.BigInt),
      note: Schema.optional(Schema.String),
    })
    const primaryKey = {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    } as const
    const Late = Entity.make({
      model: Model,
      entityType: "Late",
      primaryKey,
      versioned: { retain: true },
    } as never) as any
    const Indexed = Entity.make({
      model: Model,
      entityType: "Late",
      primaryKey,
      indexes: {
        byU: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["u"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
    } as never) as any
    const Main = Table.make({
      schema: DynamoSchema.make({ name: "srk", version: 1, escapeKeys: false }),
      entities: { Late },
    } as never) as Table.Table
    return h.on(Main, (name, rows) => {
      const run = (body: (db: any) => Effect.Effect<unknown, unknown, any>) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Late },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          return yield* body(db)
        }).pipe(Effect.provide(Main.layer({ name }))) as Effect.Effect<unknown, unknown, never>
      const note = (value: string) => (db: any) =>
        db.entities.Late.update({ id: "a" }).set({ note: value }).asEffect()
      return Effect.gen(function* () {
        yield* run((db) =>
          db.entities.Late.put({ id: "a", u: Option.some(5n), note: "x" }).asEffect(),
        )
        const row = (yield* rows()).find((r) => r.__edd_e__?.S === "Late" && !isHistory(r.sk!.S!))!
        const raw = yield* DynamoClient
        yield* raw.putItem({ TableName: name, Item: { ...row, u: { S: "abc" } } })
        // No key is composed from `u` yet: the update reads the row, asks, and leaves `u` as it is.
        // It's applied (the row it returns doesn't decode).
        yield* Effect.exit(run(note("y")))
        const updated = (yield* rows()).find(
          (r) => r.__edd_e__?.S === "Late" && !isHistory(r.sk!.S!),
        )!
        expect(updated.note).toEqual({ S: "y" })
        Late._injectIndex("byU", Indexed.indexes.byU)
        const before = yield* rows()
        refused(yield* Effect.exit(run(note("z"))), "u")
        expect(yield* rows()).toEqual(before)
      })
    })
  },
}

export const allScenarios: Readonly<Record<string, ReadonlyArray<Scenario>>> = {
  "a key composed from a row read back is the key put composed": shapes,
  "a row rekey can't compose a key for": [uncomposable],
  "an attribute a key is composed from is refused like a composite": [...readers, injectedIndex],
}
