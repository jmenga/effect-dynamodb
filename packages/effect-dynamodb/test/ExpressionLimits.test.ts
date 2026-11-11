/**
 * The guards a move or a delete sends on a row it read (`internal/ExpressionLimits.ts`): the whole
 * row, never weakened; the strongest that fits a row too wide for that; and the one switch point
 * that decides a row nothing proves unchanged.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "vitest"
import {
  asReadGuard,
  countOperators,
  EXPRESSION_MAX_OPERATORS,
  EXPRESSION_MAX_SUBSTITUTION_BYTES,
  expressionFits,
  preferredGuard,
  substitutionBytes,
  substitutionsFit,
  wholeRowGuard,
} from "../src/internal/ExpressionLimits.js"
import * as Rekey from "../src/internal/Rekey.js"

const row = (fields: number, extra: Record<string, AttributeValue> = {}) => ({
  pk: { S: "p" },
  sk: { S: "s" },
  __edd_e__: { S: "Item" },
  ...Object.fromEntries(
    Array.from({ length: fields }, (_, i) => [`f${String(i).padStart(3, "0")}`, { S: `v${i}` }]),
  ),
  ...extra,
})

describe("wholeRowGuard", () => {
  it("is the guard asReadGuard sent, byte for byte, whenever that one held the whole row", () => {
    const read = row(3, { updatedAt: { S: "t" } })
    expect(wholeRowGuard(read, "pk", [], [], [])).toEqual(asReadGuard(read, "pk", []))
    expect(wholeRowGuard(read, "pk", ["updatedAt"], [], [])).toEqual(
      asReadGuard(read, "pk", ["updatedAt"]),
    )
    const claims = ["claim", "claimedUntil"]
    expect(wholeRowGuard(read, "pk", [], claims, [])).toEqual(asReadGuard(read, "pk", [], claims))
  })

  it("keeps asReadGuard's terms in their order and appends each attribute a write could add", () => {
    const read = row(1, { updatedAt: { S: "t" } })
    const guard = wholeRowGuard(
      read,
      "pk",
      ["updatedAt"],
      [],
      ["note", "note", "f000", "pk", "sk"],
    )!
    const was = asReadGuard(read, "pk", ["updatedAt"])
    expect(guard.ConditionExpression).toBe(
      `${was.ConditionExpression} AND attribute_not_exists(#gx0)`,
    )
    expect(guard.ConditionExpression).toBe(
      "attribute_exists(#gpk) AND #g0 = :g0 AND #g1 = :g1 AND #g2 = :g2 AND attribute_not_exists(#gx0)",
    )
    expect(guard.ExpressionAttributeNames).toEqual({
      "#gpk": "pk",
      "#g0": "updatedAt",
      "#g1": "__edd_e__",
      "#g2": "f000",
      "#gx0": "note",
    })
    expect(guard.ExpressionAttributeValues).toEqual(was.ExpressionAttributeValues)
  })

  it("is undefined for a row too wide to guard whole", () => {
    expect(wholeRowGuard(row(160), "pk", [], [], [])).toBeUndefined()
    // The absent attributes count too.
    const absent = Array.from({ length: 160 }, (_, i) => `a${i}`)
    expect(wholeRowGuard(row(1), "pk", [], [], absent)).toBeUndefined()
  })

  it("is undefined when its names and values are over DynamoDB's 2 MB for one expression", () => {
    // Long attribute names, which only the attributes a write could add bring past the limit.
    const long = (i: number) => `${String(i).padStart(3, "0")}${"n".repeat(32_000)}`
    const extra = Array.from({ length: 70 }, (_, i) => long(i))
    // Its expression alone fits: 70 more terms.
    expect(
      expressionFits(
        `attribute_exists(#gpk) AND #g0 = :g0 AND #g1 = :g1${extra.map((_, i) => ` AND attribute_not_exists(#gx${i})`).join("")}`,
      ),
    ).toBe(true)
    expect(
      substitutionBytes(Object.fromEntries(extra.map((name) => [name, name])), {}),
    ).toBeGreaterThan(EXPRESSION_MAX_SUBSTITUTION_BYTES)
    expect(wholeRowGuard(row(1), "pk", [], [], extra)).toBeUndefined()
    expect(wholeRowGuard(row(1), "pk", [], [], extra.slice(0, 10))).toBeDefined()
  })
})

describe("substitutionBytes", () => {
  it("counts each placeholder with its name's bytes or its value's size", () => {
    expect(substitutionBytes({ "#a": "é" }, { ":v": { S: "abc" } })).toBe(2 + 2 + 2 + 3)
    expect(
      substitutionsFit({}, { ":v": { S: "x".repeat(EXPRESSION_MAX_SUBSTITUTION_BYTES) } }),
    ).toBe(false)
  })
})

describe("preferredGuard", () => {
  it("guards the preferred attribute first, then what fits", () => {
    const read = row(160, { updatedAt: { S: "t" } })
    const guard = preferredGuard(read, "pk", ["updatedAt"], ["note"])
    expect(
      guard.ConditionExpression.startsWith(
        "attribute_exists(#gpk) AND #gp0 = :gp0 AND attribute_not_exists(#ga0) AND ",
      ),
    ).toBe(true)
    expect(guard.ExpressionAttributeNames["#gp0"]).toBe("updatedAt")
    expect(guard.ExpressionAttributeNames["#ga0"]).toBe("note")
    expect(expressionFits(guard.ConditionExpression)).toBe(true)
    expect(countOperators(guard.ConditionExpression, "condition")).toBeLessThanOrEqual(
      EXPRESSION_MAX_OPERATORS,
    )
    // Every name it sends is used.
    for (const name of Object.keys(guard.ExpressionAttributeNames)) {
      expect(guard.ConditionExpression).toContain(name)
    }
  })

  it("guards a preferred attribute the read didn't have as still absent", () => {
    const guard = preferredGuard(row(160), "pk", ["updatedAt"], [])
    expect(
      guard.ConditionExpression.startsWith(
        "attribute_exists(#gpk) AND attribute_not_exists(#gp0) AND ",
      ),
    ).toBe(true)
  })
})

describe("Rekey.unprovableRow", () => {
  it("reports the row with writes going on, and guards what fits with them stopped", () => {
    const ctx = (writesStopped: boolean) => ({ writesStopped }) as Rekey.RekeyRowContext
    expect(Rekey.unprovableRow(ctx(false))).toBe("report")
    expect(Rekey.unprovableRow(ctx(true))).toBe("strongest")
  })
})
