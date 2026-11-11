/**
 * A clear below a field, refused only when the row couldn't be read afterwards. Published 1.39.0
 * refused none of these: it sent each, and some left a row it then couldn't read
 * (`fixtures/union-clears-1.39.0.json`). Every clear 1.39.0 completed with a row that reads back does
 * what it did, standalone, in a transaction and on a retained entity. One whose row couldn't be
 * read is refused before anything is sent where the schema shows no stored value survives it, and
 * sent as 1.39.0 sent it where which value is stored decides (a tagged union's member), which only a
 * read would say. Run on a recording table (`Kept139.test.ts`) and on DynamoDB Local
 * (`connected.kept-1.39.0.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { fixtureOf, type OpenTable, onTable, runSteps, type Step } from "./Kept139.js"

const XY = Schema.Struct({ x: Schema.Number, y: Schema.String })

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
}

type Update = any
type Op = readonly [label: string, op: (update: Update) => Update]

const pathRemoveX: Op = ["pathRemove f.x", (u) => u.pathRemove(["f", "x"])]
const setUndefined: Op = ["set f undefined", (u) => u.set({ f: undefined })]
const removeF: Op = ["remove f", (u) => u.remove(["f"])]

interface Clear {
  readonly field: string
  readonly seed: unknown
  readonly op: Op
  /** Also run on a `versioned: { retain: true }` entity. */
  readonly retained?: true
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
  ],
}

const nameOf = (clear: Clear, transaction: boolean, retain: boolean) =>
  `f: ${clear.field}, holding ${JSON.stringify(clear.seed)}: ${clear.op[0]}` +
  `${transaction ? ", in a transaction" : ""}${retain ? ", retained" : ""}`

const variantsOf = (clear: Clear) =>
  [false, true].flatMap((transaction) =>
    (clear.retained ? [false, true] : [false]).map((retain) => ({ transaction, retain })),
  )

/** The clears of `fixture`, each a test against a table `open` makes. */
export const pathClearSuite = (name: keyof typeof clears) => (open: OpenTable) => {
  const fixture =
    fixtureOf<Record<string, { readonly loads: boolean; readonly steps: ReadonlyArray<Step> }>>(
      name,
    )

  it("1.39.0 ran every clear here", () => {
    expect(Object.keys(fixture.scenarios)).toEqual(
      clears[name]!.flatMap((clear) =>
        variantsOf(clear).map(({ transaction, retain }) => nameOf(clear, transaction, retain)),
      ),
    )
  })

  for (const clear of clears[name]!) {
    for (const { transaction, retain } of variantsOf(clear)) {
      const scenario = nameOf(clear, transaction, retain)
      const expected = fixture.scenarios[scenario]!.steps
      it.effect(
        clear.refused
          ? `${scenario}: no value survives it, so it's refused and nothing is sent`
          : clear.unreadable
            ? `${scenario}: only a read would tell, so it's sent as ${fixture.generatedFrom} sent it`
            : `${scenario}: does what ${fixture.generatedFrom} did`,
        () =>
          Effect.gen(function* () {
            const Doc = Entity.make({
              model: Schema.Struct({ id: Schema.String, f: fields[clear.field]! }),
              entityType: "Doc",
              primaryKey: {
                pk: { field: "pk", composite: ["id"] },
                sk: { field: "sk", composite: [] },
              },
              ...(retain ? { versioned: { retain: true } } : {}),
            } as never) as any
            const MainTable = Table.make({
              schema: DynamoSchema.make({ name: "kept", version: 1 }),
              entities: { Doc },
            })
            const steps = yield* onTable(
              open,
              fixture.clock,
              MainTable,
              { entities: { Doc } },
              (db, table) =>
                runSteps(table, [
                  ["put", () => db.entities.Doc.put({ id: "one", f: clear.seed }).asEffect()],
                  [
                    "clear",
                    () => {
                      const update = clear.op[1](db.entities.Doc.update({ id: "one" }))
                      return transaction ? Transaction.transactWrite([update]) : update.asEffect()
                    },
                  ],
                  ["get", () => db.entities.Doc.get({ id: "one" })],
                ]),
            )
            if (!clear.refused && !clear.unreadable) {
              expect(steps).toEqual(expected)
              return
            }
            // 1.39.0 sent it, and the row couldn't be read afterwards.
            expect(expected[2]!.outcome).toEqual({
              fail: "ValidationError",
              message: "Missing key",
            })
            if (clear.unreadable) {
              // The same request, row and reads. A standalone update's `ValidationError` says the
              // update was applied and the row no longer matches the model, where 1.39.0's
              // carried the read's "Missing key".
              const tagOf = (step: Step): Step =>
                "fail" in step.outcome ? { ...step, outcome: { fail: step.outcome.fail } } : step
              expect(steps.map(tagOf)).toEqual(expected.map(tagOf))
              return
            }
            const [put] = expected
            expect(steps[0]).toEqual(put)
            expect(steps[1]!.outcome).toMatchObject({ fail: "ValidationError" })
            expect(steps[1]!.rows).toEqual(put!.rows)
            expect(steps[2]).toEqual({ step: "get", outcome: put!.outcome, rows: put!.rows })
          }),
      )
    }
  }
}
