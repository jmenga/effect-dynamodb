import type { TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  DynamoError,
  DynamoValidationError,
  ThrottlingError,
  TransactionCancelled,
  ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, vi } from "vitest"
import * as Entity from "../src/Entity.js"
import {
  batchWriteBodyBytes,
  REQUEST_MAX_BYTES,
  transactionBytes,
  transactWriteBodyBytes,
} from "../src/internal/ItemSize.js"
import {
  batchEntries,
  type Diagnosis,
  diagnosedValidationError,
  diagnoseFailure,
  diagnoseRejection,
  explainDiagnosis,
  keyAttributesOf,
  type SentRead,
  type SentSearch,
  type SentTable,
  type SentWrite,
  targetsFor,
  transactItemTarget,
} from "../src/internal/WriteDiagnosis.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  awsTransactionCanceled,
  awsValidationException,
  DDB_CONSISTENT_GSI_AWS,
  DDB_CONSISTENT_READ_GSI,
  DDB_CONSISTENT_SCAN_GSI,
  DDB_ITEM_SIZE,
  DDB_ITEM_SIZE_UPDATE,
  DDB_PARTITION_KEY_AWS,
  DDB_REPEATED_BATCH_ITEM,
  DDB_REPEATED_ITEM,
  DDB_SORT_KEY_AWS,
  DDB_SORT_KEY_LOCAL,
  DDB_TABLE_KEY_SIZE_LOCAL,
  DDB_TOO_MANY_ITEMS,
  ddbBetweenReversed,
  ddbEmptyIn,
  ddbEmptyIndexKey,
  ddbEmptyTableKey,
  ddbExpressionTooLong,
  ddbMemberOutOfRange,
  ddbPayloadTooLarge,
  ddbTooManyInOperands,
  ddbTooManyOperators,
} from "./helpers/MockDynamoClient.js"
import { makeRecordingTable, tooLargeFailure } from "./helpers/RecordingTable.js"

const tooLargeCause = () => tooLargeFailure("TransactWriteItems").cause

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

const KEYS = { partition: ["pk", "gsi1pk"], sort: ["sk", "gsi1sk"] }

const diagnose = (error: unknown, sent: SentWrite) => diagnoseRejection(error, sent, KEYS)

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
    it("names the one item, with its exact size", () => {
      const item = put("a", 410_000)
      const d = expectTag(diagnose(rejected(DDB_ITEM_SIZE), single(item)), "ItemTooLarge")
      expect(d.target.key).toBe("pk=p#a, sk=s")
      expect(d.target.source).toBe("the item")
      expect(d.bytes).toBe(410_000)
      expect(d.likely).toBe(false)
      expect(explainDiagnosis(d, "put")).toContain("the item of the item, at pk=p#a, sk=s")
    })

    it("the message is the evidence: an item measured under the limit is still named, not likely", () => {
      const d = expectTag(
        diagnose(rejected(DDB_ITEM_SIZE), single(put("a", 400_000))),
        "ItemTooLarge",
      )
      expect(d.likely).toBe(false)
    })
  })

  describe("shape 1 — item size excludes expressions", () => {
    it("a Put's condition counts toward the transaction, not toward its 400 KB", () => {
      const item: TransactWriteItem = {
        Put: {
          ...put("a", 409_600).Put!,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      }
      const d = expectTag(diagnose(rejected(DDB_ITEM_SIZE), single(item)), "ItemTooLarge")
      expect(d.bytes).toBe(409_600)
      expect(explainDiagnosis(d, "put")).toContain(", 409600 bytes by DynamoDB's item-size rules.")
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

    it("none measured over: the largest Put, named as the likely culprit", () => {
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
      expect(
        explainDiagnosis(d, "batchWrite", { committed: "the batch had written nothing before it" }),
      ).toContain("This request wrote nothing; the batch had written nothing before it.")
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

    it("measures exactly, expressions and their substitutions included", () => {
      const conditioned: TransactWriteItem = {
        Put: {
          ...put("a", 1000).Put!,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      }
      const items = [conditioned, update("b", { attr: "v".repeat(500) }), del("c")]
      const d = expectTag(
        diagnose(rejected(ddbPayloadTooLarge(4_200_000)), transaction(items)),
        "TransactionTooLarge",
      )
      // Put: 1,000 + condition 25 + "pk" 2. Update: key 8 + "SET #a0 = :v0" 13
      // + "attr" 4 + 500. Delete: key 8.
      expect(d.measured).toBe(1027 + 525 + 8)
    })

    it("measured over the limit: no disagreement is claimed", () => {
      const items = Array.from({ length: 11 }, (_, i) => put(String(i), 400_000))
      const d = expectTag(
        diagnose(rejected(ddbPayloadTooLarge(4_400_000)), transaction(items)),
        "TransactionTooLarge",
      )
      expect(d.measured).toBe(4_400_000)
      const text = explainDiagnosis(d, "transactWrite")
      expect(text).toContain("the library measures the request at 4400000 bytes")
      expect(text).toContain("running total in request order")
      expect(text).not.toContain("disagrees")
    })

    it("measured within the limit: the error gives both sizes and says the model disagrees", () => {
      const items = [put("a", 4_000_000)]
      const d = expectTag(
        diagnose(rejected(ddbPayloadTooLarge(4_194_305)), transaction(items)),
        "TransactionTooLarge",
      )
      expect(d.measured).toBe(4_000_000)
      expect(d.reported).toBe(4_194_305)
      const text = explainDiagnosis(d, "batchWrite", {
        committed: "the batch's 2 earlier transactions were already written",
      })
      expect(text).toContain("(it reported 4194305 bytes)")
      expect(text).toContain("the library measures the request at 4000000 bytes")
      expect(text).toContain("size model disagrees with DynamoDB's for this request")
      expect(text).toContain(
        "This request wrote nothing; the batch's 2 earlier transactions were already written.",
      )
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
          "KeyTooLong",
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
        expectTag(diagnose(rejected(DDB_SORT_KEY_LOCAL), single(item)), "KeyTooLong").bytes,
      ).toBe(1026)
    })

    it("reads an Update's SET pairs", () => {
      const d = expectTag(
        diagnose(rejected(DDB_SORT_KEY_AWS), single(update("a", { gsi1sk: longKey }))),
        "KeyTooLong",
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
        expectTag(diagnose(error, transaction([put("a"), item])), "KeyTooLong").attribute,
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

  describe("shape 7a — a request body over 16 MB (HTTP 413)", () => {
    /** DynamoDB Local's refusal, as the AWS SDK reports it and the client wraps it. */
    const tooLarge = new DynamoError({ operation: "TransactWriteItems", cause: tooLargeCause() })
    /** Ten Puts of `chars` NULs: 1 byte each by item size, 6 in the JSON body. */
    const nulPuts = (chars: number) =>
      Array.from(
        { length: 10 },
        (_, i): TransactWriteItem => ({
          Put: {
            TableName: "t",
            Item: { pk: { S: `p#${i}` }, sk: { S: "s" }, d: { S: "\u0000".repeat(chars) } },
          },
        }),
      )

    it("a transaction within 4 MB by item size but over 16 MB as JSON is named", () => {
      const items = nulPuts(280_000)
      const d = expectTag(diagnose(tooLarge, transaction(items)), "RequestTooLarge")
      expect(d.request).toBe("TransactWriteItems")
      expect(d.measured).toBe(transactWriteBodyBytes({ TransactItems: items }))
      expect(d.measured).toBeGreaterThan(REQUEST_MAX_BYTES)
      expect(d.itemSize).toBe(transactionBytes(items))
      expect(d.itemSize).toBeLessThan(4_194_304)
      expect(d.largest).toHaveLength(3)
      const text = explainDiagnosis(d, "transactWrite")
      expect(text).toContain("16777216 bytes (16 MB)")
      expect(text).toContain(`at ${d.measured} bytes`)
      expect(text).toContain("\\u0000")
      expect(text).toContain(`the transaction is ${d.itemSize} bytes`)
      expect(text).toContain("Split the operations into smaller transactions.")
    })

    it("a batch request's body is rebuilt from its entries, tables and all", () => {
      const requestItems = {
        a: Array.from({ length: 13 }, (_, i) => ({
          PutRequest: { Item: { pk: { S: `p#${i}` }, d: { S: "\u0000".repeat(115_000) } } },
        })),
        b: Array.from({ length: 12 }, (_, i) => ({
          PutRequest: { Item: { pk: { S: `q#${i}` }, d: { S: "\u0000".repeat(115_000) } } },
        })),
      }
      const items = batchEntries(requestItems)
      const d = expectTag(
        diagnose(tooLarge, { _tag: "Batch", items, targets: () => targets(items) }),
        "RequestTooLarge",
      )
      expect(d.request).toBe("BatchWriteItem")
      expect(d.measured).toBe(batchWriteBodyBytes({ RequestItems: requestItems }))
      expect(explainDiagnosis(d, "batchWrite")).toContain("Write fewer items per request.")
    })

    it("unconfirmed — a 413 whose request measures within the limit passes through", () => {
      expect(diagnose(tooLarge, transaction(nulPuts(270_000)))).toBeUndefined()
      expect(diagnose(tooLarge, transaction([put("a", 100)]))).toBeUndefined()
      // Reads are not measured.
      expect(diagnose(tooLarge, { _tag: "TransactGet", count: 1 })).toBeUndefined()
    })

    it("a ValidationException naming the request size (AWS's documented reason) is confirmed the same way", () => {
      const aws = rejected("The total request size exceeds 16 MB")
      expect(diagnose(aws, transaction(nulPuts(280_000)))?._tag).toBe("RequestTooLarge")
      // Under the limit: not this, and nothing else applies.
      expect(diagnose(aws, transaction(nulPuts(270_000)))).toBeUndefined()
    })

    it("diagnoseFailure rewrites a confirmed 413 and leaves an unconfirmed one as it was", () =>
      Effect.gen(function* () {
        const rewrite = (diagnosis: Diagnosis, original: unknown) =>
          diagnosedValidationError(diagnosis, original, {
            operation: "transactWrite",
            entityType: "Doc",
          })
        const over = yield* Effect.fail(tooLarge).pipe(
          diagnoseFailure({ sent: () => transaction(nulPuts(280_000)), rewrite }),
          Effect.flip,
        )
        expect(over).toBeInstanceOf(ValidationError)
        expect((over as ValidationError).entityType).toBe("Doc")
        expect(((over as ValidationError).cause as Error).cause).toBe(tooLarge)
        const under = yield* Effect.fail(tooLarge).pipe(
          diagnoseFailure({ sent: () => transaction(nulPuts(270_000)), rewrite }),
          Effect.flip,
        )
        expect(under).toBe(tooLarge)
      }).pipe(Effect.runPromise))
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
      keys: () => KEYS,
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

  describe("table key size — DynamoDB Local's wording (#144 S27)", () => {
    it("recognised request-wide and as a cancellation reason, confirmed by the sort key's bytes", () => {
      const long: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p" }, sk: { S: "s".repeat(1025) } } },
      }
      const d = expectTag(diagnose(rejected(DDB_TABLE_KEY_SIZE_LOCAL), single(long)), "KeyTooLong")
      expect(d.attribute).toBe("sk")
      expect(d.bytes).toBe(1025)
      expectTag(
        diagnose(
          cancelled([
            { Code: "None" },
            { Code: "ValidationError", Message: DDB_TABLE_KEY_SIZE_LOCAL },
          ]),
          transaction([put("a"), long]),
        ),
        "KeyTooLong",
      )
    })

    it("a partition key over 2048 bytes: named as the partition key", () => {
      const longPk: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p".repeat(2049) }, sk: { S: "s" } } },
      }
      const d = expectTag(
        diagnose(rejected(DDB_TABLE_KEY_SIZE_LOCAL), single(longPk)),
        "KeyTooLong",
      )
      expect(d.kind).toBe("partition")
      expect(d.attribute).toBe("pk")
      expect(d.bytes).toBe(2049)
      expect(explainDiagnosis(d, "put")).toContain(
        'the partition key "pk" of the item, at pk=' +
          "p".repeat(2049) +
          ", sk=s is 2049 bytes, longer than DynamoDB's 2048-byte limit for a partition key.",
      )
      // 2048 bytes is within the limit: unconfirmed.
      const atLimit: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p".repeat(2048) }, sk: { S: "s" } } },
      }
      expect(diagnose(rejected(DDB_TABLE_KEY_SIZE_LOCAL), single(atLimit))).toBeUndefined()
    })
  })

  describe("one operation per item (P2 / P2a / P2b)", () => {
    it("a transaction naming one item twice: both entries named", () => {
      const d = expectTag(
        diagnose(rejected(DDB_REPEATED_ITEM), transaction([put("a"), put("b"), del("a")])),
        "RepeatedItem",
      )
      expect(d.first.source).toBe("operation 0 (Doc)")
      expect(d.second.source).toBe("operation 2 (Doc)")
      expect(d.batch).toBe(false)
      const text = explainDiagnosis(d, "transactWrite")
      expect(text).toContain(
        "the transaction touches one item more than once — operation 0 (Doc) and operation 2 (Doc) " +
          "both target the item at pk=p#a, sk=s",
      )
      expect(text).toContain("Nothing was written.")
    })

    it("DynamoDB's message on a request with no repeat: passed through", () => {
      expect(
        diagnose(rejected(DDB_REPEATED_ITEM), transaction([put("a"), put("b")])),
      ).toBeUndefined()
    })

    it("a repeat reported as a conditional failure (P2a) is still a repeat — never a lost race", () => {
      const d = expectTag(
        diagnose(
          cancelled([{ Code: "None" }, { Code: "ConditionalCheckFailed" }]),
          transaction([put("a"), put("a")]),
        ),
        "RepeatedItem",
      )
      expect(d.first.source).toBe("operation 0 (Doc)")
      // Without a repeat, a conditional failure stays the site's to explain.
      expect(
        diagnose(
          cancelled([{ Code: "None" }, { Code: "ConditionalCheckFailed" }]),
          transaction([put("a"), put("b")]),
        ),
      ).toBeUndefined()
    })

    it("a batch request naming one item twice (P2b)", () => {
      const items = batchEntries({
        t: [
          { PutRequest: { Item: put("a").Put!.Item! } },
          { DeleteRequest: { Key: del("a").Delete!.Key! } },
        ],
      })
      const d = expectTag(
        diagnose(rejected(DDB_REPEATED_BATCH_ITEM), {
          _tag: "Batch",
          items,
          targets: () => targets(items),
        }),
        "RepeatedItem",
      )
      expect(d.batch).toBe(true)
      expect(explainDiagnosis(d, "batchWrite")).toContain(
        "the batch request touches one item more than once",
      )
    })

    it("a TransactGetItems reading one item twice", () => {
      const keys = [del("a"), del("b"), del("a")]
      const d = expectTag(
        diagnose(rejected(DDB_REPEATED_ITEM), {
          _tag: "TransactGet",
          count: keys.length,
          targets: () => targets(keys),
        }),
        "RepeatedItem",
      )
      expect(d.second.source).toBe("operation 2 (Doc)")
    })

    it("a different table is a different item", () => {
      const a = put("a")
      const other: TransactWriteItem = { Put: { ...a.Put!, TableName: "u" } }
      expect(diagnose(rejected(DDB_REPEATED_ITEM), transaction([a, other]))).toBeUndefined()
    })

    describe("P2a through Transaction.transactWrite on the recording table", () => {
      // The recording table takes a transaction's items in order, as DynamoDB Local does: an
      // item whose condition fails is that item's cancellation reason, and the repeat is never
      // reached (`connected.helper-conformance.test.ts`, "tw: one item: …").
      const Docs = Entity.make({
        model: Schema.Struct({ docId: Schema.String, n: Schema.Number }),
        entityType: "Doc",
        primaryKey: {
          pk: { field: "pk", composite: ["docId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const Main = Table.make({
        schema: DynamoSchema.make({ name: "wd", version: 1 }),
        entities: { Docs },
      })
      const run = (stored: boolean, ops: ReadonlyArray<"create" | "put">) =>
        Effect.gen(function* () {
          const table = makeRecordingTable()
          const layer = Layer.merge(table.layer, Main.layer({ name: "t" }))
          if (stored) yield* Docs.put({ docId: "d", n: 1 }).asEffect().pipe(Effect.provide(layer))
          table.take()
          const error = yield* Transaction.transactWrite(
            ops.map((op, i) =>
              (op === "create" ? Docs.create : Docs.put)({ docId: "d", n: i + 2 }),
            ),
          ).pipe(Effect.flip, Effect.provide(layer))
          const sent = table.take()
          return { error, sent, stored: [...table.items.values()] }
        })

      for (const [label, stored, ops, reasons] of [
        [
          "the first item's condition fails",
          true,
          ["create", "put"],
          "[ConditionalCheckFailed, None]",
        ],
        [
          "the second item's condition fails on what the first wrote",
          false,
          ["put", "create"],
          "[None, ConditionalCheckFailed]",
        ],
      ] as const) {
        it.effect(
          `${label}: the table cancels it; the library names the repeat, sending once`,
          () =>
            Effect.gen(function* () {
              const { error, sent, stored: after } = yield* run(stored, ops)
              expect(sent.map((request) => request.command)).toEqual(["TransactWriteItems"])
              expect(error._tag).toBe("ValidationError")
              const failure = error as ValidationError
              expect(String(failure.cause)).toContain(
                "the transaction touches one item more than once — operation 0 (Doc) and operation 1 (Doc)",
              )
              // What DynamoDB answered is kept: the cancellation, read in order.
              expect(String(((failure.cause as Error).cause as DynamoError).cause)).toContain(
                `Transaction cancelled, please refer cancellation reasons for specific reasons ${reasons}`,
              )
              expect(after.map((item) => item.n)).toEqual(stored ? [{ N: "1" }] : [])
            }),
        )
      }
    })
  })

  describe("expression limits (P3 / P4 / P5)", () => {
    const conditioned = (expression: string): TransactWriteItem => ({
      Put: { ...put("a").Put!, ConditionExpression: expression },
    })
    const ors = (n: number) => Array.from({ length: n }, (_, i) => `#a = :v${i}`).join(" OR ")

    it("a condition over 4,096 characters: its length, and the caller's share", () => {
      const caller = `#a = :${"v".repeat(4100)}`
      const expression = `attribute_not_exists(#pk) AND (${caller})`
      const d = expectTag(
        diagnoseRejection(rejected(ddbExpressionTooLong("Condition", expression.length)), {
          ...single(conditioned(expression)),
          callerCondition: () => caller,
        } as SentWrite),
        "ExpressionTooLarge",
      )
      expect(d.expression).toBe("ConditionExpression")
      expect(d.limit).toBe("length")
      expect(d.measured).toBe(expression.length)
      const text = explainDiagnosis(d, "put")
      expect(text).toContain(`it is ${expression.length} characters, over DynamoDB's limit of 4096`)
      expect(text).toContain(`The .condition() alone is ${caller.length} characters`)
      expect(text).toContain("the library's own guard needs room beside it")
    })

    it("the whole condition the caller's: no guard is blamed", () => {
      const expression = ors(160)
      const d = expectTag(
        diagnoseRejection(rejected(ddbTooManyOperators("Condition")), {
          ...single(conditioned(expression)),
          callerCondition: () => expression,
        } as SentWrite),
        "ExpressionTooLarge",
      )
      expect(d.limit).toBe("operators")
      expect(d.measured).toBe(319)
      const text = explainDiagnosis(d, "delete")
      expect(text).toContain("it holds 319 operators and functions, over DynamoDB's limit of 300")
      expect(text).toContain("Simplify the condition.")
      expect(text).not.toContain("own guard")
    })

    it("an IN over 100 operands", () => {
      const list = Array.from({ length: 101 }, (_, i) => `:v${i}`).join(", ")
      const d = expectTag(
        diagnose(
          rejected(ddbTooManyInOperands("Condition", 101)),
          single(conditioned(`#a IN (${list})`)),
        ),
        "ExpressionTooLarge",
      )
      expect(d.limit).toBe("inOperands")
      expect(d.measured).toBe(101)
    })

    it("an update expression, by its kind; the transaction's first culprit is named", () => {
      const wide = `SET ${Array.from({ length: 301 }, (_, i) => `#a${i} = #a${i} + :v`).join(", ")}`
      const items: Array<TransactWriteItem> = [
        put("a"),
        { Update: { ...update("b").Update!, UpdateExpression: wide } },
      ]
      const d = expectTag(
        diagnose(rejected(ddbTooManyOperators("Update")), transaction(items)),
        "ExpressionTooLarge",
      )
      expect(d.expression).toBe("UpdateExpression")
      expect(d.target.source).toBe("operation 1 (Doc)")
      expect(explainDiagnosis(d, "update")).toContain("Split the update into smaller ones.")
    })

    it("no expression over the limit DynamoDB named: passed through", () => {
      expect(
        diagnose(rejected(ddbExpressionTooLong("Condition", 4097)), single(conditioned("#a = :v"))),
      ).toBeUndefined()
      // The kind matters: a long condition does not confirm an update's rejection.
      expect(
        diagnose(
          rejected(ddbExpressionTooLong("Update")),
          single(conditioned(`#a = :${"v".repeat(4100)}`)),
        ),
      ).toBeUndefined()
    })
  })

  // #171: a Z-order sort key is a binary (`B`) attribute. Its size is its
  // byte length; a long prefix segment can carry it over 1024 bytes.
  describe("a binary (Z-order) sort key", () => {
    const AppSchema = DynamoSchema.make({ name: "app", version: 1 })
    class Listing extends Schema.Class<Listing>("Listing")({
      listingId: Schema.String,
      region: Schema.String,
      agencyId: Schema.String,
      price: Schema.Number,
    }) {}
    const Listings = Entity.make({
      model: Listing,
      entityType: "Listing",
      primaryKey: {
        pk: { field: "pk", composite: ["listingId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byAgency: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["region"] },
          sk: {
            field: "gsi1sk",
            prefix: ["agencyId"],
            zorder: [{ field: "price", min: 0, max: 5_000_000, step: 1_000 }],
          },
        },
      },
    })
    const sortKey = (agencyId: string) =>
      KeyComposer.composeZOrderSk(AppSchema, Listings.indexes.byAgency, {
        agencyId,
        price: 250_000,
      })

    it("over 1024 bytes from a long prefix segment: KeyTooLong, measured in bytes", () => {
      // u16be(1030) ‖ 1030 bytes of text ‖ a 2-byte address: 1034 bytes.
      const bytes = sortKey("a".repeat(1030))
      expect(bytes.length).toBe(1034)
      const item: TransactWriteItem = {
        Put: { TableName: "t", Item: { ...put("a").Put!.Item, gsi1sk: { B: bytes } } },
      }
      for (const message of [DDB_SORT_KEY_LOCAL, DDB_SORT_KEY_AWS]) {
        const d = expectTag(diagnose(rejected(message), single(item)), "KeyTooLong")
        expect(d.attribute).toBe("gsi1sk")
        expect(d.kind).toBe("sort")
        expect(d.bytes).toBe(1034)
        expect(explainDiagnosis(d, "put")).toContain(
          "is 1034 bytes, longer than DynamoDB's 1024-byte limit for a sort key",
        )
      }
      // At the limit: not attributed.
      const fits: TransactWriteItem = {
        Put: {
          TableName: "t",
          Item: { ...put("a").Put!.Item, gsi1sk: { B: sortKey("a".repeat(1020)) } },
        },
      }
      expect(diagnose(rejected(DDB_SORT_KEY_LOCAL), single(fits))).toBeUndefined()
    })

    it("an empty binary key value on a write is EmptyKey", () => {
      const item: TransactWriteItem = {
        Put: {
          TableName: "t",
          Item: { pk: { S: "p#a" }, sk: { S: "s" }, gsi1sk: { B: new Uint8Array(0) } },
        },
      }
      const d = expectTag(
        diagnose(rejected(ddbEmptyIndexKey("gsi1", "gsi1sk")), single(item)),
        "EmptyKey",
      )
      expect(explainDiagnosis(d, "put")).toContain(
        "DynamoDB does not accept an empty string or binary value as a key value",
      )
    })

    it("a binary key names its item in hex", () => {
      const target = transactItemTarget(
        {
          Delete: {
            TableName: "t",
            Key: { pk: { S: "p#a" }, sk: { B: Uint8Array.of(0x00, 0x2a) } },
          },
        },
        "t",
        ["pk", "sk"],
        "Listing",
        "operation 0 (Listing)",
      )
      expect(target.key).toBe("pk=p#a, sk=0x002a")
    })
  })

  describe("an empty key value on a write (P11)", () => {
    it("names the item, the attribute and the index DynamoDB named", () => {
      const item: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p#a" }, sk: { S: "s" }, lsi1sk: { S: "" } } },
      }
      const d = expectTag(
        diagnose(rejected(ddbEmptyIndexKey("lsi1", "lsi1sk")), transaction([put("b"), item])),
        "EmptyKey",
      )
      expect(d.attribute).toBe("lsi1sk")
      expect(d.index).toBe("lsi1")
      expect(d.target.source).toBe("operation 1 (Doc)")
      expect(explainDiagnosis(d, "put")).toContain(
        'it writes an empty value to the key attribute "lsi1sk" of index "lsi1"',
      )
    })

    it("a table key", () => {
      const item: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p" }, sk: { S: "" } } },
      }
      const d = expectTag(diagnose(rejected(ddbEmptyTableKey("sk")), single(item)), "EmptyKey")
      expect(d.index).toBeUndefined()
    })

    it("no empty value for that attribute in the request: passed through", () => {
      expect(
        diagnose(rejected(ddbEmptyIndexKey("lsi1", "lsi1sk")), single(put("a"))),
      ).toBeUndefined()
    })
  })

  describe("reads (P7 / P8 / P10)", () => {
    const read = (input: SentRead["input"], scan = false): SentRead => ({
      _tag: "Read",
      scan,
      input,
    })
    const query = (condition: string, values: Record<string, string>, index?: string) =>
      read({
        IndexName: index,
        KeyConditionExpression: condition,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "lsi1sk" },
        ExpressionAttributeValues: Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, { S: v }]),
        ),
      })
    const queryRejected = (message: string) =>
      new DynamoValidationError({ operation: "Query", cause: awsValidationException(message) })

    it("a consistent read of a GSI: a query or a scan", () => {
      const d = expectTag(
        diagnoseRejection(
          queryRejected(DDB_CONSISTENT_READ_GSI),
          read({ IndexName: "gsi1", ConsistentRead: true }),
        ),
        "ConsistentReadOnGsi",
      )
      expect(d.index).toBe("gsi1")
      expect(explainDiagnosis(d, "query")).toContain(
        'index "gsi1" is a global secondary index, which DynamoDB reads only eventually consistently',
      )
      expectTag(
        diagnoseRejection(
          queryRejected(DDB_CONSISTENT_SCAN_GSI),
          read({ IndexName: "gsi1", ConsistentRead: true }, true),
        ),
        "ConsistentReadOnGsi",
      )
      expectTag(
        diagnoseRejection(
          queryRejected(DDB_CONSISTENT_GSI_AWS),
          read({ IndexName: "gsi1", ConsistentRead: true }),
        ),
        "ConsistentReadOnGsi",
      )
      // Not a consistent read, or of the table: unconfirmed.
      expect(
        diagnoseRejection(queryRejected(DDB_CONSISTENT_READ_GSI), read({ IndexName: "gsi1" })),
      ).toBeUndefined()
      expect(
        diagnoseRejection(queryRejected(DDB_CONSISTENT_READ_GSI), read({ ConsistentRead: true })),
      ).toBeUndefined()
    })

    it("an empty key bound, under begins_with, BETWEEN or a comparison", () => {
      for (const [condition, values] of [
        ["#pk = :pk AND begins_with(#sk, :sk)", { ":pk": "p", ":sk": "" }],
        ["#pk = :pk AND #sk BETWEEN :sk1 AND :sk2", { ":pk": "p", ":sk1": "", ":sk2": "b" }],
        ["#pk = :pk AND #sk >= :sk", { ":pk": "p", ":sk": "" }],
      ] as const) {
        const d = expectTag(
          diagnoseRejection(
            queryRejected(ddbEmptyIndexKey("lsi1", "lsi1sk")),
            query(condition, values, "lsi1"),
          ),
          "EmptyKeyBound",
        )
        expect(d.attribute).toBe("lsi1sk")
        expect(d.index).toBe("lsi1")
      }
      // No empty value on the attribute DynamoDB named: unconfirmed.
      expect(
        diagnoseRejection(
          queryRejected(ddbEmptyIndexKey("lsi1", "lsi1sk")),
          query("#pk = :pk AND begins_with(#sk, :sk)", { ":pk": "p", ":sk": "a" }, "lsi1"),
        ),
      ).toBeUndefined()
    })

    it("a reversed BETWEEN, confirmed in DynamoDB's UTF-8 order", () => {
      const between = "#pk = :pk AND #sk BETWEEN :sk1 AND :sk2"
      const d = expectTag(
        diagnoseRejection(
          queryRejected(ddbBetweenReversed("b", "a")),
          query(between, { ":pk": "p", ":sk1": "b", ":sk2": "a" }),
        ),
        "BetweenReversed",
      )
      expect([d.low, d.high, d.attribute]).toEqual(["b", "a", "lsi1sk"])
      // "￿" sorts before "\u{1F600}" by UTF-8 (after it by UTF-16): in order.
      expect(
        diagnoseRejection(
          queryRejected(ddbBetweenReversed("x", "y")),
          query(between, { ":pk": "p", ":sk1": "￿", ":sk2": "\u{1F600}" }),
        ),
      ).toBeUndefined()
      expectTag(
        diagnoseRejection(
          queryRejected(ddbBetweenReversed("x", "y")),
          query(between, { ":pk": "p", ":sk1": "\u{1F600}", ":sk2": "￿" }),
        ),
        "BetweenReversed",
      )
    })

    // #171: a Z-order sort key is binary — an empty one is refused like an
    // empty string, and BETWEEN operands are named in hex.
    const binaryQuery = (condition: string, values: Record<string, Uint8Array | string>) =>
      read({
        IndexName: "gsi1",
        KeyConditionExpression: condition,
        ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
        ExpressionAttributeValues: Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? { S: v } : { B: v }]),
        ),
      })

    it("an empty binary key bound (#171)", () => {
      const d = expectTag(
        diagnoseRejection(
          queryRejected(ddbEmptyIndexKey("gsi1", "gsi1sk")),
          binaryQuery("#pk = :pk AND #sk >= :sk", { ":pk": "p", ":sk": new Uint8Array(0) }),
        ),
        "EmptyKeyBound",
      )
      expect(d.attribute).toBe("gsi1sk")
      expect(explainDiagnosis(d, "query")).toContain(
        'compares the key attribute "gsi1sk" of index "gsi1" with an empty string or binary ' +
          "value, which DynamoDB does not accept as a key value",
      )
    })

    it("a reversed binary BETWEEN, named in hex, compared by bytes (#171)", () => {
      const between = "#pk = :pk AND #sk BETWEEN :sk1 AND :sk2"
      const d = expectTag(
        diagnoseRejection(
          queryRejected(ddbBetweenReversed("x", "y")),
          binaryQuery(between, {
            ":pk": "p",
            ":sk1": Uint8Array.of(0x01, 0x00),
            ":sk2": Uint8Array.of(0x00, 0xff, 0xff),
          }),
        ),
        "BetweenReversed",
      )
      expect([d.low, d.high]).toEqual(["0x0100", "0x00ffff"])
      // A shorter prefix sorts first: in order.
      expect(
        diagnoseRejection(
          queryRejected(ddbBetweenReversed("x", "y")),
          binaryQuery(between, {
            ":pk": "p",
            ":sk1": Uint8Array.of(0x01),
            ":sk2": Uint8Array.of(0x01, 0x00),
          }),
        ),
      ).toBeUndefined()
    })

    it("a write's message on a read, or a read's on a write: passed through", () => {
      expect(
        diagnoseRejection(queryRejected(DDB_ITEM_SIZE), read({ IndexName: "gsi1" })),
      ).toBeUndefined()
      expect(diagnose(rejected(DDB_CONSISTENT_READ_GSI), single(put("a")))).toBeUndefined()
    })
  })

  describe("vector-index limits on CreateTable / UpdateTable (AWS quotas; no DynamoDB Local support)", () => {
    const vectorIndex = (name: string, filters: number) => ({
      IndexName: name,
      SearchSchema: [
        { AttributeName: "__edd_vp__", SearchSchemaElementType: "HASH" },
        ...Array.from({ length: filters }, (_, i) => ({
          AttributeName: `f${i}`,
          SearchSchemaElementType: "INLINE_FILTER",
        })),
      ],
    })
    const table = (
      operation: "CreateTable" | "UpdateTable",
      indexes: ReadonlyArray<ReturnType<typeof vectorIndex>>,
      declared = indexes.length,
      existing?: number,
    ): SentTable => ({
      _tag: "Table",
      operation,
      vectorIndexes: indexes,
      sharers: (name) => (name === "vec1" ? ["Product", "Article"] : ["Product"]),
      declared,
      existing,
    })
    const tableRejected = (message: string, name = "ValidationException") =>
      new DynamoValidationError({
        operation: "CreateTable",
        cause: Object.assign(new Error(message), { name }),
      })

    it("too many inline filters: the index, its filters and its sharers", () => {
      const d = expectTag(
        diagnoseRejection(
          tableRejected("Vector index vec1 exceeds the maximum number of inline filter attributes"),
          table("CreateTable", [vectorIndex("vec0", 3), vectorIndex("vec1", 19)]),
        ),
        "VectorIndexFilters",
      )
      expect(d.index).toBe("vec1")
      expect(d.filters).toHaveLength(19)
      expect(d.sharers).toEqual(["Product", "Article"])
      const text = explainDiagnosis(d, 'db.tables create of "t"')
      expect(text).toContain('DynamoDB rejected vector index "vec1": it declares 19 INLINE_FILTER')
      expect(text).toContain("(Product, Article)")
      expect(text).toContain("The table was not created.")
      // No index over 18 filters in the request: unconfirmed.
      expect(
        diagnoseRejection(
          tableRejected("Vector index exceeds the maximum number of inline filters"),
          table("CreateTable", [vectorIndex("vec0", 18)]),
        ),
      ).toBeUndefined()
    })

    it("too many vector indexes on CreateTable: confirmed by count, the stated quota honoured", () => {
      const six = Array.from({ length: 6 }, (_, i) => vectorIndex(`vec${i}`, 1))
      const d = expectTag(
        diagnoseRejection(
          tableRejected("Too many vector indexes: limit exceeded", "LimitExceededException"),
          table("CreateTable", six),
        ),
        "VectorIndexCount",
      )
      expect(d.indexes).toHaveLength(6)
      expect(explainDiagnosis(d, "create")).toContain(
        "the quota is adjustable through AWS Service Quotas",
      )
      // A raised quota: six indexes are within a stated limit of 8, so unconfirmed.
      expect(
        diagnoseRejection(
          tableRejected("Vector index limit of 8 exceeded"),
          table("CreateTable", six),
        ),
      ).toBeUndefined()
      // Five, the default quota: unconfirmed without a stated lower limit.
      expect(
        diagnoseRejection(
          tableRejected("Vector index limit exceeded"),
          table("CreateTable", six.slice(0, 5)),
        ),
      ).toBeUndefined()
    })

    it("too many vector indexes on UpdateTable: confirmed by the indexes the table already has", () => {
      const d = expectTag(
        diagnoseRejection(
          tableRejected("Vector index limit exceeded for table"),
          table("UpdateTable", [vectorIndex("vec2", 1)], 6, 5),
        ),
        "VectorIndexCount",
      )
      const text = explainDiagnosis(d, 'addVectorIndex("vec2")')
      expect(text).toContain('adding vector index "vec2" (Product)')
      expect(text).toContain("the table already has 5 vector indexes")
      expect(text).toContain("declare 6 in all")
      expect(text).toContain("Nothing was changed.")
      // Room under the default quota of 5: unconfirmed.
      expect(
        diagnoseRejection(
          tableRejected("Vector index limit exceeded for table"),
          table("UpdateTable", [vectorIndex("vec2", 1)], 6, 2),
        ),
      ).toBeUndefined()
      // The table's indexes could not be read back: unconfirmed.
      expect(
        diagnoseRejection(
          tableRejected("Vector index limit exceeded for table"),
          table("UpdateTable", [vectorIndex("vec2", 1)], 6),
        ),
      ).toBeUndefined()
    })

    it("UpdateTable limits that are not the per-table count: passed through", () => {
      // Another vector index is still being created: a concurrency limit,
      // whose stated "1" would otherwise read as a quota of one.
      expect(
        diagnoseRejection(
          tableRejected(
            "Subscriber limit exceeded: Only 1 vector index can be created or deleted " +
              "simultaneously per table",
            "LimitExceededException",
          ),
          table("UpdateTable", [vectorIndex("vec2", 1)], 2, 1),
        ),
      ).toBeUndefined()
      // A name too long.
      expect(
        diagnoseRejection(
          tableRejected("Vector index name exceeds maximum length of 255 characters"),
          table("UpdateTable", [vectorIndex("vec2", 1)], 6, 5),
        ),
      ).toBeUndefined()
    })

    it("a rejection not about vector indexes: passed through", () => {
      expect(
        diagnoseRejection(
          tableRejected("Limit exceeded for GSIs"),
          table("CreateTable", [vectorIndex("vec0", 19)]),
        ),
      ).toBeUndefined()
    })
  })

  describe("partition key over 2048 bytes (#144)", () => {
    const longGsiPk: TransactWriteItem = {
      Put: {
        TableName: "t",
        Item: { pk: { S: "p" }, sk: { S: "s" }, gsi1pk: { S: "g".repeat(2049) } },
      },
    }

    it("an index partition key under DynamoDB Local's index wording, request-wide in a transaction", () => {
      const d = expectTag(
        diagnose(rejected(DDB_SORT_KEY_LOCAL), transaction([put("a"), longGsiPk])),
        "KeyTooLong",
      )
      expect(d.kind).toBe("partition")
      expect(d.attribute).toBe("gsi1pk")
      expect(d.target.source).toBe("operation 1 (Doc)")
    })

    it("AWS's partition-key wording confirms only a partition key", () => {
      expect(
        expectTag(diagnose(rejected(DDB_PARTITION_KEY_AWS), single(longGsiPk)), "KeyTooLong").kind,
      ).toBe("partition")
      // A long sort key is not what AWS's partition-key message means.
      const longSk: TransactWriteItem = {
        Put: { TableName: "t", Item: { pk: { S: "p" }, sk: { S: "s".repeat(1025) } } },
      }
      expect(diagnose(rejected(DDB_PARTITION_KEY_AWS), single(longSk))).toBeUndefined()
      // Nor is a long partition key what AWS's sort-key message means.
      expect(diagnose(rejected(DDB_SORT_KEY_AWS), single(longGsiPk))).toBeUndefined()
    })

    it("a table partition key in a cancellation reason, and an update's key", () => {
      const longKey = "p".repeat(2049)
      const updateLong: TransactWriteItem = {
        Update: {
          TableName: "t",
          Key: { pk: { S: longKey }, sk: { S: "s" } },
          UpdateExpression: "SET #n = :n",
          ExpressionAttributeNames: { "#n": "n" },
          ExpressionAttributeValues: { ":n": { S: "1" } },
        },
      }
      const d = expectTag(
        diagnose(
          cancelled([
            { Code: "None" },
            { Code: "ValidationError", Message: DDB_TABLE_KEY_SIZE_LOCAL },
          ]),
          transaction([put("a"), updateLong]),
        ),
        "KeyTooLong",
      )
      expect(d.kind).toBe("partition")
      expect(d.target.source).toBe("operation 1 (Doc)")
      // An update SETting an index partition key (DynamoDB Local accepts it; AWS does not).
      expect(
        expectTag(
          diagnose(rejected(DDB_SORT_KEY_LOCAL), single(update("a", { gsi1pk: longKey }))),
          "KeyTooLong",
        ).attribute,
      ).toBe("gsi1pk")
    })

    it("a batch: the request named, with what the batch had already written", () => {
      const items = [put("a"), longGsiPk]
      const d = expectTag(
        diagnose(rejected(DDB_SORT_KEY_LOCAL), {
          _tag: "Batch",
          items,
          targets: () => targets(items),
        }),
        "KeyTooLong",
      )
      expect(
        explainDiagnosis(d, "batchWrite", { committed: "the batch had written 25 requests" }),
      ).toContain("This request wrote nothing; the batch had written 25 requests.")
    })
  })

  describe("an isIn() with no values: IN () (P14)", () => {
    const conditioned = (expression: string): TransactWriteItem => ({
      Put: {
        ...put("a").Put!,
        ConditionExpression: expression,
        ExpressionAttributeNames: { "#e0": "status", "#e1": "meta" },
      },
    })

    it("in a write's condition: the item and the attribute named", () => {
      const d = expectTag(
        diagnose(
          rejected(ddbEmptyIn("Condition", "())")),
          single(conditioned("attribute_not_exists(#e1) AND (#e1.#e0 IN ())")),
        ),
        "EmptyIn",
      )
      expect(d.attribute).toBe("meta.status")
      expect(
        expectTag(
          diagnose(
            rejected(ddbEmptyIn("Condition", "() AND")),
            single(conditioned("size(#e0) IN () AND #e1 = :v")),
          ),
          "EmptyIn",
        ).attribute,
      ).toBe("size(status)")
      expect(d.expression).toBe("ConditionExpression")
      const text = explainDiagnosis(d, "put")
      expect(text).toContain('isIn() on "meta.status" in its condition has no values')
      expect(text).toContain("Nothing was written.")
    })

    it("request-wide in a transaction: the entry holding it named", () => {
      const d = expectTag(
        diagnose(
          rejected(ddbEmptyIn("Condition")),
          transaction([put("z"), conditioned("#e0 IN ()")]),
        ),
        "EmptyIn",
      )
      expect(d.target?.source).toBe("operation 1 (Doc)")
    })

    it("in a read's filter", () => {
      const read: SentRead = {
        _tag: "Read",
        scan: true,
        input: { FilterExpression: "#e0 IN ()", ExpressionAttributeNames: { "#e0": "status" } },
      }
      const d = expectTag(diagnoseRejection(rejected(ddbEmptyIn("Filter")), read), "EmptyIn")
      expect(d.target).toBeUndefined()
      expect(explainDiagnosis(d, "query of Doc")).toContain(
        'DynamoDB rejected the filter: isIn() on "status" has no values',
      )
    })

    it("no IN () in the request, or the other expression kind: passed through", () => {
      expect(
        diagnose(rejected(ddbEmptyIn("Condition")), single(conditioned("#e0 IN (:v)"))),
      ).toBeUndefined()
      expect(
        diagnose(rejected(ddbEmptyIn("Filter")), single(conditioned("#e0 IN ()"))),
      ).toBeUndefined()
      const read: SentRead = {
        _tag: "Read",
        scan: false,
        input: { FilterExpression: "#e0 = :v", ExpressionAttributeNames: { "#e0": "status" } },
      }
      expect(diagnoseRejection(rejected(ddbEmptyIn("Filter")), read)).toBeUndefined()
    })
  })

  describe("vector dimensions and TopK (AWS's documented ranges; no DynamoDB Local support)", () => {
    const vectorTable = (dimensions: ReadonlyArray<number>): SentTable => ({
      _tag: "Table",
      operation: "CreateTable",
      vectorIndexes: dimensions.map((Dimensions, i) => ({
        IndexName: `vec${i}`,
        Dimensions,
        SearchSchema: [{ AttributeName: "__edd_vp__", SearchSchemaElementType: "HASH" }],
      })),
      sharers: () => ["Product", "Article"],
      declared: dimensions.length,
    })

    it("dimensions outside 1..4096: the index, its dimensions and its sharers", () => {
      const d = expectTag(
        diagnoseRejection(
          rejected(
            ddbMemberOutOfRange(
              5000,
              "vectorIndexes.2.member.dimensions",
              "less than or equal to 4096",
            ),
          ),
          vectorTable([1536, 5000]),
        ),
        "VectorIndexDimensions",
      )
      expect(d.index).toBe("vec1")
      expect(d.dimensions).toBe(5000)
      const text = explainDiagnosis(d, 'db.tables create of "t"')
      expect(text).toContain('DynamoDB rejected vector index "vec1": its dimensions (5000)')
      expect(text).toContain("1..4096")
      expect(text).toContain("(Product, Article)")
      expect(text).toContain("The table was not created.")
      expect(
        expectTag(
          diagnoseRejection(rejected("Dimensions must be at least 1"), vectorTable([0])),
          "VectorIndexDimensions",
        ).dimensions,
      ).toBe(0)
    })

    it("every index within range: passed through", () => {
      expect(
        diagnoseRejection(rejected("Invalid dimensions"), vectorTable([1, 4096])),
      ).toBeUndefined()
    })

    it("a TopK outside 1..100, or not an integer: named", () => {
      const search = (topK: number): SentSearch => ({ _tag: "Search", index: "vec1", topK })
      const message = ddbMemberOutOfRange(500, "topK", "less than or equal to 100")
      const d = expectTag(diagnoseRejection(rejected(message), search(500)), "TopKOutOfRange")
      const text = explainDiagnosis(d, "vectorSearch.byDescription")
      expect(text).toContain('search of vector index "vec1": topK(500) is outside')
      expect(text).toContain("an integer in 1..100")
      expectTag(diagnoseRejection(rejected(message), search(0)), "TopKOutOfRange")
      expectTag(diagnoseRejection(rejected(message), search(2.5)), "TopKOutOfRange")
      // Within range: unconfirmed.
      expect(diagnoseRejection(rejected(message), search(100))).toBeUndefined()
      // A rejection not about TopK: passed through.
      expect(diagnoseRejection(rejected("Something else"), search(500))).toBeUndefined()
    })
  })

  describe("BatchGetItem repeating a key (P2b)", () => {
    it("both reads named", () => {
      const key = { pk: { S: "p#a" }, sk: { S: "s" } }
      const target = (source: string) =>
        targetsFor(
          [{ Delete: { TableName: "t", Key: key } }],
          ["pk", "sk"],
          "Doc",
          () => source,
        )[0]!
      const d = expectTag(
        diagnose(rejected(DDB_REPEATED_BATCH_ITEM), {
          _tag: "BatchGet",
          targets: () => [target("get 0 (Doc)"), target("get 3 (Doc)")],
        }),
        "RepeatedItem",
      )
      expect(d.first.source).toBe("get 0 (Doc)")
      expect(d.second.source).toBe("get 3 (Doc)")
      expect(
        diagnose(rejected(DDB_REPEATED_BATCH_ITEM), {
          _tag: "BatchGet",
          targets: () => [target("get 0 (Doc)")],
        }),
      ).toBeUndefined()
    })
  })

  describe("diagnoseFailure — only", () => {
    it.effect("rewrites only the diagnoses named; any other passes through", () =>
      Effect.gen(function* () {
        const rewrite = (diagnosis: Diagnosis, original: unknown) =>
          diagnosedValidationError(diagnosis, original, { operation: "op", entityType: "Doc" })
        const sent = () => transaction([put("a"), put("a", 500_000)])
        const repeat = rejected(DDB_REPEATED_ITEM)
        const repeated = yield* Effect.fail(repeat).pipe(
          diagnoseFailure({ sent, only: ["RepeatedItem"], rewrite }),
          Effect.flip,
        )
        expect(repeated).toBeInstanceOf(ValidationError)
        const size = rejected(DDB_ITEM_SIZE)
        const passed = yield* Effect.fail(size).pipe(
          diagnoseFailure({ sent, only: ["RepeatedItem"], rewrite }),
          Effect.flip,
        )
        expect(passed).toBe(size)
      }),
    )
  })

  it("keyAttributesOf collects the primary and index keys by kind, once each", () => {
    expect(
      keyAttributesOf({
        primary: { pk: { field: "pk" }, sk: { field: "sk" } },
        byA: { pk: { field: "gsi1pk" }, sk: { field: "gsi1sk" } },
        byB: { pk: { field: "gsi1pk" }, sk: { field: "gsi1sk" } },
      }),
    ).toEqual({ partition: ["pk", "gsi1pk"], sort: ["sk", "gsi1sk"] })
  })
})
