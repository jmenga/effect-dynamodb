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
 * Since #168 (`docs/designs/aggregate-concurrency.md`): requests are compared as #168 changed them
 * (`Before168.ts`); a row an update leaves as it is isn't sent, and keeps what it held; the failing
 * update is one transaction, refused whole, so nothing of it is written; and from there on this
 * release is compared with itself running the same steps with nothing refused (the change applied
 * once), since 1.40.0's rows from there on hold what its partial write left.
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
  customOverRow,
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
  valueCopiesAsRoot,
} from "./AggregateUpgradeSweep.js"
import { asBefore168 } from "./Before168.js"

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
  // Since #168 the failing update's groups are one transaction: refusing it refuses the write.
  failingTransaction: 1,
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
 * The shapes whose edge has a custom `decompose` and `assemble` (#241): an `update` can't tell
 * which of its rows an element's copy of a context attribute came from, so it hands the copy back
 * as 1.40.0 did, the value before the write.
 */
const CUSTOM_EDGE: Readonly<Record<string, string>> = {
  "held: context: a custom decompose and assemble": "lines",
  "context: an Unknown element with a custom assemble holding another tenantId": "lines",
}

/** A `create` refused by `EDD-9159`: `givenOverRow`'s arguments, the member first. */
const over = (...args: Parameters<typeof givenOverRow>) => [args[0], givenOverRow(...args)] as const

/**
 * The shapes whose `create` gives, at the top of a row's value, a name the library writes on that
 * row a value a read of the member doesn't return (#241, `EDD-9159`): 1.40.0 wrote it and every
 * read handed back something else (the library's value, or nothing where a read takes the name
 * off). This release refuses the `create`, nothing sent: the member, the name, the value given,
 * what the attribute is, and what the read returns there.
 */
const REFUSED_AT_CREATE: Readonly<Record<string, readonly [member: string, reason: string]>> = {
  "held: an Unknown one edge holding pk": over("note", "pk", "mine", PARTITION, undefined),
  "held: an Unknown one edge holding sk": over("note", "sk", "mine", SORT, undefined),
  "held: an Unknown one edge holding __edd_e__": over("note", "__edd_e__", "mine", TYPE, undefined),
  "held: a one edge declaring csk (required)": over(
    "note",
    "csk",
    "mine",
    MIRRORED,
    "$sweep#v1#note",
  ),
  "held: a one edge union, a member declaring csk, given that member": over(
    "note",
    "csk",
    "mine",
    MIRRORED,
    "$sweep#v1#note",
  ),
  "context: an Unknown one edge holding another tenantId": over(
    "note",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ),
  "context: an Unknown element holding another tenantId": over(
    "lines",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ),
  "context: an Unknown element with a custom assemble holding another tenantId": [
    "lines",
    customOverRow(
      "lines",
      "tenantId",
      "other",
      CONTEXT,
      { shown: '[{ "qty": 1, "text": "n", "tenantId": "other" }]' },
      { shown: '[{ "qty": 1, "text": "n", "tenantId": "t1" }]' },
    ),
  ],
  "context: a struct one edge declaring tenantId, given another": over(
    "note",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ),
  "context: a sub-aggregate declaring tenantId, given another": over(
    "part",
    "tenantId",
    "other",
    CONTEXT,
    "t1",
  ),
  "context: an Unknown one edge holding csk, the collection sort key's copy": over(
    "note",
    "csk",
    "mine",
    MIRRORED,
    "$sweep#v1#note",
  ),
  "keys: root declares pk (optional), given mine": over("Root", "pk", "mine", PARTITION, undefined),
  "keys: root's composite id is the pk attribute": over(
    "Root",
    "id",
    "a",
    PARTITION,
    "$sweep#v1#sweep#a",
  ),
  "keys: root declares sk (optional), given mine": over("Root", "sk", "mine", SORT, undefined),
  "keys: root declares __edd_e__ (optional), given mine": over(
    "Root",
    "__edd_e__",
    "mine",
    TYPE,
    undefined,
  ),
  "keys: root declares the list pk attribute status": over(
    "Root",
    "status",
    "open",
    LIST_PK,
    "$sweep#v1#bystatus#open",
  ),
  "keys: root declares the list sk attribute rank": over(
    "Root",
    "rank",
    "r1",
    LIST_SK,
    "$sweep#v1#byrank#r1",
  ),
  "keys: root declares the list sk attribute lsk, given mine, its list composite prio given": over(
    "Root",
    "lsk",
    "mine",
    LIST_SK,
    "$sweep#v1#byprio#p1",
  ),
  "keys: one edge value declares sk (optional), given mine": over(
    "note",
    "sk",
    "mine",
    SORT,
    undefined,
  ),
  "keys: many element declares __edd_e__ (optional), given mine": over(
    "lines",
    "__edd_e__",
    "mine",
    TYPE,
    undefined,
  ),
  "keys: sub-aggregate declares pk (optional), given mine": over(
    "part",
    "pk",
    "mine",
    PARTITION,
    undefined,
  ),
  "keys: one edge value declares csk, the collection sk mirror, given mine": over(
    "note",
    "csk",
    "mine",
    MIRRORED,
    "$sweep#v1#note",
  ),
  "strip: sub-aggregate with an edge declaring pkey (optional), keyed under pkey, given mine": over(
    "part",
    "pkey",
    "mine",
    PARTITION,
    undefined,
  ),
  "strip: childless sub-aggregate declaring pkey (optional), keyed under pkey, given mine": over(
    "part",
    "pkey",
    "mine",
    PARTITION,
    "$sweep#v1#sweep#a",
  ),
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

/**
 * The keys of the rows stored before an update (`stored`) that it neither puts nor deletes (#168,
 * D2): rows it leaves as they are.
 */
const keptAt = (
  stored: ReadonlyArray<Row>,
  sent: ReadonlyArray<Request>,
  keyOf: (row: Row) => string,
): ReadonlySet<string> => {
  const touched = new Set<string>()
  for (const request of sent) {
    if (request.command !== "TransactWriteItems") continue
    for (const item of (request.input as { TransactItems: ReadonlyArray<any> }).TransactItems) {
      const at = item.Put?.Item ?? item.Delete?.Key
      if (at !== undefined) touched.add(keyOf(at))
    }
  }
  return new Set(stored.map(keyOf).filter((key) => !touched.has(key)))
}

/** `requests` without the transaction `Put`s of rows at `kept` (a row 1.40.0 rewrote unchanged). */
const withoutPutsAt = (
  requests: ReadonlyArray<Request>,
  kept: ReadonlySet<string> | undefined,
  pk: string,
): ReadonlyArray<Request> =>
  kept === undefined
    ? requests
    : requests.map((request) =>
        request.command !== "TransactWriteItems"
          ? request
          : {
              ...request,
              input: {
                ...(request.input as object),
                TransactItems: (
                  request.input as { TransactItems: ReadonlyArray<any> }
                ).TransactItems.filter(
                  (item) =>
                    item.Put === undefined ||
                    !kept.has(`${item.Put.Item[pk]?.S} ${item.Put.Item.sk?.S}`),
                ),
              },
            },
      )

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
          // Compared as #168 changed them (`asBefore168`): a `Put` of a row as `stored` held it,
          // a stamp aside, is one this release doesn't send.
          const requests = (
            sent: ReadonlyArray<Request>,
            stored?: ReadonlyArray<Row>,
            kept?: ReadonlySet<string>,
          ) =>
            stamped(
              requestsAs(
                asBefore168(withoutPutsAt(sent, kept, shape.pk ?? "pk"), {
                  stored,
                  same: (row: Row) => stamped(asRow(row)),
                }),
                asRow,
              ),
            )
          const outcome = (result: Outcome) => {
            const judgedAs = judged(result)
            return stamped("ok" in judgedAs ? { ok: asValue(judgedAs.ok) } : judgedAs)
          }
          const runOn = (with168: SweepLib) =>
            harness.onTable(shape.pk ?? "pk", (io, seed) =>
              Effect.gen(function* () {
                if (from === "seeded") yield* seed(then.rows)
                return yield* runSweep(with168, shape, io, from === "seeded")
              }),
            )
          const now = yield* runOn(lib)
          // The same steps with nothing refused (#168): the failing update's change applied once,
          // which is what this release's retry of it must do, from the same rows.
          const control = yield* runOn({ ...lib, failingTransaction: 0 })
          const refused = REFUSED_AT_CREATE[label]
          if (from === "created" && refused !== undefined) {
            // 1.40.0 created it, and its read handed back the library's value, not the one given.
            expect(judged(then.create)).toEqual({ ok: plain(inputOf(shape)) })
            expect(judged(then.get)).not.toEqual({ ok: plain(inputOf(shape)) })
            const [member, reason] = refused
            expect(now.create).toEqual({ failed: "AggregateDecompositionError", member, reason })
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
          const failingAt = now.steps.findIndex((step) => step.step.startsWith("failing"))
          const before = (
            steps: ReadonlyArray<{ readonly rows: ReadonlyArray<Row> }>,
            i: number,
          ) => (i === 0 ? undefined : steps[i - 1]!.rows)
          const nowBefore = (i: number) =>
            before(now.steps, i) ?? (from === "seeded" ? then.rows : now.rows!)
          const wasBefore = (i: number) => before(then.steps, i) ?? then.rows
          const pkOf = shape.pk ?? "pk"
          const keyOf = (row: Row) => `${row[pkOf]?.S} ${row.sk?.S}`
          const inOrder = (all: ReadonlyArray<Row>) =>
            [...all].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : keyOf(x) > keyOf(y) ? 1 : 0))
          for (const [i, step] of now.steps.entries()) {
            const was = then.steps[i]!
            expect(step.step).toBe(was.step)
            const id = { step: step.step }
            // Past the failing update, this release is compared with itself, the change applied
            // once (`control`): its retry is the control's failing update, and 1.40.0's rows from
            // there on hold what its partial write left.
            if (i > failingAt) {
              const twin = control.steps[i === failingAt + 1 ? failingAt : i]!
              const twinBefore = i === failingAt + 1 ? before(control.steps, failingAt) : twin
              expect({ ...id, update: outcome(step.update) }).toEqual({
                ...id,
                update: outcome(twin.update),
              })
              expect({ ...id, requests: requests(step.requests, nowBefore(i)) }).toEqual({
                ...id,
                requests: requests(
                  twin.requests,
                  i === failingAt + 1
                    ? (twinBefore as ReadonlyArray<Row>)
                    : before(control.steps, i),
                ),
              })
              expect({ ...id, refused: step.refused }).toEqual({ ...id, refused: [] })
              expect({ ...id, rows: rows(step.rows) }).toEqual({ ...id, rows: rows(twin.rows) })
              expect({ ...id, get: outcome(step.get) }).toEqual({ ...id, get: outcome(twin.get) })
              continue
            }
            // 1.40.0's result (#241), each copy of a context attribute a value holds as its row
            // holds it after the write: the root's value.
            const returned = (value: Outcome) =>
              shape.context !== undefined && value.ok !== undefined
                ? {
                    ...value,
                    ok: valueCopiesAsRoot(asValue(value.ok), shape.context, CUSTOM_EDGE[label]),
                  }
                : value
            expect({ ...id, update: outcome(step.update) }).toEqual({
              ...id,
              update: outcome(returned(was.update)),
            })
            if (i === failingAt) {
              // Refused whole (#168): what it sent and was refused is the whole change in one
              // transaction, as the control sent it (1.40.0 sent its groups one transaction each, and
              // stopped at the refused one), nothing is written, and a read hands back the aggregate
              // as it was.
              expect({
                ...id,
                requests: requests([...step.requests, ...step.refused], nowBefore(i)),
              }).toEqual({
                ...id,
                requests: requests(control.steps[i]!.requests, before(control.steps, i)),
              })
              expect({ ...id, rows: rows(step.rows) }).toEqual({ ...id, rows: rows(nowBefore(i)) })
              expect({ ...id, get: outcome(step.get) }).toEqual({
                ...id,
                get: outcome(i === 0 ? now.get : now.steps[i - 1]!.get),
              })
              continue
            }
            // A row the update leaves as it is isn't sent (#168, D2), and keeps what it held, where
            // 1.40.0 rewrote its group: in a form 1.40.0 stored otherwise (a held attribute it
            // dropped), it holds what it held before.
            const kept = keptAt(nowBefore(i), step.requests, keyOf)
            expect({ ...id, requests: requests(step.requests, nowBefore(i), kept) }).toEqual({
              ...id,
              requests: requests(was.requests, wasBefore(i), kept),
            })
            expect({ ...id, refused: requests(step.refused) }).toEqual({
              ...id,
              refused: requests(was.refused),
            })
            const beforeRows = new Map(nowBefore(i).map((row) => [keyOf(row), row]))
            const expected = inOrder(
              was.rows.map((row) =>
                kept.has(keyOf(row)) ? (beforeRows.get(keyOf(row)) ?? row) : row,
              ),
            )
            expect({ ...id, rows: rows(inOrder(step.rows)) }).toEqual({
              ...id,
              rows: rows(expected),
            })
            expect({ ...id, get: outcome(step.get) }).toEqual({ ...id, get: outcome(was.get) })
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
