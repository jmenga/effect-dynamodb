import type { TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import {
  DynamoError,
  DynamoValidationError,
  ThrottlingError,
  TransactionCancelled,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import { describe, expect, vi } from "vitest"
import {
  batchEntries,
  type Diagnosis,
  diagnosedValidationError,
  diagnoseFailure,
  diagnoseWriteFailure,
  explainDiagnosis,
  rangeKeysOf,
  type SentWrite,
  targetsFor,
} from "../src/internal/WriteDiagnosis.js"
import {
  awsTransactionCanceled,
  awsValidationException,
  DDB_ITEM_SIZE,
  DDB_ITEM_SIZE_UPDATE,
  DDB_SORT_KEY_AWS,
  DDB_SORT_KEY_LOCAL,
  DDB_TOO_MANY_ITEMS,
  ddbPayloadTooLarge,
} from "./helpers/MockDynamoClient.js"

// --- Fixtures ---------------------------------------------------------------

const rejected = (message: string) =>
  new DynamoValidationError({
    operation: "TransactWriteItems",
    cause: awsValidationException(message),
  })

const cancelled = (
  reasons: ReadonlyArray<{ readonly Code?: string; readonly Message?: string } | undefined>,
) => new DynamoError({ operation: "TransactWriteItems", cause: awsTransactionCanceled(reasons) })

/** A Put of `bytes` bytes by DynamoDB's rules: `pk` + `sk` + a filler attribute `d`. */
const put = (id: string, bytes = 100): TransactWriteItem => {
  const pk = `p#${id}`
  const sk = "s"
  const fixed = 2 + pk.length + 2 + sk.length + 1
  return {
    Put: {
      TableName: "t",
      Item: { pk: { S: pk }, sk: { S: sk }, d: { S: "x".repeat(Math.max(0, bytes - fixed)) } },
    },
  }
}

const update = (id: string, sets: Record<string, string> = {}): TransactWriteItem => {
  const names: Record<string, string> = {}
  const values: Record<string, { S: string }> = {}
  const clauses = Object.entries(sets).map(([attr, value], i) => {
    names[`#a${i}`] = attr
    values[`:v${i}`] = { S: value }
    return `#a${i} = :v${i}`
  })
  return {
    Update: {
      TableName: "t",
      Key: { pk: { S: `p#${id}` }, sk: { S: "s" } },
      UpdateExpression: clauses.length > 0 ? `SET ${clauses.join(", ")}` : "SET #n = :n",
      ExpressionAttributeNames: clauses.length > 0 ? names : { "#n": "n" },
      ExpressionAttributeValues: clauses.length > 0 ? values : { ":n": { S: "1" } },
    },
  }
}

const del = (id: string): TransactWriteItem => ({
  Delete: { TableName: "t", Key: { pk: { S: `p#${id}` }, sk: { S: "s" } } },
})

const targets = (items: ReadonlyArray<TransactWriteItem>) =>
  targetsFor(items, ["pk", "sk"], "Doc", (index) => `operation ${index} (Doc)`)

const transaction = (items: ReadonlyArray<TransactWriteItem>): SentWrite => ({
  _tag: "Transaction",
  items,
  targets: () => targets(items),
})

const single = (item: TransactWriteItem): SentWrite => ({
  _tag: "Item",
  item,
  target: () => targetsFor([item], ["pk", "sk"], "Doc", () => "the item")[0]!,
})

const RANGE_KEYS = ["sk", "gsi1sk"]

const diagnose = (error: unknown, sent: SentWrite) => diagnoseWriteFailure(error, sent, RANGE_KEYS)

const expectTag = <T extends Diagnosis["_tag"]>(
  diagnosis: Diagnosis | undefined,
  tag: T,
): Extract<Diagnosis, { _tag: T }> => {
  expect(diagnosis?._tag).toBe(tag)
  return diagnosis as Extract<Diagnosis, { _tag: T }>
}

// --- Tests ------------------------------------------------------------------

describe("WriteDiagnosis (#144)", () => {
  describe("shape 1 — PutItem over 400 KB", () => {
    it("names the one item, with its lower-bound size", () => {
      const item = put("a", 410_000)
      const d = expectTag(diagnose(rejected(DDB_ITEM_SIZE), single(item)), "ItemTooLarge")
      expect(d.target.key).toBe("pk=p#a, sk=s")
      expect(d.target.source).toBe("the item")
      expect(d.bytes).toBe(410_000)
      expect(d.likely).toBe(false)
      expect(explainDiagnosis(d, "put")).toContain("the item of the item, at pk=p#a, sk=s")
    })

    it("the message is the evidence: an item under the lower bound is still named, not likely", () => {
      const d = expectTag(
        diagnose(rejected(DDB_ITEM_SIZE), single(put("a", 400_000))),
        "ItemTooLarge",
      )
      expect(d.likely).toBe(false)
    })
  })

  describe("shape 2 — UpdateItem growing past 400 KB", () => {
    it("names the item; its resulting size is not in the request", () => {
      const d = expectTag(
        diagnose(rejected(DDB_ITEM_SIZE_UPDATE), single(update("a"))),
        "ItemTooLarge",
      )
      expect(d.target.key).toBe("pk=p#a, sk=s")
      expect(d.bytes).toBeUndefined()
      expect(explainDiagnosis(d, "update")).toContain("is not in the request")
    })

    it("a DeleteItem cannot grow an item: passed through", () => {
      expect(diagnose(rejected(DDB_ITEM_SIZE_UPDATE), single(del("a")))).toBeUndefined()
    })
  })

  describe("shape 3 — a transaction holding an oversized Put", () => {
    it("names the Put over 409,600 bytes", () => {
      const items = [put("a"), put("b", 410_000), del("c")]
      const d = expectTag(diagnose(rejected(DDB_ITEM_SIZE), transaction(items)), "ItemTooLarge")
      expect(d.target.source).toBe("operation 1 (Doc)")
      expect(d.likely).toBe(false)
    })

    it("none over by the lower bound: the largest Put, named as the likely culprit", () => {
      const items = [put("a", 1000), put("b", 300_000), put("c", 2000)]
      const d = expectTag(diagnose(rejected(DDB_ITEM_SIZE), transaction(items)), "ItemTooLarge")
      expect(d.target.source).toBe("operation 1 (Doc)")
      expect(d.likely).toBe(true)
      expect(explainDiagnosis(d, "transactWrite")).toContain("most likely the item of operation 1")
      expect(explainDiagnosis(d, "transactWrite")).toContain("approximate")
    })

    it("no Put in the request: passed through", () => {
      expect(diagnose(rejected(DDB_ITEM_SIZE), transaction([del("a")]))).toBeUndefined()
    })
  })

  describe("shape 4 — a cancelled transaction whose Update grows too large", () => {
    it("is attributed by the reason's index", () => {
      const items = [put("a"), update("b"), put("c")]
      const error = cancelled([
        { Code: "None" },
        { Code: "ValidationError", Message: DDB_ITEM_SIZE_UPDATE },
        { Code: "None" },
      ])
      const d = expectTag(diagnose(error, transaction(items)), "ItemTooLarge")
      expect(d.target.source).toBe("operation 1 (Doc)")
      expect(d.likely).toBe(false)
    })

    it("reads a site's TransactionCancelled the same way", () => {
      const items = [put("a"), update("b")]
      const error = new TransactionCancelled({
        operation: "TransactWriteItems",
        reasons: [{ code: "None" }, { code: "ValidationError", message: DDB_ITEM_SIZE_UPDATE }],
        cause: undefined,
      })
      expect(expectTag(diagnose(error, transaction(items)), "ItemTooLarge").target.source).toBe(
        "operation 1 (Doc)",
      )
    })

    it("a conditional failure beside it is the site's to explain: passed through", () => {
      const error = cancelled([
        { Code: "ConditionalCheckFailed" },
        { Code: "ValidationError", Message: DDB_ITEM_SIZE_UPDATE },
      ])
      expect(diagnose(error, transaction([put("a"), update("b")]))).toBeUndefined()
    })

    it("a reason at an index outside the request: passed through", () => {
      const error = cancelled([
        { Code: "None" },
        { Code: "ValidationError", Message: DDB_ITEM_SIZE_UPDATE },
      ])
      expect(diagnose(error, transaction([put("a")]))).toBeUndefined()
    })
  })

  describe("shape 5 — a BatchWriteItem holding an oversized item", () => {
    it("sizes every PutRequest and names the one over", () => {
      const items = batchEntries({
        t: [
          { PutRequest: { Item: put("a").Put!.Item } },
          { DeleteRequest: { Key: del("b").Delete!.Key } },
          { PutRequest: { Item: put("c", 420_000).Put!.Item } },
        ],
      })
      const sent: SentWrite = { _tag: "Batch", items, targets: () => targets(items) }
      const d = expectTag(diagnose(rejected(DDB_ITEM_SIZE), sent), "ItemTooLarge")
      expect(d.target.key).toBe("pk=p#c, sk=s")
      expect(explainDiagnosis(d, "batchWrite", { partial: true })).toContain(
        "earlier requests of the operation may already have been written",
      )
    })
  })

  describe("shape 6 — 101+ transact items", () => {
    it("confirmed by count", () => {
      const items = Array.from({ length: 101 }, (_, i) => del(String(i)))
      const d = expectTag(
        diagnose(rejected(DDB_TOO_MANY_ITEMS), transaction(items)),
        "TooManyItems",
      )
      expect(d.count).toBe(101)
      expect(d.limit).toBe(100)
    })

    it("a count message on a request of 100 items or fewer: passed through", () => {
      const items = Array.from({ length: 100 }, (_, i) => del(String(i)))
      expect(diagnose(rejected(DDB_TOO_MANY_ITEMS), transaction(items))).toBeUndefined()
    })
  })

  describe("shape 7 — a transaction over 4 MB", () => {
    it("parses DynamoDB's payload size and names the three largest, largest first", () => {
      const items = [
        put("a", 1000),
        put("b", 300_000),
        put("c", 380_000),
        put("d", 200_000),
        del("e"),
      ]
      const d = expectTag(
        diagnose(rejected(ddbPayloadTooLarge(4_200_000)), transaction(items)),
        "TransactionTooLarge",
      )
      expect(d.reported).toBe(4_200_000)
      expect(d.measured).toBeGreaterThan(881_000)
      expect(d.largest.map(({ target }) => target.source)).toEqual([
        "operation 2 (Doc)",
        "operation 1 (Doc)",
        "operation 3 (Doc)",
      ])
      const text = explainDiagnosis(d, "transactWrite")
      expect(text).toContain("(it reported 4200000 bytes)")
      expect(text).toContain("counts twice")
    })

    it("without a parsable size, still diagnosed", () => {
      const d = expectTag(
        diagnose(rejected("Transaction payload size cannot exceed 4MB"), transaction([put("a")])),
        "TransactionTooLarge",
      )
      expect(d.reported).toBeUndefined()
    })
  })

  describe("shape 8 — a sort key over 1024 bytes", () => {
    const longKey = "k".repeat(1025)

    it("recognises DynamoDB Local's and AWS's wording, confirmed by UTF-8 bytes", () => {
      for (const message of [DDB_SORT_KEY_LOCAL, DDB_SORT_KEY_AWS]) {
        const item: TransactWriteItem = {
          Put: { TableName: "t", Item: { ...put("a").Put!.Item, gsi1sk: { S: longKey } } },
        }
        const d = expectTag(
          diagnose(rejected(message), transaction([put("z"), item])),
          "SortKeyTooLong",
        )
        expect(d.attribute).toBe("gsi1sk")
        expect(d.bytes).toBe(1025)
        expect(d.target.source).toBe("operation 1 (Doc)")
        expect(explainDiagnosis(d, "put")).toContain("1024-byte limit")
      }
    })

    it("counts UTF-8 bytes, not characters", () => {
      // 513 two-byte characters: 1026 bytes, 513 characters.
      const item: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p" }, sk: { S: "é".repeat(513) } } },
      }
      expect(
        expectTag(diagnose(rejected(DDB_SORT_KEY_LOCAL), single(item)), "SortKeyTooLong").bytes,
      ).toBe(1026)
    })

    it("reads an Update's SET pairs", () => {
      const d = expectTag(
        diagnose(rejected(DDB_SORT_KEY_AWS), single(update("a", { gsi1sk: longKey }))),
        "SortKeyTooLong",
      )
      expect(d.attribute).toBe("gsi1sk")
    })

    it("as a cancellation reason", () => {
      const item: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p" }, sk: { S: longKey } } },
      }
      const error = cancelled([
        { Code: "None" },
        { Code: "ValidationError", Message: DDB_SORT_KEY_LOCAL },
      ])
      expect(
        expectTag(diagnose(error, transaction([put("a"), item])), "SortKeyTooLong").attribute,
      ).toBe("sk")
    })

    it("no range key over 1024 bytes: passed through", () => {
      const item: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p" }, sk: { S: "k".repeat(1024) } } },
      }
      expect(diagnose(rejected(DDB_SORT_KEY_LOCAL), transaction([item]))).toBeUndefined()
      // An attribute that is not a range key is never measured.
      const other: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p" }, sk: { S: "s" }, note: { S: longKey } } },
      }
      expect(diagnose(rejected(DDB_SORT_KEY_LOCAL), transaction([other]))).toBeUndefined()
    })
  })

  describe("shape 9 — TransactGetItems with 101+ keys", () => {
    it("confirmed by count", () => {
      const d = expectTag(
        diagnose(rejected(DDB_TOO_MANY_ITEMS), { _tag: "TransactGet", count: 101 }),
        "TooManyItems",
      )
      expect(d.count).toBe(101)
      expect(
        diagnose(rejected(DDB_TOO_MANY_ITEMS), { _tag: "TransactGet", count: 100 }),
      ).toBeUndefined()
    })
  })

  describe("pass-through", () => {
    const sent = transaction([put("a", 500_000)])

    it("an unrelated ValidationException", () => {
      expect(
        diagnose(
          rejected(
            "One or more parameter values were invalid: An AttributeValue may not contain an empty string",
          ),
          sent,
        ),
      ).toBeUndefined()
    })

    it("a throttle, a ConditionalCheckFailed and a plain DynamoError", () => {
      const throttle = new ThrottlingError({
        operation: "PutItem",
        cause: Object.assign(new Error(DDB_ITEM_SIZE), { name: "ThrottlingException" }),
      })
      const conditional = new DynamoError({
        operation: "PutItem",
        cause: Object.assign(new Error(DDB_ITEM_SIZE), { name: "ConditionalCheckFailedException" }),
      })
      const plain = new DynamoError({ operation: "PutItem", cause: new Error(DDB_ITEM_SIZE) })
      for (const error of [throttle, conditional, plain, new Error(DDB_ITEM_SIZE), undefined]) {
        expect(diagnose(error, sent)).toBeUndefined()
      }
    })

    it("the ValidationException is recognised however the client classified it", () => {
      const asDynamoError = new DynamoError({
        operation: "PutItem",
        cause: awsValidationException(DDB_ITEM_SIZE),
      })
      expect(diagnose(asDynamoError, sent)?._tag).toBe("ItemTooLarge")
    })
  })

  describe("diagnoseFailure", () => {
    const options = (spy: () => void) => ({
      sent: () => {
        spy()
        return transaction([put("a", 500_000)])
      },
      rangeKeys: () => RANGE_KEYS,
      rewrite: (diagnosis: Diagnosis, original: unknown) =>
        diagnosedValidationError(diagnosis, original, { operation: "op", entityType: "Doc" }),
    })

    it.effect("builds nothing on success", () =>
      Effect.gen(function* () {
        const spy = vi.fn()
        const result = yield* Effect.succeed(42).pipe(diagnoseFailure(options(spy)))
        expect(result).toBe(42)
        expect(spy).not.toHaveBeenCalled()
      }),
    )

    it.effect("passes an undiagnosable error through without measuring", () =>
      Effect.gen(function* () {
        const spy = vi.fn()
        const original = new DynamoError({ operation: "PutItem", cause: new Error("boom") })
        const error = yield* Effect.fail(original).pipe(diagnoseFailure(options(spy)), Effect.flip)
        expect(error).toBe(original)
        expect(spy).not.toHaveBeenCalled()
      }),
    )

    it.effect("passes an unconfirmed candidate through unchanged", () =>
      Effect.gen(function* () {
        const original = rejected(DDB_TOO_MANY_ITEMS)
        const error = yield* Effect.fail(original).pipe(
          diagnoseFailure(options(() => {})),
          Effect.flip,
        )
        expect(error).toBe(original)
      }),
    )

    it.effect("rewrites a confirmed one, keeping DynamoDB's error as the cause", () =>
      Effect.gen(function* () {
        const original = rejected(DDB_ITEM_SIZE)
        const error = yield* Effect.fail(original).pipe(
          diagnoseFailure(options(() => {})),
          Effect.flip,
        )
        expect(error).toBeInstanceOf(ValidationError)
        const failure = error as ValidationError
        expect(failure.entityType).toBe("Doc")
        expect(failure.operation).toBe("op")
        expect(String(failure.cause)).toContain("operation 0 (Doc), at pk=p#a, sk=s")
        expect((failure.cause as Error).cause).toBe(original)
      }),
    )
  })

  it("rangeKeysOf collects the primary and index sort keys, once each", () => {
    expect(
      rangeKeysOf({
        primary: { sk: { field: "sk" } },
        byA: { sk: { field: "gsi1sk" } },
        byB: { sk: { field: "gsi1sk" } },
      }),
    ).toEqual(["sk", "gsi1sk"])
  })
})
