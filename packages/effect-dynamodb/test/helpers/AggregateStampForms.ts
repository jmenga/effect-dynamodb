/**
 * The form an aggregate stores its stamps in. A stamp in a field a row declares is stored in the form
 * the row stores any value of that field in, on `create` and `update`, on the root and on edges; a
 * row that doesn't declare it holds the stamp in the root's form. That form is the field's own date
 * encoding, under `Schema.optional` too since #241, as an entity's write stores it. Published 1.39.0
 * and 1.40.0 stored a value under `Schema.optional` as ISO text whatever the encoding, and their stamps
 * followed it (`formOf139`); the cells #241 changes are exactly the `Schema.optional` ones around an
 * encoding that isn't ISO text, and the fixture's rows stay as captured.
 * The fixture (`fixtures/aggregate-stamp-forms-1.39.0.json`) holds what 1.39.0 did for each date
 * schema, required, `Schema.optional` or `Schema.optionalKey`, declared by the root (beside an
 * undeclared `one` edge), a `one` edge, a `many` element or a sub-aggregate. Run on a recording
 * table (`Kept139.test.ts`) and on DynamoDB Local (`connected.kept-1.39.0.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Duration, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import {
  fixtureOf,
  type OpenTable,
  onTable,
  type Row,
  runSteps,
  type ScenarioTable,
  type Step,
} from "./Kept139.js"

type Scenario = ReadonlyArray<Step> | { readonly make: { readonly throws: string } }

const fixture = fixtureOf<Record<string, Scenario>>("aggregate-stamp-forms")

/** A stored instant's form: ISO text, epoch milliseconds or epoch seconds. */
type Form = "iso" | "ms" | "s"

/** Each date schema the fixture was captured for, in its order, and the form it stores a value in. */
const encodings: ReadonlyArray<readonly [string, Schema.Top, Form]> = [
  ["DateString", DynamoModel.DateString, "iso"],
  ["DateEpochMs", DynamoModel.DateEpochMs, "ms"],
  ["DateEpochSeconds", DynamoModel.DateEpochSeconds, "s"],
  [
    "DateString storedAs DateEpochSeconds",
    DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    "s",
  ],
  [
    "DateTimeUtc storedAs DateEpochSeconds",
    Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    "s",
  ],
  [
    "DateTimeUtc storedAs DateEpochMs",
    Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
    "ms",
  ],
  [
    "DateEpochMs storedAs DateString",
    DynamoModel.DateEpochMs.pipe(DynamoModel.storedAs(DynamoModel.DateString)),
    "iso",
  ],
  ["Schema.Date", Schema.Date, "iso"],
]

const wraps = {
  required: (schema: Schema.Top): Schema.Top => schema,
  optional: (schema: Schema.Top): Schema.Top => Schema.optional(schema as never),
  optionalKey: (schema: Schema.Top): Schema.Top => Schema.optionalKey(schema as never),
} as const

type Wrap = keyof typeof wraps

/** Where the dates are declared, and the entity type of the row that declares them. */
const positions = { root: "Match", one: "Venue", many: "Line", sub: "Sub" } as const

type Position = keyof typeof positions

type Supplied = "a value supplied" | "no value supplied"

const epoch = new Date(0)

/** The form 1.39.0 and 1.40.0 stored a value of a date declared `wrap` around this schema in. */
const formOf139 = (form: Form, wrap: Wrap): Form => (wrap === "optional" ? "iso" : form)

/**
 * The form a value of a date declared `wrap` around this schema is stored in since #241: the
 * schema's own, whatever the wrap.
 */
const formOf = (form: Form, _wrap: Wrap): Form => form

/** A row 1.39.0 stored, with each stamp `fields` holds in `form`: the same instant. */
const inForm = (row: Row, form: Form): Row => ({
  ...row,
  ...Object.fromEntries(
    ["created", "updated"]
      .filter((field) => row[field] !== undefined)
      .map((field) => [field, storedAt(instantOf(row[field]!, "iso"), form)]),
  ),
})

/** The instant `at` (epoch ms) as `form` stores it. */
const storedAt = (at: number, form: Form): Row[string] =>
  form === "iso"
    ? { S: new Date(at).toISOString() }
    : { N: String(form === "ms" ? at : Math.floor(at / 1000)) }

/** What a stamp `form` stores can hold: the stamp at `create` or 5 s later, or the epoch passed. */
const allowedIn = (form: Form): ReadonlyArray<Row[string]> =>
  [fixture.clock, fixture.clock + 5_000, 0].map((at) => storedAt(at, form))

/** The instant a value `form` stores holds, in epoch ms. */
const instantOf = (held: Row[string], form: Form): number =>
  "S" in held ? Date.parse(held.S!) : Number(held.N) * (form === "s" ? 1000 : 1)

const build = (position: Position, date: Schema.Top, supplied: Supplied) => {
  const dates = { created: date, updated: date }
  const values = supplied === "a value supplied" ? { created: epoch, updated: epoch } : {}
  const subModel = Schema.Struct({ subName: Schema.String, ...dates })
  const model =
    position === "root"
      ? Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          ...dates,
          venue: Schema.Struct({ venueId: Schema.String }),
        })
      : position === "one"
        ? Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            venue: Schema.Struct({ venueId: Schema.String, ...dates }),
          })
        : position === "many"
          ? Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              lines: Schema.Array(Schema.Struct({ sku: Schema.String, ...dates })),
            })
          : Schema.Struct({ id: Schema.String, name: Schema.String, sub: subModel })
  const edges =
    position === "root" || position === "one"
      ? { venue: Aggregate.one({ entityType: "Venue" }) }
      : position === "many"
        ? { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } }) }
        : {
            sub: (
              Aggregate.make(
                subModel as never,
                {
                  root: { entityType: "Sub" },
                  edges: {},
                } as never,
              ) as any
            ).with({ discriminator: { slot: "a" } }),
          }
  const input =
    position === "root"
      ? { id: "m", name: "n", ...values, venue: { venueId: "v" } }
      : position === "one"
        ? { id: "m", name: "n", venue: { venueId: "v", ...values } }
        : position === "many"
          ? { id: "m", name: "n", lines: [{ sku: "s", ...values }] }
          : { id: "m", name: "n", sub: { subName: "u", ...values } }
  // The table's key definition comes from an entity.
  const Other = Entity.make({
    model: Schema.Struct({ id: Schema.String }),
    entityType: "Other",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const Base = Table.make({
    schema: DynamoSchema.make({ name: "kept", version: 1, escapeKeys: false }),
    entities: { Other },
  })
  const Agg = Aggregate.make(
    model as never,
    {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "match" },
      root: { entityType: "Match" },
      edges,
      timestamps: { created: { field: "created" }, updated: { field: "updated" } },
    } as never,
  ) as any
  return { MainTable: { ...Base, aggregates: { Agg } } as any, Agg, input }
}

const replay = (open: OpenTable, built: ReturnType<typeof build>) =>
  onTable(
    open,
    fixture.clock,
    built.MainTable,
    { entities: {}, aggregates: { Agg: built.Agg } },
    (db, table: ScenarioTable) =>
      runSteps(table, [
        ["create", () => db.aggregates.Agg.create(built.input)],
        [
          "update, 5 s later",
          () =>
            Effect.andThen(
              TestClock.adjust(Duration.seconds(5)),
              db.aggregates.Agg.update({ id: "m" }, ({ state }: any) => ({ ...state, name: "o" })),
            ),
        ],
        ["get", () => db.aggregates.Agg.get({ id: "m" })],
      ]),
  )

/** The value `get` returned for the dates `position` declares. */
const declaredIn = (position: Position, value: any): Record<string, unknown> =>
  position === "root"
    ? value
    : position === "one"
      ? value.venue
      : position === "many"
        ? value.lines[0]
        : value.sub

const scenarios = encodings.flatMap(([encoding, date, form]) =>
  (Object.keys(positions) as ReadonlyArray<Position>).flatMap((position) =>
    (Object.keys(wraps) as ReadonlyArray<Wrap>).flatMap((wrap) =>
      (["a value supplied", "no value supplied"] as const).map((supplied) => ({
        name: `${position} | ${encoding} | ${wrap} | ${supplied}`,
        position,
        date: wraps[wrap](date),
        form,
        wrap,
        supplied,
      })),
    ),
  ),
)

/** The scenarios, each a test against a table `open` makes. */
export const aggregateStampFormsSuite = (open: OpenTable) => {
  it("1.39.0 stored a root's stamps in the form the root stores the field's values in", () => {
    expect(new Set(Object.keys(fixture.scenarios))).toEqual(new Set(scenarios.map((s) => s.name)))
    for (const { name, position, form, wrap } of scenarios) {
      const scenario = fixture.scenarios[name]!
      if (position !== "root" || "make" in scenario) continue
      // A value passed for a date the root declares `Schema.optional` is stored as ISO text, and
      // a row that doesn't declare the dates holds the root's form.
      const allowed = allowedIn(formOf139(form, wrap))
      for (const { step, rows } of scenario) {
        for (const row of rows) {
          for (const field of ["created", "updated"]) {
            const held = row[field]
            if (held === undefined) continue
            expect(allowed, `${name}, ${step}: ${row.__edd_e__?.S}.${field}`).toContainEqual(held)
          }
        }
      }
    }
  })

  it("#241 stores a stamp in another form than 1.39.0 exactly under `Schema.optional` around an encoding that isn't ISO text", () => {
    const changed = scenarios.filter(
      ({ form, wrap }) => formOf(form, wrap) !== formOf139(form, wrap),
    )
    expect(new Set(changed.map(({ name }) => name.split(" | ").slice(1, 3).join(" | ")))).toEqual(
      new Set([
        "DateEpochMs | optional",
        "DateEpochSeconds | optional",
        "DateString storedAs DateEpochSeconds | optional",
        "DateTimeUtc storedAs DateEpochSeconds | optional",
        "DateTimeUtc storedAs DateEpochMs | optional",
      ]),
    )
  })

  for (const { name, position, date, form, wrap, supplied } of scenarios) {
    const captured = fixture.scenarios[name]!
    if ("make" in captured) {
      it(`${name}: Aggregate.make refuses it, as ${fixture.generatedFrom} did`, () => {
        expect(() => build(position, date, supplied)).toThrow(captured.make.throws)
      })
      continue
    }
    it.effect(
      `${name}: each stamp is stored in the form the row stores the field's values in`,
      () =>
        Effect.gen(function* () {
          const steps: ReadonlyArray<Step> = yield* replay(open, build(position, date, supplied))
          for (const step of steps) expect("ok" in step.outcome, step.step).toBe(true)
          const declaring = positions[position]
          // A row declaring the dates stores them as it stores any value of them; one that doesn't
          // holds the root's form: the root's declaration's, else the stamp's own, ISO text.
          const declared = formOf(form, wrap)
          const undeclared = position === "root" ? declared : "iso"
          for (const step of steps) {
            for (const row of step.rows) {
              const expected = row.__edd_e__?.S === declaring ? declared : undeclared
              for (const field of ["created", "updated"]) {
                const held = row[field]
                if (held === undefined) continue
                expect(
                  allowedIn(expected),
                  `${step.step}: ${row.__edd_e__?.S}.${field}`,
                ).toContainEqual(held)
              }
            }
          }
          // What `create` and `get` return is the instant stored.
          for (const step of [steps[0]!, steps[2]!]) {
            const row = step.rows.find((r) => r.__edd_e__?.S === declaring)!
            const value = declaredIn(position, (step.outcome as { readonly ok: unknown }).ok)
            for (const field of ["created", "updated"]) {
              if (row[field] === undefined) continue
              expect(value[field], `${step.step}: ${field}`).toEqual({
                date: instantOf(row[field]!, declared),
              })
            }
          }
        }),
    )
    if (position !== "root") continue
    const [create, update] = captured as readonly [Step, Step, Step]
    // A date the root declares, required or `Schema.optionalKey`, is the library's: 1.39.0 stamped it
    // over a value passed, in its own encoding, on every row, and `update` re-stamped `updated`. One
    // it declares `Schema.optional` was the caller's: 1.39.0 stored a value passed for it, and stamped
    // no row (`AggregateCreateStamps.ts` has what changed there).
    if (wrap !== "optional" && "ok" in create.outcome) {
      it.effect(`${name}: create and update store what ${fixture.generatedFrom} stored`, () =>
        Effect.gen(function* () {
          const steps: ReadonlyArray<Step> = yield* replay(open, build(position, date, supplied))
          expect(steps[0]!.rows).toEqual(create.rows)
          expect(steps[1]!.rows).toEqual(update.rows)
        }),
      )
    } else if (wrap === "optional" && supplied === "a value supplied") {
      // The value passed, stored as 1.39.0 stored it, in the form the field's encoding declares
      // since #241 (1.39.0 stored it as ISO text whatever the encoding).
      it.effect(`${name}: create stores the value passed, as ${fixture.generatedFrom} did`, () =>
        Effect.gen(function* () {
          const steps: ReadonlyArray<Step> = yield* replay(open, build(position, date, supplied))
          const root = (rows: ReadonlyArray<Row>) => rows.find((r) => r.__edd_e__?.S === "Match")!
          const captured139 = root(create.rows)
          expect(root(steps[0]!.rows)).toEqual(
            formOf(form, wrap) === formOf139(form, wrap)
              ? captured139
              : inForm(captured139, formOf(form, wrap)),
          )
        }),
      )
    }
  }
}
