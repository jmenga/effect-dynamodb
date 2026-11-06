/**
 * `escapeKeys` is off by default for all of 1.x (#183): a schema that doesn't set it composes the
 * key text 1.36 composed, so upgrading from 1.36 or earlier needs no action. This file is left out
 * of the `test:escape-on` runs, which turn the default over to run everything else under the flag.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "plain", version: 1 })

const Thing = Schema.Struct({
  tenant: Schema.String,
  n: Schema.Number,
  label: Schema.String,
})

const Things = Entity.make({
  model: Thing,
  entityType: "Thing",
  primaryKey: {
    pk: { field: "pk", composite: ["tenant", "n"] },
    sk: { field: "sk", composite: ["label"] },
  },
  indexes: {
    byLabel: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenant"] },
      sk: { field: "gsi1sk", composite: ["label", "n"] },
    },
  },
})

const MainTable = Table.make({ schema, entities: { Things } })

describe("a schema that doesn't set escapeKeys", () => {
  it("is off", () => {
    expect(schema.escapeKeys).toBeUndefined()
    expect(schema.numericKeyText).toBeUndefined()
  })

  it.effect("writes and reads the key text 1.36 composed", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Things }, tables: { MainTable } })
        const key = { tenant: "a b", n: -3, label: "x#y" }
        yield* db.entities.Things.put(key).asEffect()
        const row = table.items.values().next().value!
        expect(row.pk!.S).toBe("$plain#v1#thing#tenant_a b#n_00000000000000-3")
        expect(row.sk!.S).toBe("$plain#v1#thing#label_x#y")
        expect(yield* db.entities.Things.get(key)).toEqual(key)
        yield* db.entities.Things.byLabel({ tenant: "a b", label: "x#y" }).collect()
        const query = table.requests[table.requests.length - 1]!.input
        expect(query.KeyConditionExpression).toContain("begins_with")
      }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "plain" }))))
    }),
  )
})
