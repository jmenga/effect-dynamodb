/**
 * The removal guard is never wrong, with Effect's own decoder as the oracle. Whenever
 * `pathIsRequired` refuses a removal below a field, removing that property or splicing out that
 * list position leaves every sampled value of the field that holds it one the field's schema
 * refuses, and no sampled value holds what's above it without holding it (DynamoDB leaves such a
 * value as it was, so it would still read).
 *
 * Schemas are built by nesting wrappers at random, from a seed, and values are sampled from
 * Effect's arbitrary for each, encoded to what's stored (`helpers/GeneratedSchemas.ts`, shared
 * with `ReadersAt.property.test.ts`). A failure names the seed that rebuilds
 * its schema; a failing seed becomes a fixed case in `RowCanLack.test.ts`. This asserts soundness
 * only: a refusal is never wrong. It doesn't ask that every removal leaving a row that can't be
 * read is refused.
 */
import { Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { pathIsRequired } from "../src/internal/SchemaAccessors.js"
import {
  build,
  containerAt,
  generator,
  isMap,
  pathsOf,
  sample,
  stored,
} from "./helpers/GeneratedSchemas.js"

const SCHEMAS = 400
const FIRST_SEED = 1

/** `value` with the path removed as DynamoDB removes it: a list closes up. */
const removed = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
  const [head, ...rest] = path
  if (Array.isArray(value) && typeof head === "number") {
    return rest.length === 0
      ? value.filter((_, i) => i !== head)
      : value.map((item, i) => (i === head ? removed(item, rest) : item))
  }
  if (isMap(value) && typeof head === "string") {
    if (rest.length === 0) {
      const { [head]: _, ...left } = value
      return left
    }
    return { ...value, [head]: removed(value[head], rest) }
  }
  return value
}

type Finding = {
  readonly seed: number
  readonly field: string
  readonly path: ReadonlyArray<string | number>
  readonly value: unknown
  readonly problem: string
}

describe("pathIsRequired, against Effect's decoder", () => {
  it(`refuses no removal a value of the field survives, over ${SCHEMAS} generated schemas`, () => {
    const findings: Array<Finding> = []
    let refusals = 0
    let sampled = 0
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SCHEMAS; seed++) {
      const random = generator(seed)
      const { schema, label } = build(random, 1 + Math.floor(random() * 4))
      const decode = Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)
      const encode = Schema.encodeUnknownExit(schema as Schema.Codec<unknown, unknown>)
      let values: ReadonlyArray<unknown>
      try {
        values = sample(schema, 24, 4, seed).flatMap((value) => {
          const encoded = encode(value)
          const held = Exit.isSuccess(encoded) ? stored(encoded.value) : undefined
          return held !== undefined && Exit.isSuccess(decode(held.value)) ? [held.value] : []
        })
      } catch {
        continue
      }
      if (values.length > 0) sampled++
      const paths = new Map<string, ReadonlyArray<string | number>>()
      for (const value of values) pathsOf(value, [], paths)
      for (const path of paths.values()) {
        if (!pathIsRequired(schema, path)) continue
        refusals++
        const prefix = path.slice(0, -1)
        const last = path[path.length - 1]!
        for (const value of values) {
          const container = containerAt(value, prefix)
          const holds =
            typeof last === "number"
              ? Array.isArray(container) && last < container.length
              : isMap(container) && Object.hasOwn(container, last)
          const holdsAbove = typeof last === "number" ? Array.isArray(container) : isMap(container)
          if (!holdsAbove) continue
          if (!holds) {
            findings.push({ seed, field: label, path, value, problem: "left as it was, reads" })
          } else if (Exit.isSuccess(decode(removed(value, path)))) {
            findings.push({ seed, field: label, path, value, problem: "what's left reads" })
          }
        }
      }
    }
    expect(findings.slice(0, 5)).toEqual([])
    // Not vacuous: most schemas sampled values, and the guard refused many removals.
    expect(sampled).toBeGreaterThan(SCHEMAS * 0.8)
    expect(refusals).toBeGreaterThan(100)
  })
})
