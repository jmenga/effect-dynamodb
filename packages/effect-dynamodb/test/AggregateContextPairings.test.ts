/**
 * A root `context` attribute that a member declares too, by every pairing of the two declarations
 * and every place a member takes (#241, `EDD-9159`, `helpers/AggregateContextPairings.ts`).
 *
 * `EDD-9159` refuses a `create` only where the value the member is given is not what a `get` right
 * after returns for it: what the library writes there, read the way a `get` reads that member,
 * compared with the value given as a domain value (a set by its members, a date by its instant, a
 * number or `bigint` by its value). So against what published 1.40.0 did with each case
 * (`fixtures/aggregate-context-pairings-1.40.0.json`):
 *
 * - where 1.40.0's `get` returned the input as given, `create` sends, stores and reads what 1.40.0
 *   did, byte for byte;
 * - where it failed, or returned the member another value than the one given, `create` is
 *   refused, nothing sent, the message showing the value given (or that none was);
 * - anything else (no value given and the root's read back; a definition or a `create` 1.40.0
 *   refused) is 1.40.0's.
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
  memberValues,
  type PairLib,
  type Recorded,
  type Row,
  runPairing,
} from "./helpers/AggregateContextPairings.js"
import {
  CONTEXT,
  customOverRow,
  givenOverRow,
  unreadOverRow,
} from "./helpers/AggregateUpgradeSweep.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const published: {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/aggregate-context-pairings-1.40.0.json", import.meta.url),
    "utf8",
  ),
)

const lib: PairLib = {
  Aggregate,
  Entity,
  DynamoClient,
  Table,
  DynamoSchema,
  DynamoModel,
  Schema,
  Effect,
  DateTime,
  Exit,
  Cause,
  Layer,
}

let made = 0
const run = (label: string) => {
  const c = cases.find((each) => each.label === label)!
  const tableName = `pairings-${made++}`
  const table = makeRecordingTable()
  const take = () =>
    table.take().map(({ command, input }) => ({
      command,
      input: JSON.parse(JSON.stringify(input).replaceAll(tableName, "<table>")),
    }))
  const scan = () => Effect.sync(() => [...table.items.values()] as ReadonlyArray<Row>)
  return Effect.runPromise(
    runPairing(lib, c, { tableName, client: table.client, take, scan }) as Effect.Effect<
      Recorded,
      unknown
    >,
  )
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

describe("a root context attribute a member declares too, by every pairing (EDD-9159)", () => {
  it("the fixture is published 1.40.0's, for every case", () => {
    expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
    expect(Object.keys(published["1.40.0"]).sort()).toEqual(cases.map((c) => c.label).sort())
  })

  for (const c of cases) {
    const then = published["1.40.0"][c.label]!
    const asGiven =
      then.make === undefined && then.get.ok !== undefined && same(then.get.ok, then.input)
    // 1.40.0's `get` failed, or returned the member something other than the value given (given
    // none, the root's value is the member's: what a context copy is).
    const misread =
      then.make === undefined &&
      then.create.ok !== undefined &&
      (then.get.failed !== undefined ||
        (c.given !== "none" && !same(memberValues(then.get.ok), memberValues(then.input))))
    const title = asGiven
      ? "1.40.0 read it back as given: sends, stores and reads what 1.40.0 did"
      : misread
        ? "1.40.0's read returned the member another value there, or failed: refused, nothing sent"
        : "as 1.40.0"
    it(`${c.label}: ${title}`, async () => {
      const now = await run(c.label)
      if (then.make !== undefined || now.make !== undefined) {
        expect(now.make).toBe(then.make)
        return
      }
      if (misread) {
        expect(now.create.failed).toBe("AggregateDecompositionError")
        expect(now.create.member).toBe("m")
        expect(now.create.reason).toMatch(/^\[EDD-9159\] "m"/)
        expect(now.requests).toEqual([])
        expect(now.rows).toEqual([])
        return
      }
      expect(now.create).toEqual(then.create)
      expect(now.requests).toEqual(then.requests)
      expect(JSON.parse(JSON.stringify(now.rows))).toEqual(then.rows)
      expect(now.get).toEqual(then.get)
    })
  }
})

describe("EDD-9159's message: the value given and what a read returns, told apart", () => {
  const shown = (text: string) => ({ shown: text })
  const reasons: Record<string, string> = {
    "ReadonlySet(String) / ReadonlySet(String), declared at one, given other": givenOverRow(
      "m",
      "v",
      shown('Set { "a", "c" }'),
      CONTEXT,
      shown('Set { "a", "b" }'),
    ),
    "Number / Unknown, declared at one, given other": givenOverRow(
      "m",
      "v",
      "5",
      CONTEXT,
      shown("5"),
    ),
    "String / Unknown, declared at many, given other": givenOverRow(
      "m",
      "v",
      shown("5"),
      CONTEXT,
      "5",
    ),
    "BigInt / BigIntFromString, declared at sub, given other": givenOverRow(
      "m",
      "v",
      shown("6n"),
      CONTEXT,
      shown("5n"),
    ),
    "DateEpochMs / DateString, declared at one, given other": givenOverRow(
      "m",
      "v",
      shown("DateTime.Utc(2024-05-06T07:08:20.000Z)"),
      CONTEXT,
      shown("DateTime.Utc(2024-05-06T07:08:09.000Z)"),
    ),
    "Uint8Array / Uint8Array, declared at one, given other": givenOverRow(
      "m",
      "v",
      shown("Uint8Array [1, 2, 4]"),
      CONTEXT,
      shown("Uint8Array [1, 2, 3]"),
    ),
    "Struct / Unknown, packed at one, given other": givenOverRow(
      "m",
      "v",
      '{"a":"1"}',
      CONTEXT,
      shown('{ "a": "1" }'),
    ),
    // The root's copy is its stored text, which the member's `Schema.Number` can't read.
    "NumberFromString / Number, declared at one, given same": givenOverRow(
      "m",
      "v",
      shown("5"),
      CONTEXT,
      { fails: 'Expected number at ["v"]' },
    ),
    "NumberFromString / Number, optional at many, given none": unreadOverRow(
      "m",
      "v",
      CONTEXT,
      'Expected number | undefined at ["v"]',
    ),
    "NumberFromString / Number, optional at custom, given none":
      `[EDD-9159] "m"'s rows hold the root's "v", which the aggregate copies onto every row ` +
      `beneath the root, and a read of "m" with them fails (Expected number | undefined at ` +
      `["m"][0]["v"]), so its rows would not read back. Declare them in its elements so they ` +
      "read the root's values, or name the elements' fields something else.",
    "ReadonlySet(String) / Unknown, declared at custom, given other": customOverRow(
      "m",
      "v",
      shown('["a", "b"]'),
      CONTEXT,
      shown('[{ "k": "k1", "v": ["a", "b"] }]'),
      shown('[{ "k": "k1", "v": Set { "a", "b" } }]'),
    ),
  }
  for (const [label, reason] of Object.entries(reasons)) {
    it(label, async () => {
      const now = await run(label)
      expect(now.create).toEqual({
        failed: "AggregateDecompositionError",
        member: "m",
        reason,
      })
    })
  }
})
