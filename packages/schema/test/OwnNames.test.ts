/**
 * Looking a name up on a library object and on a caller's payload (#239), and the definitions that
 * name `__proto__` where every row written would hold it: `[EDD-9152]` (an entity) and `[EDD-9153]`
 * (an aggregate), on the pure makes. What each position does under every name, against DynamoDB Local,
 * is `effect-dynamodb`'s `connected.inherited-names.test.ts`.
 */

import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import {
  classOf,
  given,
  givenData,
  givesName,
  hasOwnName,
  isUnreadableName,
  keyEntries,
  lackedByName,
  ownValue,
  setOwn,
  type UnreadableName,
  UnreadableName as UnreadableNameError,
} from "../src/internal/OwnNames.js"

const INHERITED = Object.getOwnPropertyNames(Object.prototype)

/** An object holding each entry as its own property, `__proto__` included. */
const own = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [name, value] of entries) setOwn(out, name, value)
  return out
}

/** What a definition throws, or `"nothing refused"`. */
const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return String((error as Error).message)
  }
  return "nothing refused"
}

describe("lookups on a library object", () => {
  it.each(INHERITED)("finds nothing under %s on an object that doesn't hold it", (name) => {
    const record: Record<string, number> = { a: 1 }
    expect(hasOwnName(record, name)).toBe(false)
    expect(ownValue(record, name)).toBeUndefined()
  })

  it.each(INHERITED)("finds %s where the object holds it", (name) => {
    const record = own([[name, 7]])
    expect(hasOwnName(record, name)).toBe(true)
    expect(ownValue(record, name)).toBe(7)
  })

  it("stores under __proto__ as a property, keeping the object's prototype", () => {
    const record: Record<string, unknown> = {}
    setOwn(record, "__proto__", { a: 1 })
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
    expect(Object.keys(record)).toEqual(["__proto__"])
    expect(ownValue(record, "__proto__")).toEqual({ a: 1 })
    setOwn(record, "b", 2)
    expect(record.b).toBe(2)
  })

  it("reads nothing from an absent map", () => {
    expect(hasOwnName(undefined, "a")).toBe(false)
    expect(ownValue(undefined, "a")).toBeUndefined()
  })
})

describe("reads of a caller's payload", () => {
  class Payload {
    readonly id = "a"
    get computed() {
      return "from a getter"
    }
    method() {
      return 1
    }
  }

  it("reads what the payload answers for: a getter, a prototype, a proxy", () => {
    const payload = new Payload()
    expect(given(payload, "id")).toBe("a")
    expect(given(payload, "computed")).toBe("from a getter")
    expect(given(Object.create({ inherited: 3 }), "inherited")).toBe(3)
    const proxy = new Proxy({}, { get: (_, key) => (key === "x" ? 9 : undefined), has: () => true })
    expect(given(proxy, "x")).toBe(9)
    expect(givesName(proxy, "x")).toBe(true)
  })

  it.each(
    INHERITED,
  )("takes %s as not given where the payload reads what every plain object inherits", (name) => {
    const payloads: Array<object> = [
      {},
      new Proxy({}, { get: (target, key) => Reflect.get(target, key) }),
    ]
    // A prototype chain ending at Object.prototype reads its member, but under `__proto__`, which
    // reads the payload's own prototype.
    if (name !== "__proto__") payloads.push(Object.create({ other: 1 }))
    // A class's instance reads Object.prototype's member, but its class under `constructor`.
    if (name !== "__proto__" && name !== "constructor") payloads.push(new Payload())
    for (const payload of payloads) {
      expect(given(payload, name)).toBeUndefined()
      expect(givenData(payload, name)).toBeUndefined()
      expect(givesName(payload, name)).toBe(false)
    }
  })

  it("reads anything else under such a name as 1.40.0 read it: a class's member, a prototype", () => {
    class Overrides {
      toString() {
        return "overridden"
      }
    }
    expect(given(new Payload(), "constructor")).toBe(Payload)
    expect(given(new Overrides(), "toString")).toBe(Overrides.prototype.toString)
    expect(given(new Payload(), "__proto__")).toBe(Payload.prototype)
    const prototype = { other: 1 }
    expect(given(Object.create(prototype), "__proto__")).toBe(prototype)
    // Object.prototype's member held as the payload's own property is given.
    expect(given({ toString: Object.prototype.toString }, "toString")).toBe(
      Object.prototype.toString,
    )
    expect(given(own([["__proto__", Object.prototype]]), "__proto__")).toBe(Object.prototype)
    // Never a function where 1.40.0 took none.
    expect(givenData(new Payload(), "constructor")).toBeUndefined()
    expect(givenData(new Payload(), "__proto__")).toBe(Payload.prototype)
  })

  it("gives a function as 1.40.0 read it: an own one, a class's method, one a proxy answers", () => {
    const fn = () => 1
    expect(given({ sort: fn }, "sort")).toBe(fn)
    expect(givesName({ sort: fn }, "sort")).toBe(true)
    expect(given(new Payload(), "method")).toBe(Payload.prototype.method)
    expect(givesName(new Payload(), "method")).toBe(true)
    expect(given(new Proxy({}, { get: () => fn }), "sort")).toBe(fn)
    // One held as the object's own property is given, whatever it is.
    const toString = () => "own"
    expect(given({ toString }, "toString")).toBe(toString)
    // Where 1.40.0 took none (an aggregate's ids) or read no such name (a key's lacked composite).
    expect(givenData({ sort: fn }, "sort")).toBeUndefined()
    expect(givenData(new Payload(), "method")).toBeUndefined()
    expect(keyEntries(Object.create({ sort: fn, id: "a" }), ["id"], ["sort"])).toStrictEqual({
      id: "a",
    })
  })

  it("reads a name once, as 1.40.0 read it: one get, and no other trap of a proxy", () => {
    const traps: Array<string> = []
    const proxy = new Proxy(
      { id: "a" },
      {
        get: (target, key) => {
          traps.push(`get ${String(key)}`)
          return Reflect.get(target, key)
        },
        has: (target, key) => {
          traps.push(`has ${String(key)}`)
          return Reflect.has(target, key)
        },
        getOwnPropertyDescriptor: (target, key) => {
          traps.push(`own ${String(key)}`)
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
      },
    )
    expect(given(proxy, "id")).toBe("a")
    expect(given(proxy, "label")).toBeUndefined()
    expect(traps).toStrictEqual(["get id", "get label"])
    traps.length = 0
    // Only where the value read is Object.prototype's own member is it asked whether it holds it.
    expect(given(proxy, "toString")).toBeUndefined()
    expect(given(proxy, "__proto__")).toBeUndefined()
    expect(traps).toStrictEqual(["get toString", "own toString", "get __proto__", "own __proto__"])
    traps.length = 0
    // Where 1.40.0 asked `in` first, it asks `in` first.
    expect(givesName(proxy, "id")).toBe(true)
    expect(givesName(proxy, "label")).toBe(false)
    expect(traps).toStrictEqual(["has id", "get id", "has label"])
  })

  it.each(INHERITED)("reads a value given under %s", (name) => {
    const payload = own([[name, "v"]])
    expect(given(payload, name)).toBe("v")
    expect(givesName(payload, name)).toBe(true)
  })

  it("takes a throw for a name the payload doesn't hold for no value: a strict proxy reads as it is", () => {
    const strict = new Proxy(
      { id: "a" },
      {
        get: (target, key) => {
          if (!Object.hasOwn(target, key)) throw new Error(`no ${String(key)}`)
          return (target as Record<PropertyKey, unknown>)[key]
        },
      },
    )
    expect(given(strict, "id")).toBe("a")
    expect(given(strict, "count")).toBeUndefined()
    expect(givesName(strict, "count")).toBe(false)
    expect(keyEntries(strict, ["id"], ["count", "label"])).toStrictEqual({ id: "a" })
    expect(keyEntries(strict, ["count"], ["label"])).toStrictEqual({ id: "a" })
    // A proxy whose `get` alone answers for a name gives it, as 1.39.0 read it; `in` is what
    // `givesName` asks.
    const getOnly = new Proxy({}, { get: (_, key) => (key === "x" ? 9 : undefined) })
    expect(given(getOnly, "x")).toBe(9)
    expect(givesName(getOnly, "x")).toBe(false)
  })

  it("reports a throw from a getter the payload inherits as UnreadableName, naming the field", () => {
    class Throwing {
      id = "a"
      get count(): number {
        throw new Error("count read")
      }
    }
    const read = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        return error
      }
      return "nothing thrown"
    }
    for (const run of [
      () => given(new Throwing(), "count"),
      () => givesName(new Throwing(), "count"),
      () => keyEntries(new Throwing(), ["count"]),
    ]) {
      const error = read(run)
      expect(isUnreadableName(error)).toBe(true)
      expect((error as UnreadableName).field).toBe("count")
      expect((error as UnreadableName).message).toContain(`Reading "count" from the object given`)
      expect((error as UnreadableName).message).toContain("count read")
    }
    // A name it doesn't hold is never read.
    expect(given(new Throwing(), "label")).toBeUndefined()
    // A throw from its own getter is as it always was.
    const ownThrow = Object.defineProperty({}, "count", {
      get: () => {
        throw new Error("own read")
      },
      enumerable: true,
    })
    expect(String(read(() => given(ownThrow, "count")))).toBe("Error: own read")
  })

  it("keeps an unreadable name in a key handed on, as a getter throwing it", () => {
    class Throwing {
      id = "a"
      get count(): number {
        throw new Error("count read")
      }
    }
    const payload = new Throwing()
    const deferred = lackedByName(payload, { ...payload }, ["id", "count"], undefined, "getter")
    expect(Object.keys(deferred)).toStrictEqual(["id", "count"])
    let thrown: unknown
    try {
      void deferred.count
    } catch (error) {
      thrown = error
    }
    expect(isUnreadableName(thrown)).toBe(true)
  })

  it("keeps `in` as the presence test: a property holding undefined is given", () => {
    expect(givesName({ a: undefined }, "a")).toBe(true)
    expect(givesName({}, "a")).toBe(false)
  })

  it("reads a key's own entries alone where they hold every composite it requires", () => {
    // An instance holding the required composite itself: nothing else of it is read.
    expect(keyEntries(new Payload(), ["id"], ["computed", "method", "toString"])).toStrictEqual({
      id: "a",
    })
    // Lacking one, where 1.40.0 failed: each composite lacked is read by name.
    const values = { id: "a", computed: "from a getter" }
    const proxy = new Proxy(
      {},
      { get: (_, key) => Reflect.get(values, key), has: (_, key) => key in values },
    )
    for (const payload of [Object.create(values), proxy]) {
      expect(keyEntries(payload, ["id"], ["computed", "method", "toString"])).toEqual(values)
    }
    const copy = keyEntries(
      own([
        ["__proto__", 1],
        ["extra", 2],
      ]),
      ["id"],
    )
    expect(Object.keys(copy)).toEqual(["__proto__", "extra"])
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(ownValue(copy, "__proto__")).toBe(1)
  })

  it("reads an ordinary key as 1.40.0 read it: its entries, and no other trap of a proxy", () => {
    const traps: Array<string> = []
    const handler: ProxyHandler<object> = {}
    for (const trap of ["get", "has", "ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf"]) {
      ;(handler as Record<string, unknown>)[trap] = (...args: Array<unknown>) => {
        traps.push(
          trap === "ownKeys" || trap === "getPrototypeOf" ? trap : `${trap} ${String(args[1])}`,
        )
        return (Reflect as unknown as Record<string, (...a: Array<unknown>) => unknown>)[trap]!(
          ...args,
        )
      }
    }
    const key = new Proxy({ id: "a" }, handler)
    expect(keyEntries(key, ["id"], ["label", "toString"])).toStrictEqual({ id: "a" })
    // Object.entries's own traps, and nothing else.
    expect(traps).toStrictEqual(["ownKeys", "getOwnPropertyDescriptor id", "get id"])
  })

  it("names a payload's class, never a field named constructor", () => {
    class Event {}
    class Subclass extends Event {}
    expect(classOf(new Subclass())?.name).toBe("Subclass")
    expect(classOf(own([["constructor", "a field"]]))?.name).toBe("Object")
    expect(classOf(Object.create({ kind: 1 }))?.name).toBe("Object")
    expect(classOf(Object.create(null))).toBeUndefined()
    // A prototype's `constructor` that is a field (`Object.create`) or a getter is passed over.
    expect(classOf(Object.create(own([["constructor", "a field"]])))?.name).toBe("Object")
    class Getters {}
    Object.defineProperty(Getters.prototype, "constructor", { get: () => "a field" })
    expect(classOf(new Getters())?.name).toBe("Object")
  })
})

describe("a caller's key that isn't an object (keyEntries)", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("throws for %s as Object.entries does", (_label, value) => {
    expect(() => keyEntries(value as never, [])).toThrow(
      "Cannot convert undefined or null to object",
    )
  })

  it.each([
    ["a string", "ab"],
    ["a number", 5],
    ["an array", ["x", "y"]],
  ])("reads %s as Object.entries does", (_label, value) => {
    expect(keyEntries(value as never, [])).toStrictEqual(
      Object.fromEntries(Object.entries(value as object)),
    )
  })
})

describe("the error kept for a read that threw (UnreadableName)", () => {
  it("is recognised by identity: a value carrying its tag and fields is a value", () => {
    const stored = { _tag: "UnreadableName", field: "businessField", message: "a stored message" }
    expect(isUnreadableName(stored)).toBe(false)
    expect(isUnreadableName(Object.assign(Object.create(stored), {}))).toBe(false)
    // Not even one made outside this module.
    expect(
      isUnreadableName(
        new UnreadableNameError({ field: "x", thrown: 1, message: "made elsewhere" }),
      ),
    ).toBe(false)
    let thrown: unknown
    try {
      keyEntries(
        Object.create(
          Object.defineProperty({}, "count", {
            get: () => {
              throw new Error("count read")
            },
          }),
        ),
        ["count"],
      )
    } catch (error) {
      thrown = error
    }
    expect(isUnreadableName(thrown)).toBe(true)
  })
})

const schema = DynamoSchema.make({ name: "app", version: 1 })
const keyed = (composite: string) => ({
  pk: { field: "pk", composite: [composite] },
  sk: { field: "sk", composite: [] },
})

const entity = (config: Record<string, unknown>) =>
  Entity.make({ entityType: "Doc", primaryKey: keyed("id"), ...config } as never)

const withField = (name: string, field: Schema.Top = Schema.optional(Schema.String)) =>
  Schema.Struct(
    own([
      ["id", Schema.String],
      [name, field],
    ]) as never,
  )

const refusalText = (code: string, owner: string, where: string) =>
  `[${code}] ${owner}: ${where} is named "__proto__", and every row written would hold it. A ` +
  `JavaScript object can't hold a property of that name by assignment, and the AWS SDK's ` +
  `marshaller drops an attribute or a map entry so named, so the value would be lost when ` +
  `it's written or read. Name it otherwise.`

/** A struct of `entries`, each its own property (`__proto__` included). */
const struct = (entries: ReadonlyArray<readonly [string, Schema.Top]>) =>
  Schema.Struct(own(entries) as never) as Schema.Top

/**
 * Each container that may hold no map, or nothing at all: a `__proto__` below one is not certain to
 * be stored, so the definition loads (a write that gives it is refused when it's sent, `EDD-9165`).
 * What a write leaving the container out stores, against 1.40.0, is `effect-dynamodb`'s
 * `connected.proto-containers.test.ts`.
 */
const CONTAINERS: ReadonlyArray<readonly [string, (inner: Schema.Top) => Schema.Top]> = [
  ["optional", (inner) => Schema.optional(inner as Schema.Struct<{}>)],
  ["optionalKey", (inner) => Schema.optionalKey(inner as Schema.Struct<{}>)],
  ["nullable", (inner) => Schema.NullOr(inner as Schema.Struct<{}>)],
  ["a union alternative", (inner) => Schema.Union([Schema.String, inner as Schema.Struct<{}>])],
  ["a list element", (inner) => Schema.Array(inner as Schema.Struct<{}>)],
  [
    "a tuple's rest element",
    (inner) => Schema.TupleWithRest(Schema.Tuple([Schema.String]), [inner as Schema.Struct<{}>]),
  ],
  ["a record value", (inner) => Schema.Record(Schema.String, inner as Schema.Struct<{}>)],
  ["an Option (a declaration)", (inner) => Schema.Option(inner as Schema.Struct<{}>)],
  ["an OptionFromNullOr", (inner) => Schema.OptionFromNullOr(inner as Schema.Struct<{}>)],
  ["an OptionFromOptionalKey", (inner) => Schema.OptionFromOptionalKey(inner as Schema.Struct<{}>)],
]

describe("[EDD-9152] an entity naming __proto__ where every row would hold it", () => {
  const plain = Schema.Struct({ id: Schema.String, x: Schema.optional(Schema.Number) })
  const always = Schema.Struct({ id: Schema.String, x: Schema.Number })
  const required = struct([["__proto__", Schema.Number]])
  class Held extends Schema.Class<Held>("Held")(
    own([["__proto__", Schema.Number]]) as unknown as Schema.Struct.Fields,
  ) {}

  it.each([
    [
      "a required model field",
      () => entity({ model: withField("__proto__", Schema.String) }),
      "the model field",
    ],
    [
      "a required property of a required field",
      () => entity({ model: withField("t", required) }),
      `the model's property at "t.__proto__"`,
    ],
    [
      "a required property of a required class field",
      () => entity({ model: withField("t", Held) }),
      `the model's property at "t.__proto__"`,
    ],
    [
      "a required property two structs down",
      () => entity({ model: withField("t", struct([["u", required]])) }),
      `the model's property at "t.u.__proto__"`,
    ],
    [
      "a required property that may be null (NullOr): null is stored",
      () =>
        entity({ model: withField("t", struct([["__proto__", Schema.NullOr(Schema.Number)]])) }),
      `the model's property at "t.__proto__"`,
    ],
    [
      "a required property, an OptionFromNullOr: none is stored as null",
      () =>
        entity({
          model: withField("t", struct([["__proto__", Schema.OptionFromNullOr(Schema.Number)]])),
        }),
      `the model's property at "t.__proto__"`,
    ],
    [
      "a required field that may be null (NullOr)",
      () => entity({ model: withField("__proto__", Schema.NullOr(Schema.Number)) }),
      "the model field",
    ],
    [
      "the attribute a required field is stored under",
      () => entity({ model: DynamoModel.configure(always, { x: { field: "__proto__" } }) }),
      `the attribute the field "x" is stored under`,
    ],
    [
      "the created timestamp",
      () => entity({ model: plain, timestamps: { created: "__proto__" } }),
      "the created timestamp",
    ],
    [
      "the updated timestamp",
      () => entity({ model: plain, timestamps: { updated: "__proto__" } }),
      "the updated timestamp",
    ],
    [
      "the version field",
      () => entity({ model: plain, versioned: { field: "__proto__" } }),
      "the version field",
    ],
    [
      "a key composite",
      () =>
        entity({ model: withField("__proto__", Schema.String), primaryKey: keyed("__proto__") }),
      "the model field",
    ],
    [
      "an index's key attribute, composed of required fields",
      () =>
        entity({
          model: always,
          indexes: {
            byX: {
              name: "gsi1",
              pk: { field: "__proto__", composite: ["x"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
      `the partition key attribute of index "byX"`,
    ],
    [
      "an index's key attribute, composed of nothing beside required fields",
      () =>
        entity({
          model: always,
          indexes: {
            byX: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["x"] },
              sk: { field: "__proto__", composite: [] },
            },
          },
        }),
      `the sort key attribute of index "byX"`,
    ],
  ])("refuses %s", (_, make, where) => {
    expect(refusal(make)).toBe(refusalText("EDD-9152", `Entity "Doc"`, where))
  })

  // A write that gives the name is refused when it's sent (`EDD-9165`); one that doesn't is as it was.
  it.each([
    ["an optional model field", () => entity({ model: withField("__proto__") })],
    [
      "the attribute an optional field is stored under",
      () => entity({ model: DynamoModel.configure(plain, { x: { field: "__proto__" } }) }),
    ],
    [
      "an index's key attribute composed of an optional field (a sparse index)",
      () =>
        entity({
          model: plain,
          indexes: {
            byX: {
              name: "gsi1",
              pk: { field: "__proto__", composite: ["x"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
    ],
    [
      "an index's key attribute composed of nothing, beside an optional field (a sparse index)",
      () =>
        entity({
          model: plain,
          indexes: {
            byX: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["x"] },
              sk: { field: "__proto__", composite: [] },
            },
          },
        }),
    ],
    [
      "a required field of a declared schema (Schema.declare), which may store nothing",
      () =>
        entity({
          model: withField(
            "__proto__",
            Schema.declare<undefined>((value): value is undefined => value === undefined),
          ),
        }),
    ],
    [
      "a required field of an Option (a declaration)",
      () => entity({ model: withField("__proto__", Schema.Option(Schema.Number)) }),
    ],
    [
      "a required field of an unknown schema",
      () => entity({ model: withField("__proto__", Schema.Unknown) }),
    ],
    [
      "a required field of a suspended schema that may be undefined",
      () =>
        entity({
          model: withField(
            "__proto__",
            Schema.suspend((): Schema.Top => Schema.UndefinedOr(Schema.Number)),
          ),
        }),
    ],
    [
      "a required field stored under another attribute",
      () =>
        entity({
          model: DynamoModel.configure(withField("__proto__", Schema.Number), {
            ...own([["__proto__", { field: "stored" }]]),
          } as never),
        }),
    ],
    [
      "an optional property",
      () =>
        entity({ model: withField("t", struct([["__proto__", Schema.optional(Schema.Number)]])) }),
    ],
    ["a required property of an optional field", () => entity({ model: withField("t") })],
    [
      "a required property of an optional field, given as a struct",
      () => entity({ model: withField("t", Schema.optional(required)) }),
    ],
    [
      "a required property of a list's element",
      () => entity({ model: withField("t", Schema.Array(required)) }),
    ],
    [
      "a required property of a record's value",
      () => entity({ model: withField("t", Schema.Record(Schema.String, required)) }),
    ],
    [
      "a required property of a union's member",
      () => entity({ model: withField("t", Schema.Union([required, Schema.String])) }),
    ],
    [
      "a required property of an Option",
      () => entity({ model: withField("t", Schema.OptionFromNullOr(required)) }),
    ],
    [
      "a required field that may be undefined (UndefinedOr)",
      () => entity({ model: withField("__proto__", Schema.UndefinedOr(Schema.Number)) }),
    ],
    [
      "a required property that may be undefined (UndefinedOr)",
      () =>
        entity({
          model: withField("t", struct([["__proto__", Schema.UndefinedOr(Schema.Number)]])),
        }),
    ],
    [
      "a required property that may be null or undefined (NullishOr)",
      () =>
        entity({ model: withField("t", struct([["__proto__", Schema.NullishOr(Schema.Number)]])) }),
    ],
    [
      "a required property, a literal union with undefined",
      () =>
        entity({
          model: withField(
            "t",
            struct([["__proto__", Schema.Union([Schema.Literal("a"), Schema.Undefined])]]),
          ),
        }),
    ],
    [
      "a required property, an OptionFromUndefinedOr",
      () =>
        entity({
          model: withField(
            "t",
            struct([["__proto__", Schema.OptionFromUndefinedOr(Schema.Number)]]),
          ),
        }),
    ],
    [
      "a required property, stored optional (a decoding default)",
      () =>
        entity({
          model: withField(
            "t",
            struct([
              [
                "__proto__",
                Schema.optional(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(1))),
              ],
            ]),
          ),
        }),
    ],
    [
      "a required property inside JSON text (Schema.fromJsonString)",
      () => entity({ model: withField("t", Schema.fromJsonString(required)) }),
    ],
    [
      "a required property of a packed field",
      () =>
        entity({
          model: DynamoModel.configure(withField("t", required), {
            t: { storedAs: DynamoModel.Packed({ format: "json" }) },
          } as never),
        }),
    ],
    [
      "a required property of a packed, compressed field",
      () =>
        entity({
          model: DynamoModel.configure(withField("t", required), {
            t: {
              storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "gzip" } }),
            },
          } as never),
        }),
    ],
    [
      "an optional packed field",
      () =>
        entity({
          model: DynamoModel.configure(withField("__proto__", Schema.optional(required)), {
            ...own([["__proto__", { storedAs: DynamoModel.Packed({ format: "json" }) }]]),
          } as never),
        }),
    ],
  ])("takes %s named __proto__", (_, make) => {
    expect(refusal(make)).toBe("nothing refused")
  })

  it.each(CONTAINERS)("takes a required __proto__ below %s container", (_, container) => {
    expect(refusal(() => entity({ model: withField("t", container(required)) }))).toBe(
      "nothing refused",
    )
    // Below a required struct too: what decides is every container on the way from the root.
    expect(
      refusal(() =>
        entity({ model: withField("t", struct([["u", container(struct([["v", required]]))]])) }),
      ),
    ).toBe("nothing refused")
    // And a required __proto__ field of a struct a container holds directly.
    expect(
      refusal(() => entity({ model: withField("t", struct([["u", container(required)]])) })),
    ).toBe("nothing refused")
  })

  it("refuses below a required struct held by a required struct, whatever sits beside it", () => {
    expect(
      refusal(() =>
        entity({
          model: withField(
            "t",
            struct([
              ["o", Schema.optionalKey(required as Schema.Struct<{}>)],
              ["r", required],
            ]),
          ),
        }),
      ),
    ).toBe(refusalText("EDD-9152", `Entity "Doc"`, `the model's property at "t.r.__proto__"`))
  })

  it.each(
    INHERITED.filter((name) => name !== "__proto__"),
  )("takes every other inherited name, %s, in each of those positions", (name) => {
    const model = Schema.Struct(
      own([
        ["id", Schema.String],
        [name, Schema.Struct(own([[name, Schema.Number]]) as never)],
        ["x", Schema.optional(Schema.Number)],
      ]) as never,
    )
    expect(
      refusal(() =>
        entity({
          model: DynamoModel.configure(model, { x: { field: `${name}X` } } as never),
          timestamps: { created: `${name}C`, updated: `${name}U` },
          versioned: { field: `${name}V` },
        }),
      ),
    ).toBe("nothing refused")
    expect(
      refusal(() =>
        entity({
          model: withField(name, Schema.String),
          primaryKey: keyed(name),
          timestamps: { created: name },
        }),
      ),
    ).toBe("nothing refused")
  })
})

describe("[EDD-9153] an aggregate naming __proto__ where every row would hold it", () => {
  const table = { Tag: Symbol.for("test/own-names") }
  const Line = Schema.Struct({ lineId: Schema.String, f: Schema.Number })
  const Lines = Entity.make({
    model: Line,
    entityType: "Line",
    primaryKey: keyed("lineId"),
  } as never)
  const Child = Schema.Struct({ cid: Schema.String })
  const Children = (Aggregate.make as any)(Child, { root: { entityType: "Child" }, edges: {} })

  const aggregate = (model: Schema.Top, edges: Record<string, unknown>) =>
    (Aggregate.make as any)(model, {
      table,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { index: "gsi1", name: "root", sk: { field: "gsi1sk", composite: [] } },
      root: { entityType: "Root" },
      edges,
    })
  const message = (where: string) => refusalText("EDD-9153", `Aggregate "Root"`, where)

  it("refuses a required root field", () => {
    expect(refusal(() => aggregate(withField("__proto__", Schema.String), {}))).toBe(
      message("a field of the root"),
    )
  })

  it("refuses a required property of a required root field", () => {
    expect(
      refusal(() => aggregate(withField("t", struct([["__proto__", Schema.Number]])), {})),
    ).toBe(message(`the property at "t.__proto__"`))
  })

  it("refuses a ref edge: its entity is stored inline under the edge's name", () => {
    expect(
      refusal(() =>
        aggregate(withField("__proto__", Line), own([["__proto__", Aggregate.ref(Lines)]])),
      ),
    ).toBe(message("a ref edge of the root"))
  })

  it("refuses a sub-aggregate's discriminator: it is an attribute of each of its rows", () => {
    expect(
      refusal(() =>
        aggregate(withField("child", Child), {
          child: Children.with({ discriminator: own([["__proto__", 1]]) }),
        }),
      ),
    ).toBe(message(`a discriminator of "child"`))
  })

  it("refuses a field of a sub-aggregate's root where the aggregate holding it requires it", () => {
    const Inner = Schema.Struct(
      own([
        ["cid", Schema.String],
        ["__proto__", Schema.String],
      ]) as never,
    )
    // A sub-aggregate's rows are written where an aggregate places it: its own make takes it.
    let Inners: any
    expect(
      refusal(() => {
        Inners = (Aggregate.make as any)(Inner, { root: { entityType: "Inner" }, edges: {} })
      }),
    ).toBe("nothing refused")
    expect(
      refusal(() =>
        aggregate(withField("inner", Inner), {
          inner: Inners.with({ discriminator: { slot: 1 } }),
        }),
      ),
    ).toBe(message(`a field of "inner"`))
    for (const field of [Schema.optionalKey(Inner), Schema.optional(Inner), Schema.NullOr(Inner)]) {
      expect(
        refusal(() =>
          aggregate(withField("inner", field), {
            inner: Inners.with({ discriminator: { slot: 1 } }),
          }),
        ),
      ).toBe("nothing refused")
    }
  })

  it("refuses a required property of a one edge's value: an attribute of the edge's row", () => {
    const Odd = Schema.Struct(
      own([
        ["lineId", Schema.String],
        ["__proto__", Schema.Number],
      ]) as never,
    )
    expect(
      refusal(() =>
        aggregate(withField("line", Odd), {
          line: Aggregate.one({ entityType: "RootLine" }),
        }),
      ),
    ).toBe(message(`the property at "line.__proto__"`))
  })

  // A write that gives the name is refused when it's sent (`EDD-9165`); one that doesn't is as it was.
  it("takes __proto__ where a row written may leave it out", () => {
    const Odd = Schema.Struct(
      own([
        ["lineId", Schema.String],
        ["__proto__", Schema.Number],
      ]) as never,
    )
    const OddLines = Entity.make({
      model: DynamoModel.configure(Schema.Struct({ lineId: Schema.String, data: Odd }), {
        data: { storedAs: DynamoModel.Packed({ format: "json" }) },
      }),
      entityType: "OddLine",
      primaryKey: keyed("lineId"),
    } as never)
    for (const make of [
      () => aggregate(withField("__proto__"), {}),
      () => aggregate(withField("t", Schema.fromJsonString(Odd)), {}),
      () => aggregate(withField("t", Schema.optional(Odd)), {}),
      () =>
        aggregate(withField("lines", Schema.Array(Odd)), {
          lines: Aggregate.many({ entityType: "RootLine", sk: { composite: ["lineId"] } }),
        }),
      () =>
        aggregate(withField("line", Schema.Struct({ lineId: Schema.String, data: Odd })), {
          line: Aggregate.one({ entityType: "RootLine", entity: OddLines }),
        }),
    ]) {
      expect(refusal(make)).toBe("nothing refused")
    }
  })

  it.each(CONTAINERS)("takes a required __proto__ below %s root field", (_, container) => {
    expect(
      refusal(() =>
        aggregate(withField("t", container(struct([["__proto__", Schema.Number]]))), {}),
      ),
    ).toBe("nothing refused")
  })

  it("takes a sub-aggregate that may be left out, whatever its discriminator", () => {
    for (const field of [Schema.optionalKey(Child), Schema.optional(Child), Schema.NullOr(Child)]) {
      expect(
        refusal(() =>
          aggregate(withField("child", field), {
            child: Children.with({ discriminator: own([["__proto__", 1]]) }),
          }),
        ),
      ).toBe("nothing refused")
    }
  })

  it("takes a one edge that may be left out, whatever its value requires", () => {
    const Odd = Schema.Struct(
      own([
        ["lineId", Schema.String],
        ["__proto__", Schema.Number],
      ]) as never,
    )
    for (const field of [Schema.optionalKey(Odd), Schema.optional(Odd), Schema.NullOr(Odd)]) {
      expect(
        refusal(() =>
          aggregate(withField("line", field), { line: Aggregate.one({ entityType: "RootLine" }) }),
        ),
      ).toBe("nothing refused")
    }
  })

  it("takes an edge named __proto__: an edge is no attribute", () => {
    expect(
      refusal(() =>
        aggregate(withField("__proto__", Line), {
          ...own([["__proto__", Aggregate.one({ entityType: "RootLine", entity: Lines })]]),
        }),
      ),
    ).toBe("nothing refused")
    expect(
      refusal(() =>
        aggregate(
          withField("__proto__", Schema.Array(Line)),
          own([
            [
              "__proto__",
              Aggregate.many({ entityType: "RootLine", sk: { composite: ["lineId"] } }),
            ],
          ]),
        ),
      ),
    ).toBe("nothing refused")
    expect(
      refusal(() =>
        aggregate(
          withField("__proto__", Child),
          own([["__proto__", Children.with({ discriminator: { slot: 1 } })]]),
        ),
      ),
    ).toBe("nothing refused")
  })

  it.each(
    INHERITED.filter((name) => name !== "__proto__"),
  )("takes every other inherited name, %s, in each of those positions", (name) => {
    expect(
      refusal(() =>
        aggregate(
          Schema.Struct(
            own([
              ["id", Schema.String],
              [name, Schema.optional(Schema.String)],
              ["ref", Line],
              ["child", Child],
            ]) as never,
          ),
          {
            ref: Aggregate.ref(Lines),
            child: Children.with({ discriminator: own([[name, 1]]) }),
          },
        ),
      ),
    ).toBe("nothing refused")
  })
})
