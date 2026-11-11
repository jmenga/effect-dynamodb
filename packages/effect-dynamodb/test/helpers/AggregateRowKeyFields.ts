/**
 * A row's value declaring a field named like an attribute the library writes on that row (#241,
 * `EDD-9159`): the partition key attribute, `sk`, `__edd_e__`, the root's list keys, the collection
 * sort key's copy, or a discriminator. The library writes its own value there over the value's, so
 * published 1.39.0 and 1.40.0 stored a row and read back something else than they were given.
 *
 * - **Read back, whatever was given, on every row** (an attribute every row holds and a read hands
 *   back: `id` as the partition key attribute, the collection sort key's copy): every row misread,
 *   so `Aggregate.make` refuses the definition, the pure one and the operational one alike.
 * - **A list key a read hands back**: the list keys are sparse, written only when every list
 *   composite has a value, so a write composing them is refused, and one composing none is written
 *   and read as 1.40.0 did (1.39.0 died on it: its list keys weren't sparse).
 * - **Taken off on a read** (`pk`, `sk`, `__edd_e__`, `gsi1pk` on the root, `readTakesOff`): a
 *   value given there was lost (or, held by a sort key composite, failed every read), so a write
 *   giving it one is refused. One giving it none is written and read as 1.40.0 did.
 * - **A discriminator**: the field read back the discriminator's value, so a write holding another,
 *   or none, is refused. One holding the discriminator's own value, as given or as stored (a
 *   `NumberFromString` holding `1` stored as `"1"`), is written and read as 1.40.0 did.
 *
 * Nothing is sent for a refused write. `fixtures/aggregate-row-key-fields-1.40.0.json` holds what
 * published 1.39.0 and 1.40.0 did for each shape on DynamoDB Local. One suite, run on a recording
 * table (`AggregateRowKeyFields.test.ts`) and against DynamoDB Local
 * (`connected.aggregate-row-key-fields.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as PureAggregate from "@effect-dynamodb/schema/Aggregate.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { readTakesOff } from "@effect-dynamodb/schema/internal/AggregateSchemas.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"

type Row = Record<string, AttributeValue>
type Outcome = {
  readonly ok?: unknown
  readonly failed?: string
  readonly operation?: string
  readonly cause?: string
}
type Recorded = {
  readonly create: Outcome
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
  readonly noop: Outcome
  readonly getAfterUpdate: Outcome
}
type Published = {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.39.0": Record<string, Recorded>
  readonly "1.40.0": Record<string, Recorded>
}
const published: Published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-row-key-fields-1.40.0.json", import.meta.url),
    "utf8",
  ),
)
/** How published 1.39.0 and 1.40.0 read a value's fields off its row, by the kind of row. */
const publishedStrip: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.39.0": Record<string, { readonly create: Outcome; readonly get: Outcome }>
  readonly "1.40.0": Record<string, { readonly create: Outcome; readonly get: Outcome }>
} = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-read-strip-1.40.0.json", import.meta.url), "utf8"),
)

const schema = DynamoSchema.make({ name: "keyf", version: 1 })
export const Main = Table.make({ schema, entities: {} })

/** The `Aggregate` module a shape is defined with: the operational one, or the pure one. */
type Module = Pick<typeof Aggregate, "make" | "one" | "many">

type Shape = {
  readonly model: Schema.Top
  readonly edges: Record<string, unknown>
  readonly input: unknown
  /** The partition key attribute, when it isn't `pk`. */
  readonly pk?: string
  readonly collection?: unknown
  readonly list?: unknown
  /** Refused by `Aggregate.make`, with this message. */
  readonly make?: string
  /** Refused at `create`, nothing sent, with this message, naming `member`. */
  readonly write?: string
  readonly member?: string
  /** What 1.40.0's read returned, for a refused shape: not what was given. */
  readonly read140?: Outcome
  /** What a read returns, when it isn't the input. */
  readonly read?: unknown
}

const S = Schema.String
const opt = Schema.optional
const one = (A: Module, options: Record<string, unknown> = {}) =>
  (A.one as any)({ entityType: "Note", ...options })
const many = (A: Module, sk: ReadonlyArray<string> = ["qty"]) =>
  (A.many as any)({ entityType: "Line", sk: { composite: sk } })
const sub = (A: Module, Part: Schema.Top, edges: Record<string, unknown>) =>
  (A.make as any)(Part, { root: { entityType: "Part" }, edges }).with({
    discriminator: { side: "x" },
  })

const atMake = (owner: string, field: string, what: string) =>
  `[EDD-9159] Aggregate "Root": ${owner} declares a field "${field}", which is also ${what}. ` +
  "The library writes that attribute on the row over the value's own and a read hands it back"
const lost = (member: string, field: string, what: string) =>
  `[EDD-9159] "${member}" gives its field "${field}" a value, but "${field}" is also ${what}. ` +
  "The library writes that attribute on the row over the value's own and a read takes it off"
const overDiscriminator = (member: string, held: string, field: string) =>
  `[EDD-9159] "${member}" ${held} its field "${field}", which is also a discriminator its rows carry.`
const listKey = (field: string, what: string) =>
  `[EDD-9159] "Root" declares a field "${field}", which is also ${what}. This write composes the ` +
  "list keys, which the library writes on the row over the value's own and a read hands back"
const byRank = {
  index: "gsi1",
  name: "byRank",
  pk: { field: "lpk", composite: [] },
  sk: { field: "rank", composite: ["rank"] },
}
const byPrio = (pk: string, sk: string) => ({
  index: "gsi1",
  name: "byPrio",
  pk: { field: pk, composite: [] },
  sk: { field: sk, composite: ["prio"] },
})
const PK = "the attribute holding the partition key"
const SK = "the attribute holding its sort key"
const TYPE = "the attribute holding its entity type"

export const shapes: Record<string, (A: Module) => Shape> = {
  "root declares pk (optional), given mine": () => ({
    model: Schema.Struct({ id: S, pk: opt(S) }),
    edges: {},
    input: { id: "a", pk: "mine" },
    write: lost("Root", "pk", PK),
    member: "Root",
    read140: { ok: { id: "a" } },
  }),
  "root declares pk (optional), given none": () => ({
    model: Schema.Struct({ id: S, pk: opt(S) }),
    edges: {},
    input: { id: "a" },
  }),
  "root's composite id is the pk attribute": () => ({
    model: Schema.Struct({ id: S, title: S }),
    edges: {},
    input: { id: "a", title: "t" },
    pk: "id",
    make: atMake("its root", "id", PK),
    read140: { ok: { id: "$keyf#v1#keyf#a", title: "t" } },
  }),
  "root declares sk (optional), given mine": () => ({
    model: Schema.Struct({ id: S, sk: opt(S) }),
    edges: {},
    input: { id: "a", sk: "mine" },
    write: lost("Root", "sk", SK),
    member: "Root",
    read140: { ok: { id: "a" } },
  }),
  "root declares __edd_e__ (optional), given mine": () => ({
    model: Schema.Struct({ id: S, __edd_e__: opt(S) }),
    edges: {},
    input: { id: "a", __edd_e__: "mine" },
    write: lost("Root", "__edd_e__", TYPE),
    member: "Root",
    read140: { ok: { id: "a" } },
  }),
  "root declares the list pk attribute status": () => ({
    model: Schema.Struct({ id: S, status: S }),
    edges: {},
    input: { id: "a", status: "open" },
    list: {
      index: "gsi1",
      name: "byStatus",
      pk: { field: "status", composite: ["status"] },
      sk: { field: "lsk", composite: ["id"] },
    },
    write: listKey("status", "the attribute holding its list partition key"),
    member: "Root",
    read140: { ok: { id: "a", status: "$keyf#v1#bystatus#open" } },
  }),
  "root declares the list sk attribute rank": () => ({
    model: Schema.Struct({ id: S, rank: S }),
    edges: {},
    input: { id: "a", rank: "r1" },
    list: byRank,
    write: listKey("rank", "the attribute holding its list sort key"),
    member: "Root",
    read140: { ok: { id: "a", rank: "$keyf#v1#byrank#r1" } },
  }),
  "root declares the list sk attribute rank (optional), given none": () => ({
    model: Schema.Struct({ id: S, rank: opt(S) }),
    edges: {},
    input: { id: "a" },
    list: byRank,
  }),
  "root declares the list sk attribute lsk, given mine, its list composite prio given none":
    () => ({
      model: Schema.Struct({ id: S, lsk: opt(S), prio: opt(S) }),
      edges: {},
      input: { id: "a", lsk: "mine" },
      list: byPrio("lpk", "lsk"),
    }),
  "root declares the list sk attribute lsk, given mine, its list composite prio given": () => ({
    model: Schema.Struct({ id: S, lsk: opt(S), prio: opt(S) }),
    edges: {},
    input: { id: "a", lsk: "mine", prio: "p1" },
    list: byPrio("lpk", "lsk"),
    write: listKey("lsk", "the attribute holding its list sort key"),
    member: "Root",
    read140: { ok: { id: "a", lsk: "$keyf#v1#byprio#p1", prio: "p1" } },
  }),
  "root declares the list pk attribute gsi1pk (optional), given mine": () => ({
    model: Schema.Struct({ id: S, gsi1pk: opt(S), prio: opt(S) }),
    edges: {},
    input: { id: "a", gsi1pk: "mine" },
    list: byPrio("gsi1pk", "gsi1sk"),
    write: lost("Root", "gsi1pk", "the attribute holding its list partition key"),
    member: "Root",
    read140: { ok: { id: "a" } },
  }),
  "one edge value declares sk (optional), given mine": (A) => ({
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, sk: opt(S) }) }),
    edges: { note: one(A) },
    input: { id: "a", note: { text: "n", sk: "mine" } },
    write: lost("note", "sk", SK),
    member: "note",
    read140: { ok: { id: "a", note: { text: "n" } } },
  }),
  "one edge value declares pk (optional), given none": (A) => ({
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, pk: opt(S) }) }),
    edges: { note: one(A) },
    input: { id: "a", note: { text: "n" } },
  }),
  "many element declares sk as its sort key composite": (A) => ({
    model: Schema.Struct({
      id: S,
      lines: Schema.Array(Schema.Struct({ sk: S, qty: Schema.Number })),
    }),
    edges: { lines: many(A, ["sk"]) },
    input: { id: "a", lines: [{ sk: "x", qty: 1 }] },
    write: lost("lines", "sk", SK),
    member: "lines",
    read140: { failed: "ValidationError", operation: "aggregate.assemble" },
  }),
  "many element declares __edd_e__ (optional), given mine": (A) => ({
    model: Schema.Struct({
      id: S,
      lines: Schema.Array(Schema.Struct({ qty: Schema.Number, __edd_e__: opt(S) })),
    }),
    edges: { lines: many(A) },
    input: { id: "a", lines: [{ qty: 1, __edd_e__: "mine" }] },
    write: lost("lines", "__edd_e__", TYPE),
    member: "lines",
    read140: { ok: { id: "a", lines: [{ qty: 1 }] } },
  }),
  "sub-aggregate declares pk (optional), given mine": (A) => {
    const Part = Schema.Struct({ name: S, pk: opt(S) })
    return {
      model: Schema.Struct({ id: S, part: Part }),
      edges: { part: sub(A, Part, {}) },
      input: { id: "a", part: { name: "p", pk: "mine" } },
      write: lost("part", "pk", PK),
      member: "part",
      read140: { ok: { id: "a", part: { name: "p" } } },
    }
  },
  "one edge value declares csk, the collection sk mirror, given mine": (A) => ({
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, csk: opt(S) }) }),
    edges: { note: one(A) },
    input: { id: "a", note: { text: "n", csk: "mine" } },
    collection: { name: "keyf", index: "lsi1", sk: { field: "csk", composite: [] } },
    make: atMake(
      'the value of edge "note"',
      "csk",
      "the attribute holding the collection sort key's copy",
    ),
    read140: { ok: { id: "a", note: { text: "n", csk: "$keyf#v1#note" } } },
  }),
  "one edge value declares its discriminator kind, given another": (A) => ({
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, kind: S }) }),
    edges: { note: one(A, { discriminator: { kind: "a" } }) },
    input: { id: "a", note: { text: "n", kind: "b" } },
    write: overDiscriminator("note", 'holds "b" in', "kind"),
    member: "note",
    read140: { ok: { id: "a", note: { text: "n", kind: "a" } } },
  }),
  "one edge value declares its discriminator kind, given it": (A) => ({
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, kind: S }) }),
    edges: { note: one(A, { discriminator: { kind: "a" } }) },
    input: { id: "a", note: { text: "n", kind: "a" } },
  }),
  // The library fills the field: no value given is changed, so it's written and read as before.
  "one edge value declares its discriminator kind (optional), given none": (A) => ({
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, kind: opt(S) }) }),
    edges: { note: one(A, { discriminator: { kind: "a" } }) },
    input: { id: "a", note: { text: "n" } },
    read: { id: "a", note: { text: "n", kind: "a" } },
  }),
  "one edge value declares its numeric discriminator n as NumberFromString, given it": (A) => ({
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, n: Schema.NumberFromString }) }),
    edges: { note: one(A, { discriminator: { n: 1 } }) },
    input: { id: "a", note: { text: "n", n: 1 } },
  }),
  "many element under a sub-aggregate declares its discriminator side, given another": (A) => {
    const Part = Schema.Struct({
      name: S,
      lines: Schema.Array(Schema.Struct({ qty: Schema.Number, side: S })),
    })
    return {
      model: Schema.Struct({ id: S, part: Part }),
      edges: { part: sub(A, Part, { lines: many(A) }) },
      input: { id: "a", part: { name: "p", lines: [{ qty: 1, side: "y" }] } },
      write: overDiscriminator("lines", 'holds "y" in', "side"),
      member: "lines",
      read140: { ok: { id: "a", part: { name: "p", lines: [{ qty: 1, side: "x" }] } } },
    }
  },
  "sub-aggregate declares its discriminator side, given another": (A) => {
    const Part = Schema.Struct({ name: S, side: S })
    return {
      model: Schema.Struct({ id: S, part: Part }),
      edges: { part: sub(A, Part, {}) },
      input: { id: "a", part: { name: "p", side: "y" } },
      write: overDiscriminator("part", 'holds "y" in', "side"),
      member: "part",
      read140: { ok: { id: "a", part: { name: "p", side: "x" } } },
    }
  },
  "sub-aggregate declares its discriminator side, given it": (A) => {
    const Part = Schema.Struct({ name: S, side: S })
    return {
      model: Schema.Struct({ id: S, part: Part }),
      edges: { part: sub(A, Part, {}) },
      input: { id: "a", part: { name: "p", side: "x" } },
    }
  },
}

/** The shapes whose list composite has no value: 1.39.0, whose list keys weren't sparse, died. */
const diedOn139 = new Set([
  "root declares the list sk attribute rank (optional), given none",
  "root declares the list sk attribute lsk, given mine, its list composite prio given none",
  "root declares the list pk attribute gsi1pk (optional), given mine",
])

export interface Harness {
  /** Run `body` on a fresh, empty table keyed by `pk` and `sk`, bound to `Main`. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  /** Every row of the table. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The commands sent since the last call. */
  readonly commands: (tableName: string) => Effect.Effect<ReadonlyArray<string>>
}

const bySortKey = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => ((a.sk?.S ?? "") < (b.sk?.S ?? "") ? -1 : 1))

/** An outcome as compared: a value, or a failure by its tag and operation. */
const outcome = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const error = Cause.squash(exit.cause) as { _tag?: string; operation?: string }
  return {
    failed: error._tag ?? "defect",
    ...(error.operation !== undefined && { operation: error.operation }),
  }
}
const judged = (result: Outcome): Outcome =>
  result.failed === undefined
    ? { ok: result.ok }
    : {
        failed: result.failed,
        ...(result.operation !== undefined && { operation: result.operation }),
      }

/** The pure `make` reads a collection's index and sort key, so it's given one beside the shape's. */
const PURE_COLLECTION = { name: "keyf", index: "gsi9", sk: { field: "gsi9sk", composite: [] } }

const define = (A: Module, shape: Shape) =>
  (A.make as any)(shape.model, {
    table: Main,
    schema,
    pk: { field: shape.pk ?? "pk", composite: ["id"] },
    collection:
      shape.collection ?? ((A as unknown) === PureAggregate ? PURE_COLLECTION : { name: "keyf" }),
    ...(shape.list !== undefined && { list: shape.list }),
    root: { entityType: "Root" },
    edges: shape.edges,
  })

const bind = (shape: Shape) =>
  Effect.gen(function* () {
    const A = define(Aggregate, shape)
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { A },
      tables: { Main },
    } as never)
    return db.aggregates.A
  })

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a row's value declaring a field the library writes on the row (EDD-9159)", () => {
    it("the fixture is published 1.39.0's and 1.40.0's, for every shape, and they agree", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0", "effect-dynamodb@1.39.0"])
      expect(Object.keys(published["1.40.0"]).sort()).toEqual(Object.keys(shapes).sort())
      expect(Object.keys(published["1.39.0"]).sort()).toEqual(Object.keys(shapes).sort())
      for (const [label, was] of Object.entries(published["1.39.0"])) {
        // 1.39.0's list keys weren't sparse: a list composite with no value died.
        if (diedOn139.has(label)) {
          expect({ label, died: (was.create as { died?: string }).died }).toEqual({
            label,
            died: expect.stringContaining("Error: Missing composite attribute"),
          })
          expect(was.rows).toEqual([])
          continue
        }
        expect({ label, ...was }).toEqual({ label, ...published["1.40.0"][label] })
      }
    })

    describe("a sub-aggregate's row is read as a sub-aggregate's root with an edge of its own, as a one edge's without", () => {
      const strip = DynamoSchema.make({ name: "strip", version: 1 })
      const StripTable = Table.make({ schema: strip, entities: {} })
      const then = publishedStrip["1.40.0"]
      const pure = PureAggregate as unknown as Module
      const sub = (A: Module, withEdge: boolean) => {
        const Part = Schema.Struct({
          name: S,
          pkey: opt(S),
          ...(withEdge ? { note: Schema.Struct({ text: S }) } : {}),
        })
        const Sub = (A.make as any)(Part, {
          root: { entityType: "Part" },
          edges: withEdge ? { note: (A.one as any)({ entityType: "Note" }) } : {},
        })
        return (A.make as any)(Schema.Struct({ id: S, part: Part }), {
          table: StripTable,
          schema: strip,
          pk: { field: "pkey", composite: ["id"] },
          collection: A === pure ? { ...PURE_COLLECTION, name: "strip" } : { name: "strip" },
          root: { entityType: "Root" },
          edges: { part: Sub.with({ discriminator: { side: 1 } }) },
        })
      }

      it("the fixture is published 1.39.0's and 1.40.0's, and they agree", () => {
        expect(publishedStrip.generatedFrom).toEqual([
          "effect-dynamodb@1.40.0",
          "effect-dynamodb@1.39.0",
        ])
        expect(publishedStrip["1.39.0"]).toEqual(publishedStrip["1.40.0"])
      })

      it("readTakesOff states 1.40.0's reads: prefixes off an edge's and a sub-aggregate root's row", () => {
        expect(judged(then["one edge declaring gsiNote"]!.get)).toEqual({
          failed: "ValidationError",
          operation: "aggregate.assemble",
        })
        expect(judged(then["sub-aggregate with an edge, declaring skills"]!.get)).toEqual({
          failed: "ValidationError",
          operation: "aggregate.assemble",
        })
        expect(judged(then["sub-aggregate declaring skills"]!.get)).toEqual({
          ok: { id: "a", part: { name: "p", skills: "ts" } },
        })
        expect(judged(then["sub-aggregate declaring pkg (optional)"]!.get)).toEqual({
          ok: { id: "a", part: { name: "p", pkg: "x" } },
        })
        expect(judged(then["root declaring gsi2pk (optional), no list"]!.get)).toEqual({
          ok: { id: "a" },
        })
        expect(readTakesOff("edge", "gsiNote")).toBe(true)
        expect(readTakesOff("subAggregate", "skills")).toBe(true)
        expect(readTakesOff("edge", "skills")).toBe(false)
        expect(readTakesOff("edge", "pkg")).toBe(false)
        expect(readTakesOff("root", "gsi2pk")).toBe(true)
        expect(readTakesOff("root", "gsiNote")).toBe(false)
      })

      it("without an edge, its pkey read back the key text, so Aggregate.make refuses it", () => {
        const label =
          "childless sub-aggregate declaring pkey (optional), keyed under pkey, given none"
        expect(judged(then[label]!.get)).toEqual({
          ok: { id: "a", part: { name: "p", pkey: "$strip#v1#strip#a" } },
        })
        const message = atMake('the sub-aggregate at "part"', "pkey", PK)
        expect(() => sub(Aggregate, false)).toThrow(message)
        expect(() => sub(pure, false)).toThrow(message)
      })

      it("with an edge, its pkey was taken off, so only a write giving it a value is refused", () =>
        Effect.runPromise(
          harness.onTable((tableName) =>
            Effect.gen(function* () {
              const label =
                "sub-aggregate with an edge declaring pkey (optional), keyed under pkey, given mine"
              expect(judged(then[label]!.get)).toEqual({
                ok: { id: "a", part: { name: "p", note: { text: "n" } } },
              })
              expect(() => sub(pure, true)).not.toThrow()
              const A = sub(Aggregate, true)
              const db: any = yield* DynamoClient.make({
                entities: {},
                aggregates: { A },
                tables: { StripTable },
              } as never).pipe(Effect.provide(StripTable.layer({ name: tableName })))
              yield* harness.commands(tableName)
              const exit = yield* Effect.exit(
                db.aggregates.A.create({
                  id: "a",
                  part: { name: "p", pkey: "mine", note: { text: "n" } },
                }),
              )
              const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as {
                _tag?: string
                reason?: string
              }
              expect(error._tag).toBe("AggregateDecompositionError")
              expect(error.reason).toContain(lost("part", "pkey", PK))
              expect(yield* harness.commands(tableName)).toEqual([])
            }),
          ),
        ))
    })

    // An `update` judges what it writes as `create` does: one introducing a collision is refused
    // after its read, with nothing written.
    const updates: ReadonlyArray<{
      readonly from: string
      readonly change: (state: any) => any
      readonly message: string
      readonly member: string
    }> = [
      {
        from: "root declares the list sk attribute lsk, given mine, its list composite prio given none",
        change: (state) => ({ ...state, prio: "p1" }),
        message: listKey("lsk", "the attribute holding its list sort key"),
        member: "Root",
      },
      {
        from: "root declares pk (optional), given none",
        change: (state) => ({ ...state, pk: "mine" }),
        message: lost("Root", "pk", PK),
        member: "Root",
      },
      {
        from: "one edge value declares pk (optional), given none",
        change: (state) => ({ ...state, note: { ...state.note, pk: "mine" } }),
        message: lost("note", "pk", PK),
        member: "note",
      },
      {
        from: "one edge value declares its discriminator kind, given it",
        change: (state) => ({ ...state, note: { ...state.note, kind: "b" } }),
        message: overDiscriminator("note", 'holds "b" in', "kind"),
        member: "note",
      },
      {
        from: "sub-aggregate declares its discriminator side, given it",
        change: (state) => ({ ...state, part: { ...state.part, side: "y" } }),
        message: overDiscriminator("part", 'holds "y" in', "side"),
        member: "part",
      },
    ]
    for (const { from, change, message, member } of updates) {
      it(`${from}: an update introducing a collision is refused, nothing written`, () =>
        Effect.runPromise(
          harness.onTable((tableName) =>
            Effect.gen(function* () {
              const shape = shapes[from]!(Aggregate)
              const A = yield* bind(shape)
              yield* A.create(shape.input)
              const before = bySortKey(yield* harness.rows(tableName))
              yield* harness.commands(tableName)
              const exit = yield* Effect.exit(
                A.update({ id: "a" }, ({ state }: any) => change(state)),
              )
              const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as {
                _tag?: string
                member?: string
                reason?: string
              }
              expect(error._tag).toBe("AggregateDecompositionError")
              expect(error.member).toBe(member)
              expect(error.reason).toContain(message)
              expect(yield* harness.commands(tableName)).toEqual(["Query"])
              expect(bySortKey(yield* harness.rows(tableName))).toEqual(before)
            }),
          ),
        ))
    }

    for (const [label, shapeOf] of Object.entries(shapes)) {
      const then = published["1.40.0"][label]!
      const shape = shapeOf(Aggregate)
      if (shape.make !== undefined) {
        it(`${label}: 1.40.0 read back the library's value; Aggregate.make refuses it`, () => {
          expect(judged(then.create)).toEqual({ ok: shape.input })
          expect(judged(then.get)).toEqual(shape.read140)
          expect(judged(then.getAfterUpdate)).toEqual(shape.read140)
          expect(() => define(Aggregate, shape)).toThrow(shape.make)
          const pure = shapeOf(PureAggregate as unknown as Module)
          expect(() => define(PureAggregate as unknown as Module, pure)).toThrow(shape.make)
        })
        continue
      }
      if (shape.write !== undefined) {
        it(`${label}: 1.40.0 read back something else; the write is refused, nothing sent`, () =>
          Effect.runPromise(
            harness.onTable((tableName) =>
              Effect.gen(function* () {
                expect(judged(then.create)).toEqual({ ok: shape.input })
                expect(judged(then.get)).toEqual(shape.read140)
                // The pure make takes it: the value isn't known until a write.
                const pure = PureAggregate as unknown as Module
                expect(() => define(pure, shapeOf(pure))).not.toThrow()
                const A = yield* bind(shape)
                yield* harness.commands(tableName)
                const exit = yield* Effect.exit(A.create(shape.input))
                expect(Exit.isFailure(exit)).toBe(true)
                const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as {
                  _tag?: string
                  member?: string
                  reason?: string
                }
                expect(error._tag).toBe("AggregateDecompositionError")
                expect(error.member).toBe(shape.member)
                expect(error.reason).toContain(shape.write)
                expect(yield* harness.commands(tableName)).toEqual([])
                expect(yield* harness.rows(tableName)).toEqual([])
              }),
            ),
          ))
        continue
      }
      it(`${label}: stores and reads what 1.40.0 did`, () =>
        Effect.runPromise(
          harness.onTable((tableName) =>
            Effect.gen(function* () {
              const A = yield* bind(shape)
              const create = outcome(yield* Effect.exit(A.create(shape.input)))
              const rows = bySortKey(yield* harness.rows(tableName))
              const get = outcome(yield* Effect.exit(A.get({ id: "a" })))
              yield* harness.commands(tableName)
              const noop = outcome(
                yield* Effect.exit(A.update({ id: "a" }, ({ state }: any) => ({ ...state }))),
              )
              // A no-op update sends its read and nothing else.
              expect(yield* harness.commands(tableName)).toEqual(["Query"])
              const getAfterUpdate = outcome(yield* Effect.exit(A.get({ id: "a" })))
              expect(judged(create)).toEqual(judged(then.create))
              expect(rows).toEqual(bySortKey(then.rows))
              expect(judged(get)).toEqual(judged(then.get))
              expect(judged(noop)).toEqual(judged(then.noop))
              expect(judged(getAfterUpdate)).toEqual(judged(then.getAfterUpdate))
              expect(judged(get)).toEqual({ ok: shape.read ?? shape.input })
            }),
          ),
        ))
    }
  })
