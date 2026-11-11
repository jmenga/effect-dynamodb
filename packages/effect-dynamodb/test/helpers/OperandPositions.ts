/**
 * A matrix of the positions a path operation's operand can sit at: every way a schema can wrap the
 * value, crossed with every path operation that carries an operand, with three operands (one
 * valid as given, one valid only once encoded, one invalid) and with three ways of sending it (an
 * update alone, an update in a transaction, and a retained entity's update, which reads first).
 *
 * `test/fixtures/operand-positions-1.39.0.json` (and `-retained-`, for a retained entity's
 * updates) holds what the published 1.39.0 did for every case: the requests it sent, how the update ended, and whether the row read back.
 * `test/OperandPositions.test.ts` runs the same cases against this source and compares each with
 * it (`helpers/Against139.ts`).
 *
 * The library is taken as a parameter, so one definition serves both.
 */

import { DateTime, Effect, Exit, Layer, Option, Schema, SchemaGetter } from "effect"
import { SecureRandom } from "effect/crypto"
import { failureOf, type Outcome, plain } from "./Against139.js"
import { makeRecordingTable } from "./RecordingTable.js"

/** The library's public modules, of whichever release is under test. */
export interface Api {
  readonly DynamoClient: any
  readonly DynamoModel: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
  readonly Transaction: any
}

type Segments = ReadonlyArray<string | number>

/** A number stored as text: `7` is valid only encoded, `"7"` as given. */
const Text = Schema.NumberFromString
/** The value every wrapper wraps: a property, a list and an optional property of such numbers. */
const leafy = {
  n: Text,
  list: Schema.Array(Text),
  maybe: Schema.optionalKey(Text),
}
const Leafy = Schema.Struct(leafy)
class LeafyClass extends Schema.Class<LeafyClass>("LeafyClass")(leafy) {}
/** The same value, read as numbers by a transformation over the whole of it. */
const plainly = {
  n: Schema.Number,
  list: Schema.Array(Schema.Number),
  maybe: Schema.optionalKey(Schema.Number),
}
const identity = {
  decode: SchemaGetter.transform((value: any) => value),
  encode: SchemaGetter.transform((value: any) => value),
}
const A = Schema.Struct({ k: Schema.Literal("a"), ...leafy })
const B = Schema.Struct({ k: Schema.Literal("b"), ...plainly })
const C = Schema.Struct({
  k: Schema.Literal("c"),
  n: Schema.String,
  list: Schema.Array(Schema.String),
  maybe: Schema.optionalKey(Schema.String),
})
const seeded = { n: 1, list: [1] }
class LeafyExtended extends LeafyClass.extend<LeafyExtended>("LeafyExtended")({
  extra: Schema.optionalKey(Schema.String),
}) {}
const Recursive: Schema.Top = Schema.suspend(
  (): Schema.Top => Schema.Struct({ ...leafy, child: Schema.optionalKey(Recursive as never) }),
)
/** A list, or a single value, of numbers stored as text: the operands of a position that is one. */
const TEXT_LIST = {
  list: true,
  operands: [
    ["valid as given", ["7"]],
    ["valid only encoded", [7]],
    ["invalid", [true]],
  ],
} as const

export interface Kind {
  readonly name: string
  /** The schema of the field `target`. */
  readonly field: Schema.Top
  readonly config?: (api: Api) => Record<string, unknown>
  /** What `target` is seeded with. */
  readonly seed: unknown
  /** The path to the wrapped value: its `n`, `list` and `maybe` sit below. */
  readonly base: Segments
  /** The wrapped value is the operand's position itself: no property below it. */
  readonly leaf?: {
    readonly operands: ReadonlyArray<readonly [name: string, value: unknown]>
    /** The position is a list: the operations that append to it. */
    readonly list?: true
    /** A position like it that the seeded row doesn't hold, for `pathIfNotExists` to fill. */
    readonly absent?: Segments
  }
}

/** Members every object inherits: none of them is a field a schema declares. */
const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]

export const kinds: ReadonlyArray<Kind> = [
  { name: "a struct", field: Leafy, seed: seeded, base: ["target"] },
  {
    name: "a struct in a struct",
    field: Schema.Struct({ inner: Leafy }),
    seed: { inner: seeded },
    base: ["target", "inner"],
  },
  {
    name: "an optional key",
    field: Schema.optionalKey(Leafy) as unknown as Schema.Top,
    seed: seeded,
    base: ["target"],
  },
  {
    name: "an optional value",
    field: Schema.optional(Leafy) as unknown as Schema.Top,
    seed: seeded,
    base: ["target"],
  },
  { name: "a nullable", field: Schema.NullOr(Leafy), seed: seeded, base: ["target"] },
  {
    name: "an Option",
    field: Schema.Option(Leafy),
    seed: Option.some(seeded),
    base: ["target", "value"],
  },
  {
    name: "a record",
    field: Schema.Record(Schema.String, Leafy),
    seed: { a: seeded },
    base: ["target", "a"],
  },
  {
    name: "a sparse map's entry",
    field: Schema.Record(Schema.String, Leafy),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: seeded },
    base: ["target#a"],
  },
  {
    name: "a sparse map's entry that is the value",
    field: Schema.Record(Schema.String, Text),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: 1 },
    base: ["target#a"],
    leaf: {
      absent: ["target#b"],
      operands: [
        ["valid as given", "7"],
        ["valid only encoded", 7],
        ["invalid", true],
      ],
    },
  },
  {
    name: "a sparse map's entry that is a list",
    field: Schema.Record(Schema.String, Schema.Array(Text)),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: [1] },
    base: ["target#a"],
    leaf: {
      list: true,
      operands: [
        ["valid as given", ["7"]],
        ["valid only encoded", [7]],
        ["invalid", [true]],
      ],
    },
  },
  {
    name: "a tuple",
    field: Schema.Tuple([Leafy, Schema.Number]),
    seed: [seeded, 2],
    base: ["target", 0],
  },
  { name: "an array", field: Schema.Array(Leafy), seed: [seeded], base: ["target", 0] },
  {
    name: "a set",
    field: Schema.Struct({ tags: Schema.ReadonlySet(Schema.String) }),
    seed: { tags: new Set(["a"]) },
    base: ["target", "tags"],
    leaf: {
      operands: [
        ["valid as given", new Set(["x"])],
        ["invalid", 7],
      ],
    },
  },
  {
    name: "a union",
    field: Schema.Union([A, B]),
    seed: { k: "a", ...seeded },
    base: ["target"],
  },
  {
    name: "a nested union",
    field: Schema.Union([Schema.Union([A, B]), C]),
    seed: { k: "a", ...seeded },
    base: ["target"],
  },
  {
    name: "a union in a sparse map's entry",
    field: Schema.Record(Schema.String, Schema.Union([A, B])),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: { k: "a", ...seeded } },
    base: ["target#a"],
  },
  {
    name: "a Schema.Class",
    field: LeafyClass,
    seed: new LeafyClass(seeded),
    base: ["target"],
  },
  {
    name: "a Schema.Class in a sparse map's entry",
    field: Schema.Record(Schema.String, LeafyClass),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: new LeafyClass(seeded) },
    base: ["target#a"],
  },
  {
    name: "a suspended schema",
    field: Schema.suspend(() => Leafy),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a decoding default",
    field: Leafy.pipe(
      Schema.withDecodingDefault(Effect.succeed({ n: "1", list: [] as ReadonlyArray<string> })),
    ) as unknown as Schema.Top,
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a transformed list",
    field: Schema.Array(Text).pipe(Schema.decodeTo(Schema.Array(Schema.Number), identity)),
    seed: [1],
    base: ["target"],
    leaf: {
      list: true,
      operands: [
        ["valid as given", ["7"]],
        ["valid only encoded", [7]],
        ["invalid", [true]],
      ],
    },
  },
  {
    name: "a transformed list in a sparse map's entry",
    field: Schema.Record(
      Schema.String,
      Schema.Array(Text).pipe(Schema.decodeTo(Schema.Array(Schema.Number), identity)),
    ),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: [1] },
    base: ["target#a"],
    leaf: {
      list: true,
      operands: [
        ["valid as given", ["007"]],
        ["valid only encoded", [7]],
        ["invalid", [true]],
      ],
    },
  },
  {
    name: "a transformed struct",
    field: Leafy.pipe(Schema.decodeTo(Schema.Struct(plainly), identity)),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a packed field",
    field: Leafy,
    config: (api) => ({ storedAs: api.DynamoModel.Packed({ format: "json" }) }),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a renamed field",
    field: Leafy,
    config: () => ({ field: "stored" }),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a date stored as a number",
    field: Schema.DateTimeUtc,
    config: (api) => ({ storedAs: api.DynamoModel.DateEpochMs }),
    seed: DateTime.makeUnsafe(1600000000000),
    base: ["target"],
    leaf: {
      operands: [
        ["valid as given", 1700000000000],
        ["valid only encoded", DateTime.makeUnsafe(1700000000000)],
        ["invalid", true],
      ],
    },
  },
  // Shapes a walk of the schema has to take care with: each is sent as 1.39.0 sent it.
  {
    name: "a branded struct",
    field: Leafy.pipe(Schema.brand("Edge")),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "an annotated struct",
    field: Leafy.annotate({ description: "edge" }),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a checked struct",
    field: Leafy.check(Schema.makeFilter(() => true)),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a struct transformed into a suspended struct",
    field: Leafy.pipe(
      Schema.decodeTo(
        Schema.suspend(() => Schema.Struct(plainly)),
        identity,
      ),
    ),
    seed: seeded,
    base: ["target"],
  },
  {
    name: "a list transformed into a suspended list",
    field: Schema.Array(Text).pipe(
      Schema.decodeTo(
        Schema.suspend(() => Schema.Array(Schema.Number)),
        identity,
      ),
    ),
    seed: [1],
    base: ["target"],
    leaf: TEXT_LIST,
  },
  {
    name: "a suspended checked struct",
    field: Schema.suspend(() => Leafy.check(Schema.makeFilter(() => true))),
    seed: seeded,
    base: ["target"],
  },
  { name: "a recursive struct", field: Recursive, seed: seeded, base: ["target"] },
  {
    name: "a recursive struct's child",
    field: Recursive,
    seed: { ...seeded, child: seeded },
    base: ["target", "child"],
  },
  {
    name: "a fixed property of a struct with an index signature",
    field: Schema.StructWithRest(Schema.Struct({ x: Leafy }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
    seed: { x: seeded },
    base: ["target", "x"],
  },
  {
    name: "a fixed property an index signature also checks, in a sparse map's entry",
    field: Schema.Record(
      Schema.String,
      Schema.StructWithRest(Schema.Struct({ n: Schema.suspend(() => Text) }), [
        Schema.Record(Schema.String, Text.check(Schema.isLessThan(5))),
      ]),
    ),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: { n: 1 } },
    base: ["target#a", "n"],
    leaf: {
      absent: ["target#a", "m"],
      operands: [
        ["valid as given", "7"],
        ["valid only encoded", 7],
        ["invalid", true],
      ],
    },
  },
  {
    name: "a flipped checked struct, in a sparse map's entry",
    field: Schema.Record(
      Schema.String,
      Schema.flip(
        Schema.Struct({ n: Text }).check(
          Schema.makeFilter((value: { readonly n: number }) => value.n < 5),
        ),
      ),
    ),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: { n: "1" } },
    base: ["target#a", "n"],
    leaf: {
      absent: ["target#a", "m"],
      operands: [
        ["valid as given", "007"],
        ["valid only encoded", 7],
        ["invalid", true],
      ],
    },
  },
  {
    name: "a flipped checked list, in a sparse map's entry",
    field: Schema.Record(
      Schema.String,
      Schema.flip(
        Schema.Array(Text).check(
          Schema.makeFilter((value: ReadonlyArray<number>) => value.every((n) => n < 5)),
        ),
      ),
    ),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: ["1"] },
    base: ["target#a"],
    leaf: {
      list: true,
      operands: [
        ["valid as given", ["007"]],
        ["valid only encoded", [7]],
        ["invalid", [true]],
      ],
    },
  },
  {
    name: "a checked list",
    field: Schema.Array(Leafy).check(Schema.isMinLength(1)),
    seed: [seeded],
    base: ["target", 0],
  },
  {
    name: "a tuple's rest element",
    field: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Leafy]),
    seed: ["first", seeded],
    base: ["target", 1],
  },
  {
    name: "a record with a refined key",
    field: Schema.Record(Schema.String.check(Schema.isPattern(/^x/)), Leafy),
    seed: { x: seeded },
    base: ["target", "x"],
  },
  {
    name: "an extended Schema.Class",
    field: LeafyExtended,
    seed: new LeafyExtended(seeded),
    base: ["target"],
  },
  {
    name: "a Schema.Class with a check",
    field: LeafyClass.check(Schema.makeFilter(() => true)),
    seed: new LeafyClass(seeded),
    base: ["target"],
  },
  // An entry's key spelled as a member every object inherits: a name the caller supplies is
  // looked up among what the schema declares, and nowhere else.
  ...INHERITED.flatMap(
    (name): ReadonlyArray<Kind> => [
      {
        name: `a sparse map's entry keyed \`${name}\``,
        field: Schema.Record(Schema.String, Text),
        config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
        seed: { a: 1 },
        base: [`target#${name}`],
        leaf: {
          operands: [
            ["valid as given", "7"],
            ["valid only encoded", 7],
            ["invalid", true],
          ],
        },
      },
    ],
  ),
]

const VALUES: ReadonlyArray<readonly [string, unknown]> = [
  ["valid as given", "7"],
  ["valid only encoded", 7],
  ["invalid", true],
]
const ELEMENTS: ReadonlyArray<readonly [string, unknown]> = [
  ["valid as given", ["7"]],
  ["valid only encoded", [7]],
  ["invalid", [true]],
]

/** How a case's update is sent. */
export const sendings = ["alone", "in a transaction", "retained"] as const
export type Sending = (typeof sendings)[number]

export interface Case {
  readonly key: string
  readonly kind: Kind
  readonly sending: Sending
  readonly op: "pathSet" | "pathIfNotExists" | "pathAppend" | "pathPrepend"
  readonly operand: string
  readonly segments: Segments
  readonly value: unknown
}

/** Every wrapper, crossed with every path operation that carries an operand and every operand. */
export const matrix: ReadonlyArray<Case> = kinds.flatMap((kind) => {
  const ops: ReadonlyArray<
    readonly [Case["op"], Segments, ReadonlyArray<readonly [string, unknown]>]
  > =
    kind.leaf === undefined
      ? [
          ["pathSet", [...kind.base, "n"], VALUES],
          ["pathIfNotExists", [...kind.base, "maybe"], VALUES],
          ["pathAppend", [...kind.base, "list"], ELEMENTS],
          ["pathPrepend", [...kind.base, "list"], ELEMENTS],
        ]
      : kind.leaf.list
        ? [
            ["pathAppend", kind.base, kind.leaf.operands],
            ["pathPrepend", kind.base, kind.leaf.operands],
          ]
        : [
            ["pathSet", kind.base, kind.leaf.operands],
            ["pathIfNotExists", kind.leaf.absent ?? kind.base, kind.leaf.operands],
          ]
  return ops.flatMap(([op, segments, operands]) =>
    operands.flatMap(([operand, value]) =>
      sendings.map((sending) => ({
        key: `${kind.name} / ${op} / ${operand} / ${sending}`,
        kind,
        sending,
        op,
        operand,
        segments,
        value,
      })),
    ),
  )
})

/** The entity a kind's cases run on, for a client to bind. */
export const definitions = (api: Api, kind: Kind, retain = false) => {
  const model = api.DynamoModel.configure(
    Schema.Struct({ id: Schema.String, target: kind.field }),
    kind.config === undefined ? {} : { target: kind.config(api) },
  )
  const E = api.Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(retain ? { versioned: { retain: true } } : {}),
  })
  const Main = api.Table.make({
    schema: api.DynamoSchema.make({ name: "positions", version: 1 }),
    entities: { E },
  })
  return { E, Main }
}

/** The update a case sends, on `update`. */
export const apply = (each: Case, update: any): any =>
  each.op === "pathSet"
    ? update.pathSet({ segments: each.segments, value: each.value, isPath: false })
    : each.op === "pathIfNotExists"
      ? update.pathIfNotExists({ segments: each.segments, value: each.value })
      : each.op === "pathAppend"
        ? update.pathAppend({ segments: each.segments, value: each.value })
        : update.pathPrepend({ segments: each.segments, value: each.value })

/** Seeds an item, sends the case's update, and returns what was sent and whether the row reads. */
export const capture = (api: Api, each: Case): Effect.Effect<Outcome> => {
  const { E, Main } = definitions(api, each.kind, each.sending === "retained")
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* api.DynamoClient.make({ entities: { E }, tables: { Main } })
    yield* db.entities.E.put({ id: "a", target: each.kind.seed }).asEffect()
    table.take()
    const exit = yield* Effect.exit(
      Effect.suspend(() => {
        const op = apply(each, db.entities.E.update({ id: "a" }))
        return each.sending === "in a transaction"
          ? api.Transaction.transactWrite([op])
          : op.asEffect()
      }),
    )
    const requests = plain(table.take())
    const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
    const failure = failureOf(exit)
    return {
      ok: Exit.isSuccess(exit),
      ...(failure === undefined ? {} : { failure }),
      reads: Exit.isSuccess(read),
      requests,
    }
  }).pipe(
    Effect.provide(Main.layer({ name: "t" })),
    Effect.provide(Layer.succeed(api.DynamoClient, table.client)),
    Effect.provide(
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((n) => new Uint8Array(n).fill(7)),
      ),
    ),
  ) as unknown as Effect.Effect<Outcome>
}
