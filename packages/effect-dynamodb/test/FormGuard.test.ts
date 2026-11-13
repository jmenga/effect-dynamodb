/**
 * `rejectedBy` (`internal/FormGuard.ts`) says which part of a refused write's condition refused it,
 * judged on the stored item the refusal returned (#238, DESIGN.md §7 "Which verdict a refused write
 * gets"). Every write carrying a renamed sparse map's form guard asks it; the decision table those
 * writes follow is pinned cell by cell in `helpers/RenamedSparseMapVerdictTable.ts`.
 */

import { describe, expect, it } from "vitest"
import { formGuard, formGuardName, rejectedBy } from "../src/internal/FormGuard.js"

const names = { "#fm0": "sr", "#fm1": "tg", "#n": "note", "#v": "version" }
const values = { ":one": { N: "1" }, ":zero": { N: "0" }, ":e": { S: "é" }, ":no": { S: "no" } }
const whole = { sr: { M: { a: { N: "1" } } }, note: { S: "é" }, version: { N: "1" } }
const entries = { "counts#a": { N: "1" }, note: { S: "é" }, version: { N: "1" } }
const judge = (expression: string, stored: Record<string, unknown> | undefined) =>
  rejectedBy({ expression, names, values }, stored)

describe("formGuard", () => {
  it("names the map by its placeholder, whole or as entries", () => {
    expect(formGuardName(3)).toBe("#fm3")
    expect(formGuard(0, "whole")).toBe("attribute_exists(#fm0)")
    expect(formGuard(1, "entries")).toBe("attribute_not_exists(#fm1)")
  })
})

describe("rejectedBy", () => {
  it("is the rest's where there's no row or no condition", () => {
    expect(judge(formGuard(0, "entries"), undefined)).toEqual({ _tag: "Rest" })
    expect(rejectedBy({ expression: undefined, names, values }, whole)).toEqual({ _tag: "Rest" })
  })

  it("is the rest's where every form guard holds on the row", () => {
    expect(judge(`#n = :no AND ${formGuard(0, "entries")}`, entries)).toEqual({ _tag: "Rest" })
    expect(judge(`#n = :e AND ${formGuard(0, "whole")}`, whole)).toEqual({ _tag: "Rest" })
  })

  it("is the form's, known, where a form guard fails and there's no rest", () => {
    expect(judge(formGuard(0, "entries"), whole)).toEqual({
      _tag: "Form",
      attribute: "sr",
      known: true,
    })
    expect(judge(formGuard(0, "whole"), entries)).toEqual({
      _tag: "Form",
      attribute: "sr",
      known: true,
    })
  })

  it("is the form's, known, where a form guard fails and the rest holds", () => {
    expect(judge(`#n = :e AND #v = :one AND ${formGuard(0, "entries")}`, whole)).toEqual({
      _tag: "Form",
      attribute: "sr",
      known: true,
    })
  })

  it("is the rest's where a form guard fails and the rest is false: the caller's verdict first", () => {
    expect(judge(`#n = :no AND ${formGuard(0, "entries")}`, whole)).toEqual({ _tag: "Rest" })
    expect(judge(`${formGuard(0, "entries")} AND #v = :zero`, whole)).toEqual({ _tag: "Rest" })
  })

  it("is the form's, unsure, where the rest is one the evaluator can't tell", () => {
    // `size("é")` is 1 in UTF-16 code units and code points, 2 in UTF-8 bytes.
    expect(judge(`size(#n) = :one AND ${formGuard(0, "entries")}`, whole)).toEqual({
      _tag: "Form",
      attribute: "sr",
      known: false,
    })
    // ...but one false part beside it decides: the caller's verdict.
    expect(judge(`size(#n) = :one AND #n = :no AND ${formGuard(0, "entries")}`, whole)).toEqual({
      _tag: "Rest",
    })
  })

  it("names the first map whose guard fails", () => {
    const both = { ...whole, tg: { M: {} } }
    expect(judge(`${formGuard(0, "whole")} AND ${formGuard(1, "entries")}`, both)).toEqual({
      _tag: "Form",
      attribute: "tg",
      known: true,
    })
  })

  it("keeps a guard inside parentheses, and an unnamed placeholder, in the rest", () => {
    // Not a top-level part: the caller's own `attribute_exists`, judged with the rest.
    expect(judge(`(${formGuard(0, "whole")} OR #n = :e) AND #v = :one`, entries)).toEqual({
      _tag: "Rest",
    })
    expect(
      rejectedBy({ expression: "attribute_not_exists(#fm9) AND #n = :e", names, values }, whole),
    ).toEqual({ _tag: "Rest" })
  })

  it("joins a BETWEEN back as it was", () => {
    expect(judge(`#v BETWEEN :zero AND :one AND ${formGuard(0, "entries")}`, whole)).toEqual({
      _tag: "Form",
      attribute: "sr",
      known: true,
    })
    expect(judge(`#v BETWEEN :zero AND :zero AND ${formGuard(0, "entries")}`, whole)).toEqual({
      _tag: "Rest",
    })
  })
})
