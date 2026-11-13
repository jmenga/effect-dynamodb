/**
 * `keyReadings` (#242): the readings of a row's key values `rekey` looks for the row under, each
 * composite read its own way, in every combination, up to `READINGS_BOUND`.
 */
import { describe, expect, it } from "@effect/vitest"
import { keyReadings, READINGS_BOUND } from "../src/internal/KeyReadings.js"

describe("keyReadings", () => {
  it("is the key form's reading alone when no earlier one differs", () => {
    const keyForm = { id: "a", d: "1500 millis" }
    expect(keyReadings(keyForm, [])).toEqual([keyForm])
    expect(keyReadings(keyForm, [undefined, { ...keyForm }])).toEqual([keyForm])
  })

  it("combines composites read different ways: a restored map and a zone as given", () => {
    const keyForm = { id: "a", d: "1500 millis", at: "…[UTC]" }
    const given = { ...keyForm, at: "…[Etc/UTC]" }
    const restored = { ...keyForm, d: "[object Object]" }
    expect(keyReadings(keyForm, [given, restored])).toEqual([
      keyForm,
      given,
      restored,
      { id: "a", d: "[object Object]", at: "…[Etc/UTC]" },
    ])
  })

  it("named: tells readings apart by their values, not by the key text they compose", () => {
    // Left as is: two readings whose values compose one key text (here under the default
    // lowercase casing) are two readings, each tried and each counted towards READINGS_BOUND.
    const keyForm = { id: "a", at: "…[UTC]" }
    const other = { ...keyForm, at: "…[utc]" }
    expect(keyReadings(keyForm, [other])).toEqual([keyForm, other])
  })

  it("reads a composite an earlier reading leaves out as the key form does", () => {
    const keyForm = { id: "a", d: "x" }
    expect(keyReadings(keyForm, [{ d: "x:x" }])).toEqual([keyForm, { id: "a", d: "x:x" }])
  })

  it("tries the fewest composites changed first, each earlier reading by itself always", () => {
    // Seven composites each read one other way: 128 combinations, past the bound.
    const keyForm = Object.fromEntries([..."abcdefg"].map((attr) => [attr, attr]))
    const every = Object.fromEntries([..."abcdefg"].map((attr) => [attr, `${attr}'`]))
    const others = [every, ...[..."abcdefg"].map((attr) => ({ ...keyForm, [attr]: `${attr}'` }))]
    const readings = keyReadings(keyForm, others)
    expect(READINGS_BOUND).toBe(64)
    expect(readings).toHaveLength(READINGS_BOUND)
    expect(readings[0]).toEqual(keyForm)
    // The reading changing all seven comes in by itself, though its level is past the bound.
    expect(readings).toContainEqual(every)
    const changed = (reading: Record<string, unknown>) =>
      Object.keys(keyForm).filter((attr) => reading[attr] !== keyForm[attr]).length
    // Every reading of up to two changes is there (1 + 7 + 21), and none is there twice.
    for (const reading of readings.slice(9)) {
      expect(changed(reading)).toBeGreaterThanOrEqual(2)
    }
    expect(readings.filter((reading) => changed(reading) <= 2)).toHaveLength(29)
    expect(new Set(readings.map((reading) => JSON.stringify(reading))).size).toBe(readings.length)
  })
})
