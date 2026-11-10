/**
 * Updates whose operands 1.39.0 accepted, and the requests each one sends.
 *
 * `test/fixtures/update-operand-requests-1.39.0.json` holds what the published 1.39.0 sent for
 * every case here, captured by running `capture` against it. `test/UpdateOperandRequests.test.ts`
 * runs the same cases against this source and compares the requests whole.
 *
 * The library is taken as a parameter, so one definition serves both.
 */

import { Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
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

export const variants = ["plain", "retain", "softDelete", "unique"] as const
export type Variant = (typeof variants)[number]

const Positive = Schema.Number.check(Schema.isGreaterThan(0))
/** A custom declaration that reads back: any object with a numeric `n`. */
export const Duck = Schema.declare<{ readonly n: number }>(
  (value): value is { readonly n: number } =>
    typeof value === "object" && value !== null && typeof (value as { n?: unknown }).n === "number",
)
const Entry = Schema.Struct({
  n: Positive,
  list: Schema.Array(Positive),
  nested: Schema.Struct({ n: Positive }),
  maybe: Schema.optionalKey(Positive),
  amount: Schema.NumberFromString,
  blob: Duck,
})
/** Members that store one value differently: `2` is `"2"` in the first and `2` in the second. */
const Coded = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("encoded"),
    value: Schema.NumberFromString,
    list: Schema.Array(Schema.NumberFromString),
  }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    value: Schema.Number,
    list: Schema.Array(Schema.Number),
  }),
])
/** Members that take different values, each stored as given. */
const Shape = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("number"),
    value: Schema.Number,
    list: Schema.Array(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    value: Schema.String,
    list: Schema.Array(Schema.String),
  }),
])
/** A number stored as `n` and its digits. */
const Tagged = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((text: string) => Number(text.slice(1))),
    encode: SchemaGetter.transform((n: number) => `n${n}`),
  }),
)
/** Members that each store a number as text, differently: `2` is `"2"` or `"n2"`, never `2`. */
const Rival = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("digits"), value: Schema.NumberFromString }),
  Schema.Struct({ kind: Schema.Literal("tagged"), value: Tagged }),
])
/** `count` is also the name of a renamed model field: below a field, a path's `count` is this one. */
const Tally = Schema.Struct({ count: Schema.NumberFromString, renamed: Schema.Number })

const fields = {
  id: Schema.String,
  name: Schema.String,
  count: Schema.Number,
  list: Schema.Array(Positive),
  meta: Schema.Struct({
    n: Positive,
    optional: Schema.optionalKey(Positive),
    amount: Schema.NumberFromString,
  }),
  coded: Coded,
  shape: Shape,
  tally: Tally,
  buckets: Schema.Record(Schema.String, Entry),
  codes: Schema.Record(Schema.String, Coded),
  shapes: Schema.Record(Schema.String, Shape),
  rivals: Schema.Record(Schema.String, Rival),
  tallies: Schema.Record(Schema.String, Tally),
  beside: Entry,
}

/** A number stored as one digit of text. */
const Digit = Schema.String.check(Schema.isPattern(/^[0-9]$/)).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((text: string) => Number(text)),
    encode: SchemaGetter.transform((n: number) => String(n)),
  }),
)
/** An entry whose every property is stored as text and read from a number too. */
const Slot = Schema.Struct({
  amount: Schema.NumberFromString,
  amounts: Schema.Array(Schema.NumberFromString),
  nested: Schema.Struct({ amount: Schema.NumberFromString }),
  digit: Digit,
  maybe: Schema.optionalKey(Schema.NumberFromString),
})
/** A number stored as a set of one number: two encodings of it are two `Set`s holding the same. */
const InSet = Schema.ReadonlySet(Schema.Number).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((set: ReadonlySet<number>) => [...set][0]!),
    encode: SchemaGetter.transform((n: number) => new Set([n])),
  }),
)
/** Members that store a value the same way, as a set. */
const Sets = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("a"), value: InSet }),
  Schema.Struct({ kind: Schema.Literal("b"), value: InSet }),
])

/**
 * The second model, `"stored"`: operands whose stored form differs from what 1.39.0 wrote and its
 * reader read all the same, and a union of lists.
 */
const storedFields = {
  id: Schema.String,
  name: Schema.String,
  count: Schema.Number,
  counts: Schema.Record(Schema.String, Schema.NumberFromString),
  bigs: Schema.Record(Schema.String, Schema.BigIntFromString),
  slots: Schema.Record(Schema.String, Slot),
  sets: Schema.Record(Schema.String, Sets),
  either: Schema.Union([Schema.Array(Schema.Number), Schema.Array(Schema.String)]),
}

/**
 * The third model, `"named"`: fields named as entries of the sparse map `lists` (whose prefix is
 * `list`) would be, and stored elsewhere. A retained entity's update of such a model fails on
 * 1.39.0 whatever it writes, so these cases don't run on one.
 */
const namedFields = {
  id: Schema.String,
  name: Schema.String,
  count: Schema.Number,
  "list#x": Schema.Array(Schema.NumberFromString),
  "list#n": Schema.Number,
  "list#s": Schema.ReadonlySet(Schema.String),
  lists: Schema.Record(Schema.String, Schema.Array(Schema.Boolean)),
}

export type World = "main" | "stored" | "named"

export const definitions = (api: Api, variant: Variant, world: World = "main") => {
  const sparse = { storedAs: api.DynamoModel.SparseMap() }
  const model =
    world === "main"
      ? api.DynamoModel.configure(Schema.Struct(fields), {
          count: { field: "renamed" },
          buckets: sparse,
          codes: sparse,
          shapes: sparse,
          rivals: sparse,
          tallies: sparse,
        })
      : world === "stored"
        ? api.DynamoModel.configure(Schema.Struct(storedFields), {
            counts: sparse,
            bigs: sparse,
            slots: sparse,
            sets: sparse,
          })
        : api.DynamoModel.configure(Schema.Struct(namedFields), {
            "list#x": { field: "storedList" },
            "list#n": { field: "storedN" },
            "list#s": { field: "storedSet" },
            lists: { storedAs: api.DynamoModel.SparseMap({ prefix: "list" }) },
          })
  const E = api.Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(variant === "retain" ? { versioned: { retain: true } } : {}),
    ...(variant === "softDelete" ? { softDelete: true } : {}),
    ...(variant === "unique" ? { unique: { name: ["name"] } } : {}),
  })
  const Main = api.Table.make({
    schema: api.DynamoSchema.make({ name: "operands", version: 1 }),
    entities: { E },
  })
  return { E, Main }
}

const entry = (n: number) => ({ n, list: [n], nested: { n }, amount: n, blob: { n } })
const storedSeed = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  count: 1,
  counts: { a: 1 },
  bigs: { a: 1n },
  slots: { a: { amount: 1, amounts: [1], nested: { amount: 1 }, digit: 1 } },
  sets: { a: { kind: "b", value: 1 } },
  either: [1],
})
const namedSeed = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  count: 1,
  "list#x": [1],
  "list#n": 1,
  "list#s": new Set(["a", "b"]),
  lists: { x: [true] },
})
export const seed = (id: string, world: World = "main"): Record<string, unknown> =>
  world === "stored" ? storedSeed(id) : world === "named" ? namedSeed(id) : mainSeed(id)
const mainSeed = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  count: 1,
  list: [1],
  meta: { n: 1, amount: 1 },
  coded: { kind: "encoded", value: 1, list: [1] },
  shape: { kind: "number", value: 1, list: [1] },
  tally: { count: 1, renamed: 1 },
  buckets: { a: entry(1) },
  codes: {
    a: { kind: "raw", value: 1, list: [1] },
    b: { kind: "encoded", value: 1, list: [1] },
  },
  shapes: { a: { kind: "text", value: "old", list: ["old"] } },
  rivals: { a: { kind: "tagged", value: 1 } },
  tallies: { a: { count: 1, renamed: 1 } },
  beside: entry(2),
})

type Segments = ReadonlyArray<string | number>
const set = (segments: Segments, value: unknown) => (update: any) =>
  update.pathSet({ segments, value, isPath: false })
const copy = (segments: Segments, valueSegments: Segments) => (update: any) =>
  update.pathSet({ segments, value: undefined, isPath: true, valueSegments })
const append = (segments: Segments, value: unknown) => (update: any) =>
  update.pathAppend({ segments, value })
const prepend = (segments: Segments, value: unknown) => (update: any) =>
  update.pathPrepend({ segments, value })
const ifNotExists = (segments: Segments, value: unknown) => (update: any) =>
  update.pathIfNotExists({ segments, value })

export interface Case {
  readonly name: string
  readonly apply: (update: any) => any
  /** Every variant, or the two that neither read first nor retain alone. */
  readonly everyVariant?: true
  /** The model the case runs on: the first one, unless it says another. */
  readonly world?: World
}

/** Each case's operand is one 1.39.0 wrote and read back. */
export const cases: ReadonlyArray<Case> = [
  // Paths the model names.
  { name: "append", apply: (update) => update.append({ list: [2] }) },
  { name: "pathSet", apply: set(["meta", "n"], 2) },
  { name: "pathSet of a transformed field", apply: set(["meta", "amount"], 7) },
  { name: "pathAppend", apply: append(["list"], [3]) },
  { name: "pathPrepend", apply: prepend(["list"], [4]) },
  { name: "pathIfNotExists", apply: ifNotExists(["meta", "optional"], 5) },
  { name: "pathSet of a field copied from another", apply: copy(["meta", "n"], ["beside", "n"]) },
  // A path into a union, for the member 1.39.0 wrote by: the first that has the property.
  { name: "pathSet into a union's first member", apply: set(["coded", "value"], 2) },
  { name: "pathAppend into a union's first member", apply: append(["coded", "list"], [2]) },
  { name: "pathSet into a union whose members agree", apply: set(["shape", "value"], 3) },
  // Paths naming a sparse map's entry, which 1.39.0 wrote as given.
  { name: "entry: pathSet of a field", apply: set(["buckets#a", "n"], 2) },
  {
    name: "entry: pathSet of the whole entry",
    apply: set(["buckets#a"], { n: 2, list: [2], nested: { n: 2 }, amount: "2", blob: { n: 2 } }),
  },
  {
    name: "entry: pathSet of a new entry",
    apply: set(["buckets#z"], { n: 3, list: [3], nested: { n: 3 }, amount: "3", blob: { n: 3 } }),
  },
  {
    name: "entry: pathSet of a value in its stored form",
    apply: set(["buckets#a", "amount"], "7"),
  },
  {
    name: "entry: pathSet of a stored form that encoding would rewrite",
    apply: set(["buckets#a", "amount"], "007"),
  },
  { name: "entry: pathAppend", apply: append(["buckets#a", "list"], [3]) },
  { name: "entry: pathPrepend", apply: prepend(["buckets#a", "list"], [4]) },
  { name: "entry: pathIfNotExists", apply: ifNotExists(["buckets#a", "maybe"], 5) },
  {
    name: "entry: pathSet into a union's second member",
    apply: set(["codes#a", "value"], 2),
    everyVariant: true,
  },
  {
    name: "entry: pathAppend into a union's second member",
    apply: append(["codes#a", "list"], [2]),
  },
  {
    name: "entry: pathPrepend into a union's second member",
    apply: prepend(["codes#a", "list"], [2]),
  },
  {
    name: "entry: pathIfNotExists into a union's second member",
    apply: ifNotExists(["codes#a", "value"], 2),
  },
  { name: "entry: pathSet into a union's first member", apply: set(["codes#b", "value"], "2") },
  {
    name: "entry: pathSet of a value only a union's second member takes",
    apply: set(["shapes#a", "value"], "new"),
    everyVariant: true,
  },
  {
    name: "entry: pathAppend of values only a union's second member takes",
    apply: append(["shapes#a", "list"], ["new"]),
  },
  {
    name: "entry: pathSet of a whole entry copied from a field",
    apply: copy(["buckets#a"], ["beside"]),
    everyVariant: true,
  },
  {
    name: "entry: pathSet of a property copied from a field's",
    apply: copy(["buckets#a", "blob"], ["beside", "blob"]),
    everyVariant: true,
  },
  // An entry's operand in a form its schema doesn't store, which the row's reader reads all the
  // same: a number where the schema stores text.
  {
    name: "entry: pathSet of a number its schema stores as text",
    apply: set(["counts#a"], 2),
    everyVariant: true,
    world: "stored",
  },
  {
    name: "entry: pathSet of a bigint its schema stores as text",
    apply: set(["bigs#a"], 2n),
    world: "stored",
  },
  {
    name: "entry: pathSet of a property that is such a number",
    apply: set(["slots#a", "amount"], 2),
    world: "stored",
  },
  {
    name: "entry: pathSet of a nested property that is such a number",
    apply: set(["slots#a", "nested", "amount"], 2),
    world: "stored",
  },
  {
    name: "entry: pathSet of a whole entry of such numbers",
    apply: set(["slots#a"], { amount: 2, amounts: [2], nested: { amount: 2 }, digit: 2 }),
    world: "stored",
  },
  {
    name: "entry: pathAppend of such numbers",
    apply: append(["slots#a", "amounts"], [2]),
    world: "stored",
  },
  {
    name: "entry: pathPrepend of such numbers",
    apply: prepend(["slots#a", "amounts"], [2]),
    world: "stored",
  },
  {
    name: "entry: pathIfNotExists of such a number",
    apply: ifNotExists(["slots#a", "maybe"], 2),
    world: "stored",
  },
  {
    name: "entry: pathSet of a number its schema's stored form has no text for",
    apply: set(["slots#a", "digit"], 10),
    world: "stored",
  },
  // Record operations on a field whose name reads as an entry's and whose attribute isn't one.
  {
    name: "append to a field named as an entry and stored elsewhere",
    apply: (update) => update.append({ "list#x": [2] }),
    everyVariant: true,
    world: "named",
  },
  {
    name: "set of a field named as an entry and stored elsewhere",
    apply: (update) => update.set({ "list#x": [3] }),
    world: "named",
  },
  {
    name: "add to a field named as an entry and stored elsewhere",
    apply: (update) => update.add({ "list#n": 1 }),
    world: "named",
  },
  {
    name: "subtract from a field named as an entry and stored elsewhere",
    apply: (update) => update.subtract({ "list#n": 1 }),
    world: "named",
  },
  {
    name: "deleteFromSet of a field named as an entry and stored elsewhere",
    apply: (update) => update.deleteFromSet({ "list#s": new Set(["a"]) }),
    world: "named",
  },
  // An append to a union of lists, of elements one of the lists takes.
  {
    name: "append to a union of lists",
    apply: (update) => update.append({ either: [2] }),
    world: "stored",
  },
  { name: "pathAppend to a union of lists", apply: append(["either"], [2]), world: "stored" },
  { name: "pathPrepend to a union of lists", apply: prepend(["either"], [2]), world: "stored" },
]

/** Each case, on each variant it runs on, alone and in a transaction. */
export const matrix: ReadonlyArray<{
  readonly key: string
  readonly variant: Variant
  readonly transaction: boolean
  readonly world: World
  readonly apply: (update: any) => any
}> = cases.flatMap((each) =>
  variants
    .filter((variant) =>
      each.world === "named"
        ? variant !== "retain"
        : each.everyVariant || variant === "plain" || variant === "retain",
    )
    .flatMap((variant) =>
      [false, true].map((transaction) => ({
        key: `${each.name} / ${variant} / ${transaction ? "in a transaction" : "alone"}`,
        variant,
        transaction,
        world: each.world ?? "main",
        apply: each.apply,
      })),
    ),
)

/** JSON as a fixture holds it. */
export const plain = <A>(value: A): A => JSON.parse(JSON.stringify(value))

export interface Captured {
  /** Whether the update succeeded: alone, that means the row it returned decoded. */
  readonly ok: boolean
  readonly requests: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
  /** The row of item `a` after the update. */
  readonly row: Record<string, any> | undefined
  /** Whether item `a` reads back afterwards. */
  readonly reads: boolean
  readonly error: unknown
}

/** Seeds items `a` and `b`, applies `apply` to an update of `a`, and returns what was sent. */
export const capture = (
  api: Api,
  variant: Variant,
  transaction: boolean,
  apply: (update: any) => any,
  /** Fields of item `a` to seed differently. */
  seeded: Record<string, unknown> = {},
  world: World = "main",
): Effect.Effect<Captured> => {
  const { E, Main } = definitions(api, variant, world)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* api.DynamoClient.make({ entities: { E }, tables: { Main } })
    yield* db.entities.E.put({ ...seed("a", world), ...seeded }).asEffect()
    yield* db.entities.E.put(seed("b", world)).asEffect()
    table.take()
    const update = (id: string) => db.entities.E.update({ id })
    const exit = yield* Effect.exit(
      Effect.suspend(() => {
        const op = apply(update("a"))
        return transaction
          ? api.Transaction.transactWrite([update("b").set({ count: 2 }), op])
          : op.asEffect()
      }),
    )
    const requests = plain(table.take())
    const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
    const row = [...table.items.values()].find(
      (item) => item.id?.S === "a" && item.sk?.S === "$operands#v1#e",
    )
    return {
      ok: Exit.isSuccess(exit),
      requests,
      row: row === undefined ? undefined : plain(row),
      reads: Exit.isSuccess(read),
      error: Exit.isFailure(exit) ? exit.cause : undefined,
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
  ) as unknown as Effect.Effect<Captured>
}
