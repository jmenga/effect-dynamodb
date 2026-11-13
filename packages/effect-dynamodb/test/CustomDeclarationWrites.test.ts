/**
 * The write check for a custom declaration (`EDD-9126`), with a client that records writes: every
 * path refuses a value that wouldn't read back and writes nothing, a schema holding no custom
 * declaration has no check at all, and a new write path can't go unnoticed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { UpdateItemCommandInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { DynamoError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { holdsCustomDeclaration } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { readBackOf } from "../src/internal/RoundTrip.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { AppSchema, clientOf, membersOf, PATHS } from "./helpers/CustomDeclarationPaths.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

class Point {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}
const Custom = Schema.instanceOf(Point)
const Duck = Schema.declare(
  (input: unknown): input is Point => typeof input === "object" && input !== null && "x" in input,
)
const FromStruct = Schema.Struct({ x: Schema.Number, y: Schema.Number }).pipe(
  Schema.decodeTo(Custom, {
    decode: SchemaGetter.transform(({ x, y }: { x: number; y: number }) => new Point(x, y)),
    encode: SchemaGetter.transform((point: Point) => ({ x: point.x, y: point.y })),
  }),
)
class Located extends Schema.Class<Located>("Located")({ x: Schema.Number }) {}

/**
 * A client whose writes are recorded and whose reads find a row that holds nothing of note. An
 * update requiring an attribute (`attribute_exists(#fb0)`, a `pathIfNotExists` whose operand would
 * be refused where stored, #236) is refused as DynamoDB refuses it on that row, writing nothing.
 */
const recording = () => {
  const writes: Array<string> = []
  const write = (name: string) => () =>
    Effect.sync(() => {
      writes.push(name)
      return {}
    }) as never
  const row = toAttributeMap({ pk: "p", sk: "s", __edd_e__: "Row", id: "a" })
  const orderRoot = toAttributeMap({ pk: "p", sk: "s", __edd_e__: "Order", id: "a" })
  const layer = mockDynamoClientLayer({
    putItem: write("putItem"),
    updateItem: (input: UpdateItemCommandInput) => {
      const required = input.ExpressionAttributeNames?.["#fb0"]
      if (
        input.ConditionExpression?.includes("attribute_exists(#fb0)") === true &&
        required !== undefined &&
        !Object.hasOwn(row, required)
      ) {
        return Effect.fail(
          new DynamoError({
            operation: "UpdateItem",
            cause: Object.assign(new Error("The conditional request failed"), {
              name: "ConditionalCheckFailedException",
              Item: row,
            }),
          }),
        ) as never
      }
      return write("updateItem")()
    },
    deleteItem: write("deleteItem"),
    transactWriteItems: write("transactWriteItems"),
    batchWriteItem: write("batchWriteItem"),
    executeStatement: write("executeStatement"),
    executeTransaction: write("executeTransaction"),
    // Only what's seeded in `CustomDeclarationPaths` is found: an entity's row and an aggregate's root.
    getItem: (input: { readonly Key?: unknown }) =>
      Effect.succeed(JSON.stringify(input.Key).includes("#row") ? { Item: row } : {}) as never,
    query: (input: unknown) =>
      Effect.succeed(
        JSON.stringify(input).includes("#order")
          ? { Items: [orderRoot], Count: 1, ScannedCount: 1 }
          : { Items: [], Count: 0, ScannedCount: 0 },
      ) as never,
  })
  return { writes, layer }
}

describe("[EDD-9126] every write path refuses a value that wouldn't read back", () => {
  const value = new Point(1, 2)
  for (const path of PATHS) {
    it.effect(`${path.operation}: ${path.name}`, () =>
      Effect.gen(function* () {
        const { writes, layer } = recording()
        const members = membersOf(Custom)
        const provided = Layer.merge(layer, members.Base.layer({ name: "custom-table" }))
        const exit = yield* Effect.gen(function* () {
          const db = yield* clientOf(members)
          return yield* path.run(db, members, value)
        }).pipe(Effect.provide(provided as never), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Cause.squash(
          (exit as Exit.Failure<unknown, unknown>).cause,
        ) as ValidationError
        expect(error).toBeInstanceOf(ValidationError)
        expect(String(error.cause)).toContain("EDD-9126")
        expect(writes).toEqual([])
      }),
    )
  }
})

describe("holdsCustomDeclaration", () => {
  const CUSTOM: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["an instanceOf", Custom],
    ["a duck-typed declare", Duck],
    ["a checked one", Custom.check(Schema.makeFilter(() => true))],
    ["a branded one", Custom.pipe(Schema.brand("B"))],
    ["one in a struct", Schema.Struct({ p: Custom })],
    ["one in a class", Schema.Struct({ c: Custom }).pipe(Schema.brand("C"))],
    ["one in a list", Schema.Array(Custom)],
    ["one in a tuple", Schema.Tuple([Schema.String, Custom])],
    ["one in a record", Schema.Record(Schema.String, Custom)],
    ["one or null", Schema.NullOr(Custom)],
    ["one optional", Schema.optional(Custom)],
    ["one optional by key", Schema.optionalKey(Custom)],
    ["one in a union", Schema.Union([Schema.String, Custom])],
    ["one suspended", Schema.suspend(() => Custom)],
    ["one in an Option", Schema.Option(Custom)],
    ["one in a set", Schema.ReadonlySet(Custom)],
    ["one with a decoding default", Custom.pipe(Schema.withDecodingDefault(Effect.die("unused")))],
    [
      "one stored beneath a transformation",
      Custom.pipe(
        Schema.decodeTo(Schema.Unknown, {
          decode: SchemaGetter.passthrough<unknown>(),
          encode: SchemaGetter.passthrough<unknown>() as never,
        } as never),
      ),
    ],
    ["a class's type side", Schema.toType(Located)],
  ]
  it("finds one at the stored end of two steps", () => {
    const stepped = Custom.pipe(
      Schema.decodeTo(
        Schema.String.pipe(
          Schema.decodeTo(Schema.Unknown, SchemaTransformation.passthrough() as never),
        ),
        SchemaTransformation.passthrough() as never,
      ),
    )
    expect(holdsCustomDeclaration(stepped.ast)).toBe(true)
  })

  for (const [name, schema] of CUSTOM) {
    it(`finds ${name}`, () => {
      expect(holdsCustomDeclaration(schema.ast)).toBe(true)
    })
  }

  const NONE: ReadonlyArray<readonly [string, Schema.Top]> = [
    ["a string", Schema.String],
    ["a struct", Schema.Struct({ s: Schema.String, n: Schema.Number })],
    ["a class", Located],
    ["a struct decoded to a class", FromStruct],
    ["a tagged class", Schema.TaggedClass<Located>()("T", { x: Schema.Number })],
    ["an Option", Schema.Option(Schema.String)],
    ["a date", Schema.DateTimeUtc],
    ["a duration", Schema.Duration],
    ["a cause", Schema.Cause(Schema.String, Schema.String)],
    ["a time zone", Schema.TimeZone],
    [
      "a string decoded to what was decoded from one",
      Schema.String.pipe(
        Schema.decodeTo(
          Custom.pipe(Schema.decodeTo(Schema.Unknown, SchemaTransformation.passthrough() as never)),
          SchemaTransformation.passthrough() as never,
        ),
      ),
    ],
    ["a hash set", Schema.HashSet(Schema.String)],
    ["a big decimal", Schema.BigDecimal],
    ["a set", Schema.ReadonlySet(Schema.String)],
    ["a JSON value", Schema.Json],
    ["unknown", Schema.Unknown],
  ]
  for (const [name, schema] of NONE) {
    it(`finds nothing in ${name}`, () => {
      expect(holdsCustomDeclaration(schema.ast)).toBe(false)
    })
  }

  it("ends on a cycle", () => {
    type T = { readonly next?: T }
    const T: Schema.Codec<T> = Schema.Struct({
      next: Schema.optionalKey(Schema.suspend((): Schema.Codec<T> => T)),
    })
    expect(holdsCustomDeclaration(T.ast)).toBe(false)
  })
})

describe("readBackOf", () => {
  const check = (schema: Schema.Top) => readBackOf(schema, () => schema)!
  const passes = (schema: Schema.Top, value: unknown) =>
    Effect.runPromiseExit(check(schema)(value)).then(Exit.isSuccess)

  it("a schema holding none has no check, and its read isn't built", () => {
    let built = false
    expect(
      readBackOf(Schema.Struct({ s: Schema.String }), () => {
        built = true
        return Schema.String
      }),
    ).toBeUndefined()
    expect(built).toBe(false)
  })

  it("an instance's map isn't an instance", async () => {
    expect(await passes(Custom, new Point(1, 2))).toBe(false)
    expect(await passes(Schema.Array(Custom), [new Point(1, 2)])).toBe(false)
  })

  it("a declare that takes the map passes", async () => {
    expect(await passes(Duck, new Point(1, 2))).toBe(true)
    expect(await passes(Duck, { x: 1 })).toBe(true)
  })

  it("a declare that takes what's stored for a Uint8Array, a set or a string passes", async () => {
    const taking = (guard: (input: unknown) => boolean) =>
      Schema.declare((input: unknown): input is unknown => guard(input))
    expect(
      await passes(
        taking((u) => u instanceof Uint8Array),
        new Uint8Array([1]),
      ),
    ).toBe(true)
    expect(
      await passes(
        taking((u) => u instanceof Set),
        new Set(["a"]),
      ),
    ).toBe(true)
    expect(
      await passes(
        taking((u) => typeof u === "string"),
        "a",
      ),
    ).toBe(true)
  })

  it("a value the marshaller refuses isn't this check's", async () => {
    expect(await passes(Custom, Number.NaN)).toBe(true)
  })

  it("the read it was given decides, not the stored side's own", async () => {
    const fallback = Schema.Union([Custom, Schema.Struct({ x: Schema.Number })])
    const readBack = readBackOf(Custom, () => fallback)!
    expect(Exit.isSuccess(await Effect.runPromiseExit(readBack(new Point(1, 2))))).toBe(true)
  })
})

const onMembers =
  (members: any, layer: Layer.Layer<any>) =>
  <A, E>(self: Effect.Effect<A, E, unknown>) =>
    self.pipe(
      Effect.provide(Layer.merge(layer, members.Base.layer({ name: "custom-table" })) as never),
    ) as Effect.Effect<A, E>

describe("a value that takes another way back", () => {
  it.effect("a union's other member that takes the map keeps the write", () =>
    Effect.gen(function* () {
      const members = membersOf(Schema.Union([Custom, Schema.Struct({ x: Schema.Number })]))
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db = yield* clientOf(members)
        yield* db.entities.Rows.put({ id: "a", f: new Point(1, 2) })
          .asEffect()
          .pipe(Effect.exit)
      }).pipe(onMembers(members, layer))
      expect(writes).toEqual(["putItem"])
    }),
  )

  it.effect("a null or an absent field has nothing to check", () =>
    Effect.gen(function* () {
      const members = membersOf(Schema.NullOr(Custom))
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db = yield* clientOf(members)
        yield* db.entities.Rows.put({ id: "a", f: null }).asEffect().pipe(Effect.exit)
        yield* db.entities.Rows.put({ id: "a" }).asEffect().pipe(Effect.exit)
      }).pipe(onMembers(members, layer))
      expect(writes).toEqual(["putItem", "putItem"])
    }),
  )

  it.effect("an operand that's applied rather than stored isn't a value of the field", () =>
    Effect.gen(function* () {
      const members = membersOf(Custom)
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db = yield* clientOf(members)
        yield* db.entities.Rows.update({ id: "a" }).add({ n: 1 }).asEffect().pipe(Effect.exit)
      }).pipe(onMembers(members, layer))
      expect(writes).toEqual(["updateItem"])
    }),
  )
})

describe("a new write path can't go unnoticed", () => {
  /** Every operation has a case in the coverage test, which fails on one without. */
  const operations = [
    ...readFileSync(
      fileURLToPath(new URL("./ConsumedCapacity.coverage.test.ts", import.meta.url)),
      "utf8",
    ).matchAll(/^\s*\[?\s*"([A-Z][A-Za-z]+\.[A-Za-z.]+)",?/gm),
  ].map((match) => match[1]!)

  const carried = new Set(PATHS.map((path) => path.operation))

  /** Writes that go through a path in the list, and what that path is. */
  const THROUGH: Readonly<Record<string, string>> = {
    "Projection.applyBatch": "Projection.apply",
    "Projection.catchUp": "Projection.apply",
    "Projection.rebuild": "Projection.apply",
    "Projection.processBatch": "Projection.apply",
    "MultiProjection.applyBatch": "Projection.apply",
    "MultiProjection.catchUp": "Projection.apply",
    "MultiProjection.rebuild": "Projection.apply",
    "MultiProjection.processBatch": "Projection.apply",
    "EventStore.processBatch": "Projection.apply",
  }

  /** What stores nothing a caller handed it in a model's shape, and why. */
  const CARRIES_NOTHING: Readonly<Record<string, string>> = {
    "Aggregate.delete": "takes a key",
    "Aggregate.get": "a read",
    "Aggregate.list": "a read",
    "Batch.get": "a read",
    "CheckpointStore.acquireLease": "its own items, no model",
    "CheckpointStore.commit": "its own items, no model",
    "CheckpointStore.load": "a read",
    "CheckpointStore.releaseLease": "its own items, no model",
    "CheckpointStore.renewLease": "its own items, no model",
    "Collection.query": "a read",
    "Entity.collect": "a read",
    "Entity.delete": "takes a key",
    "Entity.deleteIfExists": "takes a key",
    "Entity.deleted.get": "a read",
    "Entity.deleted.list": "a read",
    "Entity.fetch": "a read",
    "Entity.get": "a read",
    "Entity.getVersion": "a read",
    "Entity.history": "a read",
    "Entity.paginate": "a read",
    "Entity.purge": "takes a key",
    "Entity.query": "a read",
    "Entity.reembed": "stores only a vector",
    "Entity.restore": "takes a key, and writes back the row it read",
    "Entity.scan": "a read",
    "Entity.vectorSearch": "a read",
    "Entity.versions": "a read",
    "EventStream.currentVersion": "a read",
    "EventStream.read": "a read",
    "EventStream.readFrom": "a read",
    "EventStream.readIndex": "a read",
    "EventStream.readLatest": "a read",
    "EventStream.readSnapshot": "a read",
    "Projection.drain": "delivers what's stored",
    "Projection.drainPending": "delivers what's stored",
    "Query.collect": "a read",
    "Query.count": "a read",
    "Query.execute": "a read",
    "Query.paginate": "a read",
    "Transaction.transactGet": "a read",
  }

  it("finds the operations it judges", () => {
    expect(operations).toContain("Entity.put")
    expect(operations).toContain("Transaction.transactWrite")
    expect(operations).toContain("EventStream.writeSnapshot")
    expect(new Set(operations).size).toBeGreaterThan(50)
  })

  it("every operation is a write path in the list, goes through one, or carries nothing", () => {
    const unjudged = [...new Set(operations)].filter(
      (operation) =>
        !carried.has(operation) && !(operation in THROUGH) && !(operation in CARRIES_NOTHING),
    )
    expect(unjudged).toEqual([])
    for (const path of Object.values(THROUGH)) expect(carried.has(path)).toBe(true)
  })

  it("nothing in the lists has gone from the library", () => {
    const known = new Set(operations)
    expect(
      [...carried, ...Object.keys(THROUGH), ...Object.keys(CARRIES_NOTHING)].filter(
        (operation) => !known.has(operation),
      ),
    ).toEqual([])
  })

  const src = fileURLToPath(new URL("../src", import.meta.url))
  const files = (dir: string): ReadonlyArray<string> =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : []
    })
  /** Comments and string contents out, so a mention doesn't count. */
  const code = (path: string): string =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
  const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length
  const sources = new Map(files(src).map((path) => [relative(src, path), code(path)]))
  const source = (name: string): string => sources.get(name) ?? ""

  /**
   * Every encode in the library, which is how a model's value gets its stored form. A new one is a new
   * way for a value to be stored: route it through the check, or say here why it isn't one.
   */
  const ENCODES: Readonly<Record<string, readonly [number, string]>> = {
    "Aggregate.ts": [
      5,
      "attribute encoders, and a kept stamp put in its row's form (`inStampForm`), feeding rows " +
        "`refuseNotReadBack` reads",
    ],
    "Entity.ts": [
      6,
      "two probes that store nothing, a key (2), a ref's stored row, a history bound's key text",
    ],
    "EventStore.ts": [2, "`encodeToWire`, which checks"],
    "StorageEncoding.ts": [4, "a public helper: what's done with its value is the caller's"],
    "internal/InputForm.ts": [
      3,
      "`encodeInput`, the one decision of a write input's form; its callers " +
        "(`encodeOrDecodeEncode`, `validateAndBuildPutItem`) check",
    ],
    "internal/OperandReaders.ts": [
      1,
      "an update's operand in another form, kept only where its position's readers read it back",
    ],
    "internal/ProjectionEngine.ts": [1, "the outbox, which checks"],
  }

  it("every encode in the library is accounted for", () => {
    const found = Object.fromEntries(
      [...sources]
        .map(([name, text]) => [name, count(text, /\b(?:Schema|S)\.encode\w*\(/g)] as const)
        .filter(([, n]) => n > 0),
    )
    expect(found).toEqual(
      Object.fromEntries(Object.entries(ENCODES).map(([name, [n]]) => [name, n])),
    )
  })

  it("an entity's writes encode through the one function that checks", () => {
    const entity = source("Entity.ts")
    // `encodeForWrite`'s one encode, and `_unstorableKey`'s encode of a key record as `put` would
    // encode it, which writes nothing.
    expect(count(entity, /\bencodeOrDecodeEncode\(/g)).toBe(2)
    // Put, update, upsert twice, and a time series' append.
    expect(count(entity, /\bencodeForWrite\(/g)).toBe(5)
    // A key value that reads back as the other numeric kind is refused in `encodeForWrite`, and in
    // the check a transaction's or a batch's put goes through (`_refuseNotReadBack`).
    expect(count(entity, /\brefuseOtherKindRead\(/g)).toBe(2)
    // Path values encode in one place, and an update's operands are judged in one.
    expect(count(entity, /\bpathValues\.(?:value|elements)\(/g)).toBe(2)
    expect(count(entity, /\bnotReadBackOperand\(/g)).toBe(1)
  })

  it("a transaction's, a batch's and a projection's puts go through the one builder that checks", () => {
    expect(count(source("internal/TransactableOps.ts"), /_refuseNotReadBack\(/g)).toBe(1)
    // Its input takes its form where an entity's write's does.
    expect(count(source("internal/TransactableOps.ts"), /\bencodeInput\(/g)).toBe(1)
    expect(count(source("Entity.ts"), /\bencodeInput\(/g)).toBe(1)
    for (const name of ["Batch.ts", "Transaction.ts", "internal/TransactWriteOps.ts"]) {
      expect(count(source(name), /\binputSchema\b/g)).toBe(0)
    }
  })

  it("an aggregate's every write of new rows reads them first", () => {
    const aggregate = source("Aggregate.ts")
    // `create`, and `update`.
    expect(count(aggregate, /\brefuseNotReadBack\(/g)).toBe(2)
    // Both of those compose from a packed group; a `rekey` moves what it read.
    expect(count(aggregate, /\bpackAggregateGroups\(/g)).toBe(3)
  })

  it("a stream's writes encode through the one function that checks", () => {
    const stream = source("EventStore.ts")
    // A snapshot's state, metadata, an event, and an event's own metadata.
    expect(count(stream, /\bencodeToWire\(/g)).toBe(4)
  })
})

describe("what the check leaves alone", () => {
  const keyed = {
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  }
  const Duck = Schema.declare(
    (input: unknown): input is Point => typeof input === "object" && input !== null && "x" in input,
  )
  const entityOver = (fields: Schema.Struct.Fields) => {
    const Rows = Entity.make({
      model: Schema.Struct({ id: Schema.String, ...fields }),
      entityType: "Row",
      ...keyed,
    } as never) as any
    const Base = Table.make({ schema: AppSchema, entities: { Rows } } as never) as any
    return {
      Base,
      Rows,
      client: DynamoClient.make({ entities: { Rows }, tables: { Base } } as never) as any,
    }
  }

  it.effect("an absent optional key has nothing to check", () =>
    Effect.gen(function* () {
      const { Base, client } = entityOver({ f: Schema.optionalKey(Custom) })
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Rows.put({ id: "a" }).asEffect()
      }).pipe(onMembers({ Base }, layer))
      expect(writes).toEqual(["putItem"])
    }),
  )

  it.effect("an operand of another field isn't judged", () =>
    Effect.gen(function* () {
      const { Base, client } = entityOver({ f: Schema.optional(Custom), big: Schema.BigInt })
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Rows.update({ id: "a" })
          .pathSet({ segments: ["big"], value: 5n })
          .asEffect()
          .pipe(Effect.exit)
      }).pipe(onMembers({ Base }, layer))
      expect(writes).toEqual(["updateItem"])
    }),
  )

  it.effect("what's appended is judged as elements, not as the list", () =>
    Effect.gen(function* () {
      const { Base, client } = entityOver({
        list: Schema.Array(Duck).check(Schema.isMaxLength(1)),
      })
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Rows.update({ id: "a" })
          .append({ list: [new Point(1, 2), new Point(3, 4)] })
          .asEffect()
          .pipe(Effect.exit)
      }).pipe(onMembers({ Base }, layer))
      expect(writes).toEqual(["updateItem"])
    }),
  )

  const unstorable: ReadonlyArray<readonly [string, (update: any) => any]> = [
    [".append", (update) => update.append({ list: [Number.NaN] })],
    ["pathSet", (update) => update.pathSet({ segments: ["f"], value: Number.NaN })],
    ["pathAppend", (update) => update.pathAppend({ segments: ["list"], value: [Number.NaN] })],
    ["pathPrepend", (update) => update.pathPrepend({ segments: ["list"], value: [Number.NaN] })],
    ["pathIfNotExists", (update) => update.pathIfNotExists({ segments: ["f"], value: Number.NaN })],
  ]
  for (const [name, op] of unstorable) {
    it.effect(`an operand the marshaller refuses is still its to report: ${name}`, () =>
      Effect.gen(function* () {
        const { Base, client } = entityOver({
          f: Schema.optional(Duck),
          list: Schema.optional(Schema.Array(Duck)),
        })
        const { writes, layer } = recording()
        const error = yield* Effect.gen(function* () {
          const db = yield* client
          return yield* Effect.flip(op(db.entities.Rows.update({ id: "a" })).asEffect())
        }).pipe(onMembers({ Base }, layer))
        expect(error).toBeInstanceOf(ValidationError)
        expect(String((error as ValidationError).cause)).toContain("EDD-9124")
        expect(writes).toEqual([])
      }),
    )
  }

  it.effect("an event another event's schema reads keeps writing", () =>
    Effect.gen(function* () {
      class Noted extends Schema.TaggedClass<Noted>()("Noted", { f: Custom }) {}
      class Either extends Schema.Class<Either>("Either")({
        _tag: Schema.Literals(["Noted", "Either"]),
        f: Schema.Struct({ x: Schema.Number }),
      }) {}
      const Base = Table.make({ schema: AppSchema, entities: {} } as never) as any
      const Stream = EventStore.makeStream({
        table: Base,
        streamName: "Stream",
        events: [Noted, Either],
        streamId: { composite: ["id"] },
      } as never) as any
      const { writes, layer } = recording()
      const appended: Effect.Effect<unknown, unknown> = Stream.append(
        { id: "a" },
        [new Noted({ f: new Point(1, 2) })],
        0,
      )
      yield* appended.pipe(onMembers({ Base }, layer))
      expect(writes).toEqual(["putItem"])
    }),
  )

  it.effect("an aggregate holding none isn't read on its way to the table", () =>
    Effect.gen(function* () {
      const Base = Table.make({ schema: AppSchema, entities: {} } as never) as any
      // Takes its value on the way in and refuses what's stored, so a read would fail.
      const Lossy = Schema.Literals(["ok", "stored"]).pipe(
        Schema.decodeTo(
          Schema.Literal("ok"),
          SchemaTransformation.transform({
            decode: () => "bad" as "ok",
            encode: () => "stored" as const,
          }) as never,
        ),
      )
      const Team = (Aggregate.make as any)(Schema.Struct({ id: Schema.String, f: Lossy }), {
        table: Base,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "team" },
        root: { entityType: "Team" },
        edges: {},
      })
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Team },
          tables: { Base },
        } as never)
        yield* db.aggregates.Team.create({ id: "a", f: "ok" })
      }).pipe(onMembers({ Base }, layer))
      expect(writes).toEqual(["transactWriteItems"])
    }),
  )

  it.effect("an aggregate's packed edge is unpacked for its check", () =>
    Effect.gen(function* () {
      const json = DynamoModel.Packed({ format: "json" })
      const Coach = Schema.Struct({
        coachId: Schema.String.pipe(DynamoModel.identifier),
        kit: Schema.Struct({ size: Schema.Number }),
      })
      const Coaches = Entity.make({
        model: DynamoModel.configure(Coach, { kit: { storedAs: json } }),
        entityType: "Coach",
        primaryKey: {
          pk: { field: "pk", composite: ["coachId"] },
          sk: { field: "sk", composite: [] },
        },
      } as never) as any
      const Base = Table.make({ schema: AppSchema, entities: { Coaches } } as never) as any
      const Team = (Aggregate.make as any)(
        Schema.Struct({ id: Schema.String, f: Duck, coach: Coach }),
        {
          table: Base,
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "team" },
          root: { entityType: "Team" },
          edges: { coach: Aggregate.one({ entityType: "TeamCoach", entity: Coaches } as never) },
        },
      )
      const { writes, layer } = recording()
      yield* Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Coaches },
          aggregates: { Team },
          tables: { Base },
        } as never)
        yield* db.aggregates.Team.create({
          id: "a",
          f: new Point(1, 2),
          coach: { coachId: "b", kit: { size: 1 } },
        })
      }).pipe(onMembers({ Base }, layer))
      expect(writes).toEqual(["transactWriteItems"])
    }),
  )
})

describe("a packed field, which packing judges", () => {
  const json = DynamoModel.Packed({ format: "json" })
  const refusedByPacking = (error: unknown) => {
    expect(error).toBeInstanceOf(ValidationError)
    const cause = String((error as ValidationError).cause)
    expect(cause).toContain("an instance of Point")
    expect(cause).not.toContain("EDD-9126")
  }
  const keyed = {
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  }

  it.effect("on an entity", () =>
    Effect.gen(function* () {
      const Rows = Entity.make({
        model: DynamoModel.configure(
          Schema.Struct({ id: Schema.String, f: Schema.Struct({ p: Custom }) }),
          { f: { storedAs: json } },
        ),
        entityType: "Row",
        ...keyed,
      } as never) as any
      const Base = Table.make({ schema: AppSchema, entities: { Rows } } as never) as any
      const { writes, layer } = recording()
      const error = yield* Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { Base } } as never)
        return yield* Effect.flip(
          db.entities.Rows.put({ id: "a", f: { p: new Point(1, 2) } }).asEffect(),
        )
      }).pipe(onMembers({ Base }, layer))
      refusedByPacking(error)
      expect(writes).toEqual([])
    }),
  )

  it.effect("on an event and a snapshot", () =>
    Effect.gen(function* () {
      const Base = Table.make({ schema: AppSchema, entities: {} } as never) as any
      const Event = Schema.Struct({ _tag: Schema.tag("Noted"), f: Custom })
      const Packed = EventStore.makeStream({
        table: Base,
        streamName: "Packed",
        events: [Event],
        streamId: { composite: ["id"] },
        storedAs: { data: json },
      } as never) as any
      const State = EventStore.makeStream({
        table: Base,
        streamName: "State",
        events: [Schema.Struct({ _tag: Schema.tag("Noted") })],
        streamId: { composite: ["id"] },
        snapshot: { schema: Schema.Struct({ f: Custom }), mode: "inline", storedAs: json },
      } as never) as any
      const { writes, layer } = recording()
      const [error, snapshotError] = yield* Effect.all([
        Effect.flip(Packed.append({ id: "a" }, [{ _tag: "Noted", f: new Point(1, 2) }], 0)),
        Effect.flip(State.writeSnapshot({ id: "a" }, { f: new Point(1, 2) }, 1)),
      ]).pipe(onMembers({ Base }, layer))
      refusedByPacking(error)
      refusedByPacking(snapshotError)
      expect((error as ValidationError).operation).toBe("EventStore.append.packed")
      expect(writes).toEqual([])
    }),
  )

  it.effect("on an aggregate's edge", () =>
    Effect.gen(function* () {
      const Coach = Schema.Struct({
        coachId: Schema.String.pipe(DynamoModel.identifier),
        kit: Schema.Struct({ p: Custom }),
      })
      const Coaches = Entity.make({
        model: DynamoModel.configure(Coach, { kit: { storedAs: json } }),
        entityType: "Coach",
        primaryKey: {
          pk: { field: "pk", composite: ["coachId"] },
          sk: { field: "sk", composite: [] },
        },
      } as never) as any
      const Base = Table.make({ schema: AppSchema, entities: { Coaches } } as never) as any
      const Team = (Aggregate.make as any)(Schema.Struct({ id: Schema.String, coach: Coach }), {
        table: Base,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "team" },
        root: { entityType: "Team" },
        edges: { coach: Aggregate.one({ entityType: "TeamCoach", entity: Coaches } as never) },
      })
      const { writes, layer } = recording()
      const error = yield* Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Coaches },
          aggregates: { Team },
          tables: { Base },
        } as never)
        return yield* Effect.flip(
          db.aggregates.Team.create({
            id: "a",
            coach: { coachId: "b", kit: { p: new Point(1, 2) } },
          }),
        )
      }).pipe(onMembers({ Base }, layer))
      refusedByPacking(error)
      expect(writes).toEqual([])
    }),
  )
})

describe("what a schema holding none pays", () => {
  it("an entity with none has an empty list of checks", () => {
    const members = membersOf(Schema.String)
    expect(holdsCustomDeclaration(members.F.ast)).toBe(false)
  })

  it.effect("its put marshals what it always did and sends one write", () =>
    Effect.gen(function* () {
      const members = membersOf(Schema.String)
      const items: Array<unknown> = []
      const layer = mockDynamoClientLayer({
        putItem: (input: { readonly Item?: unknown }) =>
          Effect.sync(() => {
            items.push(input.Item)
            return {}
          }) as never,
      })
      yield* Effect.gen(function* () {
        const db = yield* clientOf(members)
        yield* db.entities.Rows.put({ id: "a", f: "x" }).asEffect().pipe(Effect.exit)
      }).pipe(onMembers(members, layer))
      expect(items).toHaveLength(1)
      expect((items[0] as Record<string, unknown>).f).toEqual({ S: "x" })
    }),
  )
})

describe("Option and absent values through a check", () => {
  it("an Option of a custom declaration is flagged, and an Option holding a map reads", async () => {
    const check = readBackOf(Schema.Option(Duck), () => Schema.Option(Duck))!
    const exit = await Effect.runPromiseExit(check(Option.some(new Point(1, 2))))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
