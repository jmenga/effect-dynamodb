/**
 * The stored rows on a failed condition's exception (`ALL_OLD`) stay readable,
 * since the verdicts read them, and stay out of anything that serializes an error.
 */
import { describe, expect, it } from "vitest"
import { classifyError } from "../src/DynamoClient.js"
import { hideReturnedItems } from "../src/internal/ReturnedItem.js"

const SECRET = "hunter2"
const row = { pk: { S: "p" }, secret: { S: SECRET } }

const thrown = (name: string, fields: object) =>
  Object.assign(new Error("The conditional request failed"), { name }, fields)

describe("hideReturnedItems", () => {
  it("hides a conditional failure's item from serialization, and leaves it readable", () => {
    const cause = hideReturnedItems(
      thrown("ConditionalCheckFailedException", { Item: row, $metadata: { requestId: "r-1" } }),
    ) as { readonly Item: unknown; readonly $metadata: unknown }
    expect(cause.Item).toBe(row)
    expect(Object.keys(cause)).not.toContain("Item")
    expect(JSON.stringify(cause)).not.toContain(SECRET)
    expect(cause.$metadata).toEqual({ requestId: "r-1" })
  })

  it("hides every cancellation reason's item, and keeps each code", () => {
    const cause = hideReturnedItems(
      thrown("TransactionCanceledException", {
        CancellationReasons: [
          { Code: "ConditionalCheckFailed", Item: row },
          { Code: "None" },
          { Code: "ConditionalCheckFailed", Item: row },
        ],
      }),
    ) as {
      readonly CancellationReasons: ReadonlyArray<{
        readonly Code: string
        readonly Item?: unknown
      }>
    }
    expect(cause.CancellationReasons.map((reason) => reason.Code)).toEqual([
      "ConditionalCheckFailed",
      "None",
      "ConditionalCheckFailed",
    ])
    expect(cause.CancellationReasons[0]?.Item).toBe(row)
    expect(cause.CancellationReasons[2]?.Item).toBe(row)
    expect(JSON.stringify(cause)).not.toContain(SECRET)
    expect(JSON.stringify(cause)).toContain("ConditionalCheckFailed")
  })

  it("adds no Item where there was none", () => {
    const reason = { Code: "None" }
    const cause = thrown("TransactionCanceledException", {
      CancellationReasons: [reason, null, "other"],
    })
    expect(hideReturnedItems(cause)).toBe(cause)
    expect(Object.hasOwn(cause, "Item")).toBe(false)
    expect(Object.hasOwn(reason, "Item")).toBe(false)
  })

  it("passes through what isn't an object, and doesn't throw on a frozen one", () => {
    expect(hideReturnedItems("text")).toBe("text")
    expect(hideReturnedItems(null)).toBe(null)
    expect(hideReturnedItems(undefined)).toBe(undefined)
    const frozen = Object.freeze({ Item: row })
    expect(hideReturnedItems(frozen)).toBe(frozen)
  })
})

describe("classifyError", () => {
  it("hides the items on the cause of the error it builds", () => {
    const error = classifyError("TransactWriteItems")(
      thrown("TransactionCanceledException", {
        CancellationReasons: [{ Code: "ConditionalCheckFailed", Item: row }],
      }),
    )
    expect(error._tag).toBe("DynamoError")
    expect(JSON.stringify(error)).not.toContain(SECRET)
    expect(
      (error.cause as { CancellationReasons: ReadonlyArray<{ Item: unknown }> })
        .CancellationReasons[0]?.Item,
    ).toBe(row)
  })
})
