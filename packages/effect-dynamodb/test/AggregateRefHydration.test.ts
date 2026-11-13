/**
 * What an aggregate `create` hydrates from an edge's `entity`, and the key it fetches each id by.
 * The shapes are `fixtures/ref-hydration-1.39.0.json`'s, which published 1.39.0 ran against DynamoDB
 * Local: there, a `many` element that is the entity's own model, given whole, was taken for a ref by
 * its `lineId`, every entity without a `DynamoModel.identifier` was fetched under `id`, and one
 * whose identifier is another field under that field, so `create` died composing the entity's key.
 * Each now writes the rows 1.39.0 wrote for the same shape over an entity whose identifier is its
 * key, and an entity no one id keys fails with `EDD-9129`.
 *
 * Shapes 1.39.0 hydrated as it should (a key composite in both halves of the key; a `Date` key given
 * its ISO string; a `NumberFromString` key, alone or in a wrapper, given its encoded string) write
 * and read exactly what 1.39.0 did. An id of the key composite's own type that 1.39.0 dropped (a
 * number, a bigint, a number for an optional `NumberFromString`) or fetched under a key
 * `Entity.put` never wrote (a string codec) is now fetched by the key `put` wrote; an id of no type
 * of the key composite (`"5"` for a number), or one no item is keyed by (`Infinity`), fails with
 * `EDD-9131`, as does one `put` refuses deeper in it (`Infinity` in a struct, an `Option` or a
 * `Result`), whose key text names an item of another value, or one that doesn't encode as `put`
 * stores it. Every refusal comes before any request.
 *
 * A `many` element's id is of the key composite's type only where the element's definition says it
 * holds the entity: the element is the entity, or a plain struct or class whose field of the
 * entity's name is the entity's own model (under `optional` at most) and which declares no `lineId`
 * itself. Every other element is judged as 1.39.0 judged it: a string `lineId` is fetched, whatever
 * the element declares, and its input is as 1.39.0's. So every union shape (through a
 * transformation or `suspend` too) and every element declaring the entity's field another schema
 * fetches, writes and reads what 1.39.0 did, but for a string id of no type of the key composite
 * (`EDD-9131`). A `NumberFromString` id given an infinity as its encoded string, which `put` stores,
 * is fetched as 1.39.0 fetched it.
 *
 * An element is the entity only when its schema is the entity's own model, by reference: a class of
 * the entity's identifier is another schema, and sends, writes and reads what 1.39.0 did. A `one`
 * edge's id follows the rule a `many` element's does: a string is fetched as on 1.39.0, and an id of
 * another type is never fetched where the model declares it, or where the entity is given whole,
 * which is stored as given with the requests 1.39.0 sent. An id given more than once is judged once.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Option, Schema, SchemaAST, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import {
  aggregate,
  byKey,
  CONTROLS,
  EIGHTH,
  fixture,
  JUDGED_AS_139,
  json,
  KEYED_TWICE_BY_139,
  keyedBy,
  keyedOnce,
  lineClass,
  lines,
  NINTH,
  NOW_FETCHED,
  OWN_KEY_WHOLE,
  outcomeOf,
  SHAPES,
  type Shape,
  SIXTH,
  schema,
  sharedDiscriminator,
  singleKey,
  stringIds,
  UNFETCHABLE,
  UNIONS,
  UNKEYABLE,
  UNSTORABLE,
  unescapedSchema,
  WRITES_AS,
} from "./helpers/RefHydrationShapes.js"

type Row = Record<string, AttributeValue>

/** `put` of the shape's entity, an item of it given, on a recording table. */
const runPut = (shape: Shape, item: Record<string, unknown>) => {
  const table = makeRecordingTable()
  const Base = Table.make({
    schema: shape.schema ?? schema,
    entities: shape.entities,
  } as never) as any
  return Effect.gen(function* () {
    const edb: any = yield* DynamoClient.make({
      entities: shape.entities,
      tables: { Base },
    } as never) as Effect.Effect<any>
    return yield* Effect.exit(edb.entities.Lines.put(item).asEffect() as Effect.Effect<unknown>)
  }).pipe(
    Effect.provide(Base.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<Exit.Exit<unknown, unknown>>
}
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

/** How many `BatchGetItem` requests were sent. */
const fetches = (requests: ReadonlyArray<string>) =>
  requests.filter((command) => command === "BatchGetItem").length

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

/**
 * Seeds the entity's rows, then runs `create` and `get` on a recording table. A row keyed by an object
 * can't be written since 1.41.0 (`EDD-9162`: every such key is `[object Object]`), so where `put`
 * refuses one, the rows are the ones 1.39.0's `put` wrote (`written`, none where nothing is fetched);
 * any other refusal fails the shape.
 */
const run = (shape: Shape, written?: ReadonlyArray<Row>) => {
  const table = makeRecordingTable()
  const Base = Table.make({
    schema: shape.schema ?? schema,
    entities: shape.entities,
  } as never) as any
  const A = shape.make(Base)
  const Tb = { ...Base, aggregates: { A } }
  return Effect.gen(function* () {
    const edb: any = yield* DynamoClient.make({
      entities: shape.entities,
      tables: { Base },
    } as never) as Effect.Effect<any>
    for (const [member, item] of shape.seed) {
      const seeded = yield* Effect.exit(edb.entities[member].put(item).asEffect())
      if (Exit.isSuccess(seeded)) continue
      const refused = Cause.squash(seeded.cause) as { readonly cause?: unknown }
      if (!String(refused?.cause).includes("EDD-9162") || written === undefined) {
        return yield* Effect.die(refused)
      }
      for (const row of written) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row as never)
    }
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
        const written = fixture.shapes[label]!.seeded
        // 1.39.0 keyed a codec `encode` takes on its own output by its stored text encoded once more.
        expect(written.some((row) => row.pk!.S!.includes("x:x:"))).toBe(
          KEYED_TWICE_BY_139.has(label),
        )
        const seeded = KEYED_TWICE_BY_139.has(label) ? written.map(keyedOnce) : written
        expect(byKey(rows.filter((row) => row.__edd_e__?.S === "Line"))).toEqual(byKey(seeded))
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
      expect(message).toContain("`put` refuses it, as DynamoDB can't store it")
      expect(message).toContain('"lineId": Special numeric value Infinity is not allowed.')
      expect(message).toContain("[EDD-9124]")
    }),
  )

  for (const given of [Infinity, -Infinity]) {
    it.effect(`an id that doesn't encode as put stores it (${given}) fails with EDD-9131`, () =>
      Effect.gen(function* () {
        // A digits-only string, decoded to a number: an infinity is a number no string encodes.
        const Digits = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transform(Number),
            encode: SchemaGetter.transform(String),
          }),
        )
        const shape = keyedBy(Digits, 5, given)()
        const { create, requests } = yield* run(shape)
        const message = refusal(create)
        expect(message).toContain("[EDD-9131]")
        expect(message).toContain('`put` refuses it, as it doesn\'t encode as "lineId" is stored')
        expect(message).toContain("Nothing was fetched or written.")
        expect(requests).toEqual([])
        // `put` refuses the same id, before any request.
        expect(Exit.isFailure(yield* runPut(shape, { lineId: given, f: 5 }))).toBe(true)
      }),
    )
  }

  for (const [label, at] of Object.entries(UNSTORABLE)) {
    it.effect(`${label}: create fails with EDD-9131 as put refuses the id, nothing fetched`, () =>
      Effect.gen(function* () {
        const shape = SHAPES[label]!()
        const { create, requests, rows } = yield* run(shape, fixture.shapes[label]!.seeded)
        const message = refusal(create)
        expect(message).toContain("[EDD-9131]")
        expect(message).toContain('entity "Line" can be keyed by: `put` refuses it')
        expect(message).toContain(
          `(${at}: Special numeric value Infinity is not allowed. [EDD-9124])`,
        )
        expect(message).toContain("Nothing was fetched or written.")
        // Not even the item of another value its key text names, seeded by 1.39.0's own `put`.
        expect(requests).toEqual([])
        expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.seeded))
        // `put` refuses the same id, with the same words; a struct first as an object composing
        // `[object Object]`, which every struct composes alike (`EDD-9162`).
        const given = (shape.input.part ?? shape.input) as { readonly lineId: unknown }
        const put = yield* runPut(shape, { lineId: given.lineId, f: 5 })
        expect(refusal(put)).toContain(
          at === '"lineId.a"'
            ? 'composes the key text "[object Object]"'
            : `${at}: Special numeric value Infinity is not allowed.`,
        )
        // 1.39.0 refused it as no string, before any request.
        expect(fixture.shapes[label]!.create).toBe("failed: ValidationError")
      }),
    )
  }

  for (const label of [...UNIONS, ...JUDGED_AS_139]) {
    it.effect(`${label}: fetches, writes and reads what 1.39.0 did`, () =>
      Effect.gen(function* () {
        const shape = SHAPES[label]!()
        const { create, sent, rows, get } = yield* run(shape)
        expect(outcomeOf(create)).toBe(fixture.shapes[label]!.create)
        // Fetched as 1.39.0 fetched: a string `lineId`, whatever member the value is.
        expect(batchGetKeys(sent)).toEqual(
          stringIds(shape.input).length === 0
            ? []
            : fixture.shapes[label]!.seeded.filter((row) => row.__edd_e__?.S === "Line").map(keyOf),
        )
        expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.rows))
        expect(outcomeOf(get)).toBe(fixture.shapes[label]!.get)
      }),
    )
  }

  it("a union element's input is the union as declared, as on 1.39.0", () => {
    // A field's own type: `undefined` and a class's declaration taken off.
    const unwrap = (ast: SchemaAST.AST): SchemaAST.AST =>
      SchemaAST.isUnion(ast) && ast.types.some((member) => SchemaAST.isUndefined(member))
        ? unwrap(ast.types.find((member) => !SchemaAST.isUndefined(member))!)
        : SchemaAST.isDeclaration(ast)
          ? unwrap(ast.typeParameters[0]!)
          : ast
    const property = (ast: SchemaAST.AST, name: string) =>
      (unwrap(ast) as SchemaAST.Objects).propertySignatures.find(
        (signature) => signature.name === name,
      )?.type
    const elementOf = (derived: Schema.Top) => {
      const lines = property(property(derived.ast, "part") ?? derived.ast, "lines")!
      return (unwrap(lines) as SchemaAST.Arrays).rest[0]
    }
    for (const label of UNIONS) {
      const shape = SHAPES[label]!()
      const A = shape.make(Table.make({ schema, entities: shape.entities } as never)) as any
      if (!label.includes("through a transformation")) {
        expect(SchemaAST.isUnion(elementOf(A.schema)!)).toBe(true)
      }
      // The model's own element, under the JSON codec the input schema is.
      const declared = elementOf(Schema.toCodecJson(A.schema))
      expect(elementOf(A.inputSchema)).toEqual(declared)
      expect(elementOf(A.createSchema)).toEqual(declared)
    }
  })

  for (const refFirst of [false, true]) {
    it.effect(
      `members sharing a discriminator (the wrapping one ${refFirst ? "first" : "second"}): a string id is fetched, as on 1.39.0`,
      () =>
        Effect.gen(function* () {
          const { create, requests } = yield* run(sharedDiscriminator(refFirst))
          expect(Exit.isSuccess(create) && create.value).toEqual({
            id: "a",
            lines: [{ kind: "a", line: { lineId: "l", f: 5 }, qty: 1 }],
          })
          expect(requests).toEqual(["BatchGetItem", "TransactWriteItems"])
        }),
    )
  }

  it.effect("a union element given a number id of a string-keyed entity: stored as given", () =>
    Effect.gen(function* () {
      const label =
        "many, element a union whose later member declares the entity's field a string and its id a number"
      const { create, requests } = yield* run(SHAPES[label]!())
      expect(Exit.isSuccess(create) && create.value).toEqual({
        id: "a",
        lines: [{ kind: "a", line: "KEEP", lineId: 123, qty: 1 }],
      })
      expect(fetches(requests)).toBe(0)
    }),
  )

  it.effect("a union element given a string id of a number-keyed entity fails with EDD-9131", () =>
    Effect.gen(function* () {
      const Line = Schema.Struct({ lineId: Schema.Number, f: Schema.Number })
      const Lines = lines(Line, singleKey)
      const Sheet = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), line: Line, qty: Schema.Number }),
        Schema.Struct({ kind: Schema.Literal("b"), qty: Schema.Number }),
      ])
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
        seed: [["Lines", { lineId: 5, f: 1 }]],
        input: {
          id: "a",
          lines: [
            { kind: "a", lineId: "x", qty: 1 },
            { kind: "b", lineId: 5, qty: 2 },
          ],
        },
      }
      const { create, requests } = yield* run(shape)
      const message = refusal(create)
      expect(message).toContain("[EDD-9131]")
      expect(message).toContain('"lines[0].lineId"')
      expect(requests).toEqual([])
    }),
  )

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

  it.effect("an element declaring the entity's field a scalar is judged as on 1.39.0", () =>
    Effect.gen(function* () {
      const label = "many, element declares the entity's field a string, given it and a lineId"
      const { create, requests, rows, get } = yield* run(SHAPES[label]!())
      // As 1.39.0: the line fetched by that string `lineId`, its record put in `line`, which
      // fails decoding. Nothing written.
      expect(outcomeOf(create)).toBe(fixture.shapes[label]!.create)
      expect(requests).toEqual(["BatchGetItem"])
      expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.rows))
      expect(outcomeOf(get)).toBe(fixture.shapes[label]!.get)
    }),
  )

  it.effect(
    "an element declaring the entity's field a scalar takes a string id, as on 1.39.0",
    () =>
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
        // Its input takes `lineId: string` in place of `line`, as 1.39.0's did.
        const A = shape.make(Table.make({ schema, entities: shape.entities } as never)) as any
        expect(Schema.decodeUnknownExit(A.inputSchema)(shape.input)._tag).toBe("Success")
        // Fetched, and the record put in `line` fails decoding, nothing written.
        const { create, requests } = yield* run(shape)
        expect(refusal(create)).toContain('["line"]')
        expect(requests).toEqual(["BatchGetItem"])
      }),
  )

  it.effect("an element holding the entity in a field of another name is taken whole", () =>
    Effect.gen(function* () {
      const { Line } = lineClass(false)
      const Lines = lines(Line, singleKey)
      const Crew = Schema.Struct({ captain: Line, qty: Schema.Number })
      const shape = (input: Record<string, unknown>): Shape => ({
        entities: { Lines },
        make: (base) =>
          aggregate(Schema.Struct({ id: Schema.String, crew: Schema.Array(Crew) }), base, {
            crew: Aggregate.many({
              entityType: "Crew",
              entity: Lines,
              sk: { composite: ["qty"] },
            } as never),
          }),
        seed: [["Lines", { lineId: "l", f: 5 }]],
        input,
      })
      const whole = yield* run(
        shape({ id: "a", crew: [{ captain: { lineId: "l", f: 5 }, qty: 2 }] }),
      )
      expect(Exit.isSuccess(whole.create)).toBe(true)
      expect(whole.requests).toEqual(["TransactWriteItems"])
      // Only the field of the entity's name (`line`) is taken by id, so `captainId` is not fetched.
      const byId = yield* run(shape({ id: "a", crew: [{ captainId: "l", qty: 2 }] }))
      expect(refusal(byId.create)).toContain('["captain"]')
      expect(byId.requests).toEqual([])
    }),
  )

  it.effect("a NumberFromString id given an infinity as its encoded string: put stores it", () =>
    Effect.gen(function* () {
      for (const [sign, given] of [
        [Infinity, "Infinity"],
        [-Infinity, "-Infinity"],
      ] as const) {
        const label = `one, an entity keyed by a NumberFromString, given ${given} as its encoded string`
        const shape = SHAPES[label]!()
        expect(Exit.isSuccess(yield* runPut(shape, { lineId: sign, f: 5 }))).toBe(true)
        const { create, requests, rows } = yield* run(shape)
        expect(Exit.isSuccess(create)).toBe(true)
        expect(requests).toEqual(["BatchGetItem", "TransactWriteItems"])
        const line = rows.find((row) => row.__edd_e__?.S === "Line")!
        expect(line.lineId).toEqual({ S: given })
        expect(rows.find((row) => row.__edd_e__?.S === "AggLine")!.lineId).toEqual({ S: given })
      }
    }),
  )

  for (const label of [...SIXTH, ...EIGHTH, ...NINTH]) {
    it.effect(`${label}: sends, writes and reads what 1.39.0 did`, () =>
      Effect.gen(function* () {
        const { create, requests, rows, get } = yield* run(SHAPES[label]!())
        const was = fixture.shapes[label]!
        expect(outcomeOf(create)).toBe(was.create)
        // The requests 1.39.0's `create` sent, each as the recording table names its command.
        expect(requests).toEqual(was.requests!.map((op) => `${op[0]!.toUpperCase()}${op.slice(1)}`))
        expect(byKey(rows)).toEqual(byKey(was.rows))
        expect(outcomeOf(get)).toBe(was.get)
      }),
    )
  }

  for (const label of OWN_KEY_WHOLE) {
    it.effect(
      `${label}: stored as given, nothing fetched (1.39.0 fetched it, then refused it)`,
      () =>
        Effect.gen(function* () {
          const { create, requests, get } = yield* run(SHAPES[label]!())
          const lines = [{ lineId: "l", f: 9 }]
          const sub = label.startsWith("sub-aggregate")
          expect(Exit.isSuccess(create) && json(create.value)).toBe(
            json(sub ? { id: "a", part: { lines } } : { id: "a", lines }),
          )
          expect(requests).toEqual(
            sub ? ["TransactWriteItems", "TransactWriteItems"] : ["TransactWriteItems"],
          )
          expect(Exit.isSuccess(get) && json(get.value)).toBe(
            json((create as Exit.Success<unknown>).value),
          )
          expect(fixture.shapes[label]!.requests).toEqual(["batchGetItem"])
          expect(fixture.shapes[label]!.create).toBe("failed: ValidationError")
        }),
    )
  }

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

  /**
   * A `many` edge over an entity keyed by `lineId` of `key`, its element wrapping the entity, given
   * `ids`, one per element. `judged` holds each key record `put`'s check (`_unstorableKey`) was run on.
   */
  const wrappingIds = (key: Schema.Top, seed: unknown, ids: ReadonlyArray<unknown>) => {
    class Line extends Schema.Class<Line>("Line")({ lineId: key as never, f: Schema.Number }) {}
    const Lines = lines(
      DynamoModel.configure(Line, { lineId: { identifier: true } } as never),
      singleKey,
    )
    const judged: Array<unknown> = []
    const unstorableKey = Lines._unstorableKey
    Lines._unstorableKey = (record: unknown) => {
      judged.push(record)
      return unstorableKey(record)
    }
    const Sheet = Schema.Struct({ line: Line, qty: Schema.Number })
    const shape: Shape = {
      schema: unescapedSchema,
      entities: { Lines },
      make: (base) =>
        aggregate(
          Schema.Struct({ id: Schema.String, lines: Schema.Array(Sheet) }),
          base,
          {
            lines: Aggregate.many({
              entityType: "SheetLine",
              entity: Lines,
              sk: { composite: ["qty"] },
            } as never),
          },
          unescapedSchema,
        ),
      seed: [["Lines", { lineId: seed, f: 5 }]],
      input: { id: "a", lines: ids.map((lineId, i) => ({ lineId, qty: i + 1 })) },
    }
    return { shape, judged }
  }

  it.effect(
    "an id given more than once, one instant's ISO strings, is judged and fetched once",
    () =>
      Effect.gen(function* () {
        const ISO = "2024-01-02T03:04:05.000Z"
        const { shape, judged } = wrappingIds(Schema.Date, new Date(ISO), [ISO, ISO, ISO])
        const { create, sent } = yield* run(shape)
        expect(Exit.isSuccess(create)).toBe(true)
        // Three `Date`s of their own, one value of the key composite, one key text: judged once.
        expect(judged).toHaveLength(1)
        expect(batchGetKeys(sent)).toHaveLength(1)
      }),
  )

  it.effect("ids composing one key text of other values are each judged: Infinity is refused", () =>
    Effect.gen(function* () {
      const { shape, judged } = wrappingIds(Schema.Struct({ a: Schema.Number }), { a: 5 }, [
        { a: 5 },
        { a: Infinity },
      ])
      // Keyed by a struct, which `put` can't seed (`EDD-9162`); nothing is fetched.
      const { create, requests } = yield* run(shape, [])
      const message = refusal(create)
      expect(message).toContain("[EDD-9131]")
      expect(message).toContain('"lines[1].lineId"')
      expect(judged).toHaveLength(2)
      expect(requests).toEqual([])
    }),
  )
})
