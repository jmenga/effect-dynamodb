/**
 * `restoredObjectReading` (#242): a row's key-form record with each composite stored as a map the key
 * form makes an instance of under the map's text, `[object Object]`: the key text 1.39.0's and
 * 1.40.0's `restore` composed from a tombstone read back, for `rekey` alone.
 */
import { describe, expect, it } from "@effect/vitest"
import { Duration, Option } from "effect"
import { restoredObjectReading } from "../src/internal/RestoredKeyText.js"

/** A `Duration`'s map as DynamoDB hands it back. */
const durationMap = {
  "~effect/Duration": "~effect/Duration",
  value: { _tag: "Millis", millis: 1500 },
}

describe("restoredObjectReading", () => {
  it("gives a map the key form makes an instance of its own text", () => {
    expect(
      restoredObjectReading(
        { id: "a", f: Duration.millis(1500) },
        { id: "a", f: durationMap, note: "x" },
      ),
    ).toEqual({ id: "a", f: "[object Object]" })
    expect(restoredObjectReading({ f: Option.some(5) }, { f: { _tag: "Some", value: 5 } })).toEqual(
      { f: "[object Object]" },
    )
  })

  it("gives no reading where the key form keeps what's stored", () => {
    // A struct, or a value no schema types: the key form is the map, whose text it already is.
    const struct = { a: 1 }
    expect(restoredObjectReading({ f: struct }, { f: struct })).toBeUndefined()
    // Text, a number, a list, a set, bytes: no map's text.
    expect(
      restoredObjectReading(
        { s: "x", n: 1, l: ["a"], set: new Set(["a"]), b: new Uint8Array([1]) },
        { s: "x", n: 1, l: ["a"], set: new Set(["a"]), b: new Uint8Array([1]) },
      ),
    ).toBeUndefined()
    // A field the row doesn't hold.
    expect(restoredObjectReading({ f: Duration.millis(1) }, {})).toBeUndefined()
  })

  it("looks only at the attributes a key reads", () => {
    expect(
      restoredObjectReading(
        { f: Duration.millis(1500), g: Duration.millis(1500) },
        { f: durationMap, g: durationMap },
        (attr) => attr === "g",
      ),
    ).toEqual({ f: Duration.millis(1500), g: "[object Object]" })
  })

  it("passes over a map holding a toString attribute, which no release composed a key from", () => {
    expect(
      restoredObjectReading({ f: Duration.millis(1) }, { f: { toString: "x" } }),
    ).toBeUndefined()
  })
})
