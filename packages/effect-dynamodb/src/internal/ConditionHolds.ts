/**
 * Whether a condition expression holds on a stored item, as DynamoDB evaluates it (#238).
 *
 * A write refused for more than one reason at once comes back with one verdict and the stored
 * item (`ReturnValuesOnConditionCheckFailure: ALL_OLD`). Where the library adds a guard of its own
 * beside the caller's condition, this tells the two apart without another request: the caller's
 * parts are judged against the item the refusal returned, and the caller's verdict wins.
 *
 * It reads the grammar DynamoDB documents for a `ConditionExpression`: comparisons (`=`, `<>`, `<`,
 * `<=`, `>`, `>=`), `BETWEEN`, `IN`, the functions `attribute_exists`, `attribute_not_exists`,
 * `attribute_type`, `begins_with`, `contains` and `size`, and `NOT` / `AND` / `OR` with
 * parentheses, `NOT` binding tighter than `AND`, and `AND` than `OR`. It answers as DynamoDB does
 * (`test/connected.condition-holds.test.ts` checks every case against DynamoDB Local): an operand
 * naming nothing makes a comparison false, except `<>`, which it makes true; values of different
 * types are never equal and never ordered; numbers compare by value, strings by their UTF-8 bytes,
 * sets as sets. `undefined` where it can't say: text it doesn't read, a request DynamoDB would
 * refuse, or a `size()` of a string beyond ASCII whose answer depends on how its length is counted.
 *
 * DynamoDB documents a string's `size()` as "the length of the string" without saying in what.
 * DynamoDB Local counts UTF-16 code units (`connected.condition-holds.test.ts` pins it: `"é"` is 1,
 * `"😀"` is 2). The evaluator answers by every count a length could be taken in — UTF-16 code
 * units, code points and UTF-8 bytes — and only where they all give the same answer: `size(s) = 0`
 * on `"é"` is false whichever DynamoDB uses, `size(s) = 1` can't be told.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"

type Item = Readonly<Record<string, AttributeValue>>
type Segment = string | number

type Token =
  | { readonly _tag: "punct"; readonly text: "(" | ")" | "," }
  | { readonly _tag: "comparator"; readonly text: "=" | "<>" | "<" | "<=" | ">" | ">=" }
  | { readonly _tag: "word"; readonly text: string }
  | { readonly _tag: "value"; readonly text: string }
  | { readonly _tag: "path"; readonly segments: ReadonlyArray<Segment> }

const tokenize = (
  expression: string,
  names: Readonly<Record<string, string>>,
): ReadonlyArray<Token> | undefined => {
  const tokens: Array<Token> = []
  let at = 0
  const name = /[A-Za-z_][A-Za-z0-9_]*/y
  const alias = /#[A-Za-z0-9_]+/y
  const placeholder = /:[A-Za-z0-9_]+/y
  const index = /\[(\d+)\]/y
  while (at < expression.length) {
    const char = expression[at]!
    if (/\s/.test(char)) {
      at++
      continue
    }
    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ _tag: "punct", text: char })
      at++
      continue
    }
    const two = expression.slice(at, at + 2)
    if (two === "<>" || two === "<=" || two === ">=") {
      tokens.push({ _tag: "comparator", text: two })
      at += 2
      continue
    }
    if (char === "=" || char === "<" || char === ">") {
      tokens.push({ _tag: "comparator", text: char })
      at++
      continue
    }
    if (char === ":") {
      placeholder.lastIndex = at
      const found = placeholder.exec(expression)
      if (found === null) return undefined
      tokens.push({ _tag: "value", text: found[0] })
      at += found[0].length
      continue
    }
    // A path: names (`#alias` or plain), joined by `.`, each followed by any `[n]`.
    const segments: Array<Segment> = []
    let word: string | undefined
    for (;;) {
      let segment: string | undefined
      if (expression[at] === "#") {
        alias.lastIndex = at
        const found = alias.exec(expression)
        if (found === null) return undefined
        if (!Object.hasOwn(names, found[0])) return undefined
        segment = names[found[0]]!
        at += found[0].length
      } else {
        name.lastIndex = at
        const found = name.exec(expression)
        if (found === null) return undefined
        segment = found[0]
        if (segments.length === 0) word = segment
        at += found[0].length
      }
      segments.push(segment)
      for (;;) {
        index.lastIndex = at
        const found = index.exec(expression)
        if (found === null) break
        segments.push(Number(found[1]))
        word = undefined
        at += found[0].length
      }
      if (expression[at] !== ".") break
      word = undefined
      at++
    }
    // A plain name alone may be a keyword or a function: the parser decides by what follows.
    if (word !== undefined && segments.length === 1) tokens.push({ _tag: "word", text: word })
    else tokens.push({ _tag: "path", segments })
  }
  return tokens
}

/** Three-valued: `undefined` is "can't say". */
type Verdict = boolean | undefined

const and = (verdicts: ReadonlyArray<Verdict>): Verdict =>
  verdicts.includes(false) ? false : verdicts.includes(undefined) ? undefined : true
const or = (verdicts: ReadonlyArray<Verdict>): Verdict =>
  verdicts.includes(true) ? true : verdicts.includes(undefined) ? undefined : false

/** An operand's value: absent (`undefined`), unknown (`"unknown"`), or a value. */
type Operand = AttributeValue | undefined | "unknown"

class Unreadable extends Error {}

const KEYWORDS = new Set(["AND", "OR", "NOT", "BETWEEN", "IN"])
const FUNCTIONS = new Set([
  "attribute_exists",
  "attribute_not_exists",
  "attribute_type",
  "begins_with",
  "contains",
  "size",
])

const at = (item: Item, segments: ReadonlyArray<Segment>): AttributeValue | undefined => {
  const top = segments[0] as string
  let value: AttributeValue | undefined = Object.hasOwn(item, top) ? item[top] : undefined
  for (const segment of segments.slice(1)) {
    if (value === undefined) return undefined
    if (typeof segment === "number") {
      value = value.L === undefined ? undefined : value.L[segment]
    } else {
      value =
        value.M === undefined || !Object.hasOwn(value.M, segment) ? undefined : value.M[segment]
    }
  }
  return value
}

const kindOf = (value: AttributeValue): string => Object.keys(value)[0]!

const utf8 = new TextEncoder()
const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

/** A decimal as sign, significant digits and the power of ten of the first digit. */
const decimal = (text: string) => {
  const parsed = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (parsed === null) return undefined
  const whole = parsed[2] ?? ""
  const fraction = parsed[3] ?? ""
  const all = `${whole}${fraction}`
  const lead = all.search(/[1-9]/)
  if (lead < 0) return { sign: 0, digits: "", power: 0 }
  const digits = all.slice(lead).replace(/0+$/, "")
  const power = whole.length - lead + Number(parsed[4] ?? 0)
  return { sign: parsed[1] === "-" ? -1 : 1, digits, power }
}
const compareNumbers = (a: string, b: string): number | undefined => {
  const x = decimal(a)
  const y = decimal(b)
  if (x === undefined || y === undefined) return undefined
  if (x.sign !== y.sign) return x.sign - y.sign
  if (x.sign === 0) return 0
  const magnitude =
    x.power !== y.power
      ? x.power - y.power
      : x.digits.padEnd(y.digits.length, "0") < y.digits.padEnd(x.digits.length, "0")
        ? -1
        : x.digits.padEnd(y.digits.length, "0") > y.digits.padEnd(x.digits.length, "0")
          ? 1
          : 0
  return x.sign * Math.sign(magnitude)
}

const bytesOf = (value: unknown): Uint8Array | undefined =>
  value instanceof Uint8Array ? value : undefined

/** Two values' order, for values of one ordered type (`N`, `S`, `B`); `undefined` otherwise. */
const order = (a: AttributeValue, b: AttributeValue): number | undefined => {
  if (a.N !== undefined && b.N !== undefined) return compareNumbers(a.N, b.N)
  if (a.S !== undefined && b.S !== undefined) {
    return compareBytes(utf8.encode(a.S), utf8.encode(b.S))
  }
  const x = bytesOf(a.B)
  const y = bytesOf(b.B)
  if (x !== undefined && y !== undefined) return compareBytes(x, y)
  return undefined
}

const sameMembers = <A>(
  xs: ReadonlyArray<A>,
  ys: ReadonlyArray<A>,
  same: (x: A, y: A) => boolean,
): boolean =>
  xs.length === ys.length &&
  xs.every((x) => ys.some((y) => same(x, y))) &&
  ys.every((y) => xs.some((x) => same(x, y)))

/** DynamoDB's equality: one type, numbers by value, sets as sets. */
const equal = (a: AttributeValue, b: AttributeValue): boolean | undefined => {
  const kind = kindOf(a)
  if (kind !== kindOf(b)) return false
  switch (kind) {
    case "N":
    case "S":
    case "B": {
      const found = order(a, b)
      return found === undefined ? undefined : found === 0
    }
    case "BOOL":
      return a.BOOL === b.BOOL
    case "NULL":
      return true
    case "SS":
      return sameMembers(a.SS!, b.SS!, (x, y) => x === y)
    case "NS":
      return sameMembers(a.NS!, b.NS!, (x, y) => compareNumbers(x, y) === 0)
    case "BS":
      return sameMembers(
        a.BS!.map(bytesOf),
        b.BS!.map(bytesOf),
        (x, y) => x !== undefined && y !== undefined && compareBytes(x, y) === 0,
      )
    case "L": {
      const xs = a.L!
      const ys = b.L!
      if (xs.length !== ys.length) return false
      return and(xs.map((x, i) => equal(x, ys[i]!))) as boolean | undefined
    }
    case "M": {
      const xm = a.M!
      const ym = b.M!
      const keys = Object.keys(xm)
      if (keys.length !== Object.keys(ym).length) return false
      if (!keys.every((key) => Object.hasOwn(ym, key))) return false
      return and(keys.map((key) => equal(xm[key]!, ym[key]!))) as boolean | undefined
    }
    default:
      return undefined
  }
}

/** The ways a string's length could be counted: UTF-16 code units, code points, UTF-8 bytes. */
type Count = (text: string) => number
const COUNTS: ReadonlyArray<Count> = [
  (text) => text.length,
  (text) => [...text].length,
  (text) => utf8.encode(text).length,
]

/**
 * `size()` of a value: `undefined` for one without a size (a number, boolean or null, which a
 * comparison reads as absent); a string's length as `count` takes it.
 */
const sizeOf = (value: AttributeValue, count: Count): number | undefined | "unknown" => {
  if (value.S !== undefined) return count(value.S)
  if (value.B !== undefined) return bytesOf(value.B)?.length ?? "unknown"
  if (value.SS !== undefined) return value.SS.length
  if (value.NS !== undefined) return value.NS.length
  if (value.BS !== undefined) return value.BS.length
  if (value.L !== undefined) return value.L.length
  if (value.M !== undefined) return Object.keys(value.M).length
  return undefined
}

export const conditionHolds = (
  expression: string,
  item: Item,
  names: Readonly<Record<string, string>>,
  values: Readonly<Record<string, AttributeValue>>,
): boolean | undefined => {
  const tokens = tokenize(expression, names)
  if (tokens === undefined) return undefined
  const verdicts = COUNTS.map((count) => evaluate(tokens, item, values, count))
  return verdicts.every((verdict) => verdict === verdicts[0]) ? verdicts[0] : undefined
}

const evaluate = (
  tokens: ReadonlyArray<Token>,
  item: Item,
  values: Readonly<Record<string, AttributeValue>>,
  count: Count,
): Verdict => {
  let next = 0
  const peek = () => tokens[next]
  const take = () => {
    const token = tokens[next++]
    if (token === undefined) throw new Unreadable()
    return token
  }
  const expect = (text: string) => {
    const token = take()
    if (!("text" in token) || token.text !== text) throw new Unreadable()
  }
  const isWord = (token: Token | undefined, text: string) =>
    token?._tag === "word" && token.text.toUpperCase() === text
  const pathOf = (token: Token): ReadonlyArray<Segment> => {
    if (token._tag === "path") return token.segments
    if (token._tag === "word" && !KEYWORDS.has(token.text.toUpperCase())) return [token.text]
    throw new Unreadable()
  }
  const valueOf = (text: string): AttributeValue => {
    if (!Object.hasOwn(values, text)) throw new Unreadable()
    return values[text]!
  }

  const operand = (): Operand => {
    const token = take()
    if (token._tag === "value") return valueOf(token.text)
    if (token._tag === "word" && token.text === "size" && peek()?._tag === "punct") {
      expect("(")
      const path = pathOf(take())
      expect(")")
      const held = at(item, path)
      if (held === undefined) return undefined
      const size = sizeOf(held, count)
      return typeof size === "number" ? { N: String(size) } : size
    }
    return at(item, pathOf(token))
  }

  const compare = (op: string, a: Operand, b: Operand): Verdict => {
    if (a === "unknown" || b === "unknown") return undefined
    if (a === undefined || b === undefined) return op === "<>"
    if (op === "=") return equal(a, b)
    if (op === "<>") {
      const same = equal(a, b)
      return same === undefined ? undefined : !same
    }
    if (kindOf(a) !== kindOf(b)) return false
    const found = order(a, b)
    if (found === undefined) return ["N", "S", "B"].includes(kindOf(a)) ? undefined : false
    return op === "<" ? found < 0 : op === "<=" ? found <= 0 : op === ">" ? found > 0 : found >= 0
  }

  const functionCall = (fn: string): Verdict => {
    expect("(")
    if (fn === "attribute_exists" || fn === "attribute_not_exists") {
      const held = at(item, pathOf(take()))
      expect(")")
      return fn === "attribute_exists" ? held !== undefined : held === undefined
    }
    const held = fn === "attribute_type" ? at(item, pathOf(take())) : operand()
    expect(",")
    const given = operand()
    expect(")")
    if (held === "unknown" || given === "unknown") return undefined
    if (held === undefined || given === undefined) return false
    if (fn === "attribute_type") {
      return given.S === undefined ? undefined : kindOf(held) === given.S
    }
    if (fn === "begins_with") {
      if (held.S !== undefined && given.S !== undefined) return held.S.startsWith(given.S)
      const x = bytesOf(held.B)
      const y = bytesOf(given.B)
      if (x !== undefined && y !== undefined) {
        return y.length <= x.length && compareBytes(x.subarray(0, y.length), y) === 0
      }
      return false
    }
    // contains
    if (held.S !== undefined) return given.S === undefined ? false : held.S.includes(given.S)
    if (held.SS !== undefined || held.NS !== undefined || held.BS !== undefined) {
      const members: ReadonlyArray<AttributeValue> =
        held.SS?.map((S) => ({ S })) ?? held.NS?.map((N) => ({ N })) ?? held.BS!.map((B) => ({ B }))
      return or(members.map((member) => equal(member, given)))
    }
    if (held.L !== undefined) return or(held.L.map((element) => equal(element, given)))
    return false
  }

  const primary = (): Verdict => {
    const token = peek()
    if (token?._tag === "punct" && token.text === "(") {
      take()
      const inner = disjunction()
      expect(")")
      return inner
    }
    if (
      token?._tag === "word" &&
      FUNCTIONS.has(token.text) &&
      token.text !== "size" &&
      tokens[next + 1]?._tag === "punct"
    ) {
      take()
      return functionCall(token.text)
    }
    const left = operand()
    const after = take()
    if (after._tag === "comparator") return compare(after.text, left, operand())
    if (isWord(after, "BETWEEN")) {
      const low = operand()
      if (!isWord(take(), "AND")) throw new Unreadable()
      const high = operand()
      // DynamoDB refuses bounds out of order as a request.
      if (low !== undefined && low !== "unknown" && high !== undefined && high !== "unknown") {
        const bounds = order(low, high)
        if (bounds !== undefined && bounds > 0) return undefined
      }
      return and([compare(">=", left, low), compare("<=", left, high)])
    }
    if (isWord(after, "IN")) {
      expect("(")
      const options: Array<Operand> = [operand()]
      while (peek()?._tag === "punct" && (peek() as { text: string }).text === ",") {
        take()
        options.push(operand())
      }
      expect(")")
      return or(options.map((option) => compare("=", left, option)))
    }
    throw new Unreadable()
  }
  const negation = (): Verdict => {
    if (isWord(peek(), "NOT")) {
      take()
      const inner = negation()
      return inner === undefined ? undefined : !inner
    }
    return primary()
  }
  const conjunction = (): Verdict => {
    const verdicts = [negation()]
    while (isWord(peek(), "AND")) {
      take()
      verdicts.push(negation())
    }
    return and(verdicts)
  }
  const disjunction = (): Verdict => {
    const verdicts = [conjunction()]
    while (isWord(peek(), "OR")) {
      take()
      verdicts.push(conjunction())
    }
    return or(verdicts)
  }
  try {
    const verdict = disjunction()
    return next === tokens.length ? verdict : undefined
  } catch (error) {
    if (error instanceof Unreadable) return undefined
    throw error
  }
}
