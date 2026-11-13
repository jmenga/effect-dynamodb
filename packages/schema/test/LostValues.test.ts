/**
 * What DynamoDB doesn't store of a value at a position no schema types (#242, `EDD-9161`): the one
 * decision a native write and a packed one make, value by value. Each row is a value 1.40.0 wrote
 * without an error and read back as something else (a `Date` as `{}`), or a value it stored whole.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  Cause,
  Chunk,
  Data,
  DateTime,
  Duration,
  Exit,
  MutableHashMap,
  MutableHashSet,
  Option,
  Redacted,
  Result,
} from "effect"
import * as Cookies from "effect/http/Cookies"
import { lostIn, lostPath, lostRefusal } from "../src/internal/LostValues.js"
import { stringifyStrict } from "../src/internal/PackedCodec.js"

class Point extends Data.Class<{ readonly x: number }> {}
class Boom extends Data.TaggedError("Boom")<{ readonly message: string }> {}
class Quiet extends Data.TaggedError("Quiet")<{ readonly n: number }> {}

class BufferSub extends ArrayBuffer {}
// A DataView's constructor is generic, which a class can't extend as it is.
class ViewSub extends (DataView as new (buffer: ArrayBuffer) => DataView) {}
class BlobSub extends Blob {}
class Int8Sub extends Int8Array {}
class BigSub extends BigInt64Array {}
class Uint8Sub extends Uint8Array {}
const Float16 = (globalThis as { readonly Float16Array?: new (values: Array<number>) => object })
  .Float16Array

const hole = () => {
  const list: Array<number> = [1]
  list[2] = 3
  return list
}

/** Each value, and what of it is lost: `[what, path]`, or `undefined` when DynamoDB stores it all. */
const LOST: ReadonlyArray<readonly [string, () => unknown, readonly [string, string] | undefined]> =
  [
    ["a Date", () => new Date(0), ["a Date", "f"]],
    ["an invalid Date", () => new Date(Number.NaN), ["a Date", "f"]],
    ["a Date in a list in a struct", () => ({ a: [{ at: new Date(0) }] }), ["a Date", "f.a[0].at"]],
    ["a RegExp", () => /a/g, ["a RegExp", "f"]],
    ["a WeakMap", () => new WeakMap(), ["a WeakMap", "f"]],
    ["a WeakSet", () => new WeakSet(), ["a WeakSet", "f"]],
    ["a WeakRef", () => new WeakRef({}), ["a WeakRef", "f"]],
    [
      "a FinalizationRegistry",
      () => new FinalizationRegistry(() => undefined),
      ["a FinalizationRegistry", "f"],
    ],
    ["a Promise", () => Promise.resolve(1), ["a Promise", "f"]],
    ["an Error with a message", () => new Error("x"), ["an Error with a message", "f"]],
    ["an Error with a cause", () => new Error("", { cause: "c" }), ["an Error with a cause", "f"]],
    [
      "a tagged error with a message",
      () => new Boom({ message: "m" }),
      ["an Error with a message", "f"],
    ],
    ["a Redacted", () => Redacted.make("s"), ["a Redacted", "f"]],
    ["a Map with a number key", () => new Map([[1, "a"]]), ["a Map with a number key", "f"]],
    ["a Map with an object key", () => new Map([[{}, "a"]]), ["a Map with a object key", "f"]],
    [
      "a MutableHashSet of numbers, a Map with number keys inside",
      () => MutableHashSet.make(1, 2),
      ["a Map with a number key", "f.keyMap.backing"],
    ],
    ["an ArrayBuffer", () => new Uint8Array([1]).buffer, ["binary data (ArrayBuffer)", "f"]],
    ["a DataView", () => new DataView(new Uint8Array([1]).buffer), ["binary data (DataView)", "f"]],
    ["a Float64Array", () => new Float64Array([1.5]), ["binary data (Float64Array)", "f"]],
    // Every other typed array, which the AWS SDK fails to send (a TypeError while serialising),
    // and a SharedArrayBuffer, which it stores as an empty map.
    ...[
      Int8Array,
      Uint8ClampedArray,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      BigInt64Array,
      BigUint64Array,
    ].map(
      (Kind) => [`a ${Kind.name}`, () => new Kind(1), [`binary data (${Kind.name})`, "f"]] as const,
    ),
    [
      "a SharedArrayBuffer",
      () => new SharedArrayBuffer(1),
      ["binary data (SharedArrayBuffer)", "f"],
    ],
    // A Blob, a File, and a subclass of a kind holding its bytes outside its properties: stored
    // without them (as empty bytes, or the map of its enumerable properties).
    ["a Blob", () => new Blob(["x"]), ["binary data (Blob)", "f"]],
    ["a File", () => new File(["x"], "f"), ["binary data (File)", "f"]],
    ["an ArrayBuffer subclass", () => new BufferSub(1), ["binary data (BufferSub)", "f"]],
    ["a DataView subclass", () => new ViewSub(new ArrayBuffer(1)), ["binary data (ViewSub)", "f"]],
    ["a Blob subclass", () => new BlobSub(["x"]), ["binary data (BlobSub)", "f"]],
    [
      "an Exit dying of an Error",
      () => Exit.die(new Error("x")),
      ["an Error with a message", 'f["~effect/Effect/args"].reasons[0].defect'],
    ],
    // Stored whole: every part is one of its enumerable properties, which a read hands back. A list
    // holding undefined, a function or a hole closes up, as it always has: a documented limit.
    ["undefined in a list", () => [1, undefined, 2], undefined],
    ["a function in a list", () => [1, () => 1], undefined],
    ["a hole in a list", hole, undefined],
    ["a plain struct", () => ({ a: 1, b: ["x", null] }), undefined],
    ["a Uint8Array", () => new Uint8Array([1, 2]), undefined],
    // A typed array the AWS SDK doesn't take for bytes is stored as the map of its elements, as
    // 1.40.0 stored it: a Float16Array, a subclass of any typed array, and a kind a runtime adds.
    ["an Int8Array subclass", () => new Int8Sub([1]), undefined],
    ["a BigInt64Array subclass", () => new BigSub([1n]), undefined],
    ["a Uint8Array subclass", () => new Uint8Sub([1]), undefined],
    ...(Float16 === undefined
      ? []
      : [["a Float16Array", () => new Float16([1.5]), undefined] as const]),
    ["a Set of strings", () => new Set(["a"]), undefined],
    ["a Map with string keys", () => new Map([["a", 1]]), undefined],
    ["an Error with neither", () => new Error(), undefined],
    ["a tagged error without a message", () => new Quiet({ n: 1 }), undefined],
    ["a Data class", () => new Point({ x: 1 }), undefined],
    ["an Option", () => Option.some(1), undefined],
    ["a Result", () => Result.fail("e"), undefined],
    ["a Duration", () => Duration.millis(1), undefined],
    ["a DateTime", () => DateTime.makeUnsafe(0), undefined],
    ["a Cause of a failure", () => Cause.fail("e"), undefined],
    ["a MutableHashMap with string keys", () => MutableHashMap.make(["a", 1] as const), undefined],
    ["a Chunk, which holds itself", () => Chunk.make(1, 2), undefined],
    ["a cookie, whose expiry is written as text", () => cookie(), undefined],
    ["a number, a string, null", () => [1, "a", null, true], undefined],
  ]

function cookie() {
  return Cookies.makeCookieUnsafe("a", "b", { expires: new Date(0) })
}

describe("lostIn", () => {
  for (const [name, make, expected] of LOST) {
    it(name, () => {
      const lost = lostIn({ f: make() })
      expect(
        lost === undefined ? undefined : [lost.what, lostPath("", lost.path).slice(1)],
      ).toEqual(expected)
    })
  }

  it("calls no getter", () => {
    let calls = 0
    const value = {
      get at() {
        calls++
        return new Date(0)
      },
    }
    expect(lostIn(value)).toBeUndefined()
    expect(calls).toBe(0)
  })

  it("names a path as a refusal does", () => {
    expect(lostPath("f", ["a", 0, "b c", "_x"])).toBe('f.a[0]["b c"]._x')
  })
})

describe("a packed field refuses the same values with the same words", () => {
  for (const [name, make, expected] of LOST) {
    if (expected === undefined) continue
    const [what] = expected
    // A map, binary data and an instance packing has no form for (an Exit, a MutableHashSet) aren't
    // JSON whatever they hold, and are refused as that first.
    if (what.startsWith("a Map") || what.startsWith("binary") || name.startsWith("an Exit")) {
      continue
    }
    it(name, () => {
      const lost = lostIn({ f: make() })!
      expect(() => stringifyStrict({ f: make() }, "packed")).toThrow(
        lostRefusal(lostPath("packed", lost.path), lost),
      )
    })
  }

  it("a map and binary data are refused as not JSON", () => {
    for (const value of [new Map([[1, "a"]]), new Float64Array([1]), new Uint8Array([1])]) {
      expect(() => stringifyStrict(value, "packed")).toThrow("which JSON cannot represent")
    }
  })
})
