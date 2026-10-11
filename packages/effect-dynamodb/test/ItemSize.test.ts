import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "vitest"
import {
  attributeBytes,
  expressionBytes,
  ITEM_MAX_BYTES,
  itemBytes,
  numberBytes,
  TRANSACT_WRITE_MAX_BYTES,
  transactItemBytes,
  transactionBytes,
} from "../src/internal/ItemSize.js"

// Every expected size below was measured on DynamoDB Local (2026-10-10) from
// the "Payload Size" its 4 MB transaction rejection reports.

describe("ItemSize — exact DynamoDB size accounting (#144)", () => {
  describe("limits", () => {
    it("are DynamoDB's binary units, exactly", () => {
      expect(ITEM_MAX_BYTES).toBe(409_600)
      expect(TRANSACT_WRITE_MAX_BYTES).toBe(4_194_304)
    })
  })

  describe("N — base-100 digit pairs aligned to the decimal point", () => {
    const measured: ReadonlyArray<readonly [string, number]> = [
      ["0", 1],
      ["1", 2],
      ["9", 2],
      ["10", 2],
      ["12", 2],
      ["99", 2],
      ["100", 2],
      ["1000", 2],
      ["1200", 2],
      ["1000000", 2],
      ["1e10", 2],
      ["0.5", 2],
      ["0.05", 2],
      ["0.001", 2],
      ["0.0012", 2],
      ["1E-10", 2],
      ["9.9E+125", 2],
      ["101", 3],
      ["120", 3],
      ["123", 3],
      ["1001", 3],
      ["1234", 3],
      ["1.5", 3],
      ["12.34", 3],
      ["10.01", 3],
      ["12345", 4],
      ["123456", 4],
      ["1.234", 4],
      ["-123", 4],
      ["-1", 3],
      ["-0.000001", 3],
      ["1234567890123456789012345678901234567", 20],
      ["12345678901234567890123456789012345678", 20],
      // Negative at 19 pairs: the sign byte counts.
      ["-123456789012345678901234567890123456.78", 21],
      ["-12345678901234567890123456789012345678", 21],
      ["-1234567890123456789012345678901234567", 21],
      // Negative at the maximum 20 pairs: no sign byte — 21 bytes, not 22.
      ["9.9999999999999999999999999999999999999", 21],
      ["-9.9999999999999999999999999999999999999", 21],
      ["-1.2345678901234567890123456789012345678", 21],
      ["-12345678901234567890123456789012345.678", 21],
    ]

    it.each(measured)("%s → %i bytes", (n, bytes) => {
      expect(numberBytes(n)).toBe(bytes)
      expect(attributeBytes({ N: n })).toBe(bytes)
    })

    it("zero in any spelling is one byte", () => {
      for (const n of ["0", "-0", "0.000", "-0.000", "0e5", "+0"]) expect(numberBytes(n)).toBe(1)
    })

    it("a leading plus sign and surrounding zeros change nothing", () => {
      expect(numberBytes("+120")).toBe(3)
      expect(numberBytes("00120.000")).toBe(3)
      expect(numberBytes("1.20e2")).toBe(3)
    })
  })

  describe("scalar and set types", () => {
    const measured: ReadonlyArray<readonly [string, AttributeValue, number]> = [
      ["S, ASCII", { S: "hello" }, 5],
      ["S, UTF-8 (2-byte é)", { S: "é" }, 2],
      ["S, UTF-8 (4-byte emoji)", { S: "\u{1F600}" }, 4],
      ["S, empty", { S: "" }, 0],
      ["B", { B: new Uint8Array(10) }, 10],
      ["BOOL true", { BOOL: true }, 1],
      ["BOOL false", { BOOL: false }, 1],
      ["NULL", { NULL: true }, 1],
      ["SS: element bytes, no overhead", { SS: ["a", "bé"] }, 4],
      ["NS: element number sizes, no overhead", { NS: ["1", "120"] }, 5],
      ["BS: element byte lengths, no overhead", { BS: [new Uint8Array(3), new Uint8Array(4)] }, 7],
      ["L, empty", { L: [] }, 3],
      ["L: 3 + Σ(size + 1)", { L: [{ N: "1" }, { BOOL: true }, { NULL: true }] }, 3 + 3 + 2 + 2],
      ["M, empty", { M: {} }, 3],
      ["M: 3 + Σ(name + size + 1)", { M: { ab: { S: "xyz" } } }, 3 + 2 + 3 + 1],
    ]

    it.each(measured)("%s", (_label, value, bytes) => {
      expect(attributeBytes(value)).toBe(bytes)
    })
  })

  describe("items", () => {
    it("an item is Σ utf8(name) + size(value), with no per-item or per-attribute overhead", () => {
      expect(itemBytes({})).toBe(0)
      expect(itemBytes({ pk: { S: "abcd" } })).toBe(6)
      expect(itemBytes({ é: { S: "é" } })).toBe(4)
    })

    it("a mixed item measures as DynamoDB Local measured it: 57 bytes", () => {
      const item: Record<string, AttributeValue> = {
        pk: { S: "m1" },
        n: { N: "-12.345" },
        m: {
          M: {
            list: { L: [{ N: "1" }, { BOOL: true }, { NULL: true }] },
            s: { S: "é" },
          },
        },
        ss: { SS: ["a", "bé"] },
        ns: { NS: ["1", "120"] },
        bs: { BS: [new Uint8Array(3)] },
        b: { B: new Uint8Array(5) },
      }
      expect(itemBytes(item)).toBe(57)
    })

    it("nested lists and maps carry their overhead at every level: 35 bytes on Local", () => {
      const item: Record<string, AttributeValue> = {
        pk: { S: "m3" },
        l: {
          L: [{ L: [{ S: "ab" }, { M: {} }] }, { L: [] }, { M: { z: { L: [{ N: "0.0012" }] } } }],
        },
      }
      expect(itemBytes(item)).toBe(35)
    })

    it("a map-heavy item counts +1 per entry — the old upper bound under-counted it", () => {
      // 200 entries, each a map of two entries: 600 map entries in all. Local
      // measured 3,081 bytes. The old "upper" estimate added 3 per map but no
      // +1 per entry, and came out 600 bytes short — under the true size,
      // which an upper bound must never be.
      const item: Record<string, AttributeValue> = {
        pk: { S: "m2" },
        m: {
          M: Object.fromEntries(
            Array.from({ length: 200 }, (_, i) => [
              `k${i}`,
              { M: { a: { S: "x" }, b: { N: String(i * 7) } } },
            ]),
          ),
        },
      }
      expect(itemBytes(item)).toBe(3081)
    })

    it("boundary items: 409,600 bytes is at the limit, 409,601 over it", () => {
      // pk (2) + "p" (1) + d (1) = 4 bytes besides d's value.
      const at = { pk: { S: "p" }, d: { S: "x".repeat(ITEM_MAX_BYTES - 4) } }
      const over = { pk: { S: "p" }, d: { S: "x".repeat(ITEM_MAX_BYTES - 3) } }
      expect(itemBytes(at)).toBe(409_600)
      expect(itemBytes(over)).toBe(409_601)
      expect(itemBytes(at) <= ITEM_MAX_BYTES).toBe(true)
      expect(itemBytes(over) <= ITEM_MAX_BYTES).toBe(false)
    })
  })

  describe("expressions", () => {
    it("count their UTF-8 length as written", () => {
      expect(expressionBytes("attribute_exists(pk)", undefined, undefined)).toBe(20)
      expect(expressionBytes(undefined, undefined, undefined)).toBe(0)
    })

    it("add the substituted name for every occurrence", () => {
      // "attribute_exists(#pppp)" is 23, "#pppp" → "e" adds 1.
      expect(expressionBytes("attribute_exists(#pppp)", { "#pppp": "e" }, undefined)).toBe(24)
      // A name used twice counts twice: 44 + 2 × 10.
      const expr = "attribute_exists(#p) OR attribute_exists(#p)"
      expect(expr.length).toBe(44)
      expect(expressionBytes(expr, { "#p": "eeeeeeeeee" }, undefined)).toBe(64)
    })

    it("add the substituted value's size for every occurrence", () => {
      // "e = :v OR f = :v" is 16, :v (10 bytes) counted twice.
      expect(expressionBytes("e = :v OR f = :v", undefined, { ":v": { S: "x".repeat(10) } })).toBe(
        36,
      )
      // A number substitutes its number size: 6 + 3.
      expect(expressionBytes("q = :q", undefined, { ":q": { N: "123" } })).toBe(9)
    })

    it("an undefined placeholder adds nothing", () => {
      expect(expressionBytes("#x = :y", {}, {})).toBe(7)
    })
  })

  describe("transaction actions", () => {
    const key = { pk: { S: "abcd" } } // 6 bytes

    it("a Put counts its item, and its condition with its substitutions", () => {
      const plain: TransactWriteItem = { Put: { TableName: "t", Item: key } }
      expect(transactItemBytes(plain)).toBe(6)
      expect(
        transactItemBytes({
          Put: { TableName: "t", Item: key, ConditionExpression: "attribute_exists(pk)" },
        }),
      ).toBe(6 + 20)
    })

    it("Batch.write's create-only versioned put: 34 bytes on Local for a 7-byte item", () => {
      expect(
        transactItemBytes({
          Put: {
            TableName: "t",
            Item: { pk: { S: "m4" }, v: { N: "1" } },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        }),
      ).toBe(34)
    })

    it("a Delete and a ConditionCheck count their key and condition — never the stored item", () => {
      expect(transactItemBytes({ Delete: { TableName: "t", Key: key } })).toBe(6)
      expect(
        transactItemBytes({
          ConditionCheck: {
            TableName: "t",
            Key: key,
            ConditionExpression: "q = :q",
            ExpressionAttributeValues: { ":q": { N: "123" } },
          },
        }),
      ).toBe(6 + 9)
    })

    it("an Update counts its key and expressions — never the stored or resulting item", () => {
      // SET a = :v with a 100-byte value: key + 10 + 100.
      expect(
        transactItemBytes({
          Update: {
            TableName: "t",
            Key: key,
            UpdateExpression: "SET a = :v",
            ExpressionAttributeValues: { ":v": { S: "x".repeat(100) } },
          },
        }),
      ).toBe(6 + 10 + 100)
      // Update + condition sharing one value: 6 + 10 + 6 + 100 + 100 = 222.
      expect(
        transactItemBytes({
          Update: {
            TableName: "t",
            Key: key,
            UpdateExpression: "SET a = :v",
            ConditionExpression: "b = :v",
            ExpressionAttributeValues: { ":v": { S: "x".repeat(100) } },
          },
        }),
      ).toBe(222)
      expect(
        transactItemBytes({ Update: { TableName: "t", Key: key, UpdateExpression: "REMOVE a" } }),
      ).toBe(6 + 8)
    })

    it("a multi-clause Update with a condition: 113 bytes on Local", () => {
      expect(
        transactItemBytes({
          Update: {
            TableName: "t",
            Key: { pk: { S: "m5" } },
            UpdateExpression: "SET #a = :a, #b = :a ADD #c :n",
            ConditionExpression: "attribute_not_exists(#a) OR #a < :n",
            ExpressionAttributeNames: { "#a": "alpha", "#b": "beta", "#c": "gamma" },
            ExpressionAttributeValues: { ":a": { M: { q: { S: "zz" } } }, ":n": { N: "123" } },
          },
        }),
      ).toBe(113)
    })

    it("TableName and ReturnValuesOnConditionCheckFailure add nothing", () => {
      expect(
        transactItemBytes({
          Put: {
            TableName: "a-very-long-table-name-that-would-count-if-it-did",
            Item: key,
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        }),
      ).toBe(6)
    })

    it("a transaction is the sum of its actions", () => {
      const items: ReadonlyArray<TransactWriteItem> = [
        { Put: { TableName: "t", Item: key } },
        { Delete: { TableName: "t", Key: key } },
        { Update: { TableName: "t", Key: key, UpdateExpression: "REMOVE a" } },
      ]
      expect(transactionBytes(items)).toBe(6 + 6 + 14)
      expect(transactionBytes([])).toBe(0)
    })

    it("expressions count toward the transaction but not the item: a 409,600-byte item with a condition", () => {
      const item = { pk: { S: "p" }, d: { S: "x".repeat(ITEM_MAX_BYTES - 4) } }
      const action: TransactWriteItem = {
        Put: {
          TableName: "t",
          Item: item,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      }
      expect(itemBytes(item)).toBe(ITEM_MAX_BYTES)
      expect(transactItemBytes(action)).toBe(ITEM_MAX_BYTES + 25 + 2)
    })
  })
})
