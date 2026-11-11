/**
 * Items deleted and created again under the same key with other values, whose sentinel keys chain
 * across the settings (#240): soft deletes without `preserveUnique` (their tombstones hold no
 * reservation) and with it (each tombstone holds its value's), once and over several cycles. Run
 * over a recording table in every scan order (`RekeyVisitOrder.test.ts`) and on DynamoDB Local
 * (`connected.rekey-reused-keys.test.ts`).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

const Coded = Schema.Struct({ id: Schema.String, code: Schema.String })

export const reusedWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "order", version: 1, escapeKeys })
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const Softs = Entity.make({
    model: Coded,
    entityType: "Soft",
    primaryKey,
    unique: { code: ["code"] },
    softDelete: true,
  })
  const Keeps = Entity.make({
    model: Coded,
    entityType: "Keep",
    primaryKey,
    unique: { code: ["code"] },
    softDelete: { preserveUnique: true },
  })
  const MainTable = Table.make({ schema, entities: { Softs, Keeps } })
  return {
    schema,
    MainTable,
    client: DynamoClient.make({ entities: { Softs, Keeps }, tables: { MainTable } }),
  }
}

/**
 * Each value in turn under `id`, deleted before the next, `tick` apart (a tombstone's key holds
 * its time): the last one is live.
 */
const cycles = (entity: any, id: string, codes: ReadonlyArray<string>, tick: Effect.Effect<void>) =>
  Effect.gen(function* () {
    for (const [i, code] of codes.entries()) {
      yield* entity.put({ id, code }).asEffect()
      if (i < codes.length - 1) {
        yield* entity.delete({ id }).asEffect()
        yield* tick
      }
    }
  })

/**
 * The writes, under `world`'s setting. Under the other one, each live value's current sentinel key
 * is where the value before it was stored, and so on down the cycles: `a b` escapes to where
 * `a%20b` was stored raw, `a%20b` to where `a%2520b` was.
 */
export const writeReusedKeys = (
  world: ReturnType<typeof reusedWorld>,
  tick: Effect.Effect<void>,
): Effect.Effect<void, unknown, DynamoClient | Table.TableConfig> =>
  Effect.gen(function* () {
    const db = yield* world.client
    yield* cycles(db.entities.Softs, "k", ["a%20b", "a b"], tick)
    yield* cycles(db.entities.Softs, "j", ["c%2520d", "c%20d", "c d"], tick)
    yield* cycles(db.entities.Keeps, "k", ["a%20b", "a b"], tick)
    yield* cycles(db.entities.Keeps, "j", ["c%2520d", "c%20d", "c d"], tick)
  }) as never

/** {@link writeReusedKeys}'s rows. */
export const REUSED_ROWS = 17

/** Each sentinel, by its key, and the key it names. */
export const sentinelsOf = (rows: Iterable<Record<string, AttributeValue>>) =>
  [...rows]
    .filter((row) => row.__edd_e__?.S?.includes("._unique.") === true)
    .map((row) => `${row.pk?.S} -> ${row._entity_pk?.S}`)
    .sort()

/** The sentinels once every one is under its current key with escaping on, each naming its item. */
export const SENTINELS_ON = [
  "$order#v1#keep.code#a%20b -> $order#v1#keep#id_k",
  "$order#v1#keep.code#a%2520b -> $order#v1#keep#id_k",
  "$order#v1#keep.code#c%20d -> $order#v1#keep#id_j",
  "$order#v1#keep.code#c%2520d -> $order#v1#keep#id_j",
  "$order#v1#keep.code#c%252520d -> $order#v1#keep#id_j",
  "$order#v1#soft.code#a%20b -> $order#v1#soft#id_k",
  "$order#v1#soft.code#c%20d -> $order#v1#soft#id_j",
]

/**
 * Every live value and every value a tombstone under `preserveUnique` holds, each of which must
 * stay reserved.
 */
export const RESERVED = [
  ["Softs", "a b"],
  ["Softs", "c d"],
  ["Keeps", "a b"],
  ["Keeps", "a%20b"],
  ["Keeps", "c d"],
  ["Keeps", "c%20d"],
  ["Keeps", "c%2520d"],
] as const

/** A `put` of each {@link RESERVED} value by another item: `reserved` when it's refused. */
export const reservedOf = (db: any): Effect.Effect<ReadonlyArray<"reserved" | "free">> =>
  Effect.forEach(RESERVED, ([entity, code]) =>
    Effect.map(
      Effect.exit(db.entities[entity].put({ id: "other", code }).asEffect()),
      (exit: { readonly _tag: string }) => (exit._tag === "Failure" ? "reserved" : "free"),
    ),
  ) as never
