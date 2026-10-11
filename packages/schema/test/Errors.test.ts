import { describe, expect, it } from "vitest"
import {
  AggregateTransactionOverflow,
  ConditionalCheckFailed,
  DynamoError,
  ItemDeleted,
  ItemNotFound,
  OptimisticLockError,
  TransactionCancelled,
  UniqueConstraintViolation,
  ValidationError,
} from "../src/Errors.js"

describe("Errors", () => {
  describe("AggregateTransactionOverflow has a readable message (#144)", () => {
    const base = { aggregate: "Match", subgraph: "team2", itemCount: 107, limit: 100 }

    it("nothing committed: says nothing was written", () => {
      const err = new AggregateTransactionOverflow(base)
      expect(err._tag).toBe("AggregateTransactionOverflow")
      expect(err.message).toBe(
        'Aggregate "Match": the transaction of sub-aggregate "team2" holds 107 items, over ' +
          "DynamoDB's limit of 100 for one transaction, and DynamoDB rejected it. Nothing was written.",
      )
    })

    it("names what earlier groups committed", () => {
      const err = new AggregateTransactionOverflow({
        ...base,
        committed: ["root", "team1"],
        operation: "update",
      })
      expect(err.message).toContain('already committed: "root", "team1".')
      expect(err.message).not.toContain("retried create")
    })

    it("a failed create: the root may be committed, so update or delete the partial aggregate", () => {
      const err = new AggregateTransactionOverflow({
        ...base,
        committed: ["root"],
        operation: "create",
      })
      expect(err.message).toContain(
        "The root may be among them, so a retried create fails its root guard " +
          "(ConditionalCheckFailed): update or delete the partial aggregate instead.",
      )
      // Additive: the fields are unchanged.
      expect(err.committed).toEqual(["root"])
      expect(err.subgraph).toBe("team2")
    })
  })

  it("DynamoError has correct tag", () => {
    const err = new DynamoError({ operation: "PutItem", cause: new Error("boom") })
    expect(err._tag).toBe("DynamoError")
    expect(err.operation).toBe("PutItem")
    expect(err.cause).toBeInstanceOf(Error)
  })

  it("ItemNotFound has correct tag", () => {
    const err = new ItemNotFound({ entityType: "User", key: { userId: "u-1" } })
    expect(err._tag).toBe("ItemNotFound")
    expect(err.entityType).toBe("User")
    expect(err.key).toEqual({ userId: "u-1" })
  })

  it("ConditionalCheckFailed has correct tag", () => {
    const err = new ConditionalCheckFailed({ entityType: "User", key: { userId: "u-1" } })
    expect(err._tag).toBe("ConditionalCheckFailed")
  })

  it("ValidationError has correct tag", () => {
    const err = new ValidationError({
      entityType: "User",
      operation: "decode",
      cause: new Error("invalid"),
    })
    expect(err._tag).toBe("ValidationError")
    expect(err.operation).toBe("decode")
  })

  it("TransactionCancelled has correct tag", () => {
    const err = new TransactionCancelled({
      operation: "TransactWriteItems",
      reasons: [{ code: "ConditionalCheckFailed", message: "Condition not met" }],
      cause: new Error("cancelled"),
    })
    expect(err._tag).toBe("TransactionCancelled")
    expect(err.operation).toBe("TransactWriteItems")
    expect(err.reasons).toHaveLength(1)
    expect(err.reasons[0]?.code).toBe("ConditionalCheckFailed")
  })

  it("creates UniqueConstraintViolation error", () => {
    const error = new UniqueConstraintViolation({
      entityType: "User",
      constraint: "email",
      fields: { email: "alice@example.com" },
    })
    expect(error._tag).toBe("UniqueConstraintViolation")
    expect(error.entityType).toBe("User")
    expect(error.constraint).toBe("email")
    expect(error.fields).toEqual({ email: "alice@example.com" })
  })

  it("creates OptimisticLockError error", () => {
    const error = new OptimisticLockError({
      entityType: "User",
      key: { userId: "u-1" },
      expectedVersion: 3,
      actualVersion: 5,
    })
    expect(error._tag).toBe("OptimisticLockError")
    expect(error.expectedVersion).toBe(3)
    expect(error.actualVersion).toBe(5)
  })

  it("creates ItemDeleted error", () => {
    const error = new ItemDeleted({
      entityType: "User",
      key: { userId: "u-1" },
      deletedAt: "2024-01-15T10:30:00Z",
    })
    expect(error._tag).toBe("ItemDeleted")
    expect(error.deletedAt).toBe("2024-01-15T10:30:00Z")
  })
})
