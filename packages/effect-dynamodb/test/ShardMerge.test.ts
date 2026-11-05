/**
 * The k-way merge of a sharded index's partitions (#183, design §6.2): what it
 * proves in order, how far it goes before it needs a read, and what a partition's
 * boundary says afterwards.
 */

import { describe, expect, it } from "vitest"
import * as ShardMerge from "../src/internal/ShardMerge.js"

const rowOf = (sk: string, id = sk): ShardMerge.Row => ({ sk: { S: sk }, id: { S: id } })
const rows = (...sks: ReadonlyArray<string>) => sks.map((sk) => rowOf(sk))
const key = (sk: string): ShardMerge.Row => ({ sk: { S: sk } })
const order = { skField: "sk", reverse: false }
const backwards = { skField: "sk", reverse: true }
const names = (selection: ShardMerge.Selection) => selection.taken.map(({ row }) => row.id?.S)

/** A merge with each partition's page buffered. */
const loaded = (
  ...pages: ReadonlyArray<readonly [ReadonlyArray<ShardMerge.Row>, ShardMerge.Row?]>
): ShardMerge.MergeState =>
  pages.reduce(
    (state, [page, lastKey], i) => ShardMerge.absorb(state, i, page, lastKey),
    ShardMerge.fromStart(pages.length),
  )

describe("reading", () => {
  it("starts with every partition needing a read", () => {
    const state = ShardMerge.fromStart(3)
    expect(ShardMerge.needingRead(state)).toEqual([0, 1, 2])
    expect(ShardMerge.unfinished(state)).toBe(3)
    expect(ShardMerge.isFinished(state)).toBe(false)
  })

  it("a page without a next key leaves its partition done once consumed", () => {
    const state = loaded([rows("a")])
    expect(ShardMerge.isBuffered(state, 0)).toBe(true)
    expect(ShardMerge.needingRead(state)).toEqual([])
    const { state: after } = ShardMerge.select(state, 10, order)
    expect(after[0]!.boundary).toEqual({ _tag: "Done" })
    expect(ShardMerge.isFinished(after)).toBe(true)
  })

  it("an empty page with a next key moves the boundary on and needs a read", () => {
    const state = ShardMerge.absorb(ShardMerge.fromStart(1), 0, [], key("k"))
    expect(state[0]!.boundary).toEqual({ _tag: "At", key: key("k") })
    expect(ShardMerge.needingRead(state)).toEqual([0])
  })

  it("an empty page without a next key finishes the partition", () => {
    const state = ShardMerge.absorb(ShardMerge.fromStart(1), 0, [], undefined)
    expect(state[0]!.boundary).toEqual({ _tag: "Done" })
    expect(ShardMerge.needingRead(state)).toEqual([])
  })

  it("a page that is read leaves the boundary where it was: nothing is consumed yet", () => {
    const state = ShardMerge.absorb(
      ShardMerge.initial([{ _tag: "At", key: key("j") }]),
      0,
      rows("k"),
      key("k"),
    )
    expect(state[0]!.boundary).toEqual({ _tag: "At", key: key("j") })
  })
})

describe("selecting", () => {
  it("merges in byte order across partitions", () => {
    const selected = ShardMerge.select(
      loaded([rows("a", "d")], [rows("b", "e")], [rows("c")]),
      9,
      order,
    )
    expect(names(selected)).toEqual(["a", "b", "c", "d", "e"])
  })

  it("merges descending under reverse", () => {
    const selected = ShardMerge.select(
      loaded([rows("d", "a")], [rows("e", "b")], [rows("c")]),
      9,
      backwards,
    )
    expect(names(selected)).toEqual(["e", "d", "c", "b", "a"])
  })

  it("emits nothing while a partition with more to read has no row", () => {
    const state = ShardMerge.absorb(ShardMerge.fromStart(2), 0, rows("a"), undefined)
    expect(ShardMerge.needingRead(state)).toEqual([1])
    const { taken, state: unchanged } = ShardMerge.select(state, 9, order)
    expect(taken).toEqual([])
    expect(unchanged).toBe(state)
  })

  it("stops as soon as a partition with more to read runs dry", () => {
    const state = loaded([rows("a"), key("a")], [rows("b", "c")])
    const selected = ShardMerge.select(state, 9, order)
    expect(names(selected)).toEqual(["a"])
    expect(selected.drained).toEqual([0])
    expect(selected.state[0]!.boundary).toEqual({ _tag: "At", key: key("a") })
    expect(ShardMerge.needingRead(selected.state)).toEqual([0])
    // The other's rows wait: `b` can't be proven until partition 0 is read.
    expect(selected.state[1]!.next).toBe(0)
    expect(selected.state[1]!.boundary).toEqual({ _tag: "Start" })
  })

  it("keeps going past a partition that drains with nothing left to read", () => {
    const selected = ShardMerge.select(loaded([rows("a")], [rows("b", "c")]), 9, order)
    expect(names(selected)).toEqual(["a", "b", "c"])
    expect(selected.drained).toEqual([0, 1])
    expect(ShardMerge.isFinished(selected.state)).toBe(true)
  })

  it("stops at the budget, recording the last row consumed", () => {
    const selected = ShardMerge.select(loaded([rows("a", "c")], [rows("b", "d")]), 3, order)
    expect(names(selected)).toEqual(["a", "b", "c"])
    expect(selected.drained).toEqual([0])
    expect(selected.state[0]!.boundary).toEqual({ _tag: "Done" })
    expect(selected.state[1]!.boundary).toEqual({ _tag: "After", row: rowOf("b") })
    expect(selected.state[1]!.next).toBe(1)
  })

  it("a page untouched keeps the boundary it had", () => {
    const selected = ShardMerge.select(loaded([rows("a", "b")], [rows("c")]), 2, order)
    expect(selected.state[1]!.boundary).toEqual({ _tag: "Start" })
    expect(selected.state[1]!.next).toBe(0)
  })

  it("a budget of zero selects nothing", () => {
    const state = loaded([rows("a")])
    expect(ShardMerge.select(state, 0, order).taken).toEqual([])
  })

  it("throws for a row without its sort key", () => {
    const state = loaded([[{ id: { S: "x" } }]], [rows("a")])
    expect(() => ShardMerge.select(state, 1, order)).toThrow(/lacks its sort key/)
  })

  it("every proven selection over random pages stays sorted and complete", () => {
    let seed = 7
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return seed % n
    }
    for (let run = 0; run < 200; run++) {
      const count = 1 + next(6)
      const pages = Array.from({ length: count }, () =>
        Array.from({ length: next(6) }, () => String.fromCharCode(97 + next(10))).sort(),
      )
      const all = pages.flat().sort()
      let state = loaded(...pages.map((page) => [rows(...page)] as const))
      const out: Array<string | undefined> = []
      while (!ShardMerge.isFinished(state)) {
        const selected = ShardMerge.select(state, 1 + next(3), order)
        out.push(...selected.taken.map(({ row }) => row.sk?.S))
        state = selected.state
      }
      expect(out).toEqual(all)
    }
  })
})

describe("ties", () => {
  it("equal sort keys order by partition, in partition order", () => {
    const state = loaded(
      [[rowOf("k", "p0")]],
      [[rowOf("k", "p1")]],
      [[rowOf("k", "p2")]],
      [[rowOf("k", "p3")]],
    )
    expect(names(ShardMerge.select(state, 9, order))).toEqual(["p0", "p1", "p2", "p3"])
  })

  it("reverse is the exact reversal of forward", () => {
    const forwardPages = [
      [rowOf("a", "p0-a"), rowOf("k", "p0-k1"), rowOf("k", "p0-k2")],
      [rowOf("k", "p1-k"), rowOf("z", "p1-z")],
      [rowOf("a", "p2-a"), rowOf("k", "p2-k")],
    ]
    const forward = names(
      ShardMerge.select(loaded(...forwardPages.map((p) => [p] as const)), 99, order),
    )
    const backward = names(
      ShardMerge.select(
        loaded(...forwardPages.map((p) => [[...p].reverse()] as const)),
        99,
        backwards,
      ),
    )
    expect(backward).toEqual([...forward].reverse())
  })
})

describe("the order of a key", () => {
  it("compares S keys by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FFFD sorts below U+1F600 in UTF-8, above it in UTF-16.
    const selected = ShardMerge.select(loaded([rows("\u{1F600}")], [rows("�")]), 9, order)
    expect(names(selected)).toEqual(["�", "\u{1F600}"])
  })

  it("compares B keys by unsigned bytes", () => {
    const bin = (...bytes: ReadonlyArray<number>): ShardMerge.Row => ({
      sk: { B: Uint8Array.from(bytes) },
      id: { S: bytes.join(".") },
    })
    const state = loaded([[bin(0x01, 0xff)]], [[bin(0x80)]], [[bin(0x01)]])
    expect(names(ShardMerge.select(state, 9, order))).toEqual(["1", "1.255", "128"])
  })

  it("compares N keys numerically", () => {
    const num = (text: string): ShardMerge.Row => ({ sk: { N: text }, id: { S: text } })
    const state = loaded([[num("-10")]], [[num("9")]], [[num("10")]], [[num("0")]])
    expect(names(ShardMerge.select(state, 9, order))).toEqual(["-10", "0", "9", "10"])
  })

  it.each([
    ["1", "2", -1],
    ["2", "1", 1],
    ["1", "1", 0],
    ["1.0", "1", 0],
    ["10", "9", 1],
    ["-10", "-9", -1],
    ["-1", "1", -1],
    ["0", "-0", 0],
    ["0.5", "0.05", 1],
    ["1e3", "1000", 0],
    ["1E-3", "0.001", 0],
    ["1.5e1", "15", 0],
    ["0", "1", -1],
    ["-1", "0", -1],
    // Beyond a float's precision: these two are one double.
    ["9007199254740993", "9007199254740992", 1],
    ["12345678901234567890123456789012345678", "12345678901234567890123456789012345679", -1],
  ])("compareDecimal(%s, %s) is %d", (a, b, expected) => {
    expect(ShardMerge.compareDecimal(a, b)).toBe(expected)
  })
})
