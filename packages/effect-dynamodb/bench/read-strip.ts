/**
 * Read-strip micro-benchmark (#239) — NOT run in CI.
 *
 * Every row a read decodes goes through `Marshaller.fromAttributeMap`, which first looks for an
 * attribute or a map entry named `__proto__` (the AWS SDK's unmarshaller would set an object's
 * prototype from one) and only then unmarshalls. Up to 1.40.0 it was the SDK's `unmarshall`
 * alone. This measures what the look costs on a row holding no such entry, the row every read
 * gets: `fromAttributeMap` against `unmarshall` on the same row.
 *
 * Rows of 10, 70 and 500 values, in two shapes: flat (top-level scalars only) and mixed (scalars,
 * nested maps and lists of maps, as a real row has). Each case reports `unmarshall`'s time per row and
 * what `fromAttributeMap` adds to it: the median of `RUNS` rounds, each timing both back to back.
 *
 * Run:
 *   node --import tsx bench/read-strip.ts
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { unmarshall } from "@aws-sdk/util-dynamodb"
import { fromAttributeMap } from "../src/Marshaller.js"

const RUNS = 41

type Row = Record<string, AttributeValue>

const flat = (values: number): Row => {
  const row: Row = {}
  for (let i = 0; i < values; i++) row[`f${i}`] = i % 2 ? { S: `value ${i}` } : { N: String(i) }
  return row
}

const mixed = (values: number): Row => {
  const row: Row = {
    pk: { S: "$app#v1#doc#id_1" },
    sk: { S: "$app#v1#doc" },
    __edd_e__: { S: "Doc" },
  }
  let left = values - 3
  for (let i = 0; left > 0; i++) {
    if (i % 5 === 0 && left >= 6) {
      row[`map${i}`] = {
        M: {
          a: { S: "x" },
          b: { N: "1" },
          c: { BOOL: true },
          d: { M: { e: { S: "y" }, f: { N: "2" } } },
          g: { S: "z" },
        },
      }
      left -= 6
    } else if (i % 5 === 1 && left >= 6) {
      row[`list${i}`] = {
        L: [
          { M: { a: { S: "x" }, b: { N: "1" } } },
          { M: { a: { S: "y" }, b: { N: "2" } } },
          { S: "s" },
          { N: "3" },
        ],
      }
      left -= 6
    } else {
      row[`f${i}`] = i % 2 ? { S: `value ${i}` } : { N: String(i) }
      left -= 1
    }
  }
  return row
}

/** Nanoseconds per call of `iterations` calls. */
const timed = (run: () => unknown, iterations: number): number => {
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) run()
  return Number(process.hrtime.bigint() - start) / iterations
}

const median = (values: Array<number>): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

const lines: Array<string> = []
for (const [shape, make] of [
  ["flat", flat],
  ["mixed", mixed],
] as const) {
  for (const values of [10, 70, 500]) {
    const row = make(values)
    const iterations = Math.round(400_000 / values)
    // Warm both up, then time them back to back in each round, alternating which goes first, so
    // drift between rounds falls out of each round's difference; the median round is reported.
    timed(() => unmarshall(row), iterations * 5)
    timed(() => fromAttributeMap(row), iterations * 5)
    const sdk: Array<number> = []
    const added: Array<number> = []
    for (let round = 0; round < RUNS; round++) {
      const first = round % 2 === 0
      const a = first ? timed(() => unmarshall(row), iterations) : 0
      const b = timed(() => fromAttributeMap(row), iterations)
      const c = first ? a : timed(() => unmarshall(row), iterations)
      sdk.push(c)
      added.push(b - c)
    }
    const base = median(sdk)
    const extra = median(added)
    lines.push(
      `${shape.padEnd(5)} ${String(values).padStart(3)} values: ` +
        `unmarshall ${(base / 1000).toFixed(2)} µs, added ${(extra / 1000).toFixed(2)} µs ` +
        `(${((extra / base) * 100).toFixed(1)}%)`,
    )
  }
}
console.log(lines.join("\n"))
