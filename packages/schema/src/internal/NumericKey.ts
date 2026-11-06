/**
 * @internal NumericKey — the key text of a `number` or `bigint` composite.
 *
 * DynamoDB compares sort keys as UTF-8 bytes, so the text must sort in numeric
 * order. Up to 1.36 it was `String(n).padStart(16, "0")` (38 for a bigint),
 * which only sorts non-negative integers below the pad width: `-3` came above
 * `-5`, `10.5` below `3.14`, `1e-7` above `3`, and `1e+21` below `1e16`.
 *
 * `x` is a magnitude `|n|`; `W` is 16 for a number and 38 for a bigint.
 *
 * | value | text | e.g. |
 * |---|---|---|
 * | `0` (and `-0`), integer `x < 10^W` | `pad_W(x)` — the 1.36 bytes | `0000000000000042` |
 * | non-integer `x < 10^W` | `pad_W(int) "." frac` | `0000000000000003.14` |
 * | `x ≥ 10^W` | `":" eee digits` | `:0161` (1e16), `:02112345` (1.2345e21) |
 * | negative, `x < 10^W` | `"-" ~pad_W(int) ["." ~frac] ":"` | `-9999999999999996.85:` (-3.14) |
 * | negative, `x ≥ 10^W` | `"-*" ~eee ~digits ":"` | `-*9838:` (-1e16) |
 * | `Infinity` / `-Infinity` | `";"` / `"-)"` | |
 *
 * `frac` is the fraction digits of the number's shortest round-trip decimal
 * (`String(n)`, written out without an exponent), so `0.1` is `.1`, not the
 * binary value's 55 digits; distinct doubles keep distinct, ordered decimals.
 * `eee` is the 3-digit decimal exponent and `digits` the significant digits
 * without trailing zeros. `~` is the 9's complement of each digit (`.` kept).
 *
 * Why it sorts: within one form, equal-width digit strings compare digit by
 * digit, and a shorter fraction is a prefix of the longer (`3` < `3.14`, since
 * the composed key continues with `#` or ends, both below `.`). Across forms
 * the leading byte decides: `-` < digits < `:` < `;`, and under `-`,
 * `)` < `*` < digits. Negatives complement the magnitude, which reverses its
 * order, and end in `:` (above every digit and `.`) so that, of two negatives
 * where one magnitude's text is a prefix of the other's (`3` and `3.1`), the
 * shorter — the larger value — sorts last.
 *
 * Every byte is above the key delimiter `#` and none is a letter, so casing
 * never changes the text and a composite's text is never cut by `#`.
 *
 * `NaN` has no order and is refused (`[EDD-9096]`, {@link KeyValueError}), as
 * is a bigint of more than 1,000 digits (past the 3-digit exponent).
 *
 * Not part of the public API.
 */

import { Data, Predicate } from "effect"

/**
 * A value key composition can't place in sort order: `NaN`, or a bigint of
 * more than 1,000 digits. Thrown synchronously by `serializeValue`; the write
 * paths turn it into a `ValidationError`.
 */
export class KeyValueError extends Data.TaggedError("KeyValueError")<{
  readonly value: unknown
  readonly reason: string
  /** Human-readable description, prefixed with `EDD-9096`. */
  readonly message: string
}> {}

/**
 * Is `u` a {@link KeyValueError}? By its tag, not `instanceof`: two copies of
 * this package (a consumer's and `effect-dynamodb`'s) still agree.
 */
export const isKeyValueError = (u: unknown): u is KeyValueError =>
  Predicate.isTagged(u, "KeyValueError")

const refuse = (value: unknown, shown: string, reason: string): never => {
  throw new KeyValueError({
    value,
    reason,
    message:
      `[EDD-9096] ${shown} can't be composed into a key: ${reason}. ` +
      `Key text must sort in the value's order, and this value has no place in it.`,
  })
}

/** Pad width of a `number`'s integer part: the 1.36 width, covering `Number.MAX_SAFE_INTEGER`. */
const NUMBER_WIDTH = 16
/** Pad width of a `bigint`: the 1.36 width, DynamoDB's 38 digits of precision. */
const BIGINT_WIDTH = 38
/** The largest exponent the 3-digit field holds (a `number` reaches 308). */
const MAX_EXPONENT = 999

const POSITIVE_INFINITY = ";"
const NEGATIVE_INFINITY = "-)"

/**
 * The shortest round-trip decimal of a positive finite double as significant
 * `digits` (no leading or trailing zeros) and `point`, the number of digits
 * before the decimal point: `x = 0.<digits> × 10^point`. `3.14` is
 * `{ digits: "314", point: 1 }`, `1e-7` is `{ digits: "1", point: -6 }`.
 */
const decimalOf = (x: number): { readonly digits: string; readonly point: number } => {
  const [mantissa = "", exponent = "0"] = String(x).split("e")
  const [int = "", frac = ""] = mantissa.split(".")
  const all = `${int}${frac}`
  const significant = all.replace(/^0+/, "")
  return {
    digits: significant.replace(/0+$/, ""),
    point: int.length + Number(exponent) - (all.length - significant.length),
  }
}

/** The text of a non-zero magnitude `0.<digits> × 10^point` at pad width `width`. */
const magnitude = (digits: string, point: number, width: number): string => {
  if (point > width) return `:${String(point - 1).padStart(3, "0")}${digits}`
  const int = point <= 0 ? "" : digits.slice(0, point).padEnd(point, "0")
  const frac = `${"0".repeat(Math.max(0, -point))}${digits.slice(Math.max(0, point))}`
  return `${int.padStart(width, "0")}${frac === "" ? "" : `.${frac}`}`
}

/** 9's complement of every digit; anything else (`.`) is kept. */
const complement = (text: string): string =>
  text.replace(/[0-9]/g, (digit) => String(9 - Number(digit)))

/** The text of `-x` from the text of magnitude `x`. */
const negate = (text: string): string =>
  text.startsWith(":") ? `-*${complement(text.slice(1))}:` : `-${complement(text)}:`

/** The key text of a `number`. Throws {@link KeyValueError} (`[EDD-9096]`) for `NaN`. */
export const encodeNumber = (n: number): string => {
  if (Number.isNaN(n)) return refuse(n, "NaN", "NaN has no numeric order")
  if (n === Number.POSITIVE_INFINITY) return POSITIVE_INFINITY
  if (n === Number.NEGATIVE_INFINITY) return NEGATIVE_INFINITY
  if (n === 0) return "0".repeat(NUMBER_WIDTH)
  const { digits, point } = decimalOf(Math.abs(n))
  const text = magnitude(digits, point, NUMBER_WIDTH)
  return n < 0 ? negate(text) : text
}

/**
 * The key text of a `bigint`. Throws {@link KeyValueError} (`[EDD-9096]`) past
 * 1,000 digits.
 */
export const encodeBigInt = (n: bigint): string => {
  if (n === 0n) return "0".repeat(BIGINT_WIDTH)
  const abs = (n < 0n ? -n : n).toString()
  if (abs.length - 1 > MAX_EXPONENT) {
    return refuse(n, `A ${abs.length}-digit bigint`, "the key encoding holds at most 1,000 digits")
  }
  const text = magnitude(abs.replace(/0+$/, ""), abs.length, BIGINT_WIDTH)
  return n < 0n ? negate(text) : text
}
