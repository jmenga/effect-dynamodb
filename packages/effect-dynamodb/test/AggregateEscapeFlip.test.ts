/**
 * `escapeKeys` turned over without `rekey` (#241, `EDD-9160`, `helpers/AggregateEscapeFlip.ts`). A
 * row's sort key text can differ between the two settings: a `$`, `#` or other escaped character in
 * a `many` element's sort key value or a discriminator value, and a number other than a
 * non-negative integer below 1e16. Up to 1.40.0 an update under the other setting wrote such a
 * group's rows under this setting's text and left the ones it read where they were, so every
 * element read twice, or a sub-aggregate didn't read at all, or (texts aliasing across the
 * settings) one element's row overwrote another's. Against what published 1.40.0 did with each step
 * (`fixtures/aggregate-escape-flip-1.40.0.json`), from the rows its `create` wrote:
 *
 * - where 1.40.0's `get` after the update read what the update returned, the update sends, stores
 *   and returns what 1.40.0 did, request for request;
 * - where it read something else, the update is refused with `EDD-9160` naming the member, the row
 *   and `rekey`, after its `Query` and before anything is written.
 */

import { readFileSync } from "node:fs"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import {
  cases,
  type FlipLib,
  type KindCase,
  type KindLib,
  kindCases,
  kindStepNames,
  type Recorded,
  type Row,
  runFlip,
  runKindFlip,
  sortRows,
  stepNames,
} from "./helpers/AggregateEscapeFlip.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-escape-flip-1.40.0.json", import.meta.url), "utf8"),
)
const publishedKinds: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/aggregate-escape-flip-kinds-1.40.0.json", import.meta.url),
    "utf8",
  ),
)

const lib: FlipLib = {
  Aggregate,
  DynamoClient,
  Table,
  DynamoSchema,
  Schema,
  Effect,
  Exit,
  Cause,
  Layer,
}

const kindLib: KindLib = { ...lib, DynamoModel, DateTime, Entity }

let made = 0
/** A recording table's `FlipIo`. */
const flipIo = () => {
  const tableName = `flip-${made++}`
  const table = makeRecordingTable()
  const take = () =>
    table.take().map(({ command, input }) => ({
      command,
      input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
    }))
  const scan = () => Effect.sync(() => sortRows([...table.items.values()] as ReadonlyArray<Row>))
  const seed = (rows: ReadonlyArray<Row>) =>
    Effect.sync(() => {
      for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
    })
  return { tableName, client: table.client, take, scan, seed }
}
const runKind = (c: KindCase, step: (typeof kindStepNames)[number], created?: ReadonlyArray<Row>) =>
  Effect.runPromise(runKindFlip(kindLib, c, step, flipIo(), created))

const run = (
  c: (typeof cases)[number],
  step: (typeof stepNames)[number],
  created: ReadonlyArray<Row>,
) => {
  const tableName = `flip-${made++}`
  const table = makeRecordingTable()
  const take = () =>
    table.take().map(({ command, input }) => ({
      command,
      input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
    }))
  const scan = () => Effect.sync(() => sortRows([...table.items.values()] as ReadonlyArray<Row>))
  const seed = (rows: ReadonlyArray<Row>) =>
    Effect.sync(() => {
      for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
    })
  return Effect.runPromise(
    runFlip(lib, c, step, { tableName, client: table.client, take, scan, seed }, created),
  )
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A value read, its arrays' elements in one order: what a read holds, whatever the order. */
const unordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(unordered).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unordered(v)]))
      : value
const sameRead = (a: unknown, b: unknown) => same(unordered(a), unordered(b))

/** `EDD-9160`'s message for a row of the aggregate in schema `name`, refused under `to`. */
const refusal = (name: string, to: boolean) =>
  new RegExp(
    `^\\[EDD-9160\\] Aggregate "Root": a row of "(lines|part|bits)" is stored under the sort key "\\$${name}#v1#.+?", and this schema \\(\`escapeKeys: ${to}\`\\) keys it "\\$${name}#v1#.+?": the row was written under the other \`escapeKeys\` setting\\. .*Run \`rekey\` on the table .* Nothing was written\\.$`,
  )

describe("escapeKeys turned over without rekey (EDD-9160)", () => {
  it("the fixture is published 1.40.0's, for every case and step", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published["1.40.0"])).toEqual(cases.map((c) => c.name))
    for (const c of cases) {
      expect(Object.keys(published["1.40.0"][c.name]!.steps)).toEqual([...stepNames])
    }
  })

  for (const c of cases) {
    const then = published["1.40.0"][c.name]!
    for (const step of stepNames) {
      const was = then.steps[step]!
      const misread = was.get.ok === undefined || !same(was.update.ok, was.get.ok)
      const title = misread
        ? "1.40.0's get read otherwise than its update returned: refused, nothing written"
        : "sends, stores and returns what 1.40.0 did"
      it(`${c.name}, ${step}: ${title}`, async () => {
        const now = await run(c, step, then.created)
        if (misread) {
          expect(now.step.update.failed).toBe("ValidationError")
          expect(now.step.update.cause).toMatch(refusal("flip", c.to))
          expect(now.step.requests.map((request) => request.command)).toEqual(["Query"])
          expect(now.step.rows).toEqual(then.created)
          return
        }
        expect(now.step.requests).toEqual(was.requests)
        expect(now.step.rows).toEqual(was.rows)
        expect(now.step.update).toEqual(was.update)
        expect(now.step.get).toEqual(was.get)
      })
    }
  }
})

/**
 * Every key kind (#241, `kindCases`): strings needing escapes, fractions and negatives, bigints,
 * dates as ISO text and as epoch milliseconds before 1970, an `entity:` edge keyed by a field its
 * model encodes, in a `many` edge, a sub-aggregate's `many` edge and the sub-aggregate's
 * discriminator, both directions, and `delete`. From the rows 1.40.0's `create` wrote, against what
 * 1.40.0 did (`fixtures/aggregate-escape-flip-kinds-1.40.0.json`); and from the rows this release's
 * own `create` wrote under the other setting.
 */
describe("escapeKeys turned over without rekey, every key kind (EDD-9160)", () => {
  it("the fixture is published 1.40.0's, for every case and step", () => {
    expect(publishedKinds.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(publishedKinds["1.40.0"])).toEqual(kindCases.map((c) => c.name))
    for (const c of kindCases) {
      expect(Object.keys(publishedKinds["1.40.0"][c.name]!.steps)).toEqual([...kindStepNames])
      expect(publishedKinds["1.40.0"][c.name]!.create.failed).toBeUndefined()
    }
  })

  for (const c of kindCases) {
    const then = publishedKinds["1.40.0"][c.name]!
    // An `entity:` edge's rows 1.40.0 wrote hold its composite's stored text under both settings
    // (#241, DESIGN.md §11): turned on, an update moves them to the text composed now.
    const moves = c.kind === "entity" && c.to
    for (const step of kindStepNames) {
      const was = then.steps[step]!
      const misread =
        step !== "delete" && (was.get.ok === undefined || !sameRead(was.update.ok, was.get.ok))
      const title =
        step === "delete"
          ? "deletes every row, as 1.40.0 did"
          : moves
            ? "moves 1.40.0's entity-edge rows and reads back what it returned"
            : misread
              ? "1.40.0's get read otherwise than its update returned: refused, nothing written"
              : "sends, stores and returns what 1.40.0 did"
      it(`${c.name}, ${step}, on 1.40.0's rows: ${title}`, async () => {
        const now = await runKind(c, step, then.created)
        if (step === "delete") {
          expect(now.step.update).toEqual(was.update)
          expect(now.step.requests).toEqual(was.requests)
          expect(now.step.rows).toEqual([])
          expect(was.rows).toEqual([])
          return
        }
        if (moves) {
          expect(now.step.update.ok).toBeDefined()
          expect(unordered(now.step.update.ok)).toEqual(unordered(now.step.get.ok))
          return
        }
        if (misread) {
          expect(now.step.update.failed).toBe("ValidationError")
          expect(now.step.update.cause).toMatch(refusal("flipk", c.to))
          expect(now.step.requests.map((request) => request.command)).toEqual(["Query"])
          expect(now.step.rows).toEqual(then.created)
          return
        }
        expect(now.step.requests).toEqual(was.requests)
        expect(now.step.rows).toEqual(was.rows)
        expect(now.step.update).toEqual(was.update)
        expect(now.step.get).toEqual(was.get)
      })

      // Rows this release wrote under `from`: refused wherever a row's text differs from the one
      // composed under `to` (an `entity:` edge's, written under `on`, holds the numeric text `off`
      // doesn't compose), else written and read back once.
      const refused =
        step !== "delete" && (c.kind === "entity" ? !c.to && step !== "no change" : misread)
      it(`${c.name}, ${step}, on this release's rows: ${step === "delete" ? "deletes every row" : refused ? "refused, nothing written" : "reads back what it returned"}`, async () => {
        const now = await runKind(c, step)
        expect(now.create.ok).toEqual(then.create.ok)
        if (step === "delete") {
          expect(now.step.update).toEqual({ ok: null })
          expect(now.step.rows).toEqual([])
          return
        }
        if (refused) {
          expect(now.step.update.failed).toBe("ValidationError")
          expect(now.step.update.cause).toMatch(refusal("flipk", c.to))
          expect(now.step.requests.map((request) => request.command)).toEqual(["Query"])
          expect(now.step.rows).toEqual(now.created)
          return
        }
        expect(now.step.update.ok).toBeDefined()
        expect(unordered(now.step.update.ok)).toEqual(unordered(now.step.get.ok))
      })
    }
  }
})
