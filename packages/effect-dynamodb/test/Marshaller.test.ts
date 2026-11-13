import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { marshall } from "@aws-sdk/util-dynamodb"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Expression from "../src/Expression.js"
import { marshalOrFail } from "../src/internal/TransactableOps.js"
import {
  fromAttributeMap,
  fromAttributeValue,
  hasNoStoredForm,
  isEmptySet,
  isUnstorableValue,
  toAttributeMap,
  toAttributeValue,
  type UnstorableValue,
  unstorableIn,
} from "../src/Marshaller.js"

class Point extends Schema.Class<Point>("Point")({
  type: Schema.Literal("Point"),
  coordinates: Schema.Array(Schema.Number),
}) {}

class Location extends Schema.Class<Location>("Location")({
  timestamp: Schema.Number,
  geometry: Point,
}) {}

describe("values with no stored form", () => {
  describe("an empty set in a value whose prototype carries part of what's stored", () => {
    class Inherited {
      readonly tags = new Set<string>()
    }
    Object.assign(Inherited.prototype, { kind: "inherited", drop: () => 1 })
    class Tagged extends Schema.TaggedClass<Tagged>("Tagged")("Tagged", {
      tags: Schema.ReadonlySet(Schema.String),
    }) {}
    class Plain extends Schema.Class<Plain>("Plain")({
      tags: Schema.ReadonlySet(Schema.String),
      n: Schema.Number,
    }) {}
    const holding = (tags: ReadonlySet<string>) => ({
      option: Option.some({ tags, n: 1 }),
      optionOfOption: Option.some(Option.some({ tags })),
      optionOfSet: Option.some(tags),
      none: Option.none(),
      success: Result.succeed({ tags }),
      failure: Result.fail({ tags }),
      exit: Exit.succeed({ tags }),
      exitFailure: Exit.fail({ tags }),
      cause: Cause.fail({ tags }),
      tagged: new Tagged({ tags }),
      plain: new Plain({ tags, n: 1 }),
      list: [Option.some({ tags }), Exit.succeed({ tags }), new Tagged({ tags })],
      record: { a: Option.some({ tags }), b: Cause.fail({ tags }) },
      map: new Map([["k", Option.some({ tags })]]),
    })
    /** What marshalling stores for a value, without the attributes holding a set. */
    const withoutSets = (attribute: AttributeValue): AttributeValue => {
      if (attribute.L !== undefined) return { L: attribute.L.map(withoutSets) }
      if (attribute.M === undefined) return attribute
      return {
        M: Object.fromEntries(
          Object.entries(attribute.M)
            .filter(([, part]) => part.SS === undefined)
            .map(([key, part]) => [key, withoutSets(part)]),
        ),
      }
    }
    const direct = (item: Record<string, unknown>) =>
      marshall(item, { removeUndefinedValues: true, convertClassInstanceToMap: true })

    it("keeps everything else, the prototype's included", () => {
      const full = direct(holding(new Set(["a"])))
      const stored = toAttributeMap(holding(new Set()))
      expect(stored).toEqual(
        Object.fromEntries(Object.entries(full).map(([key, part]) => [key, withoutSets(part)])),
      )
      expect(stored.option?.M?._tag).toEqual({ S: "Some" })
      expect(stored.option?.M?._op).toEqual({ S: "Some" })
      expect(stored.option?.M?.["~effect/Option"]).toEqual({ M: {} })
      expect(stored.success?.M?._tag).toEqual({ S: "Success" })
      expect(stored.exit?.M?._tag).toEqual({ S: "Success" })
      expect(stored.exit?.M?.["~effect/Exit"]).toEqual({ S: "~effect/Exit" })
      expect(stored.cause?.M?.["~effect/Cause"]).toEqual({ S: "~effect/Cause" })
      expect(stored.tagged?.M?._tag).toEqual({ S: "Tagged" })
    })

    it("a class's own prototype goes the same way, leaving out what marshalling leaves out", () => {
      expect(toAttributeMap({ a: new Inherited() })).toEqual({
        a: { M: { kind: { S: "inherited" } } },
      })
      expect(toAttributeValue({ a: new Inherited() })).toEqual({
        M: { a: { M: { kind: { S: "inherited" } } } },
      })
    })

    it("is left alone when marshalling takes it, without looking inside", () => {
      const item = holding(new Set(["a"]))
      const stored = toAttributeMap(item)
      expect(stored).toEqual(direct(item))
      expect(Object.keys(stored.option?.M ?? {})).toEqual(Object.keys(direct(item).option?.M ?? {}))
      let reads = 0
      const counted = {
        get n() {
          reads += 1
          return 1
        },
      }
      expect(toAttributeMap({ counted })).toEqual({ counted: { M: { n: { N: "1" } } } })
      expect(reads).toBe(1)
    })

    it("a refusal names a path through what's on the prototype", () => {
      class Refusing {}
      // `NaN !== NaN`, so a NaN gets its holder rewritten, and the walk then wouldn't see a prototype.
      Object.assign(Refusing.prototype, { held: { bad: Number.POSITIVE_INFINITY } })
      const refused = (() => {
        try {
          return toAttributeMap({ a: new Set(), r: new Refusing() })
        } catch (error) {
          return error as UnstorableValue
        }
      })() as UnstorableValue
      expect(refused.path).toEqual(["r", "held", "bad"])
    })
  })

  it("an empty set is an absent attribute, in a map at any depth", () => {
    expect(
      toAttributeMap({
        id: "1",
        tags: new Set(),
        nested: { tags: new Set(), inner: { tags: new Set(), n: 1 } },
        list: [{ tags: new Set(), n: 2 }],
      }),
    ).toEqual({
      id: { S: "1" },
      nested: { M: { inner: { M: { n: { N: "1" } } } } },
      list: { L: [{ M: { n: { N: "2" } } }] },
    })
  })

  it("so is one in a class instance, and in a Map", () => {
    class Holder {
      constructor(
        readonly tags: ReadonlySet<string>,
        readonly n: number,
      ) {}
    }
    expect(toAttributeMap({ holder: new Holder(new Set(), 1) })).toEqual({
      holder: { M: { n: { N: "1" } } },
    })
    expect(
      toAttributeMap({
        byName: new Map<string, unknown>([
          ["a", new Set()],
          ["b", { tags: new Set(), n: 1 }],
          ["c", 2],
        ]),
      }),
    ).toEqual({
      byName: { M: { b: { M: { n: { N: "1" } } }, c: { N: "2" } } },
    })
  })

  it("a Set of nothing but undefined has no stored form either", () => {
    expect(toAttributeMap({ id: "1", tags: new Set([undefined]) })).toEqual({ id: { S: "1" } })
    expect(isEmptySet(new Set([undefined]))).toBe(true)
    expect(isEmptySet(new Set(["a"]))).toBe(false)
    expect(isEmptySet([])).toBe(false)
    expect(hasNoStoredForm(undefined)).toBe(true)
    expect(hasNoStoredForm(null)).toBe(false)
  })

  it("everything else in the item is stored exactly as it would be", () => {
    const rest = {
      id: "1",
      set: new Set(["a"]),
      numbers: new Set([1, 2]),
      bytes: new Uint8Array([1, 2]),
      at: { nested: [1, "x", null, { y: true }] },
      nothing: null,
      gone: undefined,
    }
    expect(toAttributeMap({ ...rest, empty: new Set() })).toEqual(toAttributeMap(rest))
    expect(toAttributeMap(rest).set).toEqual({ SS: ["a"] })
    expect(toAttributeMap(rest).bytes).toEqual({ B: new Uint8Array([1, 2]) })
  })

  it("a list can't leave one out, so marshalling still refuses it", () => {
    expect(() => toAttributeMap({ list: [new Set(["a"]), new Set()] })).toThrow(
      /"list\[1\]": DynamoDB has no empty set/,
    )
  })

  describe("what can't be stored is refused, saying where", () => {
    const refusal = (marshal: () => unknown): UnstorableValue => {
      try {
        marshal()
      } catch (error) {
        expect(isUnstorableValue(error)).toBe(true)
        return error as UnstorableValue
      }
      throw new Error("nothing was refused")
    }

    it("the deepest part refused, through lists, maps, Maps and classes", () => {
      class Inner {
        constructor(readonly at: unknown) {}
      }
      const CASES: ReadonlyArray<readonly [Record<string, unknown>, ReadonlyArray<unknown>]> = [
        [{ a: [new Set()] }, ["a", 0]],
        [{ a: ["x", new Set()] }, ["a", 1]],
        [{ a: { b: [{ c: [1, new Set()] }] } }, ["a", "b", 0, "c", 1]],
        [{ a: new Map([["k", [new Set()]]]) }, ["a", "k", 0]],
        [{ a: new Inner([new Set()]) }, ["a", "at", 0]],
        [{ a: Number.NaN }, ["a"]],
        [{ a: { b: [Number.POSITIVE_INFINITY] } }, ["a", "b", 0]],
        [{ a: { b: 2 ** 60 } }, ["a", "b"]],
        [{ a: { b: new Set([{}]) } }, ["a", "b"]],
      ]
      for (const [item, path] of CASES) {
        expect(refusal(() => toAttributeMap(item)).path).toEqual(path)
        expect(unstorableIn(item)?.path).toEqual(path)
      }
    })

    it("what isn't a refusal isn't dressed up as one", () => {
      const throwing = {
        get x(): unknown {
          throw new TypeError("boom")
        },
      }
      expect(() => unstorableIn({ a: new Set(), throwing })).toThrow(TypeError)
      expect(() => toAttributeValue({ a: new Set(), throwing })).toThrow(TypeError)
    })

    it("a value holding one it's inside is refused where it meets itself, not run to the stack's end", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      expect(unstorableIn({ a: new Set(), cyclic })?.describe()).toMatch(
        /^"cyclic\.self": it holds a value it's inside, .* \[EDD-9124\]$/,
      )
      expect(refusal(() => toAttributeValue({ cyclic }, "v")).path).toEqual(["v", "cyclic", "self"])
    })

    it("says why: an empty set as itself, anything else as marshalling did", () => {
      expect(refusal(() => toAttributeMap({ a: [new Set()] })).reason).toMatch(/no empty set/)
      expect(refusal(() => toAttributeMap({ a: Number.NaN })).reason).toMatch(/NaN/)
      expect(refusal(() => toAttributeMap({ a: 2 ** 60 })).reason).toMatch(/MAX_SAFE_INTEGER/)
    })

    it("an item it can store has nothing in it, and one holding an empty set in a map", () => {
      expect(unstorableIn({ a: 1, b: [1, "x"], c: { d: new Set(["e"]) } })).toBeUndefined()
      expect(unstorableIn({ a: new Set(), b: { c: new Set() } })).toBeUndefined()
    })

    it("in words, a stored attribute by the field it holds", () => {
      const error = refusal(() => toAttributeMap({ stored: { b: [new Set()] } }))
      expect(error.describe()).toMatch(/^"stored\.b\[0\]": /)
      expect(error.message).toMatch(/^"stored\.b\[0\]": /)
      const field = (attribute: string) => (attribute === "stored" ? "field" : attribute)
      expect(error.describe(field)).toMatch(/^"field\.b\[0\]": /)
      // Only the attribute is renamed, not what it holds under the same name.
      const same = refusal(() => toAttributeMap({ a: { stored: Number.NaN } }))
      expect(same.describe(field)).toMatch(/^"a\.stored": /)
    })

    it("a value on its own: no attribute, unless it's given a name", () => {
      const bare = refusal(() => toAttributeValue([new Set()]))
      expect(bare.path).toEqual([0])
      expect(refusal(() => toAttributeValue(new Set())).path).toEqual([])
      expect(refusal(() => toAttributeValue(new Set())).describe()).toBe(
        "DynamoDB has no empty set. [EDD-9124]",
      )
      expect(refusal(() => toAttributeValue(new Set(), "a")).path).toEqual(["a"])
      expect(refusal(() => toAttributeValue({ b: [new Set()] }, "a")).path).toEqual(["a", "b", 0])
      expect(refusal(() => toAttributeValue(Number.NaN, "a")).describe()).toMatch(/^"a": .*NaN/)
    })

    it("a limit: an Expression builder is a plain function, so it throws at the call", () => {
      for (const value of [Number.NaN, new Set(), [new Set()]]) {
        expect(refusal(() => Expression.condition({ gt: { a: value } }))._tag).toBe(
          "UnstorableValue",
        )
      }
    })

    it("marshalOrFail: a ValidationError naming it, anything else a defect", async () => {
      const failed = await Effect.runPromise(
        Effect.flip(
          marshalOrFail("Row", "put", () => toAttributeMap({ stored: [new Set()] }), {
            fieldOf: () => "field",
          }),
        ),
      )
      expect(failed).toBeInstanceOf(ValidationError)
      expect(failed.entityType).toBe("Row")
      expect(failed.operation).toBe("put")
      expect(String(failed.cause)).toMatch(/^"field\[0\]": .* Nothing was written\.$/)
      const told = await Effect.runPromise(
        Effect.flip(
          marshalOrFail("Row", "search", () => toAttributeValue(Number.NaN), {
            outcome: "Nothing was sent.",
          }),
        ),
      )
      expect(String(told.cause)).toMatch(/Nothing was sent\.$/)
      const died = await Effect.runPromiseExit(
        marshalOrFail("Row", "put", () => {
          throw new Error("not the caller's value")
        }),
      )
      expect(died._tag === "Failure" && Cause.hasDies(died.cause)).toBe(true)
    })
  })

  it("a failure that isn't an empty set is still refused", () => {
    expect(() => toAttributeMap({ n: Number.NaN })).toThrow(/"n": .*NaN/)
  })

  it("a value on its own has no attribute to leave out, so it's refused", () => {
    expect(() => toAttributeValue(new Set())).toThrow(/DynamoDB has no empty set/)
    expect(toAttributeValue({ tags: new Set(), n: 1 })).toEqual({ M: { n: { N: "1" } } })
    expect(toAttributeValue(new Set(["a"]))).toEqual({ SS: ["a"] })
  })
})

describe("Marshaller", () => {
  describe("[EDD-9124] a value with no DynamoDB form", () => {
    const refused = [
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["a number past MAX_SAFE_INTEGER", 1e21],
    ] as const

    for (const [name, value] of refused) {
      it(`${name}: both ways in, nested or not`, () => {
        for (const attempt of [
          () => toAttributeValue(value),
          () => toAttributeMap({ a: value }),
          () => toAttributeMap({ a: { b: [value] } }),
        ]) {
          let thrown: unknown
          try {
            attempt()
          } catch (error) {
            thrown = error
          }
          expect(isUnstorableValue(thrown)).toBe(true)
          expect((thrown as UnstorableValue).message).toContain("[EDD-9124]")
          expect((thrown as UnstorableValue).describe()).toContain("[EDD-9124]")
        }
      })
    }

    it("anything else isn't one", () => {
      expect(isUnstorableValue(new Error("x"))).toBe(false)
      expect(isUnstorableValue(undefined)).toBe(false)
      expect(toAttributeValue(0)).toEqual({ N: "0" })
      expect(toAttributeValue(10n ** 30n)).toEqual({ N: String(10n ** 30n) })
    })
  })

  describe("[EDD-9165] a map entry keyed __proto__", () => {
    /** An object holding each entry as its own property, `__proto__` included. */
    const own = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of entries) {
        Object.defineProperty(out, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return out
    }
    const thrownBy = (attempt: () => unknown): unknown => {
      try {
        attempt()
      } catch (error) {
        return error
      }
      return undefined
    }

    it("marshalling drops it: that's what's refused", () => {
      const marshalled = marshall({
        data: own([
          ["__proto__", 1],
          ["ok", 2],
        ]),
      })
      expect(Object.keys(marshalled.data!.M!)).toEqual(["ok"])
      expect(Object.getPrototypeOf(marshalled.data!.M!)).not.toBe(Object.prototype)
    })

    const held = [
      [
        "a record's entry",
        {
          data: own([
            ["__proto__", 1],
            ["ok", 2],
          ]),
        },
        ["data", "__proto__"],
      ],
      ["one holding a map", { data: own([["__proto__", { x: 1 }]]) }, ["data", "__proto__"]],
      ["one holding null", { data: own([["__proto__", null]]) }, ["data", "__proto__"]],
      ["a Map's entry", { data: new Map([["__proto__", 1]]) }, ["data", "__proto__"]],
      [
        "one nested in a list",
        { data: [{ m: own([["__proto__", "v"]]) }] },
        ["data", 0, "m", "__proto__"],
      ],
      ["one at the top", own([["__proto__", 1]]), ["__proto__"]],
    ] as const

    for (const [what, item, path] of held) {
      it(`${what}: refused, naming the field and the key`, () => {
        const thrown = thrownBy(() => toAttributeMap(item))
        expect(isUnstorableValue(thrown)).toBe(true)
        expect((thrown as UnstorableValue).path).toEqual(path)
        expect((thrown as UnstorableValue).code).toBe("EDD-9165")
        expect((thrown as UnstorableValue).message).toMatch(
          /^".*__proto__": an attribute or a map entry named "__proto__" is lost: .* \[EDD-9165\]$/,
        )
        expect(unstorableIn(item)?.code).toBe("EDD-9165")
      })
    }

    it("a single value names itself", () => {
      const thrown = thrownBy(() => toAttributeValue(own([["__proto__", 1]]), "data"))
      expect((thrown as UnstorableValue).path).toEqual(["data", "__proto__"])
      expect((thrown as UnstorableValue).describe()).toContain("[EDD-9165]")
    })

    it("an entry it only inherits, and every other inherited name, are stored as before", () => {
      const names = Object.getOwnPropertyNames(Object.prototype).filter((n) => n !== "__proto__")
      const data = own(names.map((name, at) => [name, at] as const))
      expect(unstorableIn({ data })).toBeUndefined()
      expect(toAttributeMap({ data })).toEqual(marshall({ data }))
      expect(Object.keys(toAttributeMap({ data }).data!.M!)).toEqual(names)
      // Every object inherits `__proto__`: a plain one, a class instance, a null-prototype one.
      expect(toAttributeMap({ data: { ok: 1 } })).toEqual({ data: { M: { ok: { N: "1" } } } })
      expect(
        unstorableIn({
          data: new Location({
            timestamp: 1,
            geometry: new Point({ type: "Point", coordinates: [0] }),
          }),
        }),
      ).toBeUndefined()
      expect(unstorableIn({ data: Object.assign(Object.create(null), { ok: 1 }) })).toBeUndefined()
    })

    it("a write path refuses it with a ValidationError, nothing marshalled", () => {
      const exit = Effect.runSyncExit(
        marshalOrFail("Doc", "put", () => toAttributeMap({ data: own([["__proto__", 1]]) })),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain('"data.__proto__"')
      expect(String((error as ValidationError).cause)).toContain("[EDD-9165]")
    })

    it("a condition holding it compiles as 1.40.0 compiled it, the entry left out; it is refused where it is sent", () => {
      const compiled = Expression.condition({ eq: { data: own([["__proto__", 1]]) } })
      expect(compiled.expression).toBe("#data = :v0")
      expect(compiled.values).toEqual({ ":v0": { M: {} } })
    })
  })

  describe("toAttributeMap / fromAttributeMap", () => {
    it("round-trips a simple object", () => {
      const obj = { name: "Alice", age: 30, active: true }
      const attrMap = toAttributeMap(obj)
      expect(attrMap).toEqual({
        name: { S: "Alice" },
        age: { N: "30" },
        active: { BOOL: true },
      })
      const result = fromAttributeMap(attrMap)
      expect(result).toEqual(obj)
    })

    it("removes undefined values", () => {
      const obj = { name: "Alice", email: undefined }
      const attrMap = toAttributeMap(obj)
      expect(attrMap).toEqual({ name: { S: "Alice" } })
    })

    it("handles nested objects", () => {
      const obj = { data: { nested: "value" } }
      const attrMap = toAttributeMap(obj)
      const result = fromAttributeMap(attrMap)
      expect(result).toEqual(obj)
    })
  })

  describe("toAttributeValue / fromAttributeValue", () => {
    it("marshalls a string", () => {
      const av = toAttributeValue("hello")
      expect(av).toEqual({ S: "hello" })
      expect(fromAttributeValue(av)).toBe("hello")
    })

    it("marshalls a number", () => {
      const av = toAttributeValue(42)
      expect(av).toEqual({ N: "42" })
      expect(fromAttributeValue(av)).toBe(42)
    })

    // Regression: toAttributeValue previously did not pass
    // convertClassInstanceToMap, so any Schema.Class-valued field marshalled
    // through update/append SET clauses or condition values threw at runtime.
    // See https://github.com/jmenga/effect-dynamodb/issues/12
    it("marshalls a Schema.Class instance as a map", () => {
      const point = new Point({ type: "Point", coordinates: [-87.6298, 41.8781] })
      const av = toAttributeValue(point)
      expect(av).toEqual({
        M: {
          type: { S: "Point" },
          coordinates: { L: [{ N: "-87.6298" }, { N: "41.8781" }] },
        },
      })
    })

    it("marshalls a nested Schema.Class instance as a map", () => {
      const loc = new Location({
        timestamp: 1704067200000,
        geometry: new Point({ type: "Point", coordinates: [-87.6298, 41.8781] }),
      })
      const av = toAttributeValue(loc)
      expect(av).toEqual({
        M: {
          timestamp: { N: "1704067200000" },
          geometry: {
            M: {
              type: { S: "Point" },
              coordinates: { L: [{ N: "-87.6298" }, { N: "41.8781" }] },
            },
          },
        },
      })
    })

    it("produces the same shape as toAttributeMap for the same class instance", () => {
      const loc = new Location({
        timestamp: 1704067200000,
        geometry: new Point({ type: "Point", coordinates: [-87.6298, 41.8781] }),
      })
      const mapped = toAttributeMap({ location: loc })
      const perField = toAttributeValue(loc)
      expect(mapped.location).toEqual(perField)
    })

    it("removes undefined values inside nested objects", () => {
      const av = toAttributeValue({ a: "x", b: undefined })
      expect(av).toEqual({ M: { a: { S: "x" } } })
    })
  })
})
