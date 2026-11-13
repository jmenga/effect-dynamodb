/**
 * The row comparison the order and interleaving tests make (`helpers/StoredRows.ts`) sees every
 * attribute's content: rows that differ in one key character, one value, one type or one missing
 * attribute compare different, and rows that differ only in attribute or set member order compare
 * the same.
 */
import { describe, expect, it } from "vitest"
import { storedRows } from "./helpers/StoredRows.js"

const row = {
  pk: { S: "$app#v1#item#id_a b" },
  sk: { S: "$app#v1#item" },
  __edd_e__: { S: "Item" },
  count: { N: "1" },
  tags: { SS: ["x", "y"] },
  blob: { B: new Uint8Array([1, 2, 3]) },
  nested: { M: { list: { L: [{ S: "one" }, { N: "2" }] }, flag: { BOOL: true } } },
}

const differs = (other: Record<string, any>) =>
  expect(storedRows([other])).not.toEqual(storedRows([row]))

describe("the stored-row comparison", () => {
  it("tells apart rows differing in one key character", () => {
    differs({ ...row, pk: { S: "$app#v1#item#id_a%20b" } })
    differs({ ...row, sk: { S: "$app#v1#iteM" } })
  })

  it("tells apart rows differing in one value", () => {
    differs({ ...row, __edd_e__: { S: "Other" } })
    differs({ ...row, count: { N: "2" } })
    differs({ ...row, tags: { SS: ["x", "z"] } })
    differs({ ...row, blob: { B: new Uint8Array([1, 2, 4]) } })
    differs({ ...row, nested: { M: { ...row.nested.M, flag: { BOOL: false } } } })
    differs({
      ...row,
      nested: { M: { ...row.nested.M, list: { L: [{ N: "2" }, { S: "one" }] } } },
    })
  })

  it("tells apart rows differing in one type", () => {
    differs({ ...row, count: { S: "1" } })
    differs({ ...row, tags: { L: [{ S: "x" }, { S: "y" }] } })
    differs({ ...row, nested: { L: [] } })
  })

  it("tells apart rows differing in one missing attribute", () => {
    const { count: _count, ...without } = row
    differs(without)
    differs({ ...row, extra: { NULL: true } })
  })

  it("takes rows differing only in attribute order or set member order for the same", () => {
    const reordered = Object.fromEntries(Object.entries(row).reverse())
    expect(storedRows([{ ...reordered, tags: { SS: ["y", "x"] } }])).toEqual(storedRows([row]))
  })

  it("compares tables as sets of rows, whatever order they're listed in", () => {
    const other = { ...row, pk: { S: "other" } }
    expect(storedRows([row, other])).toEqual(storedRows([other, row]))
    expect(storedRows([row, other])).not.toEqual(storedRows([row, row]))
  })
})
