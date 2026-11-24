/**
 * The structural fingerprint behind `commandHandler`'s `checkStateUse`
 * (#290): unchanged values compare equal, a change is named by its first
 * path, and the caches Effect's data types keep are not taken for changes.
 */

import { describe, expect, it } from "@effect/vitest"
import { BigDecimal, Chunk, DateTime, HashMap, HashSet, Option, Result } from "effect"
import * as StateFingerprint from "../src/internal/StateFingerprint.js"

/** The first difference `change` makes to `value`. */
const changed = <A>(value: A, change: (value: A) => void) => {
  const before = StateFingerprint.of(value)
  change(value)
  return StateFingerprint.firstDifference(before, StateFingerprint.of(value))
}

describe("StateFingerprint (#290)", () => {
  it("two fingerprints of an unchanged value are equal", () => {
    const value = {
      status: "live",
      innings: [{ overs: 3 }, { overs: 4 }],
      tags: new Set(["a"]),
      byPlayer: new Map([["p1", { runs: 1 }]]),
      at: new Date(0),
      score: 1n,
      none: undefined,
      nothing: null,
    }
    expect(
      StateFingerprint.firstDifference(StateFingerprint.of(value), StateFingerprint.of(value)),
    ).toBeUndefined()
    // A structurally equal copy fingerprints the same.
    expect(
      StateFingerprint.firstDifference(
        StateFingerprint.of(value),
        StateFingerprint.of(structuredClone(value)),
      ),
    ).toBeUndefined()
  })

  it("names a nested change by its path, with the values before and after", () => {
    const difference = changed({ innings: [{ overs: 3 }, { overs: 4 }] }, (s) => {
      s.innings[1]!.overs = 5
    })
    expect(difference).toEqual({ path: "innings[1].overs", before: "4", after: "5" })
  })

  it("reports an added or removed member at its container", () => {
    expect(
      changed({ innings: [{ overs: 3 }] }, (s) => {
        s.innings.push({ overs: 4 })
      }),
    ).toEqual({ path: "innings", before: "Array of length 1", after: "Array of length 2" })
    expect(
      changed({ a: 1 } as Record<string, number>, (s) => {
        s.b = 2
      }),
    ).toEqual({ path: "", before: "{ a }", after: "{ a, b }" })
    expect(
      changed({ a: 1, b: 2 } as Record<string, number>, (s) => {
        delete s.b
      }),
    ).toEqual({ path: "", before: "{ a, b }", after: "{ a }" })
    expect(StateFingerprint.formatPath("")).toBe("the state itself")
  })

  it("quotes keys that aren't identifiers, and strings in values", () => {
    expect(
      changed({ "home team": { name: "a" } }, (s) => {
        s["home team"].name = "b"
      }),
    ).toEqual({ path: '["home team"].name', before: '"a"', after: '"b"' })
  })

  it("reads Map, Set, HashMap, HashSet and Chunk by their contents", () => {
    expect(
      changed({ byPlayer: new Map([["p1", { runs: 1 }]]) }, (s) => {
        s.byPlayer.get("p1")!.runs = 2
      }),
    ).toEqual({ path: 'byPlayer.get("p1").runs', before: "1", after: "2" })
    expect(
      changed({ tags: new Set(["a"]) }, (s) => {
        s.tags.add("b")
      }),
    ).toMatchObject({ path: "tags", before: "Set of size 1", after: "Set of size 2" })

    const members = { runs: 1 }
    expect(
      changed({ map: HashMap.make(["p1", members]) }, () => {
        members.runs = 2
      }),
    ).toEqual({ path: 'map.get("p1").runs', before: "1", after: "2" })
    expect(
      changed({ set: HashSet.make(members) }, () => {
        members.runs = 3
      }),
    ).toMatchObject({ path: "set[0].runs" })
    expect(
      changed({ chunk: Chunk.make(members) }, () => {
        members.runs = 4
      }),
    ).toMatchObject({ path: "chunk[0].runs" })
  })

  it("doesn't take the caches of Chunk, BigDecimal and DateTime for changes", () => {
    // A concatenated Chunk caches its array form in an own field when read.
    expect(
      changed({ chunk: Chunk.appendAll(Chunk.make(1, 2), Chunk.make(3)) }, (s) => {
        Chunk.toReadonlyArray(s.chunk)
      }),
    ).toBeUndefined()
    // A BigDecimal caches its normal form in an own field.
    expect(
      changed({ amount: BigDecimal.make(1500n, 3) }, (s) => {
        BigDecimal.normalize(s.amount)
      }),
    ).toBeUndefined()
    // A DateTime caches its parts in non-enumerable slots.
    expect(
      changed({ at: DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" }) }, (s) => {
        DateTime.toParts(s.at)
        DateTime.formatIsoZoned(s.at)
      }),
    ).toBeUndefined()
  })

  it("reads Date, DateTime, BigDecimal, Option and Result by value", () => {
    expect(
      changed({ at: new Date(0) }, (s) => {
        s.at.setTime(1000)
      }),
    ).toEqual({
      path: "at",
      before: "Date(1970-01-01T00:00:00.000Z)",
      after: "Date(1970-01-01T00:00:01.000Z)",
    })
    const nested = { overs: 1 }
    expect(
      changed({ venue: Option.some(nested) }, () => {
        nested.overs = 2
      }),
    ).toEqual({ path: "venue.value.overs", before: "1", after: "2" })
    expect(
      changed({ result: Result.succeed(nested) }, () => {
        nested.overs = 3
      }),
    ).toMatchObject({ path: "result.success.overs" })
    expect(
      changed({ venue: Option.none() as Option.Option<string> }, (s) => {
        s.venue = Option.some("Lord's")
      }),
    ).toEqual({ path: "venue", before: "Option.None", after: "Option.Some" })
    expect(
      changed({ amount: BigDecimal.make(15n, 1) }, (s) => {
        s.amount = BigDecimal.make(16n, 1)
      }),
    ).toEqual({ path: "amount", before: "BigDecimal(1.5)", after: "BigDecimal(1.6)" })
  })

  it("reads typed arrays by their bytes", () => {
    expect(
      changed({ bytes: new Uint8Array([1, 2]) }, (s) => {
        s.bytes[1] = 3
      }),
    ).toEqual({ path: "bytes", before: "Uint8Array of 2 bytes", after: "Uint8Array of 2 bytes" })
  })

  it("records a cycle without walking it again, and never calls an accessor", () => {
    const node: { name: string; self?: unknown } = { name: "a" }
    node.self = node
    expect(
      changed(node, (s) => {
        s.name = "b"
      }),
    ).toEqual({ path: "name", before: '"a"', after: '"b"' })
    expect(
      changed(node, (s) => {
        s.self = { name: "b" }
      }),
    ).toEqual({ path: "self", before: "a reference to the state itself", after: "{ name }" })

    let reads = 0
    const withGetter = Object.defineProperty({}, "computed", {
      enumerable: true,
      get: () => {
        reads++
        return reads
      },
    })
    StateFingerprint.of(withGetter)
    expect(reads).toBe(0)
  })

  it("reads frozen values, Effect data types included, without writing to them", () => {
    const frozen = Object.freeze({
      amount: Object.freeze(BigDecimal.make(1500n, 3)),
      overs: Object.freeze(Chunk.appendAll(Chunk.make(1, 2), Chunk.make(3))),
      at: Object.freeze(DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" })),
      tags: Object.freeze(HashSet.make("a")),
    })
    expect(
      StateFingerprint.firstDifference(StateFingerprint.of(frozen), StateFingerprint.of(frozen)),
    ).toBeUndefined()
    // A BigDecimal reads as its value, whatever its scale.
    expect(
      StateFingerprint.firstDifference(
        StateFingerprint.of({ amount: BigDecimal.make(1500n, 3) }),
        StateFingerprint.of({ amount: BigDecimal.make(15n, 1) }),
      ),
    ).toBeUndefined()
    expect(
      changed(
        { amounts: [BigDecimal.make(5n, 3), BigDecimal.make(-5n, -2), BigDecimal.make(0n, 4)] },
        (s) => {
          s.amounts[0] = BigDecimal.make(-1205n, 2)
        },
      ),
    ).toEqual({
      path: "amounts[0]",
      before: "BigDecimal(0.005)",
      after: "BigDecimal(-12.05)",
    })
  })

  it("compares Map keys in full, and symbol keys by identity", () => {
    const prefix = "tenants/0123456789/accounts/0123456789/"
    expect(
      changed({ byId: new Map([[`${prefix}old`, 1]]) }, (s) => {
        s.byId.delete(`${prefix}old`)
        s.byId.set(`${prefix}new`, 1)
      }),
    ).toMatchObject({ path: `byId.get("${prefix}old")` })
    const key = Symbol("k")
    expect(
      changed({ bySymbol: new Map([[key, 1]]) }, (s) => {
        s.bySymbol.delete(key)
        s.bySymbol.set(Symbol("k"), 1)
      }),
    ).toMatchObject({ path: "bySymbol.keys()[0]" })
  })

  it("reads array elements by descriptor: an accessor is not called, a hole is absent", () => {
    let reads = 0
    const lazy = Object.defineProperty([] as Array<unknown>, "0", {
      enumerable: true,
      get: () => {
        reads++
        throw new Error("not read")
      },
    })
    StateFingerprint.of(lazy)
    expect(reads).toBe(0)
    const slots = new Array<number | undefined>(3)
    slots[0] = 1
    slots[2] = 3
    expect(
      changed({ slots }, (s) => {
        s.slots[1] = undefined
      }),
    ).toEqual({ path: "slots[1]", before: "absent", after: "undefined" })
  })

  it("walks an object reached by several paths once, and names it by its first", () => {
    let shared: object = { n: 1 }
    for (let i = 0; i < 32; i++) shared = { left: shared, right: shared }
    // 33 distinct objects: one entry per object, property and repeat.
    expect(StateFingerprint.of(shared).length).toBeLessThan(200)

    const innings = { overs: 3 }
    expect(
      changed({ first: innings, current: innings as { overs: number } }, (s) => {
        s.current = { overs: 3 }
      }),
    ).toEqual({ path: "current", before: "the same object as at first", after: "{ overs }" })
    expect(
      changed({ first: innings, current: innings }, (s) => {
        s.current.overs = 4
      }),
    ).toEqual({ path: "first.overs", before: "3", after: "4" })
  })

  it("compares functions and prototypes by identity", () => {
    class Score {
      constructor(readonly runs: number) {}
    }
    expect(
      changed({ score: new Score(1) as object }, (s) => {
        s.score = { runs: 1 }
      }),
    ).toEqual({ path: "score", before: "Score { runs }", after: "{ runs }" })
    expect(
      changed({ handler: (() => 1) as () => number }, (s) => {
        s.handler = () => 2
      }),
    ).toMatchObject({ path: "handler" })
  })
})
