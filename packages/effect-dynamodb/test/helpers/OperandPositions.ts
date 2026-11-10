/**
 * A matrix of the positions a path operation's operand can sit at: every way a schema can wrap the
 * value, crossed with every path operation that carries an operand and with three operands (one
 * valid as given, one valid only once encoded, one invalid).
 *
 * `test/fixtures/operand-positions-1.39.0.json` holds what the published 1.39.0 did for every
 * case: the requests it sent, whether the update succeeded, and whether the row read back.
 * `test/OperandPositions.test.ts` runs the same cases against this source.
 *
 * A wrapper the library can't resolve the operand's reader through exactly is marked `unknown`:
 * an operand there is sent as 1.39.0 sent it, whatever it is.
 *
 * The library is taken as a parameter, so one definition serves both.
 */

import { DateTime, Effect, Exit, Layer, Option, Schema, SchemaGetter } from "effect"
import { SecureRandom } from "effect/crypto"
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
  /** The library can't resolve the reader through this wrapper exactly. */
  readonly unknown?: true
  /** The position is inside a union: a path can't tell which member the row holds. */
  readonly union?: true
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
    unknown: true,
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
    union: true,
  },
  {
    name: "a nested union",
    field: Schema.Union([Schema.Union([A, B]), C]),
    seed: { k: "a", ...seeded },
    base: ["target"],
    union: true,
  },
  {
    name: "a union in a sparse map's entry",
    field: Schema.Record(Schema.String, Schema.Union([A, B])),
    config: (api) => ({ storedAs: api.DynamoModel.SparseMap() }),
    seed: { a: { k: "a", ...seeded } },
    base: ["target#a"],
    union: true,
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
    unknown: true,
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
    unknown: true,
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
    unknown: true,
  },
  {
    name: "a transformed struct",
    field: Leafy.pipe(Schema.decodeTo(Schema.Struct(plainly), identity)),
    seed: seeded,
    base: ["target"],
    unknown: true,
  },
  {
    name: "a packed field",
    field: Leafy,
    config: (api) => ({ storedAs: api.DynamoModel.Packed({ format: "json" }) }),
    seed: seeded,
    base: ["target"],
    unknown: true,
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
        // A read drops an entry keyed `__proto__`, so nothing reads the operand back.
        ...(name === "__proto__" ? { unknown: true as const } : {}),
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

export interface Case {
  readonly key: string
  readonly kind: Kind
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
    operands.map(([operand, value]) => ({
      key: `${kind.name} / ${op} / ${operand}`,
      kind,
      op,
      operand,
      segments,
      value,
    })),
  )
})

/** JSON as a fixture holds it. */
export const plain = <A>(value: A): A =>
  JSON.parse(JSON.stringify(value, (_key, held) => (held instanceof Set ? [...held] : held)))

export interface Outcome {
  /** Whether the update succeeded: it returns the row, so the row it wrote decoded. */
  readonly ok: boolean
  /** Whether the item reads back afterwards. */
  readonly reads: boolean
  readonly requests: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
}

/** Whether a write was sent. */
export const wrote = (outcome: Outcome): boolean =>
  outcome.requests.some((request) => request.command !== "GetItem")

/** The entity a kind's cases run on, for a client to bind. */
export const definitions = (api: Api, kind: Kind) => {
  const model = api.DynamoModel.configure(
    Schema.Struct({ id: Schema.String, target: kind.field }),
    kind.config === undefined ? {} : { target: kind.config(api) },
  )
  const E = api.Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
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
export const capture = (api: Api, each: Case, transaction = false): Effect.Effect<Outcome> => {
  const { E, Main } = definitions(api, each.kind)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* api.DynamoClient.make({ entities: { E }, tables: { Main } })
    yield* db.entities.E.put({ id: "a", target: each.kind.seed }).asEffect()
    table.take()
    const exit = yield* Effect.exit(
      Effect.suspend(() => {
        const op = apply(each, db.entities.E.update({ id: "a" }))
        return transaction ? api.Transaction.transactWrite([op]) : op.asEffect()
      }),
    )
    const requests = plain(table.take())
    const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
    return { ok: Exit.isSuccess(exit), reads: Exit.isSuccess(read), requests }
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
