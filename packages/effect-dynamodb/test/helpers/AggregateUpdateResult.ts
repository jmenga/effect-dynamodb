/**
 * What an aggregate's `update` returns (#241): published 1.40.0's object, the state the mutation
 * produced as decoded, with one change: a copy of a context attribute a member's value holds is set
 * to what its row holds after the write. Each case is created by 1.40.0, then each step is one
 * `update` from the rows that create wrote, under the same `escapeKeys` setting.
 * `fixtures/aggregate-update-result-1.40.0.json` holds what published 1.40.0 did, captured by running
 * this module with its modules; values are kept with {@link rich} (class, element order, own
 * properties, an explicit `undefined`), so whole results compare.
 *
 * No runtime import: every schema is made with the release's own modules (`UpdateLib`).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"

export type Row = Record<string, AttributeValue>
export type Request = { readonly command: string; readonly input: unknown }
export type Outcome = { readonly ok?: unknown; readonly failed?: string; readonly cause?: string }
export type Step = {
  readonly update: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
}
export type Recorded = {
  readonly create: Outcome
  readonly created: ReadonlyArray<Row>
  readonly steps: Record<string, Step>
}

/** The modules of one release the cases run with. */
export type UpdateLib = {
  readonly Aggregate: any
  readonly DynamoClient: any
  readonly Table: any
  readonly DynamoSchema: any
  readonly Schema: typeof Schema
  readonly Effect: typeof Effect
  readonly Exit: typeof Exit
  readonly Cause: typeof Cause
  readonly Layer: typeof Layer
  readonly DateTime: typeof DateTime
}

/**
 * A value as compared: JSON, keeping what JSON drops. A class instance carries its class's name
 * (`$class`), an object without a prototype `$proto: null`; an own property holding `undefined`
 * stays (`$undefined`); a `bigint`, `-0`, `NaN` and the infinities, a `Date`, bytes, a set and a map
 * are tagged; an Effect value (`DateTime`, `Option`, `BigDecimal`, …) is its `toJSON` and the names
 * of its own properties, so a property cached on it shows. Compared as text, so key order counts.
 */
export const rich = (value: unknown): unknown => {
  switch (typeof value) {
    case "undefined":
      return { $undefined: true }
    case "bigint":
      return { $bigint: String(value) }
    case "number":
      return Object.is(value, -0)
        ? { $number: "-0" }
        : Number.isFinite(value)
          ? value
          : { $number: String(value) }
    case "function":
      return { $function: value.name }
    case "symbol":
      return { $symbol: String(value) }
    case "string":
    case "boolean":
      return value
  }
  if (value === null) return null
  if (Array.isArray(value)) return value.map(rich)
  if (value instanceof Date) {
    return { $date: Number.isNaN(value.getTime()) ? "invalid" : value.toISOString() }
  }
  if (value instanceof Uint8Array) return { $bytes: [...value] }
  if (value instanceof Set) return { $set: [...value].map(rich) }
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [rich(k), rich(v)]) }
  const object = value as Record<string, unknown> & { toJSON?: () => unknown }
  const proto = Object.getPrototypeOf(object)
  if (proto !== null && proto !== Object.prototype && typeof object.toJSON === "function") {
    // A `DateTime`'s instant is in its `toJSON`.
    const own = Object.keys(object).filter((key) => key !== "epochMilliseconds")
    return { $json: rich(object.toJSON()), $own: own }
  }
  const out: Record<string, unknown> = {}
  if (proto === null) out.$proto = null
  else if (proto !== Object.prototype) out.$class = proto.constructor?.name ?? "anonymous"
  for (const key of Object.keys(object)) out[key] = rich(object[key])
  return out
}

/** A timestamp the library stamps, as compared: its text differs on every run. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const stamped = (value: unknown): unknown =>
  value === undefined
    ? value
    : JSON.parse(
        JSON.stringify(value, (_key, v) =>
          typeof v === "string" && STAMP.test(v) ? "<stamp>" : v,
        ),
      )

type StepDef = readonly [label: string, change: (state: any) => any]

export type Case = {
  readonly name: string
  readonly escapeKeys: boolean
  /**
   * Where the result holds a copy of the context attribute `tenantId` (`*` any element): set, in
   * 1.40.0's result, to the root's value, which every row holds after the write.
   */
  readonly copies?: ReadonlyArray<ReadonlyArray<string>>
}

type Built = {
  readonly Main: any
  readonly Agg: any
  readonly input: unknown
  readonly steps: ReadonlyArray<StepDef>
}

type Def = {
  readonly copies?: ReadonlyArray<ReadonlyArray<string>>
  readonly build: (lib: UpdateLib, escapeKeys: boolean) => Built
}

const defs: Readonly<Record<string, Def>> = {
  // The four cases the round-five review gave: elements added around the ones stored, reordered,
  // an optional field set to `undefined`, unchanged; and a custom assemble beside them.
  "elements added, reordered, an optional set undefined": {
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      const Line = Schema.Struct({ id: Schema.String, text: Schema.String })
      const Agg = A.make(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          extra: Schema.optional(Schema.String),
          lines: Schema.Array(Line),
        }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "agg" },
          root: { entityType: "Root" },
          edges: { lines: A.many({ entityType: "Line", sk: { composite: ["id"] } }) },
        },
      )
      return {
        Main,
        Agg,
        input: {
          id: "a",
          title: "old",
          extra: "x",
          lines: [
            { id: "b", text: "b" },
            { id: "d", text: "d" },
          ],
        },
        steps: [
          [
            "elements added before and after",
            (s) => ({
              ...s,
              title: "new",
              lines: [{ id: "c", text: "c" }, ...s.lines, { id: "a", text: "a" }],
            }),
          ],
          ["elements reversed", (s) => ({ ...s, lines: [...s.lines].reverse() })],
          ["optional set undefined", (s) => ({ ...s, title: "new", extra: undefined })],
          ["unchanged state", (s) => s],
          [
            "new object equal to the state",
            (s) => ({ ...s, lines: s.lines.map((l: any) => ({ ...l })) }),
          ],
        ],
      }
    },
  },
  "a custom assemble rewriting its elements": {
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      const Line = Schema.Struct({ id: Schema.String, text: Schema.String })
      const Agg = A.make(
        Schema.Struct({ id: Schema.String, title: Schema.String, lines: Schema.Array(Line) }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "agg" },
          root: { entityType: "Root" },
          edges: {
            lines: A.many({
              entityType: "Line",
              sk: { composite: ["id"] },
              assemble: (rows: ReadonlyArray<any>) =>
                rows.map((row, i) => ({ id: row.id, text: `position ${i}` })),
            }),
          },
        },
      )
      return {
        Main,
        Agg,
        input: {
          id: "a",
          title: "old",
          lines: [
            { id: "b", text: "b" },
            { id: "d", text: "d" },
          ],
        },
        steps: [
          ["root field", (s) => ({ ...s, title: "new" })],
          [
            "elements added before and after",
            (s) => ({ ...s, lines: [{ id: "c", text: "c" }, ...s.lines, { id: "a", text: "a" }] }),
          ],
          ["elements reversed", (s) => ({ ...s, lines: [...s.lines].reverse() })],
        ],
      }
    },
  },
  "classes, Unknown values and a sub-aggregate": {
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      class Note extends Schema.Class<Note>("UpdNote")({
        text: Schema.String,
        extra: Schema.optional(Schema.String),
      }) {}
      class Line extends Schema.Class<Line>("UpdLine")({
        k: Schema.String,
        qty: Schema.Number,
        memo: Schema.optionalKey(Schema.String),
      }) {}
      const Bit = Schema.Struct({ k: Schema.String, qty: Schema.Number })
      const Part = Schema.Struct({ name: Schema.String, bits: Schema.Array(Bit) })
      class Root extends Schema.Class<Root>("UpdRoot")({
        id: Schema.String,
        title: Schema.String,
        sub: Schema.optional(Schema.String),
        note: Note,
        lines: Schema.Array(Line),
        bag: Schema.Array(Schema.Unknown),
        any: Schema.Unknown,
        part: Part,
      }) {}
      const Agg = A.make(Root, {
        schema,
        table: Main,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "agg" },
        root: { entityType: "Root" },
        edges: {
          note: A.one({ entityType: "Note" }),
          lines: A.many({ entityType: "Line", sk: { composite: ["k"] } }),
          bag: A.many({ entityType: "Bag", sk: { composite: ["k"] } }),
          any: A.one({ entityType: "Any" }),
          part: A.make(Part, {
            root: { entityType: "Part" },
            edges: { bits: A.many({ entityType: "Bit", sk: { composite: ["k"] } }) },
          }).with({ discriminator: { side: 1 } }),
        },
      })
      return {
        Main,
        Agg,
        input: {
          id: "a",
          title: "t",
          note: new Note({ text: "n" }),
          lines: [new Line({ k: "k2", qty: 2 }), new Line({ k: "k4", qty: 4 })],
          bag: [{ k: "b2", z: 1, a: 2 }],
          any: { z: 1, a: 2 },
          part: { name: "p", bits: [{ k: "x2", qty: 1 }] },
        },
        steps: [
          ["root field", (s) => ({ ...s, title: "t2" })],
          ["optional added", (s) => ({ ...s, sub: "s" })],
          ["optional set undefined", (s) => ({ ...s, sub: undefined })],
          ["edge field", (s) => ({ ...s, note: { ...s.note, text: "n2" } })],
          ["edge optional added", (s) => ({ ...s, note: { ...s.note, extra: "e" } })],
          [
            "element changed",
            (s) => ({
              ...s,
              lines: s.lines.map((l: any) => (l.k === "k2" ? { ...l, qty: 20 } : l)),
            }),
          ],
          [
            "element appended out of key order",
            (s) => ({ ...s, lines: [...s.lines, { k: "k1", qty: 1 }] }),
          ],
          [
            "element prepended, memo given",
            (s) => ({ ...s, lines: [{ k: "k0", qty: 0, memo: "m" }, ...s.lines] }),
          ],
          ["elements reversed", (s) => ({ ...s, lines: [...s.lines].reverse() })],
          ["all elements removed", (s) => ({ ...s, lines: [] })],
          [
            "Unknown value's keys reordered and changed",
            (s) => ({ ...s, any: { c: 3, a: 2, z: 9 } }),
          ],
          ["Unknown element added first", (s) => ({ ...s, bag: [{ k: "b1", q: 1 }, ...s.bag] })],
          ["sub field", (s) => ({ ...s, part: { ...s.part, name: "p2" } })],
          [
            "sub element added out of key order",
            (s) => ({ ...s, part: { ...s.part, bits: [...s.part.bits, { k: "x1", qty: 7 }] } }),
          ],
          ["new object equal to the state", (s) => JSON.parse(JSON.stringify(s))],
        ],
      }
    },
  },
  "timestamps declared on the model": {
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      const Line = Schema.Struct({ k: Schema.String, qty: Schema.Number })
      const Agg = A.make(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          createdAt: Schema.optional(Schema.DateTimeUtc),
          updatedAt: Schema.optional(Schema.DateTimeUtc),
          note: Schema.Struct({ text: Schema.String }),
          lines: Schema.Array(Line),
        }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "agg" },
          root: { entityType: "Root" },
          timestamps: true,
          edges: {
            note: A.one({ entityType: "Note" }),
            lines: A.many({ entityType: "Line", sk: { composite: ["k"] } }),
          },
        },
      )
      return {
        Main,
        Agg,
        input: { id: "a", title: "t", note: { text: "n" }, lines: [{ k: "k2", qty: 2 }] },
        steps: [
          ["root field", (s) => ({ ...s, title: "t2" })],
          [
            "element appended out of key order",
            (s) => ({ ...s, lines: [...s.lines, { k: "k1", qty: 1 }] }),
          ],
          ["no change", (s) => s],
        ],
      }
    },
  },
  "a custom decompose and assemble, order-sensitive": {
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      const Line = Schema.Struct({ k: Schema.String, qty: Schema.Number })
      const Agg = A.make(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          lines: Schema.Struct({ first: Schema.optional(Schema.String), all: Schema.Array(Line) }),
        }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "agg" },
          root: { entityType: "Root" },
          edges: {
            lines: A.many({
              entityType: "Line",
              sk: { composite: ["k"] },
              decompose: (value: any) => value.all,
              assemble: (rows: ReadonlyArray<any>) => ({
                first: rows[0]?.k,
                all: rows.map(({ k, qty }: any) => ({ k, qty })),
              }),
            }),
          },
        },
      )
      return {
        Main,
        Agg,
        input: {
          id: "a",
          title: "t",
          lines: {
            first: "k2",
            all: [
              { k: "k2", qty: 2 },
              { k: "k4", qty: 4 },
            ],
          },
        },
        steps: [
          ["root field", (s) => ({ ...s, title: "t2" })],
          [
            "element appended out of key order",
            (s) => ({
              ...s,
              lines: { first: s.lines.first, all: [...s.lines.all, { k: "k1", qty: 1 }] },
            }),
          ],
        ],
      }
    },
  },
  "numeric many keys added out of numeric order": {
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      const Line = Schema.Struct({ k: Schema.Number, qty: Schema.Number })
      const Agg = A.make(
        Schema.Struct({ id: Schema.String, title: Schema.String, lines: Schema.Array(Line) }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "agg" },
          root: { entityType: "Root" },
          edges: { lines: A.many({ entityType: "Line", sk: { composite: ["k"] } }) },
        },
      )
      return {
        Main,
        Agg,
        input: {
          id: "a",
          title: "t",
          lines: [
            { k: 5, qty: 1 },
            { k: 10, qty: 2 },
          ],
        },
        steps: [
          [
            "element appended (7 after 10)",
            (s) => ({ ...s, lines: [...s.lines, { k: 7, qty: 3 }] }),
          ],
        ],
      }
    },
  },
  // A root field that is also the list index's partition key attribute: the row holds the key's
  // text, which the state read hands back, and under `escapeKeys` the write stores the escaped text.
  "a root field that is the list key attribute": {
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      const Line = Schema.Struct({ k: Schema.String, qty: Schema.Number })
      const Agg = A.make(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          status: Schema.String,
          lines: Schema.Array(Line),
        }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "agg" },
          root: { entityType: "Root" },
          list: {
            index: "gsi1",
            name: "byStatus",
            pk: { field: "status", composite: ["status"] },
            sk: { field: "gsi1sk", composite: ["id"] },
          },
          edges: { lines: A.many({ entityType: "Line", sk: { composite: ["k"] } }) },
        },
      )
      return {
        Main,
        Agg,
        input: { id: "a", title: "t", status: "open", lines: [{ k: "k2", qty: 2 }] },
        steps: [
          ["root field", (s) => ({ ...s, title: "t2" })],
          ["element added", (s) => ({ ...s, lines: [...s.lines, { k: "k1", qty: 1 }] })],
          ["no change", (s) => s],
        ],
      }
    },
  },
  // `tenantId` copied onto every row beneath the root (`context`). 1.40.0 returned the copies the
  // state held, read before the write; this release sets each to what its row holds after it.
  "context copies held by Unknown, struct and sub-aggregate values": {
    copies: [
      ["any", "tenantId"],
      ["own", "tenantId"],
      ["bag", "*", "tenantId"],
      ["part", "tenantId"],
      ["part", "tag", "tenantId"],
      ["part", "bits", "*", "tenantId"],
    ],
    build: (lib, escapeKeys) => {
      const { Aggregate: A, Schema } = lib
      const schema = lib.DynamoSchema.make({ name: "upd", version: 1, escapeKeys })
      const Main = lib.Table.make({ schema, entities: {} })
      const Own = Schema.Struct({ text: Schema.String, tenantId: Schema.optional(Schema.String) })
      const Part = Schema.Struct({
        name: Schema.String,
        tenantId: Schema.optional(Schema.String),
        tag: Schema.Unknown,
        bits: Schema.Array(Schema.Unknown),
      })
      const Agg = A.make(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          tenantId: Schema.String,
          any: Schema.Unknown,
          own: Own,
          bag: Schema.Array(Schema.Unknown),
          part: Part,
        }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "agg" },
          root: { entityType: "Root" },
          context: ["tenantId"],
          edges: {
            any: A.one({ entityType: "Any" }),
            own: A.one({ entityType: "Own" }),
            bag: A.many({ entityType: "Bag", sk: { composite: ["k"] } }),
            part: A.make(Part, {
              root: { entityType: "Part" },
              edges: {
                tag: A.one({ entityType: "Tag" }),
                bits: A.many({ entityType: "Bit", sk: { composite: ["k"] } }),
              },
            }).with({ discriminator: { side: 1 } }),
          },
        },
      )
      return {
        Main,
        Agg,
        input: {
          id: "a",
          title: "t",
          tenantId: "t1",
          any: { text: "x" },
          own: { text: "o" },
          bag: [{ k: "b2", text: "b" }],
          part: { name: "p", tag: { text: "pt" }, bits: [{ k: "x2", text: "x" }] },
        },
        steps: [
          ["root field", (s) => ({ ...s, title: "t2" })],
          ["context changed", (s) => ({ ...s, tenantId: "t2" })],
          [
            "context changed with a member",
            (s) => ({ ...s, tenantId: "t2", own: { ...s.own, text: "o2" } }),
          ],
          ["new Unknown element", (s) => ({ ...s, bag: [{ k: "b0" }, ...s.bag] })],
          [
            "new Unknown element under the sub-aggregate",
            (s) => ({ ...s, part: { ...s.part, bits: [{ k: "x0" }, ...s.part.bits] } }),
          ],
          [
            "context changed and a new Unknown element",
            (s) => ({ ...s, tenantId: "t2", bag: [{ k: "b0" }, ...s.bag] }),
          ],
          ["no change", (s) => s],
        ],
      }
    },
  },
}

export const cases: ReadonlyArray<Case> = Object.entries(defs).flatMap(([name, def]) =>
  [false, true].map((escapeKeys) => ({
    name: `${name}, escapeKeys ${escapeKeys ? "on" : "off"}`,
    escapeKeys,
    ...(def.copies !== undefined && { copies: def.copies }),
  })),
)

const defOf = (c: Case): Def => defs[c.name.replace(/, escapeKeys (on|off)$/, "")]!

export const build = (lib: UpdateLib, c: Case): Built => defOf(c).build(lib, c.escapeKeys)

/** The step labels of a case. */
export const stepsOf = (lib: UpdateLib, c: Case): ReadonlyArray<string> =>
  build(lib, c).steps.map(([label]) => label)

const outcomeOf = (lib: UpdateLib, exit: any): Outcome => {
  if (lib.Exit.isSuccess(exit)) return { ok: rich(exit.value) }
  const error = lib.Cause.squash(exit.cause) as { _tag?: string; cause?: unknown }
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return { failed: error._tag ?? "defect", ...(cause !== undefined && { cause }) }
}

export type UpdateIo = {
  readonly tableName: string
  readonly client: any
  readonly take: () => ReadonlyArray<Request>
  readonly scan: () => Effect.Effect<ReadonlyArray<Row>, unknown>
  /** Store rows as they are (this release's run starts from the rows 1.40.0's create wrote). */
  readonly seed?: ((rows: ReadonlyArray<Row>) => Effect.Effect<void, unknown>) | undefined
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
export const sortRows = (rows: ReadonlyArray<Row>): Array<Row> =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

/** `create`, or `created` stored as given; then one step's `update`. */
export const runStep = (
  lib: UpdateLib,
  c: Case,
  step: string,
  io: UpdateIo,
  created?: ReadonlyArray<Row>,
): Effect.Effect<
  { readonly create: Outcome; readonly created: ReadonlyArray<Row>; readonly step: Step },
  unknown
> => {
  const { Effect, Layer } = lib
  const { Main, Agg, input, steps } = build(lib, c)
  const change = steps.find(([label]) => label === step)![1]
  return Effect.gen(function* () {
    const db: any = yield* lib.DynamoClient.make({
      entities: {},
      aggregates: { Agg },
      tables: { Main },
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(lib.DynamoClient, io.client), Main.layer({ name: io.tableName })),
      ),
    )
    const agg = db.aggregates.Agg
    let create: Outcome = { ok: null }
    if (created !== undefined) yield* io.seed!(created)
    else create = outcomeOf(lib, yield* Effect.exit(agg.create(input)))
    const rows = sortRows(yield* io.scan())
    io.take()
    const update = outcomeOf(
      lib,
      yield* Effect.exit(agg.update({ id: "a" }, ({ state }: any) => change(state))),
    )
    const requests = io.take()
    const after = sortRows(yield* io.scan())
    return { create, created: rows, step: { update, requests, rows: after } }
  }) as unknown as Effect.Effect<
    { create: Outcome; created: ReadonlyArray<Row>; step: Step },
    unknown
  >
}

/**
 * 1.40.0's result as this release returns it: each copy of `tenantId` at one of the case's `copies`
 * paths (where the value holds one, own) set to the root's.
 */
export const withCopiesAsRoot = (c: Case, result: unknown): unknown => {
  if (c.copies === undefined || result === null || typeof result !== "object") return result
  const root = result as Record<string, unknown>
  if (!Object.hasOwn(root, "tenantId")) return result
  const set = (value: unknown, path: ReadonlyArray<string>): unknown => {
    if (value === null || typeof value !== "object") return value
    const [head, ...rest] = path
    if (Array.isArray(value)) {
      return head === "*" ? value.map((element) => set(element, rest)) : value
    }
    const object = value as Record<string, unknown>
    if (!Object.hasOwn(object, head!)) return value
    return {
      ...object,
      [head!]: rest.length === 0 ? root.tenantId : set(object[head!], rest),
    }
  }
  return c.copies.reduce<unknown>((value, path) => set(value, path), result)
}
