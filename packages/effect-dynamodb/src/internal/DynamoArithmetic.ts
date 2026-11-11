/**
 * DynamoDB's arithmetic and set algebra on values as a read returns them (#236).
 *
 * A retained entity's update (and a unique entity's that writes the row whole) applies `.add()`,
 * `.subtract()` and `.deleteFromSet()` to the row it read, where every other update sends `ADD`,
 * `SET #f = #f - :v` and `DELETE` for DynamoDB to apply. DynamoDB computes on decimal numbers of
 * up to 38 significant digits, exactly, and compares set members by value. A read returns a number
 * as a JavaScript `number`, or as a `bigint` past `Number.MAX_SAFE_INTEGER`, and a bigint field's
 * operand is a `bigint`. So the sum is taken on the numbers' decimal text, and given back as a read
 * would give the stored result: `5 + 2n` is `7`, `0.2 + 0.1` is `0.3`, and `(2^53 + 1) + 2` is
 * `9007199254740995n`. A result DynamoDB can't hold (39 significant digits) is written as it is,
 * for DynamoDB to refuse, as it refuses the expression.
 */

/** A decimal number: `digits × 10^-scale`, `scale >= 0`. */
type Decimal = { readonly digits: bigint; readonly scale: number }

/** The decimal a number or bigint holds, or `undefined` for one DynamoDB has no number for. */
const decimalOf = (value: number | bigint): Decimal | undefined => {
  if (typeof value === "bigint") return { digits: value, scale: 0 }
  if (!Number.isFinite(value)) return undefined
  // `String` gives the shortest text that reads back as the same number: what a read of the
  // stored text gave, and what marshalling writes for it.
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value))
  if (match === null) return undefined
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match
  const digits = BigInt(`${sign}${whole}${fraction}`)
  const scale = fraction.length - Number(exponent)
  return scale >= 0 ? { digits, scale } : { digits: digits * 10n ** BigInt(-scale), scale: 0 }
}

/** The decimal with no trailing zero in its fraction. */
const normalized = ({ digits, scale }: Decimal): Decimal => {
  let [d, s] = [digits, scale]
  while (s > 0 && d % 10n === 0n) {
    d /= 10n
    s -= 1
  }
  return { digits: d, scale: s }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * A decimal as a read returns it (`unmarshall`): an integer past `Number.MAX_SAFE_INTEGER` as a
 * `bigint`, anything else as a `number`.
 */
const asRead = (decimal: Decimal): number | bigint => {
  const { digits, scale } = normalized(decimal)
  if (scale === 0) {
    return digits > MAX_SAFE || digits < -MAX_SAFE ? digits : Number(digits)
  }
  const negative = digits < 0n
  const text = (negative ? -digits : digits).toString().padStart(scale + 1, "0")
  return Number(`${negative ? "-" : ""}${text.slice(0, -scale)}.${text.slice(-scale)}`)
}

/** Whether a value is a number as a read or an operand holds one. */
export const isNumeric = (value: unknown): value is number | bigint =>
  typeof value === "number" || typeof value === "bigint"

/**
 * `before + operand`, or `before - operand` (`negate`), as DynamoDB's `ADD` or `#f - :v` stores
 * it, as a read returns it. Two values DynamoDB has no number for (`NaN`, an infinity) are added
 * as JavaScript adds them, for marshalling to refuse.
 */
export const numberSum = (
  before: number | bigint,
  operand: number | bigint,
  negate: boolean,
): number | bigint => {
  const [a, b] = [decimalOf(before), decimalOf(operand)]
  if (a === undefined || b === undefined) {
    return negate ? Number(before) - Number(operand) : Number(before) + Number(operand)
  }
  const scale = Math.max(a.scale, b.scale)
  const left = a.digits * 10n ** BigInt(scale - a.scale)
  const right = b.digits * 10n ** BigInt(scale - b.scale)
  return asRead({ digits: negate ? left - right : left + right, scale })
}

/** The kind of set a member makes: DynamoDB's `NS`, `SS` or `BS`. */
export const memberKind = (member: unknown): "number" | "string" | "binary" | undefined =>
  isNumeric(member)
    ? "number"
    : typeof member === "string"
      ? "string"
      : member instanceof Uint8Array
        ? "binary"
        : undefined

/** What DynamoDB compares a set member by: its number, its text or its bytes. */
const memberKey = (member: unknown): unknown => {
  if (isNumeric(member)) {
    const decimal = decimalOf(member)
    if (decimal === undefined) return member
    const { digits, scale } = normalized(decimal)
    return `n:${digits}e-${scale}`
  }
  if (member instanceof Uint8Array) return `b:${member.join(",")}`
  return member
}

/** `before ∪ operand`, as DynamoDB's `ADD` of a set stores it: each member once, by value. */
export const setUnion = (
  before: ReadonlySet<unknown> | undefined,
  operand: ReadonlySet<unknown>,
): Set<unknown> => {
  const members = new Map<unknown, unknown>()
  for (const member of [...(before ?? []), ...operand]) {
    const key = memberKey(member)
    if (!members.has(key)) members.set(key, member)
  }
  return new Set(members.values())
}

/** `before ∖ operand`, as DynamoDB's `DELETE` stores it: members compared by value. */
export const setDifference = (
  before: ReadonlySet<unknown>,
  operand: ReadonlySet<unknown>,
): Set<unknown> => {
  const removed = new Set([...operand].map(memberKey))
  return new Set([...before].filter((member) => !removed.has(memberKey(member))))
}
