/**
 * `DynamoClient.make` checks an entity made with `@effect-dynamodb/schema`'s pure `Entity.make` as
 * it checks one made with `effect-dynamodb`'s (#265): its checks run on the entity the client
 * promotes the definition to. Up to the fix they read the definition as given, so a pure entity
 * passed both of these and failed later, or read its rows wrong:
 *
 * - `EDD-9078`: a packed field's codec that no `Compression` registers;
 * - `EDD-9140`: the table's TTL attribute, which the entity writes, read as a sparse map's entry.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

/** How `DynamoClient.make` refuses to bind `Docs`: the defect's message. */
const refusal = (Docs: unknown, ttlAttributeName?: string) =>
  Effect.gen(function* () {
    const MainTable = Table.make({
      schema: DynamoSchema.make({ name: "checks", version: 1 }),
      entities: { Docs: Docs as never },
    })
    const exit = yield* Effect.exit(
      DynamoClient.make({ entities: { Docs: Docs as never }, tables: { MainTable } }).pipe(
        Effect.provide(
          Layer.merge(
            mockDynamoClientLayer({}),
            MainTable.layer({ name: "t", ...(ttlAttributeName && { ttlAttributeName }) }),
          ),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return ""
    expect(exit.cause.reasons[0]!._tag).toBe("Die")
    return String(Cause.squash(exit.cause))
  })

describe("DynamoClient.make checks a pure definition as an operational entity (#265)", () => {
  it.effect("a packed field's codec no Compression registers (EDD-9078)", () =>
    Effect.gen(function* () {
      const docs = {
        model: DynamoModel.configure(
          Schema.Struct({ id: Schema.String, body: Schema.Struct({ text: Schema.String }) }),
          {
            body: {
              storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
            },
          },
        ),
        entityType: "Doc",
        primaryKey,
      } as const
      const pure = yield* refusal(PureEntity.make(docs))
      expect(pure).toContain("[EDD-9078]")
      expect(pure).toBe(yield* refusal(Entity.make(docs)))
    }),
  )

  it.effect("the table's TTL attribute read as a sparse map's entry (EDD-9140)", () =>
    Effect.gen(function* () {
      const docs = {
        model: DynamoModel.configure(
          Schema.Struct({ id: Schema.String, data: Schema.Record(Schema.String, Schema.Number) }),
          { data: { storedAs: DynamoModel.SparseMap() } },
        ),
        entityType: "Doc",
        primaryKey,
        softDelete: { ttl: "1 day" },
      } as const
      const pure = yield* refusal(PureEntity.make(docs), "data#expires")
      expect(pure).toContain("[EDD-9140]")
      expect(pure).toBe(yield* refusal(Entity.make(docs), "data#expires"))
    }),
  )
})
