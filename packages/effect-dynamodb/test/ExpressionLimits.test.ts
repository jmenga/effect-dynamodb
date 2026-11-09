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
  expressionFits,
  preferredGuard,
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
    expect(wholeRowGuard(read, "pk", [])).toEqual(asReadGuard(read, "pk", []))
    const claims = ["claim", "claimedUntil"]
    expect(wholeRowGuard(read, "pk", claims)).toEqual(asReadGuard(read, "pk", [], claims))
  })

  it("names each absent attribute once, and never the table key", () => {
    const guard = wholeRowGuard(row(1), "pk", ["note", "note", "f000", "pk", "sk"])!
    expect(guard.ConditionExpression).toBe(
      "attribute_exists(#gpk) AND attribute_not_exists(#ga0) AND #g0 = :g0 AND #g1 = :g1",
    )
    expect(guard.ExpressionAttributeNames).toEqual({
      "#gpk": "pk",
      "#ga0": "note",
      "#g0": "__edd_e__",
      "#g1": "f000",
    })
  })

  it("is undefined for a row too wide to guard whole", () => {
    expect(wholeRowGuard(row(160), "pk", [])).toBeUndefined()
    // The absent attributes count too.
    const absent = Array.from({ length: 160 }, (_, i) => `a${i}`)
    expect(wholeRowGuard(row(1), "pk", absent)).toBeUndefined()
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
