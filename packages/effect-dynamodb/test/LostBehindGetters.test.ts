/**
 * A part DynamoDB doesn't store, behind a getter at a position no schema types (#242, `EDD-9161`).
 * `lostIn` reads descriptors and calls no getter, so a `Date` an enumerable getter returns was stored
 * as an empty map, as 1.40.0 stored it. The marshaller is what calls the getter, once, so that's
 * where what it returns is judged (`readJudged`): refused where it's lost, stored as before where it
 * isn't, and every getter called exactly as often as published 1.40.0 called it on every write path
 * (`READS_140`, measured with 1.40.0's own copy of `CustomDeclarationPaths` on this client).
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { holdsGetters, lostIn } from "@effect-dynamodb/schema/internal/LostValues.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { isUnstorableValue, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { clientOf, membersOf, PATHS } from "./helpers/CustomDeclarationPaths.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** A client whose writes are recorded and whose reads find a row that holds nothing of note. */
const recording = () => {
  const writes: Array<string> = []
  const write = (name: string) => () =>
    Effect.sync(() => {
      writes.push(name)
      return {}
    }) as never
  const row = toAttributeMap({ pk: "p", sk: "s", __edd_e__: "Row", id: "a" })
  const orderRoot = toAttributeMap({ pk: "p", sk: "s", __edd_e__: "Order", id: "a" })
  const layer = mockDynamoClientLayer({
    putItem: write("putItem"),
    updateItem: write("updateItem"),
    deleteItem: write("deleteItem"),
    transactWriteItems: write("transactWriteItems"),
    batchWriteItem: write("batchWriteItem"),
    getItem: (input: { readonly Key?: unknown }) =>
      Effect.succeed(JSON.stringify(input.Key).includes("#row") ? { Item: row } : {}) as never,
    query: (input: unknown) =>
      Effect.succeed(
        JSON.stringify(input).includes("#order")
          ? { Items: [orderRoot], Count: 1, ScannedCount: 1 }
          : { Items: [], Count: 0, ScannedCount: 0 },
      ) as never,
  })
  return { writes, layer }
}

/**
 * How often published 1.40.0 called a getter in the value each path writes, on this client: once for
 * each time it marshalled the value, and once more for each time an update operand was checked
 * against its schema. A getter returning a value DynamoDB stores is called exactly this often.
 */
const READS_140: Readonly<Record<string, number>> = {
  put: 1,
  "put, in a list": 1,
  "put, in a struct": 1,
  "put, with retained versions": 3,
  "put, with a unique constraint": 2,
  "put, unbound": 1,
  create: 1,
  upsert: 2,
  "upsert, omitting a defaulted index composite": 2,
  "update .set": 2,
  "update .set, with retained versions, which reads first": 1,
  "update .append": 6,
  "update pathSet": 6,
  "update pathSet, below a field": 6,
  "update pathSet, of the struct holding one": 6,
  "update pathSet, of a list position": 6,
  "update pathAppend": 6,
  "update pathPrepend": 6,
  "update pathIfNotExists": 6,
  "patch .set": 2,
  "patch pathSet": 6,
  "a time series' append": 3,
  "a transaction's put": 1,
  "a transaction's create, unbound": 1,
  "a transaction's put, with a unique constraint": 2,
  "a transaction's update": 2,
  "a transaction's patch pathSet": 6,
  "a batch's put": 1,
  "a batch's put, unbound": 1,
  "an aggregate's create, on the root": 1,
  "an aggregate's create, on a one edge": 1,
  "an aggregate's create, on a many edge": 1,
  "an aggregate's update, on the root": 1,
  "an aggregate's update, on a one edge": 1,
  "an aggregate's update, on a many edge": 1,
  "an event": 1,
  "an append's metadata": 1,
  "an event's own metadata": 1,
  "an additional item's put": 1,
  "a nested append's event": 1,
  writeSnapshot: 1,
  "a command's event": 1,
  "a command's metadata": 1,
  "a command's additional item": 1,
  "a command's inline snapshot": 1,
  "a projection's outbox": 1,
  "a projection's row": 1,
  "a projection's row, beside its outbox": 2,
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): any =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

/** A value holding a getter that counts its calls and returns `returns()`. */
const counted = (returns: () => unknown) => {
  const calls = { count: 0 }
  const value = {
    get at() {
      calls.count++
      return returns()
    },
  }
  return { value, calls }
}

const runPath = (path: (typeof PATHS)[number], value: unknown) =>
  Effect.gen(function* () {
    const { writes, layer } = recording()
    const members = membersOf(Schema.Unknown)
    const provided = Layer.merge(layer, members.Base.layer({ name: "untyped-table" }))
    const exit = yield* Effect.gen(function* () {
      const db = yield* clientOf(members)
      return yield* path.run(db, members, value)
    }).pipe(Effect.provide(provided as never), Effect.exit)
    return { exit, writes }
  })

describe("[EDD-9161] a Date behind a getter, on every write path", () => {
  it("every path's 1.40.0 count is here", () => {
    expect(PATHS.map((path) => path.name)).toEqual(Object.keys(READS_140))
  })

  for (const path of PATHS) {
    it.effect(`${path.operation}: ${path.name}`, () =>
      Effect.gen(function* () {
        const { value, calls } = counted(() => new Date(0))
        const { exit, writes } = yield* runPath(path, value)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
        const error = failureOf(exit)
        expect(error).toBeInstanceOf(ValidationError)
        expect(String(error.cause)).toMatch(/the value at [\w.[\]]*at is a Date/i)
        expect(String(error.cause)).toContain("[EDD-9161]")
        expect(writes).toEqual([])
        // Never called more often than 1.40.0 called it, which then wrote `{}`.
        expect(calls.count).toBeGreaterThanOrEqual(1)
        expect(calls.count).toBeLessThanOrEqual(READS_140[path.name]!)
      }),
    )
  }
})

describe("a getter returning what DynamoDB stores is called as often as 1.40.0 called it", () => {
  for (const path of PATHS) {
    it.effect(`${path.operation}: ${path.name}`, () =>
      Effect.gen(function* () {
        const { value, calls } = counted(() => 1)
        const { exit } = yield* runPath(path, value)
        expect(String(failureOf(exit)?.cause ?? "")).not.toContain("EDD-9161")
        expect(calls.count).toBe(READS_140[path.name])
      }),
    )
  }
})

/** Marshals `make()` as it always was, then once more after `lostIn` has marked it. */
const bothWays = (make: () => { readonly value: unknown; readonly calls: () => number }) => {
  const before = make()
  const unmarked = toAttributeMap({ u: before.value })
  const after = make()
  expect(lostIn(after.value)).toBeUndefined()
  expect(holdsGetters(after.value)).toBe(true)
  const marked = toAttributeMap({ u: after.value })
  return { unmarked, marked, before: before.calls(), after: after.calls() }
}

/** A counter and a getter descriptor that counts its calls. */
const getterOf = (returns: () => unknown) => {
  let count = 0
  return {
    calls: () => count,
    descriptor: {
      get: () => {
        count++
        return returns()
      },
      enumerable: true,
      configurable: true,
    },
  }
}

describe("judged as it's read: the same bytes, the same calls", () => {
  const SHAPES: ReadonlyArray<
    readonly [string, () => { readonly value: unknown; readonly calls: () => number }]
  > = [
    [
      "an own getter",
      () => {
        const getter = getterOf(() => ({ n: 1, s: "x" }))
        return { value: Object.defineProperty({ a: 1 }, "g", getter.descriptor), ...getter }
      },
    ],
    [
      "an enumerable getter on a class's prototype, between data keys",
      () => {
        const getter = getterOf(() => [1, "two"])
        class Holder {
          z = 1
          "2" = "two"
        }
        Object.defineProperty(Holder.prototype, "1", getter.descriptor)
        Object.defineProperty(Holder.prototype, "g", getter.descriptor)
        Object.defineProperty(Holder.prototype, "h", {
          value: "proto",
          enumerable: true,
        })
        return { value: new Holder(), ...getter }
      },
    ],
    [
      "a getter at a list's index, beside a hole",
      () => {
        const getter = getterOf(() => "at")
        const list: Array<unknown> = new Array(3)
        list[0] = "a"
        Object.defineProperty(list, 2, getter.descriptor)
        return { value: list, ...getter }
      },
    ],
    [
      "a frozen struct and list on the way to it",
      () => {
        const getter = getterOf(() => 5)
        const inner = Object.freeze(Object.defineProperty({}, "g", getter.descriptor))
        return {
          value: Object.freeze({ list: Object.freeze([Object.freeze({ inner })]), n: 1 }),
          ...getter,
        }
      },
    ],
    [
      "a map holding it",
      () => {
        const getter = getterOf(() => "v")
        return {
          value: new Map<string, unknown>([
            ["k", Object.defineProperty({}, "g", getter.descriptor)],
            ["plain", 1],
          ]),
          ...getter,
        }
      },
    ],
    [
      "a getter returning a value holding another",
      () => {
        const inner = getterOf(() => "deep")
        const outer = getterOf(() => Object.defineProperty({ x: 1 }, "g", inner.descriptor))
        return {
          value: Object.defineProperty({}, "g", outer.descriptor),
          calls: () => outer.calls() * 100 + inner.calls(),
        }
      },
    ],
  ]

  for (const [name, make] of SHAPES) {
    it(name, () => {
      const { unmarked, marked, before, after } = bothWays(make)
      expect(marked).toEqual(unmarked)
      expect(JSON.stringify(marked)).toBe(JSON.stringify(unmarked))
      expect(after).toBe(before)
    })
  }

  it("a getter the marshaller doesn't read isn't called, and its Date isn't looked at", () => {
    class Holder {
      readonly n = 1
      get at() {
        throw new Error("called")
      }
    }
    const value = new Holder()
    expect(lostIn(value)).toBeUndefined()
    expect(holdsGetters(value)).toBe(false)
    expect(toAttributeMap({ u: value })).toEqual({ u: { M: { n: { N: "1" } } } })
  })
})

describe("what a getter returns is refused where it's lost", () => {
  const LOST: ReadonlyArray<readonly [string, () => unknown, string, string]> = [
    ["a Date", () => new Date(0), "u.g", "a Date"],
    ["a RegExp", () => /a/, "u.g", "a RegExp"],
    ["an Int16Array", () => new Int16Array(1), "u.g", "binary data (Int16Array)"],
    ["a WeakMap", () => new WeakMap(), "u.g", "a WeakMap"],
    [
      "a Date inside what it returns",
      () => ({ list: [{ at: new Date(0) }] }),
      "u.g.list[0].at",
      "a Date",
    ],
  ]
  for (const [name, returns, at, what] of LOST) {
    it(name, () => {
      const getter = getterOf(returns)
      const value = { list: [Object.defineProperty({}, "g", getter.descriptor)] }
      expect(lostIn(value)).toBeUndefined()
      const thrown = (() => {
        try {
          toAttributeMap({ u: value.list[0] })
        } catch (error) {
          return error
        }
      })()
      expect(isUnstorableValue(thrown)).toBe(true)
      const refused = (thrown as { describe: () => string }).describe()
      expect(refused).toContain(`the value at ${at} is ${what}, which DynamoDB doesn't store`)
      expect(refused).toContain("[EDD-9161]")
      expect(getter.calls()).toBe(1)
    })
  }
})

describe("a put through the entity", () => {
  const schema = DynamoSchema.make({ name: "getters", version: 1 })
  const Values = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        loose: Schema.optional(Schema.Unknown),
        packed: Schema.optional(Schema.Unknown),
      }),
      { packed: { storedAs: DynamoModel.Packed({ format: "json" }) } },
    ),
    entityType: "V",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const Main = Table.make({ schema, entities: { Values } })
  const run = <A, E>(body: (db: any) => Effect.Effect<A, E>) => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Values }, tables: { Main } })
      return { result: yield* body(db), table }
    }).pipe(Effect.provide(Main.layer({ name: "getters" })), Effect.provide(table.layer))
  }

  it.effect("returns the caller's own value, stored as 1.40.0 stored it", () =>
    Effect.gen(function* () {
      const { value, calls } = counted(() => 1)
      const { result, table } = yield* run((db) =>
        db.entities.Values.put({ id: "a", loose: value }).asEffect(),
      )
      expect((result as { readonly loose: unknown }).loose).toBe(value)
      expect(calls.count).toBe(1)
      expect([...table.items.values()][0]!.loose).toEqual({ M: { at: { N: "1" } } })
    }),
  )

  it.effect("refuses a Date behind a getter, natively and packed, and writes nothing", () =>
    Effect.gen(function* () {
      for (const field of ["loose", "packed"] as const) {
        const { value, calls } = counted(() => new Date(0))
        const exit = yield* Effect.exit(
          run((db) => db.entities.Values.put({ id: "a", [field]: value }).asEffect()),
        )
        const error = failureOf(exit)
        expect(error).toBeInstanceOf(ValidationError)
        expect(String(error.cause)).toContain(`${field}.at is a Date, which DynamoDB doesn't`)
        expect(calls.count).toBeLessThanOrEqual(1)
      }
    }),
  )
})

describe("named, left as 1.40.0: a getter a list inherits at an index", () => {
  // The getter is on the list's prototype, not the list: `lostIn` reads a list's own indices, so
  // what the getter returns is stored as 1.40.0 stored it, and the getter is called once, as then.
  it("a Date it returns is stored as an empty map, as 1.40.0 stored it", () => {
    let calls = 0
    const prototype = Object.create(Array.prototype)
    Object.defineProperty(prototype, "1", {
      get: () => {
        calls++
        return new Date(0)
      },
      enumerable: true,
    })
    const list: Array<unknown> = new Array(3)
    list[0] = "a"
    list[2] = "c"
    Object.setPrototypeOf(list, prototype)
    expect(lostIn({ u: list })).toBeUndefined()
    expect(toAttributeMap({ u: list })).toEqual({
      u: { L: [{ S: "a" }, { M: {} }, { S: "c" }] },
    })
    expect(calls).toBe(1)
  })
})
