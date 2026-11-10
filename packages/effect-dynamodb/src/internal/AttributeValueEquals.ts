/**
 * Structural equality of marshalled DynamoDB attribute values.
 *
 * Lives in its own module so both `Entity.ts` and `internal/TransactPlan.ts`
 * can use it without a runtime import cycle.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"

/**
 * A binary value's bytes as text, whatever form the marshaller took it in. It stores a `B` as it is
 * given: a `Uint8Array`, another typed array or `DataView` (its bytes in the buffer), an
 * `ArrayBuffer`, or a `Blob` / `File`, whose bytes can't be read here. `Array.from` over an
 * `ArrayBuffer` or a `DataView` is empty, so two of them with different bytes compared equal.
 */
const bytesKey = (binary: unknown): string => {
  const bytes = ArrayBuffer.isView(binary)
    ? new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
    : binary instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== "undefined" && binary instanceof SharedArrayBuffer)
      ? new Uint8Array(binary as ArrayBuffer)
      : undefined
  return bytes === undefined ? "" : Array.from(bytes).join(",")
}

/** Whether two binary values hold the same bytes. One whose bytes can't be read equals only itself. */
const sameBytes = (a: unknown, b: unknown): boolean =>
  a === b || (readable(a) && readable(b) && bytesKey(a) === bytesKey(b))

const readable = (binary: unknown): boolean =>
  ArrayBuffer.isView(binary) ||
  binary instanceof ArrayBuffer ||
  (typeof SharedArrayBuffer !== "undefined" && binary instanceof SharedArrayBuffer)

/**
 * A number as DynamoDB holds it, whatever text it is given in: `2`, `2.0` and `0.2e1` are one
 * number, which DynamoDB stores once, normalised. Text that isn't a number is kept as it is.
 */
const numberKey = (text: string): string => {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) return text
  const [, sign, whole = "", fraction = "", exponent = "0"] = match
  const digits = (whole + fraction).replace(/^0+/, "")
  if (digits === "") return "0"
  const significant = digits.replace(/0+$/, "")
  const power = Number(exponent) - fraction.length + (digits.length - significant.length)
  return `${sign === "-" ? "-" : ""}${significant}e${power}`
}

/** Structural equality of two marshalled values (sets compare as sets, numbers as numbers). */
export const attributeValueEquals = (
  a: AttributeValue | undefined,
  b: AttributeValue | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b
  const [kind] = Object.keys(a)
  if (kind === undefined || Object.keys(b)[0] !== kind) return false
  const x = (a as unknown as globalThis.Record<string, unknown>)[kind]
  const y = (b as unknown as globalThis.Record<string, unknown>)[kind]
  switch (kind) {
    case "L": {
      const xs = x as ReadonlyArray<AttributeValue>
      const ys = y as ReadonlyArray<AttributeValue>
      return xs.length === ys.length && xs.every((v, i) => attributeValueEquals(v, ys[i]))
    }
    case "M": {
      const xm = x as globalThis.Record<string, AttributeValue>
      const ym = y as globalThis.Record<string, AttributeValue>
      const keys = Object.keys(xm)
      return (
        keys.length === Object.keys(ym).length &&
        keys.every((k) => attributeValueEquals(xm[k], ym[k]))
      )
    }
    case "N":
      return typeof x === "string" && typeof y === "string"
        ? numberKey(x) === numberKey(y)
        : x === y
    case "SS":
    case "NS": {
      const key = kind === "NS" ? numberKey : (text: string) => text
      const xs = new Set((x as ReadonlyArray<string>).map(key))
      const ys = (y as ReadonlyArray<string>).map(key)
      return xs.size === new Set(ys).size && ys.every((v) => xs.has(v))
    }
    case "B":
      return sameBytes(x, y)
    case "BS": {
      const xs = x as ReadonlyArray<unknown>
      const ys = y as ReadonlyArray<unknown>
      // A set: each member of one is in the other, and they hold as many distinct members.
      const distinct = (values: ReadonlyArray<unknown>) =>
        values.filter((value, i) => values.findIndex((other) => sameBytes(other, value)) === i)
      const [dx, dy] = [distinct(xs), distinct(ys)]
      return dx.length === dy.length && dx.every((v) => dy.some((other) => sameBytes(other, v)))
    }
    default:
      return x === y
  }
}
