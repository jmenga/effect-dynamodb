/**
 * @internal Equality of attribute values as DynamoDB stores them: compared on the attribute values
 * themselves, never on what they unmarshal to, so a number is the exact decimal stored. Unmarshalled,
 * `N "0.1"` and `N "0.10000000000000001"` are one JavaScript number; stored, they're two values.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"

/**
 * A DynamoDB number's value, spelled one way: its sign, its digits without leading or trailing
 * zeros, and its exponent (`0.100` and `0.1` are one value; `0.10000000000000001` another).
 * Undefined for text that isn't a number, which then compares as written.
 */
export const decimalValue = (text: string): string | undefined => {
  const match = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(text)
  if (match === null) return undefined
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match
  if (whole === "" && fraction === "") return undefined
  const digits = `${whole}${fraction}`.replace(/^0+/, "")
  if (digits === "") return "0"
  const significant = digits.replace(/0+$/, "")
  const scale = Number(exponent) - fraction.length + (digits.length - significant.length)
  return `${sign === "-" ? "-" : ""}${significant}e${scale}`
}

export const sameNumber = (a: string, b: string): boolean =>
  a === b || (decimalValue(a) ?? a) === (decimalValue(b) ?? b)

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const sameMembers = <A>(
  a: ReadonlyArray<A>,
  b: ReadonlyArray<A>,
  same: (x: A, y: A) => boolean,
): boolean =>
  a.length === b.length &&
  a.every((x) => b.some((y) => same(x, y))) &&
  b.every((y) => a.some((x) => same(x, y)))

/**
 * Whether two attribute values, as stored, are one value: compared on the attribute values
 * themselves, so a number compares as the exact decimal it is (`N "0.100"` is `N "0.1"`, and
 * `N "0.10000000000000001"` isn't, though both read back as the same JavaScript number).
 */
export const sameAttributeValue = (
  a: AttributeValue | undefined,
  b: AttributeValue | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b
  if (a.S !== undefined) return b.S === a.S
  if (a.N !== undefined) return b.N !== undefined && sameNumber(a.N, b.N)
  if (a.B !== undefined) return b.B !== undefined && sameBytes(a.B, b.B)
  if (a.BOOL !== undefined) return b.BOOL === a.BOOL
  if (a.NULL !== undefined) return b.NULL !== undefined
  if (a.SS !== undefined) return b.SS !== undefined && sameMembers(a.SS, b.SS, (x, y) => x === y)
  if (a.NS !== undefined) return b.NS !== undefined && sameMembers(a.NS, b.NS, sameNumber)
  if (a.BS !== undefined) return b.BS !== undefined && sameMembers(a.BS, b.BS, sameBytes)
  if (a.L !== undefined) {
    const list = b.L
    return (
      list !== undefined &&
      a.L.length === list.length &&
      a.L.every((member, i) => sameAttributeValue(member, list[i]))
    )
  }
  if (a.M !== undefined) {
    const map = b.M
    if (map === undefined) return false
    const names = Object.keys(a.M).filter((name) => a.M![name] !== undefined)
    return (
      names.length === Object.keys(map).filter((name) => map[name] !== undefined).length &&
      names.every((name) => sameAttributeValue(a.M![name], map[name]))
    )
  }
  return false
}
