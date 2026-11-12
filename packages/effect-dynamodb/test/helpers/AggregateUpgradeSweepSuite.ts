/**
 * The upgrade sweep (#241): every shape of the aggregate fixtures, written by published 1.40.0,
 * continued by this release. On the rows 1.40.0's `create` wrote, this release reads the aggregate,
 * updates it with no change, updates it three times, updates it while its second transaction fails,
 * reads it, retries the failed update and updates it with no change again (`AggregateUpgradeSweep.ts`).
 * No step is refused, and each sends, stores and reads what 1.40.0 did
 * (`fixtures/aggregate-upgrade-sweep-1.40.0.json`). Each `update` returns what 1.40.0's returned,
 * with the one change the changeset names: a member value's copy of a context attribute is the
 * value its row now stores, the copy a `get` right after reads. Apart from that, the changes the
 * changeset names, per shape ({@link NAMED}).
 *
 * Run on a recording table (`AggregateUpgradeSweep.test.ts`) and against DynamoDB Local
 * (`connected.aggregate-upgrade-sweep.test.ts`).
 */

import { readFileSync } from "node:fs"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, DateTime, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"
import {
  CONTEXT,
  givenOverRow,
  inputOf,
  LIST_PK,
  LIST_SK,
  MIRRORED,
  type Outcome,
  PARTITION,
  plain,
  type Recorded,
  type Request,
  type Row,
  type Run,
  runSweep,
  SORT,
  type SweepIo,
  type SweepLib,
  shapeOf,
  stepsOf,
  sweepShapes,
  TYPE,
  withCopiesRead,
} from "./AggregateUpgradeSweep.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-upgrade-sweep-1.40.0.json", import.meta.url), "utf8"),
)

const lib: SweepLib = {
  Aggregate,
  DynamoClient,
  DynamoError,
  Table,
  DynamoSchema,
  DynamoModel,
  Schema,
  SchemaGetter,
  Effect,
  DateTime,
  Exit,
  Cause,
  Layer,
}

/** A timestamp the library stamps, as compared: its text differs on every run. */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const stamped = <A>(value: A): A =>
  value === undefined
    ? value
    : JSON.parse(
        JSON.stringify(value, (_key, v) =>
          typeof v === "string" && STAMP.test(v) ? "<stamp>" : v,
        ),
      )

const judged = (result: Outcome): Outcome =>
  result.failed === undefined
    ? { ok: result.ok }
    : {
        failed: result.failed,
        ...(result.operation !== undefined && { operation: result.operation }),
      }

/** `value` with each property `f` maps to something other than `undefined` replaced by that. */
const mapProps = (value: unknown, f: (key: string, value: unknown) => unknown): unknown => {
  if (Array.isArray(value)) return value.map((element) => mapProps(element, f))
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    const mapped = f(key, inner)
    out[key] = mapped === undefined ? mapProps(inner, f) : mapped
  }
  return out
}

/** Every item a request puts. */
const putsOf = (requests: ReadonlyArray<Request>): ReadonlyArray<Row> => {
  const items: Array<Row> = []
  const walk = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) for (const element of value) walk(element)
    else if (value !== null && typeof value === "object") {
      if (key === "Item") items.push(value as Row)
      else for (const [inner, v] of Object.entries(value)) walk(v, inner)
    }
  }
  for (const request of requests) walk(request.input)
  return items
}

/** The rows after each step, the rows the run started from first. */
const rowsAfter = (now: Run, start: ReadonlyArray<Row>) => [
  start,
  ...now.steps.map((step) => step.rows),
]

/** Every item the run put: its `create`'s, when it created the aggregate, and each step's. */
const putsIn = (now: Run): ReadonlyArray<Row> => [
  ...putsOf(now.requests ?? []),
  ...now.steps.flatMap((step) => putsOf(step.requests)),
]

const typeOf = (row: Row): string | undefined => (row.__edd_e__ as { S?: string } | undefined)?.S

/** A date stored as epoch milliseconds, as the ISO text 1.40.0 stored. */
const isoOfEpoch = (key: string, value: unknown): unknown => {
  const n = (value as { N?: string } | null)?.N
  return key === "since" && n !== undefined ? { S: new Date(Number(n)).toISOString() } : undefined
}

/** A change the changeset names, as the sweep compares it. */
type Named = {
  /** Why: the changeset's entry. */
  readonly why: string
  /** A row stored, or put by a request, as compared, on both sides. */
  readonly row?: (row: Row) => Row
  /** A value `get` or `update` returns, as compared, on both sides. */
  readonly value?: (value: unknown) => unknown
  /** What this release does: asserted on its run, from the rows it started from (`start`). */
  readonly head: (now: Run, start: ReadonlyArray<Row>) => void
}

/** The renaming union member's `text`, stored under `line`, by every write that writes its row. */
const RENAMED: Named = {
  why:
    "A many element whose schema shows no fields of its own is stored in its stored form: the " +
    "renaming member's `text` under `line`, by each write that writes its row. Read through the " +
    "member's transformation, an element so stored leaves out the sub-aggregate's discriminator " +
    "(`side`) 1.40.0 handed back inside it.",
  value: (value) =>
    mapProps(value, (key, inner) =>
      key === "lines" && Array.isArray(inner)
        ? inner.map((element) => {
            const { side: _, ...rest } = element as Record<string, unknown>
            return rest
          })
        : undefined,
    ),
  row: (row) => {
    if (typeOf(row) !== "Sheet" || !Object.hasOwn(row, "line")) return row
    const { line, ...rest } = row
    return { ...rest, text: line! }
  },
  head: (now, start) => {
    const puts = putsIn(now).filter((row) => typeOf(row) === "Sheet")
    // A run creating the aggregate writes the row; one on 1.40.0's rows, when its group changes.
    if (now.create !== undefined) expect(puts.length).toBeGreaterThan(0)
    for (const put of puts) {
      expect({ line: put.line, text: put.text }).toEqual({ line: { S: "KEEP" }, text: undefined })
    }
    // Each read hands the element back as given; under a sub-aggregate, with its discriminator
    // only while its row holds 1.40.0's form.
    const reads = [
      [now.get, now.rows ?? start] as const,
      ...now.steps.map((step) => [step.get, step.rows] as const),
    ]
    for (const [read, rows] of reads) {
      const sheet = rows.find((row) => typeOf(row) === "Sheet")!
      const value = read.ok as any
      const element = (value.part ?? value).lines[0]
      const { side, ...rest } = element
      expect(rest).toEqual({ kind: "own", qty: 3, text: "KEEP" })
      expect(side).toBe(value.part !== undefined && sheet.text !== undefined ? 1 : undefined)
    }
  },
}

/**
 * The changes the changeset names, by shape: where this release sends, stores or reads otherwise
 * than 1.40.0 did on the rows 1.40.0 wrote. Compared with the change taken out on both sides
 * (`row`, `value`); what this release does there is asserted on its own run (`head`).
 */
const NAMED: Readonly<Record<string, Named>> = {
  "strip: root declaring gsi2pk (optional), no list": {
    why:
      "A field a row's value declares now reads back even when its name begins like an index key: " +
      "1.40.0 took the root's gsi2pk off every read, so an update's state lacked it and the root " +
      "row lost it on the update's write.",
    row: (row) => {
      const { gsi2pk: _, ...rest } = row
      return rest
    },
    value: (value) => {
      if (value === null || typeof value !== "object") return value
      const { gsi2pk: _, ...rest } = value as Record<string, unknown>
      return rest
    },
    head: (now, start) => {
      const outcomes = [now.get, ...now.steps.flatMap((step) => [step.update, step.get])]
      for (const outcome of outcomes) {
        if (outcome.ok !== undefined) expect((outcome.ok as { gsi2pk?: unknown }).gsi2pk).toBe("x")
      }
      for (const rows of rowsAfter(now, start)) {
        const root = rows.find((row) => typeOf(row) === "Root")
        expect(root?.gsi2pk).toEqual({ S: "x" })
      }
    },
  },
  "disc: a union member renaming a field, given its domain value": RENAMED,
  "disc: sub-aggregate, a union member renaming a field, given its domain value": RENAMED,
  "repro: context over a Schema.optional date beside an Unknown value under a sub-aggregate": {
    why:
      "An aggregate stores a date declared Schema.optional in the encoding it declares " +
      "(DateEpochMs, a number), on its group's next changed write; a row not declaring it holds " +
      "the root's form, and an Unknown value's copy reads it back as that number.",
    row: (row) => mapProps(row, isoOfEpoch) as Row,
    value: (value) =>
      mapProps(value, (key, inner) =>
        key === "since" && typeof inner === "number" ? new Date(inner).toISOString() : undefined,
      ),
    head: (now) => {
      const puts = putsIn(now)
      expect(puts.filter((row) => row.since !== undefined).length).toBeGreaterThan(0)
      for (const put of puts) {
        if (put.since !== undefined) expect(Object.keys(put.since)).toEqual(["N"])
      }
      // The copy on the Unknown note reads back as its row holds it: on a row 1.40.0 wrote, ISO
      // text until the row's group is next changed, then the number. An update returns the same
      // as the get after it.
      for (const step of now.steps) {
        const note = step.rows.find((row) => typeOf(row) === "Note")!.since as {
          S?: string
          N?: string
        }
        const read = note.N !== undefined ? Number(note.N) : note.S
        expect({ step: step.step, get: (step.get.ok as any).part.note.since }).toEqual({
          step: step.step,
          get: read,
        })
        if (step.update.ok !== undefined) {
          expect({ step: step.step, update: (step.update.ok as any).part.note.since }).toEqual({
            step: step.step,
            update: read,
          })
        }
      }
    },
  },
}

/**
 * The shapes whose `create` gives, at the top of a row's value, a name the library writes on that
 * row a value other than the library's (#241, `EDD-9159`): 1.40.0 wrote it and every read handed back
 * the library's, never what was given. This release refuses the `create`, nothing sent: the
 * member, the name, the value given, what the attribute is, and the library's value.
 */
const REFUSED_AT_CREATE: Readonly<
  Record<
    string,
    readonly [member: string, name: string, given: string, what: string, library: string]
  >
> = {
  "held: an Unknown one edge holding pk": ["note", "pk", "mine", PARTITION, "$sweep#v1#sweep#a"],
  "held: an Unknown one edge holding sk": ["note", "sk", "mine", SORT, "$sweep#v1#note"],
  "held: an Unknown one edge holding __edd_e__": ["note", "__edd_e__", "mine", TYPE, "Note"],
  "held: a one edge declaring csk (required)": ["note", "csk", "mine", MIRRORED, "$sweep#v1#note"],
  "context: an Unknown one edge holding another tenantId": [
    "note",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ],
  "context: an Unknown element holding another tenantId": [
    "lines",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ],
  "context: a struct one edge declaring tenantId, given another": [
    "note",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ],
  "context: a sub-aggregate declaring tenantId, given another": [
    "part",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ],
  "context: an Unknown one edge holding csk, the collection sort key's copy": [
    "note",
    "csk",
    "mine",
    MIRRORED,
    "$sweep#v1#note",
  ],
  "keys: root declares pk (optional), given mine": [
    "Root",
    "pk",
    "mine",
    PARTITION,
    "$sweep#v1#sweep#a",
  ],
  "keys: root's composite id is the pk attribute": [
    "Root",
    "id",
    "a",
    PARTITION,
    "$sweep#v1#sweep#a",
  ],
  "keys: root declares sk (optional), given mine": ["Root", "sk", "mine", SORT, "$sweep#v1#root"],
  "keys: root declares __edd_e__ (optional), given mine": [
    "Root",
    "__edd_e__",
    "mine",
    TYPE,
    "Root",
  ],
  "keys: root declares the list pk attribute status": [
    "Root",
    "status",
    "open",
    LIST_PK,
    "$sweep#v1#bystatus#open",
  ],
  "keys: root declares the list sk attribute rank": [
    "Root",
    "rank",
    "r1",
    LIST_SK,
    "$sweep#v1#byrank#r1",
  ],
  "keys: root declares the list sk attribute lsk, given mine, its list composite prio given": [
    "Root",
    "lsk",
    "mine",
    LIST_SK,
    "$sweep#v1#byprio#p1",
  ],
  "keys: one edge value declares sk (optional), given mine": [
    "note",
    "sk",
    "mine",
    SORT,
    "$sweep#v1#note",
  ],
  "keys: many element declares __edd_e__ (optional), given mine": [
    "lines",
    "__edd_e__",
    "mine",
    TYPE,
    "Line",
  ],
  "keys: sub-aggregate declares pk (optional), given mine": [
    "part",
    "pk",
    "mine",
    PARTITION,
    "$sweep#v1#sweep#a",
  ],
  "keys: one edge value declares csk, the collection sk mirror, given mine": [
    "note",
    "csk",
    "mine",
    MIRRORED,
    "$sweep#v1#note",
  ],
  "strip: sub-aggregate with an edge declaring pkey (optional), keyed under pkey, given mine": [
    "part",
    "pkey",
    "mine",
    PARTITION,
    "$sweep#v1#sweep#a",
  ],
  "strip: childless sub-aggregate declaring pkey (optional), keyed under pkey, given mine": [
    "part",
    "pkey",
    "mine",
    PARTITION,
    "$sweep#v1#sweep#a",
  ],
}

/** `requests` with each item put held as `row` makes it. */
const requestsAs = (requests: ReadonlyArray<Request>, row: (row: Row) => Row): unknown => {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== "object") return value
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        key === "Item" && inner !== null && typeof inner === "object"
          ? row(inner as Row)
          : walk(inner)
    }
    return out
  }
  return walk(requests)
}

export interface SweepHarness {
  /**
   * Run `body` on a fresh table keyed by `pk` and `sk`, with the local index `lsi1` on `csk`: its
   * recording client (`io`) and a way to put rows on it unrecorded (`seed`).
   */
  readonly onTable: <A>(
    pk: string,
    body: (
      io: SweepIo,
      seed: (rows: ReadonlyArray<Row>) => Effect.Effect<void, unknown>,
    ) => Effect.Effect<A, unknown>,
  ) => Effect.Effect<A, unknown>
}

export const sweepSuite = (
  harness: SweepHarness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("aggregates 1.40.0 wrote, continued by this release (the upgrade sweep)", () => {
    it("the fixture is published 1.40.0's, for every shape and step", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
      expect(Object.keys(published["1.40.0"]).sort()).toEqual(Object.keys(sweepShapes).sort())
      for (const [label, then] of Object.entries(published["1.40.0"])) {
        expect({ label, create: judged(then.create).failed }).toEqual({ label, create: undefined })
        expect(then.steps.map(({ step }) => step)).toEqual(
          stepsOf(shapeOf(lib, label)).map(({ label: step }) => step),
        )
      }
    })

    for (const label of Object.keys(sweepShapes)) {
      const then = published["1.40.0"][label]!
      const compare = (from: "seeded" | "created") =>
        Effect.gen(function* () {
          const shape = shapeOf(lib, label)
          const named = NAMED[label]
          const asRow = named?.row ?? ((row: Row) => row)
          const asValue = named?.value ?? ((value: unknown) => value)
          const rows = (all: ReadonlyArray<Row>) => stamped(all.map(asRow))
          const requests = (sent: ReadonlyArray<Request>) => stamped(requestsAs(sent, asRow))
          const outcome = (result: Outcome) => {
            const judgedAs = judged(result)
            return stamped("ok" in judgedAs ? { ok: asValue(judgedAs.ok) } : judgedAs)
          }
          const now = yield* harness.onTable(shape.pk ?? "pk", (io, seed) =>
            Effect.gen(function* () {
              if (from === "seeded") yield* seed(then.rows)
              return yield* runSweep(lib, shape, io, from === "seeded")
            }),
          )
          const refused = REFUSED_AT_CREATE[label]
          if (from === "created" && refused !== undefined) {
            // 1.40.0 created it, and its read handed back the library's value, not the one given.
            expect(judged(then.create)).toEqual({ ok: plain(inputOf(shape)) })
            expect(judged(then.get)).not.toEqual({ ok: plain(inputOf(shape)) })
            const [member] = refused
            expect(now.create).toEqual({
              failed: "AggregateDecompositionError",
              member,
              reason: givenOverRow(...refused),
            })
            expect(now.requests).toEqual([])
            expect(now.rows).toEqual([])
            return
          }
          if (from === "created") {
            expect(outcome(now.create!)).toEqual(outcome(then.create))
            expect(requests(now.requests!)).toEqual(requests(then.requests))
            expect(rows(now.rows!)).toEqual(rows(then.rows))
          }
          named?.head(now, from === "seeded" ? then.rows : now.rows!)
          expect(outcome(now.get)).toEqual(outcome(then.get))
          const context = shape.context ?? []
          const edges = {
            ...shape.edges,
            aside: { _tag: "BoundSubAggregate", aggregate: { edges: {} } },
          }
          for (const [i, step] of now.steps.entries()) {
            const was = then.steps[i]!
            expect(step.step).toBe(was.step)
            const id = { step: step.step }
            expect({ ...id, get: outcome(step.get) }).toEqual({ ...id, get: outcome(was.get) })
            expect({ ...id, update: outcome(step.update) }).toEqual({
              ...id,
              update: outcome(
                was.update.failed !== undefined
                  ? was.update
                  : { ok: withCopiesRead(was.update.ok, was.get.ok, edges, context) },
              ),
            })
            expect({ ...id, requests: requests(step.requests) }).toEqual({
              ...id,
              requests: requests(was.requests),
            })
            expect({ ...id, refused: requests(step.refused) }).toEqual({
              ...id,
              refused: requests(was.refused),
            })
            expect({ ...id, rows: rows(step.rows) }).toEqual({ ...id, rows: rows(was.rows) })
          }
        })
      it(`${label}: on 1.40.0's rows, never refused; sends, stores, reads and returns what 1.40.0 did`, () =>
        Effect.runPromise(compare("seeded")))
      it(
        REFUSED_AT_CREATE[label] !== undefined
          ? `${label}: created by this release, refused, nothing sent: 1.40.0 read back the library's value`
          : `${label}: created by this release, never refused; sends, stores, reads and returns what 1.40.0 did`,
        () => Effect.runPromise(compare("created")),
      )
    }
  })
