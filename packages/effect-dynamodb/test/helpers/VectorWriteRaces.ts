/**
 * Writes landing between a vector entity's read and a write that copies what it read (#240).
 *
 * `reembed` scans an item, embeds the source text it read, and writes the vector and the partition
 * it composed. Up to 1.40.0 its `UpdateItem` was conditioned on `attribute_exists(#pk)` alone, so an
 * update that changed the text (and embedded it) between the scan and that write was overwritten
 * with the old text's vector, and one that changed a partition composite with the old partition.
 * The write now holds each source field and partition composite as read: such an update cancels
 * it, the item is skipped (not counted), and the update's vector and partition stay.
 *
 * The other way round, `reembed` lands between the read and the write of an operation that reads a
 * versioned item first ({@link copyScenarios}). It stamps no version, so a write guarded on the
 * version alone didn't see it: a soft delete stashed the old vector in its tombstone, and an update
 * too wide for one expression put the item back whole with it. Those two hold the vector and
 * partition attributes as read. A retain delete, and an update writing only what changed, copy
 * no vector, so they lose nothing to it and hold nothing more.
 *
 * Each scenario runs on a recording table (`VectorWriteRaces.test.ts`) and on DynamoDB Local
 * (`connected.vector-write-races.test.ts`).
 */
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Context, Effect, Layer, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import {
  EXPRESSION_MAX_SUBSTITUTION_BYTES,
  substitutionBytes,
} from "../../src/internal/ExpressionLimits.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import type { Harness, RepairTable } from "./RekeyRepair.js"

type Row = Record<string, any>

export interface VectorRaceScenario {
  readonly name: string
  readonly run: (harness: Harness) => Effect.Effect<void, unknown>
}

const DIMENSIONS = 4
const STALE = [0, 0, 0, 1]
/** The embedding of each text the scenarios write. */
const VECTORS: Readonly<Record<string, ReadonlyArray<number>>> = {
  a: [1, 0, 0, 0],
  b: [0, 1, 0, 0],
}
const TextEmbedder = Layer.succeed(Embedder, {
  dimensions: DIMENSIONS,
  embed: (text: string) => Effect.succeed([...(VECTORS[text] ?? [0, 0, 1, 0])]),
})

/**
 * Item `x` of an entity whose vector is embedded from `text`, and, with `partitioned`, partitioned
 * by `tenant`, a field outside its primary key.
 */
const docsWorld = (versioned: boolean, partitioned: boolean) => {
  const schema = DynamoSchema.make({ name: "vecraces", version: 1 })
  const Docs = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      tenant: Schema.String,
      text: Schema.String,
      note: Schema.optionalKey(Schema.String),
    }),
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    ...(versioned && { versioned: true }),
    vectorIndexes: {
      byText: {
        name: "vec1",
        dimensions: DIMENSIONS,
        distance: "cosine",
        source: { fields: ["text"] },
        ...(partitioned && { partition: ["tenant"] }),
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Docs } })
  return {
    MainTable,
    client: DynamoClient.make({ entities: { Docs }, tables: { MainTable } } as never).pipe(
      Effect.provide(TextEmbedder),
    ) as Effect.Effect<any>,
  }
}

const vectorOf = (row: Row): ReadonlyArray<number> =>
  (row.__edd_v_vec1__?.L ?? []).map((n: Row) => Number(n.N))

const live = (rows: ReadonlyArray<Row>) => rows.filter((row) => row.__edd_e__?.S === "Doc")

/** Whether an `UpdateItem` is `reembed`'s: it sets the vector attributes and nothing else. */
const isReembed = (input: Row): boolean => input.UpdateExpression === "SET #v0 = :v0, #v1 = :v1"

/**
 * Seeds item `x` (tenant `t1`, text `a`) with a stale vector, runs `race` just before `reembed`'s
 * write, and returns what `reembed` returned, the item afterwards and the requests `reembed` sent.
 */
const raceReembed = (
  table: RepairTable,
  db: any,
  race: ((db: any) => Effect.Effect<unknown, unknown>) | undefined,
) =>
  Effect.gen(function* () {
    yield* db.entities.Docs.put({ id: "x", tenant: "t1", text: "a" }).withVector("byText", STALE)
    let landed = 0
    table.beforeUpdate((input) => {
      if (race === undefined || !isReembed(input) || landed > 0) return Effect.void
      landed++
      return Effect.asVoid(race(db))
    })
    table.clear()
    const rewritten: number = yield* db.entities.Docs.reembed({ concurrency: 1 })
    const requests = table.requests()
    const rows = live(yield* table.rows())
    expect(rows).toHaveLength(1)
    return { rewritten, row: rows[0]!, landed, requests }
  })

const scenario = (
  name: string,
  versioned: boolean,
  partitioned: boolean,
  body: (table: RepairTable, db: any) => Effect.Effect<void, unknown, any>,
): VectorRaceScenario => ({
  name,
  run: (harness) => {
    const world = docsWorld(versioned, partitioned)
    return harness.on(world, (table) =>
      Effect.gen(function* () {
        yield* body(table, yield* world.client)
      }),
    )
  },
})

export const reembedScenarios: ReadonlyArray<VectorRaceScenario> = [false, true].flatMap(
  (versioned) => {
    const of = versioned ? "a versioned item" : "an item"
    return [
      scenario(
        `reembed of ${of}, an update changing its text in between: skipped, the update's vector kept`,
        versioned,
        false,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, landed } = yield* raceReembed(table, db, (db) =>
              db.entities.Docs.update({ id: "x" }).set({ text: "b" }).asEffect(),
            )
            expect(landed).toBe(1)
            expect(row.text).toEqual({ S: "b" })
            // The update embedded `b`; `reembed` embedded `a`, and lost the race.
            expect(vectorOf(row)).toEqual(VECTORS.b)
            expect(rewritten).toBe(0)
          }),
      ),
      scenario(
        `reembed of ${of}, an update changing its partition composite in between: skipped, the update's partition kept`,
        versioned,
        true,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, landed } = yield* raceReembed(table, db, (db) =>
              db.entities.Docs.update({ id: "x" }).set({ tenant: "t2", text: "a" }).asEffect(),
            )
            expect(landed).toBe(1)
            expect(row.tenant).toEqual({ S: "t2" })
            expect(row.__edd_vp_vec1__.S).toContain("t2")
            expect(vectorOf(row)).toEqual(VECTORS.a)
            expect(rewritten).toBe(0)
          }),
      ),
      scenario(
        `reembed of ${of}, an update leaving its text and partition alone in between: rewritten`,
        versioned,
        true,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, landed } = yield* raceReembed(table, db, (db) =>
              db.entities.Docs.update({ id: "x" }).set({ note: "n" }).asEffect(),
            )
            expect(landed).toBe(1)
            expect(row.note).toEqual({ S: "n" })
            expect(vectorOf(row)).toEqual(VECTORS.a)
            expect(rewritten).toBe(1)
          }),
      ),
      scenario(
        `reembed of ${of}, nobody racing: 1.40.0's request, with the text and partition held as read`,
        versioned,
        true,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, requests } = yield* raceReembed(table, db, undefined)
            expect(rewritten).toBe(1)
            expect(vectorOf(row)).toEqual(VECTORS.a)
            const writes = requests.filter((request) => request.command !== "scan")
            expect(writes.map((request) => request.command)).toEqual(["updateItem"])
            const sent = writes[0]!.input
            expect(sent).toEqual({
              TableName: sent.TableName,
              Key: { pk: row.pk, sk: row.sk },
              UpdateExpression: "SET #v0 = :v0, #v1 = :v1",
              // 1.40.0 sent `attribute_exists(#pk)` alone, and these names and values but the
              // last two of each.
              ConditionExpression: "attribute_exists(#pk) AND #s0 = :s0 AND #s1 = :s1",
              ExpressionAttributeNames: {
                "#pk": "pk",
                "#v0": "__edd_vp_vec1__",
                "#v1": "__edd_v_vec1__",
                "#s0": "text",
                "#s1": "tenant",
              },
              ExpressionAttributeValues: {
                ":v0": row.__edd_vp_vec1__,
                ":v1": row.__edd_v_vec1__,
                ":s0": { S: "a" },
                ":s1": { S: "t1" },
              },
            })
          }),
      ),
    ]
  },
)

// ---------------------------------------------------------------------------
// A `reembed` of an item whose source is too wide for one expression
// ---------------------------------------------------------------------------

/** Fields enough to make an update that sets them all too wide for one expression. */
const WIDE_FIELDS = Array.from({ length: 350 }, (_, i) => `f${i}`)

/** Item `x` of an entity whose vector is embedded from {@link WIDE_FIELDS}, partitioned by `tenant`. */
const wideSourceWorld = (versioned: boolean) => {
  const schema = DynamoSchema.make({ name: "vecwide", version: 1 })
  const Wides = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      tenant: Schema.String,
      note: Schema.optionalKey(Schema.String),
      ...Object.fromEntries(WIDE_FIELDS.map((field) => [field, Schema.String])),
    }),
    entityType: "Wide",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    ...(versioned && { versioned: true }),
    vectorIndexes: {
      byText: {
        name: "vec1",
        dimensions: DIMENSIONS,
        distance: "cosine",
        source: { fields: WIDE_FIELDS },
        partition: ["tenant"],
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Wides } })
  // Text holding `b` embeds as `b`, any other as `a`.
  const embedder = Layer.succeed(Embedder, {
    dimensions: DIMENSIONS,
    embed: (text: string) => Effect.succeed([...(text.includes("b") ? VECTORS.b! : VECTORS.a!)]),
  })
  return {
    MainTable,
    client: DynamoClient.make({ entities: { Wides }, tables: { MainTable } } as never).pipe(
      Effect.provide(embedder),
    ) as Effect.Effect<any>,
  }
}

/**
 * {@link raceReembed} on {@link wideSourceWorld}: item `x` (tenant `t1`, every source field `a`)
 * with a stale vector, `race` just before `reembed`'s write.
 */
const raceWideReembed = (
  table: RepairTable,
  db: any,
  race: ((db: any) => Effect.Effect<unknown, unknown>) | undefined,
) =>
  Effect.gen(function* () {
    const source = Object.fromEntries(WIDE_FIELDS.map((field) => [field, "a"]))
    yield* db.entities.Wides.put({ id: "x", tenant: "t1", ...source }).withVector("byText", STALE)
    let landed = 0
    table.beforeUpdate((input) => {
      if (race === undefined || !isReembed(input) || landed > 0) return Effect.void
      landed++
      return Effect.asVoid(race(db))
    })
    table.clear()
    const rewritten: number = yield* db.entities.Wides.reembed({ concurrency: 1 })
    const requests = table.requests()
    const rows = (yield* table.rows()).filter((row: Row) => row.__edd_e__?.S === "Wide")
    expect(rows).toHaveLength(1)
    return { rewritten, row: rows[0]!, landed, requests }
  })

const wideScenario = (
  name: string,
  versioned: boolean,
  body: (table: RepairTable, db: any) => Effect.Effect<void, unknown, any>,
): VectorRaceScenario => ({
  name,
  run: (harness) => {
    const world = wideSourceWorld(versioned)
    return harness.on(world, (table) =>
      Effect.gen(function* () {
        yield* body(table, yield* world.client)
      }),
    )
  },
})

/**
 * Up to the second fix `reembed` held the source fields that fit one expression and left the rest
 * out, so an update of one left out was overwritten with the old text's vector. Its vector and
 * partition attributes as read now stand in for them.
 */
export const wideSourceScenarios: ReadonlyArray<VectorRaceScenario> = [false, true].flatMap(
  (versioned) => {
    const of = versioned ? "a versioned item" : "an item"
    return [
      wideScenario(
        `reembed of ${of} with 350 source fields, an update changing the last in between: skipped, the update's vector kept`,
        versioned,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, landed } = yield* raceWideReembed(table, db, (db) =>
              db.entities.Wides.update({ id: "x" }).set({ f349: "b" }).asEffect(),
            )
            expect(landed).toBe(1)
            expect(row.f349).toEqual({ S: "b" })
            expect(vectorOf(row)).toEqual(VECTORS.b)
            expect(rewritten).toBe(0)
          }),
      ),
      wideScenario(
        `reembed of ${of} with 350 source fields, an update moving its partition in between: skipped, the update's partition kept`,
        versioned,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, landed } = yield* raceWideReembed(table, db, (db) =>
              db.entities.Wides.update({ id: "x" }).set({ tenant: "t2" }).asEffect(),
            )
            expect(landed).toBe(1)
            expect(row.__edd_vp_vec1__.S).toContain("t2")
            expect(rewritten).toBe(0)
          }),
      ),
      wideScenario(
        `reembed of ${of} with 350 source fields, an update leaving its source and partition alone in between: rewritten`,
        versioned,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, landed } = yield* raceWideReembed(table, db, (db) =>
              db.entities.Wides.update({ id: "x" }).set({ note: "n" }).asEffect(),
            )
            expect(landed).toBe(1)
            expect(row.note).toEqual({ S: "n" })
            expect(vectorOf(row)).toEqual(VECTORS.a)
            expect(rewritten).toBe(1)
          }),
      ),
      wideScenario(
        `reembed of ${of} with 350 source fields, nobody racing: the vector and partition held as read, then the source fields that fit`,
        versioned,
        (table, db) =>
          Effect.gen(function* () {
            const { rewritten, row, requests } = yield* raceWideReembed(table, db, undefined)
            expect(rewritten).toBe(1)
            expect(vectorOf(row)).toEqual(VECTORS.a)
            const writes = requests.filter((request) => request.command !== "scan")
            expect(writes.map((request) => request.command)).toEqual(["updateItem"])
            const sent = writes[0]!.input
            expect(sent.ConditionExpression).toMatch(
              /^attribute_exists\(#pk\) AND #dv0 = :dv0 AND #dv1 = :dv1 AND #s0 = :s0 AND /,
            )
            expect(sent.ExpressionAttributeNames["#dv0"]).toBe("__edd_v_vec1__")
            expect(sent.ExpressionAttributeNames["#dv1"]).toBe("__edd_vp_vec1__")
            expect(sent.ExpressionAttributeValues[":dv0"]).toEqual({
              L: STALE.map((n) => ({ N: String(n) })),
            })
            expect(sent.ExpressionAttributeValues[":dv1"]).toEqual(
              expect.objectContaining({ S: expect.stringContaining("t1") }),
            )
            // Not every source field fits: this is the wide condition.
            const held = new Set(Object.values(sent.ExpressionAttributeNames))
            expect(WIDE_FIELDS.some((field) => !held.has(field))).toBe(true)
          }),
      ),
    ]
  },
)

/**
 * An item whose stored vector alone is past DynamoDB's limit on one expression's substitutions (a
 * row only a table without the 400 KB item limit holds, so a recording table's): neither its source
 * nor its vector fits a condition, so `reembed` fails with a `ValidationError` naming it, and writes
 * nothing.
 */
export const wideSourceUnguardable: VectorRaceScenario = wideScenario(
  "reembed of an item no condition fits: a ValidationError naming it, nothing written",
  false,
  (table, db) =>
    Effect.gen(function* () {
      const source = Object.fromEntries(WIDE_FIELDS.map((field) => [field, "a"]))
      yield* db.entities.Wides.put({ id: "x", tenant: "t1", ...source }).withVector("byText", STALE)
      const [row] = (yield* table.rows()).filter((row: Row) => row.__edd_e__?.S === "Wide")
      const huge = { L: Array.from({ length: 400_000 }, () => ({ N: "0.1234567890123" })) }
      yield* table.seed({ ...row!, __edd_v_vec1__: huge })
      table.clear()
      const exit = yield* Effect.exit(db.entities.Wides.reembed({ concurrency: 1 }))
      expect(exit._tag).toBe("Failure")
      const error = (exit as any).cause.reasons?.[0]?.error ?? (exit as any).cause.failures?.[0]
      expect(error?._tag).toBe("ValidationError")
      expect(error.operation).toBe("reembed")
      expect(String(error.cause)).toContain("vecwide#v1#wide#id_x")
      expect(table.requests().map((request) => request.command)).toEqual(["scan"])
      const [after] = (yield* table.rows()).filter((row: Row) => row.__edd_e__?.S === "Wide")
      expect(after!.__edd_v_vec1__).toEqual(huge)
    }),
)

// ---------------------------------------------------------------------------
// A `reembed` between a read-first write's read and its write
// ---------------------------------------------------------------------------

/**
 * Versioned vector entities, one per write that reads first: a soft delete (`Soft`), a retain
 * delete and update with a unique handle (`Kept`), an update of an index composite (`Count`), and a
 * unique handle's update (`Unique`).
 */
const copiesWorld = () => {
  const schema = DynamoSchema.make({ name: "veccopies", version: 1 })
  const model = Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    handle: Schema.optionalKey(Schema.String),
    count: Schema.optionalKey(Schema.Number),
    note: Schema.optionalKey(Schema.String),
    ...Object.fromEntries(WIDE_FIELDS.map((field) => [field, Schema.optionalKey(Schema.String)])),
  })
  const of = (entityType: string, config: Record<string, unknown>) =>
    Entity.make({
      model,
      entityType,
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
      vectorIndexes: {
        byText: {
          name: "vec1",
          dimensions: DIMENSIONS,
          distance: "cosine",
          source: { fields: ["text"] },
        },
      },
      ...config,
    } as never) as any
  const Softs = of("Soft", { versioned: true, softDelete: true })
  const Kepts = of("Kept", { versioned: { retain: true }, unique: { handle: ["handle"] } })
  const Counts = of("Count", {
    versioned: true,
    indexes: {
      byCount: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["id"] },
        sk: { field: "gsi1sk", composite: ["count"] },
      },
    },
  })
  const Uniques = of("Unique", { versioned: true, unique: { handle: ["handle"] } })
  const entities = { Softs, Kepts, Counts, Uniques }
  const MainTable = Table.make({ schema, entities })
  return {
    MainTable,
    client: DynamoClient.make({ entities, tables: { MainTable } } as never).pipe(
      Effect.provide(TextEmbedder),
    ) as Effect.Effect<any>,
  }
}

const wide = Object.fromEntries(WIDE_FIELDS.map((field) => [field, "w"]))

/** The live row of `entityType` (none after a delete), and its tombstones and snapshots. */
const rowsOf = (rows: ReadonlyArray<Row>, entityType: string) => {
  const own = rows.filter((row) => row.__edd_e__?.S === entityType)
  return {
    live: own.filter((row) => !/#(deleted|v)#/.test(row.sk.S)),
    tombstones: own.filter((row) => /#deleted#/.test(row.sk.S)),
  }
}

/** The condition terms of each request naming a vector or partition attribute. */
const vectorTerms = (requests: ReadonlyArray<{ readonly input: Row }>) =>
  requests.flatMap(({ input }) =>
    [input, ...(input.TransactItems ?? []).map((item: Row) => Object.values(item)[0])].flatMap(
      (action: Row) =>
        Object.entries(action.ExpressionAttributeNames ?? {})
          .filter(([, name]) => /^__edd_vp?_/.test(String(name)))
          .map(([token]) => token),
    ),
  )

/**
 * Puts item `x` of `entity` (text `a`, handle `h`) with a stale vector, then runs `write` with a
 * `reembed` landing just before its `hook`ed request, the first time only: `reembed` writes `a`'s
 * vector. Returns how `write` ended, the rows afterwards, the requests `write` sent and how many
 * `reembed`s landed.
 */
const raceCopy = (
  table: RepairTable,
  db: any,
  entity: string,
  hook: "beforeTransact" | "beforePut" | "beforeUpdate",
  write: (db: any) => Effect.Effect<unknown, unknown, any>,
) =>
  Effect.gen(function* () {
    yield* db.entities[entity]
      .put({ id: "x", text: "a", handle: "h", count: 1 })
      .withVector("byText", STALE)
    let landed = 0
    let embedding = false
    table[hook]((input) => {
      if (landed > 0 || embedding || (hook === "beforeUpdate" && isReembed(input))) {
        return Effect.void
      }
      landed++
      embedding = true
      return Effect.ensuring(
        Effect.asVoid(db.entities[entity].reembed({ concurrency: 1 })),
        Effect.sync(() => {
          embedding = false
        }),
      )
    })
    table.clear()
    const exit = yield* Effect.exit(write(db))
    // What `write` sent: not `reembed`'s scan and update.
    const requests = table
      .requests()
      .filter(
        (request) =>
          request.command !== "scan" &&
          !(request.command === "updateItem" && isReembed(request.input)),
      )
    return { exit, rows: yield* table.rows(), requests, landed }
  })

const failure = (exit: { readonly _tag: string; readonly cause?: any }) =>
  exit._tag === "Success"
    ? undefined
    : (exit.cause.reasons.find((r: any) => r._tag === "Fail") as any)?.error

const copyScenario = (
  name: string,
  body: (table: RepairTable, db: any) => Effect.Effect<void, unknown, any>,
): VectorRaceScenario => ({
  name,
  run: (harness) => {
    const world = copiesWorld()
    return harness.on(world, (table) =>
      Effect.gen(function* () {
        yield* body(table, yield* world.client)
      }),
    )
  },
})

export const copyScenarios: ReadonlyArray<VectorRaceScenario> = [
  copyScenario(
    "a soft delete of a versioned item, a reembed in between: deleted again from a fresh read, the tombstone stashing the new vector",
    (table, db) =>
      Effect.gen(function* () {
        const { exit, rows, landed, requests } = yield* raceCopy(
          table,
          db,
          "Softs",
          "beforeTransact",
          (db) => db.entities.Softs.delete({ id: "x" }).asEffect(),
        )
        expect(landed).toBe(1)
        expect(exit._tag).toBe("Success")
        const { live, tombstones } = rowsOf(rows, "Soft")
        expect(live).toEqual([])
        expect(tombstones).toHaveLength(1)
        // 1.40.0 stashed the vector it read: `restore` would bring the stale one back.
        expect((tombstones[0]!.__edd_vs_vec1__?.L ?? []).map((n: Row) => Number(n.N))).toEqual(
          VECTORS.a,
        )
        // Two attempts, each a read and a transaction holding the vector as read.
        expect(requests.map((request) => request.command)).toEqual([
          "getItem",
          "transactWriteItems",
          "getItem",
          "transactWriteItems",
        ])
        expect(vectorTerms(requests)).toEqual(["#dv0", "#dv1", "#dv0", "#dv1"])
      }),
  ),
  copyScenario(
    "a soft delete with a condition, a reembed in between: fails as a race, and nothing is written",
    (table, db) =>
      Effect.gen(function* () {
        const { exit, rows, landed } = yield* raceCopy(table, db, "Softs", "beforeTransact", (db) =>
          db.entities.Softs.delete({ id: "x" }).condition({ handle: "h" }).asEffect(),
        )
        expect(landed).toBe(1)
        // The caller's condition holds: the race is what failed it, and it says so.
        expect(failure(exit)?._tag).toBe("ConcurrentModification")
        expect(failure(exit)?.attributes).toEqual(["__edd_v_vec1__"])
        const { live, tombstones } = rowsOf(rows, "Soft")
        expect(tombstones).toEqual([])
        expect(vectorOf(live[0]!)).toEqual(VECTORS.a)
      }),
  ),
  copyScenario(
    "a soft delete with a condition in a transaction, a reembed in between: planned again as a race, the tombstone stashing the new vector",
    (table, db) =>
      Effect.gen(function* () {
        const { exit, rows, landed } = yield* raceCopy(table, db, "Softs", "beforeTransact", (db) =>
          Transaction.transactWrite([
            db.entities.Softs.delete({ id: "x" }).condition({ handle: "h" }),
          ]),
        )
        expect(landed).toBe(1)
        // The caller's condition held: the race failed it, so it is planned again, never
        // reported as the condition.
        expect(exit._tag).toBe("Success")
        const { live, tombstones } = rowsOf(rows, "Soft")
        expect(live).toEqual([])
        expect((tombstones[0]!.__edd_vs_vec1__?.L ?? []).map((n: Row) => Number(n.N))).toEqual(
          VECTORS.a,
        )
      }),
  ),
  copyScenario(
    "a retain update too wide for one expression, a reembed in between: fails as a race, the new vector kept",
    (table, db) =>
      Effect.gen(function* () {
        const { exit, rows, landed, requests } = yield* raceCopy(
          table,
          db,
          "Kepts",
          "beforeTransact",
          (db) => db.entities.Kepts.update({ id: "x" }).set(wide).asEffect(),
        )
        expect(landed).toBe(1)
        expect(failure(exit)?._tag).toBe("ConcurrentModification")
        expect(failure(exit)?.attributes).toEqual(["__edd_v_vec1__"])
        const { live } = rowsOf(rows, "Kept")
        // 1.40.0 put the item back whole, with the vector it read.
        expect(vectorOf(live[0]!)).toEqual(VECTORS.a)
        expect(live[0]!.f0).toBeUndefined()
        expect(vectorTerms(requests)).toEqual(["#dv0", "#dv1"])
      }),
  ),
  copyScenario(
    "an index composite's update too wide for one expression, a reembed in between: fails as a race, the new vector kept",
    (table, db) =>
      Effect.gen(function* () {
        const { exit, rows, landed, requests } = yield* raceCopy(
          table,
          db,
          "Counts",
          "beforePut",
          (db) => db.entities.Counts.update({ id: "x" }).set(wide).add({ count: 1 }).asEffect(),
        )
        expect(landed).toBe(1)
        expect(failure(exit)?._tag).toBe("ConcurrentModification")
        const { live } = rowsOf(rows, "Count")
        expect(vectorOf(live[0]!)).toEqual(VECTORS.a)
        expect(live[0]!.count).toEqual({ N: "1" })
        expect(requests.map((request) => request.command)).toEqual(["getItem", "putItem"])
        expect(vectorTerms(requests)).toEqual(["#dv0", "#dv1"])
      }),
  ),
  copyScenario(
    "a wide update that embeds its own text, a reembed in between: its own vector wins, nothing more held",
    (table, db) =>
      Effect.gen(function* () {
        const { exit, rows, landed, requests } = yield* raceCopy(
          table,
          db,
          "Kepts",
          "beforeTransact",
          (db) =>
            db.entities.Kepts.update({ id: "x" })
              .set({ ...wide, text: "b" })
              .asEffect(),
        )
        expect(landed).toBe(1)
        expect(exit._tag).toBe("Success")
        const { live } = rowsOf(rows, "Kept")
        expect(vectorOf(live[0]!)).toEqual(VECTORS.b)
        expect(vectorTerms(requests)).toEqual([])
      }),
  ),
  copyScenario(
    "a retain delete, a reembed in between: deleted, its snapshot holding no vector, so nothing more is held",
    (table, db) =>
      Effect.gen(function* () {
        const { exit, rows, landed, requests } = yield* raceCopy(
          table,
          db,
          "Kepts",
          "beforeTransact",
          (db) => db.entities.Kepts.delete({ id: "x" }).asEffect(),
        )
        expect(landed).toBe(1)
        expect(exit._tag).toBe("Success")
        const own = rows.filter((row) => row.__edd_e__?.S === "Kept")
        expect(own.map((row) => row.sk.S)).toEqual([expect.stringContaining("#v#")])
        expect(own[0]!.__edd_v_vec1__).toBeUndefined()
        expect(vectorTerms(requests)).toEqual([])
      }),
  ),
  ...(
    [
      ["a retain update", "Kepts"],
      ["a unique handle's update", "Uniques"],
    ] as const
  ).map(([what, entity]) =>
    copyScenario(
      `${what} writing only what changed, a reembed in between: updated, the new vector kept, nothing more held`,
      (table, db) =>
        Effect.gen(function* () {
          const { exit, rows, landed, requests } = yield* raceCopy(
            table,
            db,
            entity,
            "beforeTransact",
            (db) => db.entities[entity].update({ id: "x" }).set({ handle: "k" }).asEffect(),
          )
          expect(landed).toBe(1)
          expect(exit._tag).toBe("Success")
          const { live } = rowsOf(rows, entity === "Kepts" ? "Kept" : "Unique")
          expect(live[0]!.handle).toEqual({ S: "k" })
          expect(vectorOf(live[0]!)).toEqual(VECTORS.a)
          expect(vectorTerms(requests)).toEqual([])
        }),
    ),
  ),
]

// ---------------------------------------------------------------------------
// The vector terms fit beside the caller's condition, or aren't sent
// ---------------------------------------------------------------------------

/** The substitution bytes of the conditioned action of each request `write` sent. */
const conditionSubstitutions = (requests: ReadonlyArray<{ readonly input: Row }>) =>
  requests.flatMap(({ input }) =>
    [input, ...(input.TransactItems ?? []).map((item: Row) => Object.values(item)[0])]
      .filter((action: Row) => action.ConditionExpression !== undefined)
      .map((action: Row) => {
        const tokens = new Set<string>(action.ConditionExpression.match(/[#:][A-Za-z0-9_]+/g) ?? [])
        const used = (entries: Row = {}) =>
          Object.fromEntries(Object.entries(entries).filter(([token]) => tokens.has(token)))
        return {
          bytes: substitutionBytes(
            used(action.ExpressionAttributeNames),
            used(action.ExpressionAttributeValues),
          ),
          vector: substitutionBytes(
            Object.fromEntries(
              Object.entries(
                (action.ExpressionAttributeNames ?? {}) as Record<string, string>,
              ).filter(([, name]) => /^__edd_vp?_/.test(name)),
            ),
            Object.fromEntries(
              Object.entries((action.ExpressionAttributeValues ?? {}) as Row).filter(([token]) =>
                /^:dv\d+$/.test(token),
              ),
            ),
          ),
        }
      }),
  )

/**
 * A write copying the vector from its read, under a caller's condition holding `pad` in a value:
 * once with a short pad, to measure the condition with the vector terms, then with a pad that
 * leaves the condition one byte under DynamoDB's substitution limit without them. The vector terms
 * don't fit beside it, so the write holds the version alone, as 1.40.0 sent it, and stays within
 * the limit.
 */
const besideCondition = (
  name: string,
  entity: "Softs" | "Counts",
  write: (db: any, pad: string) => Effect.Effect<unknown, unknown, any>,
): VectorRaceScenario =>
  copyScenario(name, (table, db) =>
    Effect.gen(function* () {
      const sent = (pad: string, id: string) =>
        Effect.gen(function* () {
          yield* db.entities[entity]
            .put({ id, text: "a", handle: "h", count: 1 })
            .withVector("byText", STALE)
          table.clear()
          yield* write(db, pad).pipe(Effect.provideService(Id, id))
          return table.requests()
        })
      const measured = conditionSubstitutions(yield* sent("", "x"))
      expect(measured).toHaveLength(1)
      expect(measured[0]!.vector).toBeGreaterThan(1)
      const room = EXPRESSION_MAX_SUBSTITUTION_BYTES - (measured[0]!.bytes - measured[0]!.vector)
      const requests = yield* sent("p".repeat(room - 1), "y")
      expect(vectorTerms(requests)).toEqual([])
      const [action] = conditionSubstitutions(requests)
      expect(action!.bytes).toBe(EXPRESSION_MAX_SUBSTITUTION_BYTES - 1)
    }),
  )

/** The item a {@link besideCondition} write names. */
class Id extends Context.Service<Id, string>()("test/VectorWriteRaces/Id") {}

export const budgetScenarios: ReadonlyArray<VectorRaceScenario> = [
  besideCondition(
    "a soft delete under a condition filling the substitutions: the version alone, as 1.40.0 sent it",
    "Softs",
    (db, pad) =>
      Effect.gen(function* () {
        const id = yield* Id
        yield* db.entities.Softs.delete({ id })
          .condition((t: any, { or, eq }: any) => or(eq(t.handle, "h"), eq(t.note, pad)))
          .asEffect()
      }),
  ),
  besideCondition(
    "a wide update under a condition filling the substitutions: the version alone, as 1.40.0 sent it",
    "Counts",
    (db, pad) =>
      Effect.gen(function* () {
        const id = yield* Id
        yield* db.entities.Counts.update({ id })
          .set(wide)
          .add({ count: 1 })
          .condition((t: any, { or, eq }: any) => or(eq(t.handle, "h"), eq(t.note, pad)))
          .asEffect()
      }),
  ),
]
