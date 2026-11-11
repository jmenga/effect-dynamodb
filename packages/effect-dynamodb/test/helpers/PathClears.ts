/**
 * A clear below a field, refused only when the row couldn't be read afterwards. Published 1.39.0
 * refused none of these: it sent each, and some left a row it then couldn't read
 * (`fixtures/union-clears-1.39.0.json`, `fixtures/tuple-clears-1.39.0.json`, which also keep the
 * requests each step sent where a step has them). Every clear 1.39.0 completed with a row that
 * reads back does what it did, standalone, in a transaction and on a retained entity, and the
 * tuple clears and the clears marked `everyMode` on an entity with a unique constraint too. One
 * whose row couldn't be read is refused before anything is sent where the schema shows no stored
 * value survives it, and sent as 1.39.0 sent it where which value is stored decides (a tagged
 * union's member, how many positions a tuple holds), which only a read would say. A list position
 * is judged by the lists that may read what's left: their lengths, their elements against the
 * ones that moved, and a tag beside the list; a record by the signatures its key matches (#238).
 * A clear whose way to the path passes a node the guard doesn't model (`Schema.Unknown`, a tuple
 * with elements after its rest) is sent as 1.39.0 sent it, whatever the row reads. Run on a
 * recording table (`Kept139.test.ts`) and on DynamoDB Local (`connected.kept-1.39.0.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import {
  fixtureOf,
  type OpenTable,
  onTable,
  recordingRequests,
  runSteps,
  type Step,
} from "./Kept139.js"

const XY = Schema.Struct({ x: Schema.Number, y: Schema.String })
const T2 = Schema.Tuple([Schema.String, Schema.String])
const open = Schema.Record(
  Schema.TemplateLiteral(["open-", Schema.String]),
  Schema.Tuple([Schema.String, Schema.optional(Schema.String)]),
)
const fixed = Schema.Record(Schema.TemplateLiteral(["fixed-", Schema.String]), T2)

/** Each field by its label in a scenario's name. */
const fields: Record<string, Schema.Top> = {
  "Union([{ x, y }, { y }])": Schema.Union([XY, Schema.Struct({ y: Schema.String })]),
  'Union([{ kind: "a", x }, { kind: "b", y }])': Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), x: Schema.Number }),
    Schema.Struct({ kind: Schema.Literal("b"), y: Schema.String }),
  ]),
  "Union([{ x, y }, { x: string }])": Schema.Union([XY, Schema.Struct({ x: Schema.String })]),
  "NullOr({ x, y })": Schema.NullOr(XY),
  "{ x, y }": XY,
  "[string, string?]": Schema.Tuple([Schema.String, Schema.optional(Schema.String)]),
  "[string, string]": T2,
  "Union([[string, string], [string]])": Schema.Union([T2, Schema.Tuple([Schema.String])]),
  "Union([[string], []])": Schema.Union([Schema.Tuple([Schema.String]), Schema.Tuple([])]),
  "string[]": Schema.Array(Schema.String),
  "[string, number?]": Schema.Tuple([Schema.String, Schema.optional(Schema.Number)]),
  "Union([[string, string], [number, number]])": Schema.Union([
    T2,
    Schema.Tuple([Schema.Number, Schema.Number]),
  ]),
  'Union([{ kind: "a", p: [string, string] }, { kind: "b", p: [string] }])': Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), p: T2 }),
    Schema.Struct({ kind: Schema.Literal("b"), p: Schema.Tuple([Schema.String]) }),
  ]),
  'Union([{ kind: "a", p: [string, string] }, { kind: "b", p: [number, number] }])': Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), p: T2 }),
    Schema.Struct({ kind: Schema.Literal("b"), p: Schema.Tuple([Schema.Number, Schema.Number]) }),
  ]),
  "TupleWithRest([], [[string, string], string[]])": Schema.TupleWithRest(Schema.Tuple([]), [
    T2,
    Schema.Array(Schema.String),
  ]),
  "{ [open-*]: [string, string?], [fixed-*]: [string, string] }": Schema.StructWithRest(
    Schema.Struct({}),
    [open, fixed],
  ),
  "{ [fixed-*]: [string, string], [open-*]: [string, string?] }": Schema.StructWithRest(
    Schema.Struct({}),
    [fixed, open],
  ),
  "Union([[string, string], unknown])": Schema.Union([T2, Schema.Unknown]),
  "Union([[string, string], {}])": Schema.Union([T2, Schema.Struct({})]),
  "Union([[string, string, string], []])": Schema.Union([
    Schema.Tuple([Schema.String, Schema.String, Schema.String]),
    Schema.Tuple([]),
  ]),
  "Union([{ x, y }, unknown])": Schema.Union([XY, Schema.Unknown]),
  "Union([{ a: { x, y }, b }, { b }])": Schema.Union([
    Schema.Struct({ a: XY, b: Schema.String }),
    Schema.Struct({ b: Schema.String }),
  ]),
}

type Update = any
type Op = readonly [label: string, op: (update: Update) => Update]

const pathRemoveX: Op = ["pathRemove f.x", (u) => u.pathRemove(["f", "x"])]
const setUndefined: Op = ["set f undefined", (u) => u.set({ f: undefined })]
const removeF: Op = ["remove f", (u) => u.remove(["f"])]
const pathRemoveAt = (...path: ReadonlyArray<string | number>): Op => [
  `pathRemove f${path.map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`)).join("")}`,
  (u) => u.pathRemove(["f", ...path]),
]
const tagged = { kind: "a", p: ["first", "second"] }

interface Clear {
  readonly field: string
  readonly seed: unknown
  readonly op: Op
  /** Also run on a `versioned: { retain: true }` entity, and there in a transaction. */
  readonly retained?: true
  /** A union clear also run on a retained entity and on one with a unique constraint. */
  readonly everyMode?: true
  /** Refused here, where 1.39.0 sent it and left a row it couldn't read. */
  readonly refused?: true
  /** Sent as 1.39.0 sent it, leaving a row that can't be read, as on 1.39.0. */
  readonly unreadable?: true
}

const clears: Record<string, ReadonlyArray<Clear>> = {
  "union-clears": [
    // A member without `x` reads what's left, or holds the value and is left as it was.
    {
      field: "Union([{ x, y }, { y }])",
      seed: { x: 1, y: "kept" },
      op: pathRemoveX,
      retained: true,
    },
    {
      field: 'Union([{ kind: "a", x }, { kind: "b", y }])',
      seed: { kind: "b", y: "kept" },
      op: pathRemoveX,
      retained: true,
    },
    // The same removal, on a value of the member requiring it: only a read would tell.
    {
      field: 'Union([{ kind: "a", x }, { kind: "b", y }])',
      seed: { kind: "a", x: 1 },
      op: pathRemoveX,
      unreadable: true,
    },
    // No value survives these.
    {
      field: "Union([{ x, y }, { x: string }])",
      seed: { x: 1, y: "kept" },
      op: pathRemoveX,
      refused: true,
    },
    { field: "NullOr({ x, y })", seed: { x: 1, y: "kept" }, op: pathRemoveX, refused: true },
    { field: "{ x, y }", seed: { x: 1, y: "kept" }, op: pathRemoveX, refused: true },
    {
      field: "Union([{ x, y }, { y }])",
      seed: { x: 1, y: "kept" },
      op: setUndefined,
      refused: true,
    },
    { field: "Union([{ x, y }, { y }])", seed: { x: 1, y: "kept" }, op: removeF, refused: true },
    // `Schema.Unknown` reads what's left, and the guard doesn't model it: sent.
    {
      field: "Union([{ x, y }, unknown])",
      seed: { x: 1, y: "kept" },
      op: pathRemoveX,
      everyMode: true,
    },
    // The member without `a` doesn't read what's under it, so it reads what's left.
    {
      field: "Union([{ a: { x, y }, b }, { b }])",
      seed: { a: { x: 1, y: "kept" }, b: "kept" },
      op: pathRemoveAt("a", "x"),
      everyMode: true,
    },
  ],
  "tuple-clears": [
    // The list closes up, and what's left is a list the field reads.
    {
      field: "[string, string?]",
      seed: ["first", "second"],
      op: pathRemoveAt(0),
      retained: true,
    },
    { field: "[string, string?]", seed: ["first", "second"], op: pathRemoveAt(1) },
    {
      field: "Union([[string, string], [string]])",
      seed: ["first", "second"],
      op: pathRemoveAt(0),
    },
    {
      field: "Union([[string, string], [string]])",
      seed: ["first", "second"],
      op: pathRemoveAt(1),
    },
    { field: "Union([[string], []])", seed: ["first"], op: pathRemoveAt(0) },
    { field: "string[]", seed: ["first", "second"], op: pathRemoveAt(0) },
    // `Struct({})` reads any value but `null`, a list included.
    { field: "Union([[string, string], {}])", seed: ["first", "second"], op: pathRemoveAt(0) },
    // A list too short to hold the position: DynamoDB leaves it as it was.
    { field: "Union([[string, string, string], []])", seed: [], op: pathRemoveAt(2) },
    // A node the guard doesn't model on the way: sent, and what's left reads.
    {
      field: "TupleWithRest([], [[string, string], string[]])",
      seed: [["first", "second"]],
      op: pathRemoveAt(0, 0),
    },
    {
      field: "{ [fixed-*]: [string, string], [open-*]: [string, string?] }",
      seed: { "open-k": ["first", "second"] },
      op: pathRemoveAt("open-k", 0),
    },
    { field: "Union([[string, string], unknown])", seed: ["first", "second"], op: pathRemoveAt(0) },
    // The same removal, on a list holding only the required position: only a read would tell.
    { field: "[string, string?]", seed: ["first"], op: pathRemoveAt(0), unreadable: true },
    // What's left is a length the field accepts, but no list reads it (#238): the number moves
    // into the string's place, the key's signature reads only lists of two, and the tag rules out
    // the member reading a list of one.
    { field: "[string, number?]", seed: ["first", 1], op: pathRemoveAt(0), refused: true },
    {
      field: "{ [open-*]: [string, string?], [fixed-*]: [string, string] }",
      seed: { "fixed-k": ["first", "second"] },
      op: pathRemoveAt("fixed-k", 0),
      refused: true,
    },
    {
      field: 'Union([{ kind: "a", p: [string, string] }, { kind: "b", p: [string] }])',
      seed: tagged,
      op: pathRemoveAt("p", 0),
      refused: true,
    },
    // No value survives these: no list one shorter is a length the field accepts.
    { field: "[string, string]", seed: ["first", "second"], op: pathRemoveAt(0), refused: true },
    {
      field: "Union([[string, string], [number, number]])",
      seed: ["first", "second"],
      op: pathRemoveAt(0),
      refused: true,
    },
    {
      field: 'Union([{ kind: "a", p: [string, string] }, { kind: "b", p: [number, number] }])',
      seed: tagged,
      op: pathRemoveAt("p", 0),
      refused: true,
    },
    { field: "[string, string?]", seed: ["first", "second"], op: setUndefined, refused: true },
    { field: "[string, string?]", seed: ["first", "second"], op: removeF, refused: true },
  ],
}

interface Mode {
  readonly transaction?: true
  readonly retain?: true
  readonly unique?: true
}

const nameOf = (clear: Clear, { transaction, retain, unique }: Mode) =>
  `f: ${clear.field}, holding ${JSON.stringify(clear.seed)}: ${clear.op[0]}` +
  `${transaction ? ", in a transaction" : ""}${retain ? ", retained" : ""}` +
  `${unique ? ", with a unique constraint" : ""}`

/**
 * Standalone and in a transaction; the tuple clears and those marked `everyMode` also on a
 * retained entity and on a unique one.
 */
const modesOf = (name: keyof typeof clears, clear: Clear): ReadonlyArray<Mode> => {
  const every = name === "tuple-clears" || clear.everyMode === true
  return [
    {},
    { transaction: true },
    ...(every || clear.retained ? [{ retain: true } as const] : []),
    ...(every ? [{ unique: true } as const] : []),
    ...(clear.retained ? [{ transaction: true, retain: true } as const] : []),
  ]
}

/** The clears of `fixture`, each a test against a table `open` makes. */
export const pathClearSuite = (name: keyof typeof clears) => (open: OpenTable) => {
  const fixture =
    fixtureOf<Record<string, { readonly loads: boolean; readonly steps: ReadonlyArray<Step> }>>(
      name,
    )

  it("1.39.0 ran every clear here", () => {
    const names = clears[name]!.flatMap((clear) =>
      modesOf(name, clear).map((mode) => nameOf(clear, mode)),
    )
    expect(Object.keys(fixture.scenarios).sort()).toEqual(names.sort())
  })

  for (const clear of clears[name]!) {
    for (const mode of modesOf(name, clear)) {
      const scenario = nameOf(clear, mode)
      const expected = fixture.scenarios[scenario]!.steps
      // Where the fixture keeps each step's requests, they're compared too.
      const log: Array<unknown> = []
      const requests = expected[0]!.requests === undefined ? undefined : () => log.splice(0)
      it.effect(
        clear.refused
          ? `${scenario}: no value survives it, so it's refused and nothing is sent`
          : clear.unreadable
            ? `${scenario}: sent as ${fixture.generatedFrom} sent it, which only a read would judge`
            : `${scenario}: does what ${fixture.generatedFrom} did`,
        () =>
          Effect.gen(function* () {
            const Doc = Entity.make({
              model: Schema.Struct({
                id: Schema.String,
                ...(mode.unique ? { email: Schema.String } : {}),
                f: fields[clear.field]!,
              }),
              entityType: "Doc",
              primaryKey: {
                pk: { field: "pk", composite: ["id"] },
                sk: { field: "sk", composite: [] },
              },
              ...(mode.retain ? { versioned: { retain: true } } : {}),
              ...(mode.unique ? { unique: { email: ["email"] } } : {}),
            } as never) as any
            const MainTable = Table.make({
              schema: DynamoSchema.make({ name: "kept", version: 1 }),
              entities: { Doc },
            })
            const steps = yield* onTable(
              requests === undefined ? open : recordingRequests(open, log),
              fixture.clock,
              MainTable,
              { entities: { Doc } },
              (db, table) =>
                runSteps(
                  table,
                  [
                    [
                      "put",
                      () =>
                        db.entities.Doc.put({
                          id: "one",
                          ...(mode.unique ? { email: "one@example.com" } : {}),
                          f: clear.seed,
                        }).asEffect(),
                    ],
                    [
                      "clear",
                      () => {
                        const update = clear.op[1](db.entities.Doc.update({ id: "one" }))
                        return mode.transaction
                          ? Transaction.transactWrite([update])
                          : update.asEffect()
                      },
                    ],
                    ["get", () => db.entities.Doc.get({ id: "one" })],
                  ],
                  requests,
                ),
            )
            if (!clear.refused && !clear.unreadable) {
              expect(steps).toEqual(expected)
              return
            }
            // 1.39.0 sent it, and the row couldn't be read afterwards.
            expect(expected[2]!.outcome).toMatchObject({ fail: "ValidationError" })
            if (clear.unreadable) {
              // The same requests, row and reads. A standalone update's `ValidationError` says the
              // update was applied and the row no longer matches the model, where 1.39.0's
              // carried the read's failure.
              const tagOf = (step: Step): Step =>
                "fail" in step.outcome ? { ...step, outcome: { fail: step.outcome.fail } } : step
              expect(steps.map(tagOf)).toEqual(expected.map(tagOf))
              return
            }
            const [put, sent, read] = expected
            expect(steps[0]).toEqual(put)
            expect(steps[1]!.outcome).toMatchObject({ fail: "ValidationError" })
            expect(steps[1]!.rows).toEqual(put!.rows)
            if (requests !== undefined) {
              expect(sent!.requests).not.toEqual([])
              expect(steps[1]!.requests).toEqual([])
            }
            expect(steps[2]).toEqual({
              step: "get",
              outcome: put!.outcome,
              rows: put!.rows,
              ...(requests === undefined ? {} : { requests: read!.requests }),
            })
          }),
      )
    }
  }
}
