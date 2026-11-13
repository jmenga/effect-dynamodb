import { inspect } from "node:util"
import { Cause, Effect, Equal, Hash, Logger, Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  AggregateTransactionOverflow,
  ConcurrentModification,
  ConditionalCheckFailed,
  DeleteAppliedButUnreadable,
  DynamoError,
  ItemAlreadyExists,
  ItemDeleted,
  ItemNotFound,
  isAwsDuplicateItem,
  isDuplicateItemReason,
  OptimisticLockError,
  StaleAppend,
  StreamSealed,
  TransactionCancelled,
  UniqueConstraintViolation,
  ValidationError,
} from "../src/Errors.js"

const SECRET = "hunter2"

/** Each error whose field holds an item or the caller's values, made with `value` in that field. */
const holdingValues = [
  {
    field: "fields",
    make: (value: string) =>
      new UniqueConstraintViolation({
        entityType: "T",
        constraint: "email",
        fields: { email: value },
      }),
  },
  {
    field: "item",
    make: (value: string) =>
      new DeleteAppliedButUnreadable({
        entityType: "T",
        key: { id: "1" },
        item: { id: "1", secret: value },
        cause: "undecodable",
      }),
  },
  {
    field: "current",
    make: (value: string) =>
      new ConditionalCheckFailed({
        entityType: "T",
        key: { id: "1" },
        current: Option.some({ id: "1", secret: value }),
      }),
  },
  {
    field: "current",
    make: (value: string) =>
      new ConcurrentModification({
        entityType: "T",
        key: { id: "1" },
        attributes: ["email"],
        current: Option.some({ id: "1", secret: value }),
      }),
  },
  {
    field: "current",
    make: (value: string) =>
      new StaleAppend({
        entityType: "T",
        orderByField: "at",
        attemptedOrderBy: 1,
        current: Option.some({ id: "1", secret: value }),
      }),
  },
] as const

/** What each of Effect's log formats prints for `error` logged as the message. */
const logged = (error: unknown): Promise<Array<string>> => {
  const lines: Array<string> = []
  const formats = [
    Logger.formatSimple,
    Logger.formatLogFmt,
    Logger.formatJson,
    Logger.formatStructured,
  ]
  const loggers = formats.map((format) =>
    Logger.make((options) => {
      lines.push(inspect(format.log(options), { depth: 10 }))
    }),
  )
  return Effect.runPromise(
    Effect.logError(error).pipe(Effect.provide(Logger.layer(loggers)), Effect.as(lines)),
  )
}

describe("a field holding values is read, never printed", () => {
  for (const { field, make } of holdingValues) {
    const name = `${make(SECRET)._tag}.${field}`

    it(`${name} is left out of what Effect, JSON.stringify and inspect print`, async () => {
      const error = make(SECRET)
      const printed = [
        JSON.stringify(error),
        String(error),
        inspect(error, { depth: 10 }),
        Cause.pretty(Cause.fail(error)),
        ...(await logged(error)),
      ]
      for (const text of printed) {
        expect(text).not.toContain(SECRET)
        expect(text).not.toMatch(new RegExp(`\\b${field}\\b`))
      }
    })

    it(`${name} is still read, copied and compared, as before`, () => {
      const error = make(SECRET) as unknown as Record<string, unknown>
      expect(JSON.stringify(error[field])).toContain(SECRET)
      expect({ ...error }[field]).toBe(error[field])
      expect(Object.keys(error)).toContain(field)
      // Two errors that differ only in the field are not equal, by Effect or by vitest.
      const same = make(SECRET)
      const other = make("other")
      expect(Equal.equals(error, same)).toBe(true)
      expect(Equal.equals(error, other)).toBe(false)
      expect(Hash.hash(error)).not.toBe(Hash.hash(other))
      expect(error).toEqual(same)
      expect(error).not.toEqual(other)
      expect(error).not.toStrictEqual(other)
      expect(error).toMatchObject({ [field]: same[field as keyof typeof same] })
    })
  }
})

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

  it("StreamSealed carries the stream and the sealing event's version (#166)", () => {
    const err = new StreamSealed({ streamName: "Ledger", streamId: "a-1#3", sealedVersion: 42 })
    expect(err._tag).toBe("StreamSealed")
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ streamName: "Ledger", streamId: "a-1#3", sealedVersion: 42 })
  })

  it("StreamSealed is exported from the package entry point (#166)", async () => {
    const entry = await import("../src/index.js")
    expect(entry.StreamSealed).toBe(StreamSealed)
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

  describe("a PartiQL INSERT finding the key taken (#189)", () => {
    it("ItemAlreadyExists names the entity and its key", () => {
      const error = new ItemAlreadyExists({ entityType: "User", key: { userId: "u-1" } })
      expect(error._tag).toBe("ItemAlreadyExists")
      expect(error.key).toEqual({ userId: "u-1" })
    })

    it("recognises the error under AWS's name and DynamoDB Local's", () => {
      const named = (name: string) => Object.assign(new Error("x"), { name })
      expect(isAwsDuplicateItem(named("DuplicateItemException"))).toBe(true)
      expect(isAwsDuplicateItem(named("DuplicateItem"))).toBe(true)
      expect(isAwsDuplicateItem(named("ConditionalCheckFailedException"))).toBe(false)
      expect(isAwsDuplicateItem(undefined)).toBe(false)
      expect(isAwsDuplicateItem("DuplicateItem")).toBe(false)
    })

    it("recognises a cancellation reason in both forms, and no other", () => {
      const message = "Duplicate primary key exists in table"
      expect(isDuplicateItemReason({ Code: "DuplicateItem" })).toBe(true)
      expect(isDuplicateItemReason({ Code: "ValidationError", Message: message })).toBe(true)
      expect(isDuplicateItemReason({ Code: "ValidationError", Message: "other" })).toBe(false)
      expect(isDuplicateItemReason({ Code: "AccessDenied", Message: message })).toBe(false)
      expect(isDuplicateItemReason({ Code: "None" })).toBe(false)
      expect(isDuplicateItemReason(undefined)).toBe(false)
    })
  })
})
