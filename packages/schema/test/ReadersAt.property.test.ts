/**
 * What `readersAt` says of an update's operand, with Effect's own decoder as the oracle (#236), in
 * both directions. Wherever it resolves a position, for every sampled value of the field the write
 * applies to (the container is there and of the kind DynamoDB needs), with the operand written
 * there as DynamoDB writes it (`SET` replaces a property or a list position, and writes past a
 * list's end at its end; `list_append` adds elements at either end of a list):
 *
 * - an operand none of the readers reads is one no such row reads (a refusal is never wrong);
 * - an operand every reader reads is one every such row reads (the readers ask no more than the
 *   read does).
 *
 * One class of position can't be checked the second way, and is counted rather than checked: one
 * a union reaches through members that read it differently (`Union([Struct({ p: String }),
 * Struct({ p: Number })])` at `p`), with an operand some of their readers read and others don't.
 * Whether a row holding it reads depends on the member the row holds, which the readers don't
 * see: it is taken, as an operand one of them reads always was (an operand none reads is still
 * refused, and checked above).
 *
 * Schemas and values come from `helpers/GeneratedSchemas.ts`, as `PathIsRequired.property.test.ts`
 * builds them; a failure names the seed that rebuilds its schema. Operands are the values sampled
 * values hold, at any depth, and a few fixed ones.
 */
import { Exit, Schema, type SchemaAST } from "effect"
import { describe, expect, it } from "vitest"
import { type OperandKind, readersAt } from "../src/internal/SchemaAccessors.js"
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
/** How many of the values sampled values hold are written as operands, per schema. */
const OPERANDS = 12

const FIXED: ReadonlyArray<unknown> = [
  "s",
  "7",
  7,
  true,
  null,
  {},
  [],
  ["x"],
  [1],
  { p0: "a" },
  { kind: "a", p: "s" },
  { _tag: "A", p: 1 },
]

/** Every value `value` holds, itself included. */
const partsOf = (value: unknown, out: Map<string, unknown>): void => {
  out.set(JSON.stringify(value), value)
  if (Array.isArray(value)) for (const item of value) partsOf(item, out)
  else if (isMap(value)) for (const held of Object.values(value)) partsOf(held, out)
}

/** `value` with `operand` written at `path` as DynamoDB's `SET` writes it. */
const set = (value: unknown, path: ReadonlyArray<string | number>, operand: unknown): unknown => {
  const [head, ...rest] = path
  if (head === undefined) return operand
  if (Array.isArray(value) && typeof head === "number") {
    if (rest.length === 0 && head >= value.length) return [...value, operand]
    return value.map((item, i) => (i === head ? set(item, rest, operand) : item))
  }
  if (isMap(value) && typeof head === "string") {
    const out: Record<string, unknown> = { ...value }
    Object.defineProperty(out, head, {
      value: set(value[head], rest, operand),
      enumerable: true,
      writable: true,
      configurable: true,
    })
    return out
  }
  return value
}

/** Whether DynamoDB applies a write of this kind at `path` to `value`. */
const applies = (value: unknown, path: ReadonlyArray<string | number>, kind: OperandKind) => {
  if (kind === "elements") return Array.isArray(containerAt(value, path))
  const last = path[path.length - 1]
  const container = containerAt(value, path.slice(0, -1))
  return typeof last === "number" ? Array.isArray(container) : isMap(container)
}

const readerOf = new Map<SchemaAST.AST, (value: unknown) => boolean>()
const reads = (ast: SchemaAST.AST, value: unknown): boolean => {
  let reader = readerOf.get(ast)
  if (reader === undefined) {
    const decode = Schema.decodeUnknownExit(Schema.make<Schema.Codec<unknown>>(ast))
    reader = (held) => {
      try {
        return Exit.isSuccess(decode(held))
      } catch {
        return false
      }
    }
    readerOf.set(ast, reader)
  }
  return reader(value)
}

type Finding = {
  readonly seed: number
  readonly field: string
  readonly path: ReadonlyArray<string | number>
  readonly kind: OperandKind
  readonly operand: unknown
  readonly value: unknown
  readonly problem: string
}

describe("readersAt, against Effect's decoder", () => {
  it(`refuses only what no row reads, and takes what every row reads, over ${SCHEMAS} generated schemas`, () => {
    const findings: Array<Finding> = []
    let resolved = 0
    let refusals = 0
    let checked = 0
    let accepted = 0
    let checkedAccepted = 0
    let unchecked = 0
    let sampled = 0
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SCHEMAS; seed++) {
      const random = generator(seed)
      const { schema, label } = build(random, 1 + Math.floor(random() * 4))
      const decode = Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)
      const encode = Schema.encodeUnknownExit(schema as Schema.Codec<unknown, unknown>)
      const readsWhole = (value: unknown): boolean => {
        try {
          return Exit.isSuccess(decode(value))
        } catch {
          return false
        }
      }
      let values: ReadonlyArray<unknown>
      try {
        values = sample(schema, 24, 4, seed).flatMap((value) => {
          const encoded = encode(value)
          const held = Exit.isSuccess(encoded) ? stored(encoded.value) : undefined
          return held !== undefined && readsWhole(held.value) ? [held.value] : []
        })
      } catch {
        continue
      }
      if (values.length > 0) sampled++
      // The fixed operands, and the shortest of the values sampled values hold.
      const parts = new Map<string, unknown>()
      for (const value of values) partsOf(value, parts)
      const held = [...parts].sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1))
      const operands = [...FIXED, ...held.slice(0, OPERANDS).map(([, operand]) => operand)]
      const paths = new Map<string, ReadonlyArray<string | number>>()
      for (const value of values) pathsOf(value, [], paths)
      paths.set("[]", [])
      for (const path of paths.values()) {
        for (const kind of ["value", "elements"] as const) {
          if (kind === "value" && path.length === 0) continue
          const readers = readersAt(schema, path, kind)
          if (readers === undefined) continue
          resolved++
          for (const operand of operands) {
            const written = kind === "value" ? [operand] : Array.isArray(operand) ? operand : []
            if (kind === "elements" && written.length === 0) continue
            const refused = written.some((one) => !readers.some((ast) => reads(ast, one)))
            if (refused) refusals++
            else if (written.every((one) => readers.every((ast) => reads(ast, one)))) accepted++
            else {
              unchecked++
              continue
            }
            for (const value of values) {
              if (!applies(value, path, kind)) continue
              const after =
                kind === "value"
                  ? [set(value, path, operand)]
                  : [
                      set(value, path, [
                        ...(containerAt(value, path) as Array<unknown>),
                        ...written,
                      ]),
                      set(value, path, [
                        ...written,
                        ...(containerAt(value, path) as Array<unknown>),
                      ]),
                    ]
              if (refused) {
                checked++
                if (after.some(readsWhole)) {
                  findings.push({
                    seed,
                    field: label,
                    path,
                    kind,
                    operand,
                    value,
                    problem: "reads",
                  })
                }
              } else {
                checkedAccepted++
                if (!after.every(readsWhole)) {
                  findings.push({
                    seed,
                    field: label,
                    path,
                    kind,
                    operand,
                    value,
                    problem: "doesn't read",
                  })
                }
              }
            }
          }
        }
      }
    }
    expect(findings.slice(0, 5)).toEqual([])
    // Not vacuous: most schemas sampled values, many positions resolved, many operands refused
    // and taken, and many of each checked against a value the write applies to. The operands a
    // union's members read differently, taken unchecked, are few.
    expect(sampled).toBeGreaterThan(SCHEMAS * 0.8)
    expect(resolved).toBeGreaterThan(1000)
    expect(refusals).toBeGreaterThan(10_000)
    expect(checked).toBeGreaterThan(100_000)
    expect(accepted).toBeGreaterThan(10_000)
    expect(checkedAccepted).toBeGreaterThan(100_000)
    expect(unchecked).toBeLessThan(accepted / 4)
  }, 120_000)
})
