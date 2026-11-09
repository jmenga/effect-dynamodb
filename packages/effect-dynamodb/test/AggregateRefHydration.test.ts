/**
 * What an aggregate `create` hydrates from an edge's `entity`, and the key it fetches each id by.
 * The shapes are `fixtures/ref-hydration-1.39.0.json`'s, which published 1.39.0 ran against DynamoDB
 * Local: there, a `many` element that is the entity's own model, given whole, was taken for a ref by
 * its `lineId`, every entity without a `DynamoModel.identifier` was fetched under `id`, and one
 * whose identifier is another field under that field, so `create` died composing the entity's key.
 * Each now writes the rows 1.39.0 wrote for the same shape over an entity whose identifier is its
 * key, and an entity no one id keys fails with `EDD-9129`.
 *
 * Shapes 1.39.0 hydrated as it should (a union element wrapping the entity, at the root and in a
 * sub-aggregate, its discriminator nullable or its union nested; a key composite in both halves of
 * the key; a `Date` key given its ISO string; a `NumberFromString` key, alone or in a wrapper, given
 * its encoded string) write and read exactly what 1.39.0 did. An id of the key composite's own type
 * that 1.39.0 dropped (a number, a bigint, a number for an optional `NumberFromString`) or fetched
 * under a key `Entity.put` never wrote (a string codec) is now fetched by the key `put` wrote; an
 * id of no type of the key composite (`"5"` for a number), or one no item is keyed by (`Infinity`),
 * fails with `EDD-9131`. Every refusal comes before any request. A union element is read as the
 * member it is, so one whose member declares the entity's field a string keeps it, where 1.39.0
 * replaced it with the fetched entity.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  aggregate,
  byKey,
  CONTROLS,
  fixture,
  json,
  lineClass,
  lines,
  NOW_FETCHED,
  nestedSheet,
  SHAPES,
  type Shape,
  schema,
  sharedDiscriminator,
  singleKey,
  UNFETCHABLE,
  UNKEYABLE,
  WRITES_AS,
} from "./helpers/RefHydrationShapes.js"

type Row = Record<string, AttributeValue>
type Request = { readonly command: string; readonly input: any }

/** The keys a recorded `BatchGetItem` asked for. */
const batchGetKeys = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.command === "BatchGetItem")
    .flatMap((request) =>
      Object.values(
        request.input.RequestItems as Record<string, { Keys: ReadonlyArray<Row> }>,
      ).flatMap((entry) => entry.Keys),
    )

/** The key of a row: its `pk` and `sk`. */
const keyOf = (row: Row) => ({ pk: row.pk, sk: row.sk })

/**
 * The `ValidationError` a failed `create` failed with, and its message. An id is a caller's input,
 * so it is refused on the error channel, never as a defect.
 */
const refusal = (create: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(create)).toBe(true)
  const cause = (create as Exit.Failure<unknown, unknown>).cause
  expect(Cause.hasDies(cause)).toBe(false)
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  expect(error).toBeInstanceOf(ValidationError)
  return String((error as ValidationError).cause)
}

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
    for (const [member, item] of shape.seed) yield* edb.entities[member].put(item).asEffect()
    table.take()
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { A },
      tables: { Tb },
    } as never) as Effect.Effect<any>
    const create = yield* Effect.exit(db.aggregates.A.create(shape.input) as Effect.Effect<unknown>)
    const sent = table.take() as unknown as ReadonlyArray<Request>
    const requests = sent.map((request) => request.command)
    const rows = [...table.items.values()] as unknown as ReadonlyArray<Row>
    const get = yield* Effect.exit(db.aggregates.A.get({ id: "a" }) as Effect.Effect<unknown>)
    return { create, requests, sent, rows, get }
  }).pipe(
    Effect.provide(Base.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<{
    create: Exit.Exit<unknown, unknown>
    requests: ReadonlyArray<string>
    sent: ReadonlyArray<Request>
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
        expect(Exit.isSuccess(get) && json(get.value)).toBe(
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
        const { create, sent, rows, get } = yield* run(SHAPES[label]!())
        expect(Exit.isSuccess(create) && `ok ${json(create.value)}`).toBe(
          fixture.shapes[label]!.create,
        )
        // Fetched by the key 1.39.0's own `put` wrote for the seeded entity.
        expect(batchGetKeys(sent)).toEqual(
          fixture.shapes[label]!.seeded.filter((row) => row.__edd_e__?.S === "Line").map(keyOf),
        )
        expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.rows))
        expect(Exit.isSuccess(get) && `ok ${json(get.value)}`).toBe(fixture.shapes[label]!.get)
      }),
    )
  }

  for (const label of UNFETCHABLE) {
    it.effect(`${label}: create fails with EDD-9129, nothing fetched or written`, () =>
      Effect.gen(function* () {
        const shape = SHAPES[label]!()
        const { create, requests, rows } = yield* run(shape)
        const message = refusal(create)
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

  for (const label of NOW_FETCHED) {
    it.effect(`${label}: fetched by the key Entity.put wrote, which 1.39.0 missed`, () =>
      Effect.gen(function* () {
        const { create, requests, sent, rows, get } = yield* run(SHAPES[label]!())
        expect(Exit.isSuccess(create)).toBe(true)
        expect(requests).toEqual(["BatchGetItem", "TransactWriteItems"])
        const seeded = fixture.shapes[label]!.seeded
        expect(batchGetKeys(sent)).toEqual(seeded.map(keyOf))
        // The edge's row holds the entity's attributes as `put` stored them.
        const edge = rows.find((row) => row.__edd_e__?.S === "AggLine")!
        expect({ lineId: edge.lineId, f: edge.f }).toEqual({
          lineId: seeded[0]!.lineId,
          f: seeded[0]!.f,
        })
        expect(Exit.isSuccess(get)).toBe(true)
        // 1.39.0 dropped the id (a required edge failed decoding, an optional one was created
        // without it), or fetched under a key `put` never wrote.
        expect(fixture.shapes[label]!.create).toMatch(
          /^(failed: ValidationError|failed: RefNotFound|ok \{"id":"a"\})$/,
        )
      }),
    )
  }

  it.effect("an id of no type of the key composite fails with EDD-9131, nothing fetched", () =>
    Effect.gen(function* () {
      const label = "one, an entity keyed by a number, given a numeric string"
      const { create, requests, rows } = yield* run(SHAPES[label]!())
      const message = refusal(create)
      expect(message).toContain("[EDD-9131]")
      expect(message).toContain('"lineId" is given "5"')
      expect(message).toContain('entity "Line" is keyed by')
      expect(requests).toEqual([])
      expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.seeded))
      // 1.39.0 fetched `lineid_5`, a key no `put` of 5 writes.
      expect(fixture.shapes[label]!.create).toBe("failed: RefNotFound")
    }),
  )

  for (const [label, given] of Object.entries(UNKEYABLE)) {
    it.effect(`${label}: create fails with EDD-9131, nothing fetched or written`, () =>
      Effect.gen(function* () {
        const { create, requests, rows } = yield* run(SHAPES[label]!())
        const message = refusal(create)
        expect(message).toContain("[EDD-9131]")
        expect(message).toContain(`"lineId" ${given}`)
        expect(message).toContain("Nothing was fetched or written.")
        expect(requests).toEqual([])
        expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.seeded))
        // 1.39.0 also refused it, but only after fetching or composing a key from it.
        expect(fixture.shapes[label]!.create).toBe("failed: ValidationError")
      }),
    )
  }

  it.effect("an infinite id is refused as put refuses it: no item is keyed by it", () =>
    Effect.gen(function* () {
      const message = refusal(
        (yield* run(SHAPES["one, an entity keyed by a number, given Infinity"]!())).create,
      )
      expect(message).toContain("DynamoDB stores no infinite number")
      expect(message).toContain('so `put` refuses one for "lineId"')
    }),
  )

  it.effect(
    "an element a member of which declares the entity's field a scalar, sharing its discriminator, is stored as given",
    () =>
      Effect.gen(function* () {
        const label =
          "many, element members sharing a discriminator, one declaring the entity's field a string and its id"
        const { create, requests, rows, get } = yield* run(SHAPES[label]!())
        const expected = { id: "a", lines: [{ kind: "a", line: "KEEP", lineId: "l", qty: 1 }] }
        expect(Exit.isSuccess(create) && create.value).toEqual(expected)
        expect(requests).toEqual(["TransactWriteItems"])
        const sheet = rows.find((row) => row.__edd_e__?.S === "SheetLine")!
        expect({ line: sheet.line, lineId: sheet.lineId }).toEqual({
          line: { S: "KEEP" },
          lineId: { S: "l" },
        })
        expect(Exit.isSuccess(get) && get.value).toEqual(expected)
        // The input schema takes it as that member too.
        const A = SHAPES[label]!().make(
          Table.make({ schema, entities: SHAPES[label]!().entities } as never),
        ) as any
        expect(Schema.decodeUnknownSync(A.inputSchema)(expected)).toEqual({
          lines: expected.lines,
        })
        // 1.39.0 replaced the scalar it was given with the fetched entity.
        expect(fixture.shapes[label]!.create).toBe(
          'ok {"id":"a","lines":[{"kind":"a","line":{"lineId":"l","f":5},"qty":1}]}',
        )
      }),
  )

  it.effect("members sharing a discriminator, the one wrapping the entity first: hydrated", () =>
    Effect.gen(function* () {
      const shape = sharedDiscriminator(true)
      const { create, requests } = yield* run(shape)
      expect(Exit.isSuccess(create) && create.value).toEqual({
        id: "a",
        lines: [{ kind: "a", line: { lineId: "l", f: 5 }, qty: 1 }],
      })
      expect(requests).toEqual(["BatchGetItem", "TransactWriteItems"])
      // As the input schema takes it: by the first member that does.
      const A = shape.make(Table.make({ schema, entities: shape.entities } as never)) as any
      expect(Schema.decodeUnknownSync(A.inputSchema)(shape.input)).toEqual({
        lines: [{ kind: "a", lineId: "l", qty: 1 }],
      })
    }),
  )

  it("a nested union element: the input and create schemas take the id where create does", () => {
    const { Line, model } = lineClass(true)
    const Lines = lines(model, singleKey)
    const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(nestedSheet(Line)) })
    const A = aggregate(Model, Table.make({ schema, entities: { Lines } } as never), {
      lines: Aggregate.many({
        entityType: "SheetLine",
        entity: Lines,
        sk: { composite: ["qty"] },
      } as never),
    }) as any
    const input = {
      lines: [
        { kind: "a", lineId: "l", qty: 1 },
        { kind: "b", qty: 2 },
        { kind: "b", lineId: "l", qty: 3 },
        { kind: "c", line: "label", qty: 4 },
      ],
    }
    for (const derived of [A.inputSchema, A.createSchema]) {
      expect(Schema.decodeUnknownSync(derived)(input)).toEqual(input)
      expect(Schema.encodeUnknownSync(derived)(input)).toEqual(input)
      // A member wrapping the entity takes its id, not the entity.
      expect(() =>
        Schema.decodeUnknownSync(derived)({
          lines: [{ kind: "a", line: { lineId: "l", f: 5 }, qty: 1 }],
        }),
      ).toThrow()
    }
  })

  it("a nullable discriminator: the input schema takes the id in the member it names", () => {
    const label = "many, element a union with a nullable discriminator"
    const shape = SHAPES[label]!()
    const A = shape.make(Table.make({ schema, entities: shape.entities } as never)) as any
    expect(Schema.decodeUnknownSync(A.inputSchema)({ lines: shape.input.lines })).toEqual({
      lines: shape.input.lines,
    })
  })

  it.effect("an edge no one id names is refused before any other edge is fetched", () =>
    Effect.gen(function* () {
      const label = "one and one, the second an entity keyed by two composites"
      const { create, requests, rows } = yield* run(SHAPES[label]!())
      const message = refusal(create)
      expect(message).toContain("[EDD-9129]")
      expect(message).toContain('"pair" is given an id of entity "Pair"')
      expect(message).toContain('composed from "tenant", "lineId"')
      expect(requests).toEqual([])
      expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.seeded))
      expect(fixture.shapes[label]!.create).toMatch(
        /^died: Missing composite attribute "tenant" in record/,
      )
    }),
  )

  it.effect("an element declaring the entity's field a scalar holds no ref: stored as given", () =>
    Effect.gen(function* () {
      const label = "many, element declares the entity's field a string, given it and a lineId"
      const { create, requests, rows, get } = yield* run(SHAPES[label]!())
      expect(Exit.isSuccess(create) && create.value).toEqual({
        id: "a",
        lines: [{ line: "label", qty: 2 }],
      })
      expect(requests).toEqual(["TransactWriteItems"])
      const sheet = rows.find((row) => row.__edd_e__?.S === "SheetLine")!
      expect(sheet.line).toEqual({ S: "label" })
      expect(sheet.lineId).toBeUndefined()
      expect(Exit.isSuccess(get) && get.value).toEqual({
        id: "a",
        lines: [{ line: "label", qty: 2 }],
      })
      // 1.39.0 fetched the line by that `lineId`, put the record in `line`, and failed decoding.
      expect(fixture.shapes[label]!.create).toBe("failed: ValidationError")
    }),
  )

  it.effect("an element declaring the entity's field a scalar is not given it by id", () =>
    Effect.gen(function* () {
      const { model } = lineClass(true)
      const Lines = lines(model, singleKey)
      const Sheet = Schema.Struct({ line: Schema.String, qty: Schema.Number })
      const shape: Shape = {
        entities: { Lines },
        make: (base) =>
          aggregate(Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) }), base, {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["qty"] },
            } as never),
          }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input: { id: "a", lines: [{ lineId: "l", qty: 2 }] },
      }
      const { create, requests } = yield* run(shape)
      expect(refusal(create)).toContain('["line"]')
      expect(requests).toEqual([])
    }),
  )

  it.effect("a union element is judged by the member its discriminator names", () =>
    Effect.gen(function* () {
      const { Line, model } = lineClass(true)
      const Lines = lines(model, singleKey)
      const Sheet = Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("a"),
          line: Line.pipe(DynamoModel.ref),
          qty: Schema.Number,
        }),
        Schema.Struct({ kind: Schema.Literal("b"), line: Schema.String, qty: Schema.Number }),
      ])
      const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
      const shape: Shape = {
        entities: { Lines },
        make: (base) =>
          aggregate(Model, base, {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["qty"] },
            } as never),
          }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input: {
          id: "a",
          lines: [
            { kind: "a", lineId: "l", qty: 1 },
            { kind: "b", line: "label", lineId: "l", qty: 2 },
          ],
        },
      }
      const { create, requests } = yield* run(shape)
      expect(Exit.isSuccess(create) && create.value).toEqual({
        id: "a",
        lines: [
          { kind: "a", line: { lineId: "l", f: 5 }, qty: 1 },
          { kind: "b", line: "label", qty: 2 },
        ],
      })
      expect(requests).toEqual(["BatchGetItem", "TransactWriteItems"])
      // The input schema takes the id in the member holding the entity, and the value in the other.
      const A = shape.make(Table.make({ schema, entities: shape.entities } as never)) as any
      expect(Schema.decodeUnknownSync(A.inputSchema)(shape.input)).toEqual({
        lines: [
          { kind: "a", lineId: "l", qty: 1 },
          { kind: "b", line: "label", qty: 2 },
        ],
      })
    }),
  )

  it.effect("ids composing one key (casing) are fetched once, each element hydrated", () =>
    Effect.gen(function* () {
      const { Line, model } = lineClass(true)
      const Lines = lines(model, singleKey)
      const Sheet = Schema.Struct({ line: Line.pipe(DynamoModel.ref), qty: Schema.Number })
      const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) })
      const shape: Shape = {
        entities: { Lines },
        make: (base) =>
          aggregate(Model, base, {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["qty"] },
            } as never),
          }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input: {
          id: "a",
          lines: [
            { lineId: "l", qty: 1 },
            { lineId: "L", qty: 2 },
          ],
        },
      }
      const { create, sent } = yield* run(shape)
      expect(Exit.isSuccess(create) && create.value).toEqual({
        id: "a",
        lines: [
          { line: { lineId: "l", f: 5 }, qty: 1 },
          { line: { lineId: "l", f: 5 }, qty: 2 },
        ],
      })
      // `BatchGetItem` refuses a repeated key.
      expect(batchGetKeys(sent)).toHaveLength(1)
    }),
  )
})
