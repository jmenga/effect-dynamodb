/**
 * What an aggregate `create` hydrates from an edge's `entity`, and the key it fetches each id by.
 * The shapes are `fixtures/ref-hydration-1.39.0.json`'s, which published 1.39.0 ran against DynamoDB
 * Local: there, a `many` element that is the entity's own model, given whole, was taken for a ref by
 * its `lineId`, every entity without a `DynamoModel.identifier` was fetched under `id`, and one
 * whose identifier is another field under that field, so `create` died composing the entity's key.
 * Each now writes the rows 1.39.0 wrote for the same shape over an entity whose identifier is its
 * key, and an entity no one id keys fails with `EDD-9129`.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  byKey,
  CONTROLS,
  fixture,
  SHAPES,
  type Shape,
  schema,
  UNFETCHABLE,
  WRITES_AS,
} from "./helpers/RefHydrationShapes.js"

type Row = Record<string, AttributeValue>

/** Seeds the entity's rows, then runs `create` and `get` on a recording table. */
const run = (shape: Shape) => {
  const table = makeRecordingTable()
  const Base = Table.make({ schema, entities: shape.entities } as never) as any
  const A = shape.make(Base)
  const Tb = { ...Base, aggregates: { A } }
  return Effect.gen(function* () {
    const edb: any = yield* DynamoClient.make({
      entities: shape.entities,
      tables: { Base },
    } as never) as Effect.Effect<any>
    for (const item of shape.seed) yield* edb.entities.Lines.put(item).asEffect()
    table.take()
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { A },
      tables: { Tb },
    } as never) as Effect.Effect<any>
    const create = yield* Effect.exit(db.aggregates.A.create(shape.input) as Effect.Effect<unknown>)
    const requests = table.take().map((request) => request.command)
    const rows = [...table.items.values()] as unknown as ReadonlyArray<Row>
    const get = yield* Effect.exit(db.aggregates.A.get({ id: "a" }) as Effect.Effect<unknown>)
    return { create, requests, rows, get }
  }).pipe(
    Effect.provide(Base.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<{
    create: Exit.Exit<unknown, unknown>
    requests: ReadonlyArray<string>
    rows: ReadonlyArray<Row>
    get: Exit.Exit<unknown, unknown>
  }>
}

describe("aggregate create hydrates an edge's entity by the key its id is", () => {
  it("covers every shape the fixture holds, generated from published 1.39.0", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.39.0")
    expect(Object.keys(SHAPES).sort()).toEqual(Object.keys(fixture.shapes).sort())
  })

  for (const [label, writesAs] of Object.entries(WRITES_AS)) {
    it.effect(`${label}: writes the rows 1.39.0 wrote with its identifier on the key`, () =>
      Effect.gen(function* () {
        const { create, rows, get } = yield* run(SHAPES[label]!())
        expect(Exit.isSuccess(create)).toBe(true)
        expect(byKey(rows)).toEqual(byKey(fixture.shapes[writesAs]!.rows))
        expect(Exit.isSuccess(get) && JSON.stringify(get.value)).toBe(
          fixture.shapes[writesAs]!.get.replace(/^ok /, ""),
        )
        expect(fixture.shapes[label]!.create).toMatch(
          /^died: Missing composite attribute "lineId" in record/,
        )
      }),
    )
  }

  it.effect(
    "many, element the entity's struct, given whole: stored as given, nothing fetched",
    () =>
      Effect.gen(function* () {
        const label = "many, element the entity's struct, given whole"
        const { create, requests, rows, get } = yield* run(SHAPES[label]!())
        expect(Exit.isSuccess(create)).toBe(true)
        expect(requests).not.toContain("BatchGetItem")
        expect(byKey(rows)).toEqual([
          {
            pk: { S: "$hydrate#v1#agg#a" },
            sk: { S: "$hydrate#v1#aggline#l" },
            lineId: { S: "l" },
            f: { N: "5" },
            __edd_e__: { S: "AggLine" },
          },
          {
            pk: { S: "$hydrate#v1#agg#a" },
            sk: { S: "$hydrate#v1#root" },
            id: { S: "a" },
            __edd_e__: { S: "Root" },
          },
        ])
        expect(Exit.isSuccess(get) && get.value).toEqual({
          id: "a",
          lines: [{ lineId: "l", f: 5 }],
        })
        // 1.39.0 took the element's own `lineId` for an id to fetch.
        expect(fixture.shapes[label]!.create).toMatch(
          /^died: Missing composite attribute "lineId" in record/,
        )
        expect(fixture.shapes[label]!.rows).toEqual([])
      }),
  )

  for (const label of CONTROLS) {
    it.effect(`${label}: writes and reads what 1.39.0 did`, () =>
      Effect.gen(function* () {
        const { create, rows, get } = yield* run(SHAPES[label]!())
        expect(Exit.isSuccess(create) && `ok ${JSON.stringify(create.value)}`).toBe(
          fixture.shapes[label]!.create,
        )
        expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.rows))
        expect(Exit.isSuccess(get) && `ok ${JSON.stringify(get.value)}`).toBe(
          fixture.shapes[label]!.get,
        )
      }),
    )
  }

  for (const label of UNFETCHABLE) {
    it.effect(`${label}: create fails with EDD-9129, nothing fetched or written`, () =>
      Effect.gen(function* () {
        const shape = SHAPES[label]!()
        const { create, requests, rows } = yield* run(shape)
        expect(Exit.isFailure(create)).toBe(true)
        const error = Cause.squash((create as Exit.Failure<unknown, unknown>).cause)
        expect(error).toBeInstanceOf(ValidationError)
        const message = String((error as ValidationError).cause)
        expect(message).toContain("[EDD-9129]")
        expect(message).toContain('"line"')
        expect(message).toContain(
          'entity "Line", whose primary key is composed from "tenant", "lineId"',
        )
        expect(requests).toEqual([])
        expect(rows).toHaveLength(1)
        expect(fixture.shapes[label]!.create).toMatch(
          /^died: Missing composite attribute "tenant" in record/,
        )
      }),
    )
  }
})
