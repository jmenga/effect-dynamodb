/**
 * What a write and a filter read of a caller's values, as a `Proxy` sees it (#242), against published
 * 1.40.0 (`fixtures/proxy-traps-1.40.0.json`, recorded on DynamoDB Local with Effect 4.1.2 and 4.1.3).
 * The check for what an untyped field doesn't keep (`EDD-9161`) reads values there through their
 * descriptors and prototypes, which only a proxy sees. The payload itself and every declared field set
 * off exactly 1.40.0's traps, in order, before and after a getter in an untyped field has been met. A
 * filter's operand sets off one more, a `getPrototypeOf` first: finding whether it is an instance to
 * put in its stored form. Named, left as it is: once a getter in an untyped field has been met in the
 * process, the marshaller's check reads the descriptors of what an operand holds too.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/proxy-traps-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly cases: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>>
}

const TRAPS = [
  "get",
  "has",
  "ownKeys",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "set",
  "defineProperty",
  "deleteProperty",
  "isExtensible",
  "preventExtensions",
  "setPrototypeOf",
] as const
const KEYED = new Set([
  "get",
  "has",
  "getOwnPropertyDescriptor",
  "set",
  "defineProperty",
  "deleteProperty",
])

/** Each trap set off on a recorded value, by label, as `trap key`. */
let log: Record<string, Array<string>> = {}

const recorded = <A extends object>(label: string, target: A): A =>
  new Proxy(
    target,
    Object.fromEntries(
      TRAPS.map((trap) => [
        trap,
        (...args: Array<unknown>) => {
          const traps = log[label] ?? []
          log[label] = traps
          traps.push(KEYED.has(trap) ? `${trap} ${String(args[1])}` : trap)
          return (Reflect[trap] as (...args: Array<unknown>) => unknown)(...args)
        },
      ]),
    ),
  )

const values = () => ({
  n: 1,
  s: recorded("typed struct", { a: 1, b: recorded("typed list in it", [1, 2]) }),
  tags: recorded("typed list", ["x", "y"]),
  rec: recorded("typed record", { k: 1 }),
  u: recorded("untyped", { k: 1, l: recorded("untyped list in it", [1, 2, 3, 4]) }),
})

const Inner = Schema.Struct({ a: Schema.Number, b: Schema.Array(Schema.Number) })
const Rows = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    n: Schema.optional(Schema.Number),
    s: Schema.optional(Inner),
    tags: Schema.optional(Schema.Array(Schema.String)),
    rec: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    u: Schema.optional(Schema.Unknown),
  }),
  entityType: "Row",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Main = Table.make({
  schema: DynamoSchema.make({ name: "rp", version: 1 }),
  entities: { Rows },
})

/** The traps on typed positions only: an untyped field's own are the check's (see above). */
const typedTraps = () =>
  Object.fromEntries(Object.entries(log).filter(([label]) => !label.startsWith("untyped")))

describe("a caller's values, as a Proxy sees them, against 1.40.0", () => {
  it("the fixture is published 1.40.0's", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.40.0")
  })

  it.effect("the payload and its declared fields, before and after a getter", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Rows }, tables: { Main } })
      const seen: Record<string, unknown> = {}
      const cases = function* (suffix: string) {
        log = {}
        yield* db.entities.Rows.put(recorded("payload", { id: "a", ...values() })).asEffect()
        seen[`put${suffix}`] = typedTraps()
        log = {}
        yield* db.entities.Rows.update({ id: "a" }).set(recorded("payload", values())).asEffect()
        seen[`update .set${suffix}`] = typedTraps()
        log = {}
        yield* db.entities.Rows.scan()
          .filter({ s: recorded("typed operand", { a: 1, b: [1, 2] }) })
          .collect()
        seen[`filter${suffix}`] = typedTraps()
      }
      yield* cases("")
      yield* db.entities.Rows.put({
        id: "g",
        u: {
          get g() {
            return 1
          },
        },
      }).asEffect()
      yield* cases(", after a getter")
      const { "filter, after a getter": afterGetter, ...pinned } = seen
      const expected = Object.fromEntries(
        Object.entries(fixture.cases)
          .filter(([name]) => name !== "filter, after a getter")
          .map(([name, labels]) => [
            name,
            name.startsWith("filter")
              ? { "typed operand": ["getPrototypeOf", ...labels["typed operand"]!] }
              : labels,
          ]),
      )
      expect(pinned).toEqual(expected)
      // Named: more reads than 1.40.0's, all of them descriptor and prototype reads.
      const operand = (afterGetter as Record<string, ReadonlyArray<string>>)["typed operand"]!
      const before = fixture.cases["filter, after a getter"]!["typed operand"]!
      expect(operand.length).toBeGreaterThan(before.length + 1)
      expect(
        operand.every(
          (trap) =>
            before.includes(trap) ||
            trap === "getPrototypeOf" ||
            trap === "ownKeys" ||
            trap.startsWith("getOwnPropertyDescriptor "),
        ),
      ).toBe(true)
    }).pipe(Effect.provide(Main.layer({ name: "rp" })), Effect.provide(table.layer))
  })
})
