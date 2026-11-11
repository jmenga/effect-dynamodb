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
 * Each scenario runs on a recording table (`VectorWriteRaces.test.ts`) and on DynamoDB Local
 * (`connected.vector-write-races.test.ts`).
 */
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Effect, Layer, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
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
