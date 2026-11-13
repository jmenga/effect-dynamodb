/**
 * The evaluator `internal/ConditionHolds.ts` answers each condition in `helpers/ConditionCases.ts`
 * as DynamoDB does (#238); `connected.condition-holds.test.ts` checks those answers are DynamoDB's.
 */

import { describe, expect, it } from "vitest"
import { conditionHolds } from "../src/internal/ConditionHolds.js"
import { cases, item, names, values } from "./helpers/ConditionCases.js"

describe("conditionHolds", () => {
  for (const { expression, holds, unsure } of cases) {
    it(expression, () => {
      expect(conditionHolds(expression, item, names, values)).toBe(
        holds === "invalid" || unsure ? undefined : holds,
      )
    })
  }

  it("can't tell for text it doesn't read", () => {
    expect(conditionHolds("#n = ", item, names, values)).toBeUndefined()
    expect(conditionHolds("#n = :five)", item, names, values)).toBeUndefined()
    expect(conditionHolds("#unnamed = :five", item, names, values)).toBeUndefined()
    expect(conditionHolds("#n = :unvalued", item, names, values)).toBeUndefined()
    expect(conditionHolds("#n ~ :five", item, names, values)).toBeUndefined()
  })

  it("reads plain attribute names and list indexes", () => {
    expect(conditionHolds("n = :five AND l[1] = :two_s AND m.k = :v", item, names, values)).toBe(
      true,
    )
  })

  it("never reads a name off the prototype", () => {
    expect(
      conditionHolds(
        "attribute_exists(#m.#proto)",
        item,
        { ...names, "#proto": "toString" },
        values,
      ),
    ).toBe(false)
    expect(
      conditionHolds(
        "attribute_exists(#proto)",
        item,
        { ...names, "#proto": "constructor" },
        values,
      ),
    ).toBe(false)
  })
})
