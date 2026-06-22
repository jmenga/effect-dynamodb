import { describe, expect, it } from "vitest"
import {
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
