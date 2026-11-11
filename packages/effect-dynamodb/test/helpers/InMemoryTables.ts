/**
 * An in-memory DynamoDB for projection and time-series unit tests — GetItem,
 * PutItem, UpdateItem, DeleteItem, Query and TransactWriteItems (`Put`,
 * `Update`, `Delete` and `ConditionCheck` items), with condition expressions
 * evaluated: `AND` / `OR` / `NOT`, parentheses, `attribute_exists` /
 * `attribute_not_exists`, `=` / `<>` on any values, compared by content as
 * DynamoDB compares them (`sameValue`), and `<` / `<=` / `>` / `>=` on numbers,
 * strings and bytes (`#a.#b` paths included). A query's sort key condition —
 * `BETWEEN`, `begins_with` or a comparison — orders `S` keys as text and `B`
 * keys by their bytes (#171). Updates go through `MockDynamoClient.applyUpdate`;
 * one whose expression the item can't take, or a transaction naming one item
 * twice, is rejected with DynamoDB Local's `ValidationException`, as the
 * library's client reports it (`DynamoValidationError`).
 */

import type {
  AttributeValue,
  GetItemCommandInput,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import { classifyError } from "../../src/DynamoClient.js"
import {
  awsValidationException,
  DDB_REPEATED_ITEM,
  mockDynamoClientLayer,
  updateOutcome,
} from "./MockDynamoClient.js"

export type Item = Record<string, AttributeValue>

/** Every stored item, keyed `<table>|<pk>|<sk>`. */
export const store = new Map<string, Item>()
export const calls = {
  query: 0,
  getItem: 0,
  putItem: 0,
  transactWriteItems: 0,
  updateItem: 0,
  deleteItem: 0,
}
/** Every query's expression values, for asserting the range read. */
export const queried: Array<Record<string, AttributeValue>> = []
/** Every `GetItem` and `TransactWriteItems` input, for asserting request shapes. */
export const sent = {
  getItem: [] as Array<GetItemCommandInput>,
  transactWriteItems: [] as Array<TransactWriteItemsCommandInput>,
}
/** Hooks run once after the next `getItem` — a concurrent writer between read and write. */
export const hooks = { afterGet: [] as Array<(table: string) => void> }
/** Fail every conditional write, as if another writer always won. */
export const rejection = { all: false, next: 0 }
/**
 * Cancel the next `next` transactions for a `TransactionConflict` — another
 * transaction in flight on the item, as real DynamoDB reports it and DynamoDB
 * Local never does — writing nothing.
 */
export const contention = { next: 0 }

export const resetStore = () => {
  store.clear()
  resetCalls()
  hooks.afterGet = []
  rejection.all = false
  rejection.next = 0
  contention.next = 0
}

export const resetCalls = () => {
  queried.length = 0
  sent.getItem.length = 0
  sent.transactWriteItems.length = 0
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0
}

/** Key attribute names per table (default `pk` / `sk`). */
export const tableKeys = new Map<string, { readonly pk: string; readonly sk: string }>()
const keysOf = (table: string) => tableKeys.get(table) ?? { pk: "pk", sk: "sk" }

export const keyOf = (table: string, item: Item) => {
  const k = keysOf(table)
  return `${table}|${item[k.pk]?.S}|${item[k.sk]?.S}`
}

const conditionalCheckFailed = (operation: string) =>
  new DynamoError({
    operation,
    cause: Object.assign(new Error("The conditional request failed"), {
      name: "ConditionalCheckFailedException",
    }),
  })

// ---------------------------------------------------------------------------
// Condition expressions
// ---------------------------------------------------------------------------

/** `obj[key]` when `obj` holds `key` itself: never a name `Object.prototype` supplies. */
const own = <V>(obj: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(obj, key) ? obj[key] : undefined

type Token = { readonly kind: "word" | "op" | "lp" | "rp" | "comma"; readonly text: string }

const tokenize = (expression: string): Array<Token> => {
  const tokens: Array<Token> = []
  const re = /\s*(?:(\()|(\))|(,)|(<>|<=|>=|=|<|>)|([#:A-Za-z_][\w#:.]*))/y
  re.lastIndex = 0
  while (re.lastIndex < expression.length) {
    const m = re.exec(expression)
    if (m === null) break
    if (m[1]) tokens.push({ kind: "lp", text: "(" })
    else if (m[2]) tokens.push({ kind: "rp", text: ")" })
    else if (m[3]) tokens.push({ kind: "comma", text: "," })
    else if (m[4]) tokens.push({ kind: "op", text: m[4] })
    else if (m[5]) tokens.push({ kind: "word", text: m[5] })
    if (expression.slice(re.lastIndex).trim() === "") break
  }
  return tokens
}

/**
 * A DynamoDB number as sign, significant digits and the power of ten of the
 * first of them, so two spellings of one number (`1.50`, `1.5`, `15E-1`) read
 * alike and none loses digits (a number holds up to 38).
 */
const decimal = (text: string) => {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (m === null) throw new Error(`InMemoryTables: not a number ${text}`)
  const all = `${m[2]}${m[3] ?? ""}`
  const lead = all.length - all.replace(/^0+/, "").length
  const digits = all.slice(lead).replace(/0+$/, "")
  const negative = m[1] === "-" && digits !== ""
  return { negative, digits, exponent: m[2]!.length - lead + Number(m[4] ?? 0) }
}

/** Order two DynamoDB numbers by value. */
const compareNumbers = (a: string, b: string): number => {
  const [x, y] = [decimal(a), decimal(b)]
  if (x.negative !== y.negative) return x.negative ? -1 : 1
  const sign = x.negative ? -1 : 1
  if (x.digits === "" || y.digits === "") {
    return x.digits === y.digits ? 0 : sign * (x.digits === "" ? -1 : 1)
  }
  if (x.exponent !== y.exponent) return sign * (x.exponent < y.exponent ? -1 : 1)
  return sign * (x.digits < y.digits ? -1 : x.digits > y.digits ? 1 : 0)
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/** Whether two sets hold the same members, by `same`. */
const sameSet = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>, same: (x: A, y: A) => boolean) =>
  a.every((x) => b.some((y) => same(x, y))) && b.every((y) => a.some((x) => same(x, y)))

/**
 * Whether two attribute values are equal as DynamoDB compares them: by
 * content. A map by its keys and their values (in any order), a list by its
 * elements in order, a set by its members (in any order), a number by its
 * value, bytes by bytes; values of different types are never equal.
 */
export const sameValue = (a: AttributeValue, b: AttributeValue): boolean => {
  if (a.S !== undefined || b.S !== undefined) return a.S === b.S
  if (a.N !== undefined || b.N !== undefined) {
    return a.N !== undefined && b.N !== undefined && compareNumbers(a.N, b.N) === 0
  }
  if (a.B !== undefined || b.B !== undefined) {
    return a.B !== undefined && b.B !== undefined && sameBytes(a.B, b.B)
  }
  if (a.BOOL !== undefined || b.BOOL !== undefined) return a.BOOL === b.BOOL
  if (a.NULL !== undefined || b.NULL !== undefined) return a.NULL === true && b.NULL === true
  if (a.SS !== undefined || b.SS !== undefined) {
    return a.SS !== undefined && b.SS !== undefined && sameSet(a.SS, b.SS, (x, y) => x === y)
  }
  if (a.NS !== undefined || b.NS !== undefined) {
    return (
      a.NS !== undefined &&
      b.NS !== undefined &&
      sameSet(a.NS, b.NS, (x, y) => compareNumbers(x, y) === 0)
    )
  }
  if (a.BS !== undefined || b.BS !== undefined) {
    return a.BS !== undefined && b.BS !== undefined && sameSet(a.BS, b.BS, sameBytes)
  }
  if (a.L !== undefined || b.L !== undefined) {
    return (
      a.L !== undefined &&
      b.L !== undefined &&
      a.L.length === b.L.length &&
      a.L.every((x, i) => sameValue(x, b.L![i]!))
    )
  }
  if (a.M !== undefined && b.M !== undefined) {
    const [x, y] = [a.M, b.M]
    const keys = Object.keys(x)
    return (
      keys.length === Object.keys(y).length &&
      keys.every((k) => Object.hasOwn(y, k) && sameValue(x[k]!, y[k]!))
    )
  }
  return false
}

/**
 * Order two values for `<`, `<=`, `>`, `>=`: numbers by value, strings by
 * their UTF-8 bytes, bytes by bytes. `undefined` for any other pair: such a
 * comparison never holds.
 */
const order = (a: AttributeValue, b: AttributeValue): number | undefined => {
  if (a.N !== undefined && b.N !== undefined) return compareNumbers(a.N, b.N)
  if (a.S !== undefined && b.S !== undefined)
    return Buffer.compare(Buffer.from(a.S), Buffer.from(b.S))
  if (a.B !== undefined && b.B !== undefined) return compareKey(a, b)
  return undefined
}

const compare = (
  a: AttributeValue | undefined,
  b: AttributeValue | undefined,
  op: string,
): boolean => {
  if (a === undefined || b === undefined) return op === "<>" ? a !== b : false
  if (op === "=") return sameValue(a, b)
  if (op === "<>") return !sameValue(a, b)
  const ordered = order(a, b)
  if (ordered === undefined) return false
  switch (op) {
    case "<":
      return ordered < 0
    case "<=":
      return ordered <= 0
    case ">":
      return ordered > 0
    default:
      return ordered >= 0
  }
}

/** Evaluate a condition against `current` (undefined: no item). */
export const holds = (
  expression: string | undefined,
  current: Item | undefined,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
): boolean => {
  if (expression === undefined) return true
  const tokens = tokenize(expression)
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]!
  // Names are looked up as the item's (or the map's) own attributes only.
  const path = (word: string): AttributeValue | undefined => {
    const parts = word.split(".").map((p) => (p.startsWith("#") ? own(names, p)! : p))
    let v: AttributeValue | undefined = current === undefined ? undefined : own(current, parts[0]!)
    for (const p of parts.slice(1)) v = v?.M === undefined ? undefined : own(v.M, p)
    return v
  }
  const operand = (word: string): AttributeValue | undefined =>
    word.startsWith(":") ? own(values, word) : path(word)
  const primary = (): boolean => {
    const t = next()
    if (t.kind === "lp") {
      const v = or()
      next() // )
      return v
    }
    if (t.text.toUpperCase() === "NOT") return !primary()
    if (t.text === "attribute_exists" || t.text === "attribute_not_exists") {
      next() // (
      const p = next().text
      next() // )
      const exists = path(p) !== undefined
      return t.text === "attribute_exists" ? exists : !exists
    }
    if (t.text === "contains" || t.text === "begins_with") {
      next() // (
      const left = operand(next().text)
      next() // ,
      const right = operand(next().text)
      next() // )
      if (left?.S === undefined || right?.S === undefined) return false
      return t.text === "contains" ? left.S.includes(right.S) : left.S.startsWith(right.S)
    }
    if (peek()?.text.toUpperCase() === "IN") {
      next() // IN
      next() // (
      const candidates: Array<string> = []
      while (peek()?.kind !== "rp") {
        const c = next()
        if (c.kind === "word") candidates.push(c.text)
      }
      next() // )
      const left = operand(t.text)
      return candidates.some((c) => compare(left, operand(c), "="))
    }
    const op = next().text
    const right = next().text
    return compare(operand(t.text), operand(right), op)
  }
  const and = (): boolean => {
    let v = primary()
    while (peek()?.text.toUpperCase() === "AND") {
      next()
      const r = primary()
      v = v && r
    }
    return v
  }
  const or = (): boolean => {
    let v = and()
    while (peek()?.text.toUpperCase() === "OR") {
      next()
      const r = and()
      v = v || r
    }
    return v
  }
  return or()
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Order two key values as DynamoDB does: a `B` value by its bytes, unsigned
 * (#171); an `S` value as text (every key these tests store is ASCII).
 */
const compareKey = (a: AttributeValue | undefined, b: AttributeValue | undefined): number => {
  if (a?.B !== undefined && b?.B !== undefined) {
    const n = Math.min(a.B.length, b.B.length)
    for (let i = 0; i < n; i++) if (a.B[i] !== b.B[i]) return a.B[i]! - b.B[i]!
    return a.B.length - b.B.length
  }
  const x = a?.S ?? ""
  const y = b?.S ?? ""
  return x < y ? -1 : x > y ? 1 : 0
}

const startsWithKey = (value: AttributeValue | undefined, prefix: AttributeValue): boolean =>
  value?.B !== undefined && prefix.B !== undefined
    ? prefix.B.length <= value.B.length &&
      compareKey({ B: value.B.subarray(0, prefix.B.length) }, prefix) === 0
    : value?.S !== undefined && prefix.S !== undefined && value.S.startsWith(prefix.S)

const runQuery = (input: {
  readonly TableName?: string | undefined
  readonly IndexName?: string | undefined
  readonly KeyConditionExpression?: string | undefined
  readonly FilterExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
  readonly ScanIndexForward?: boolean | undefined
  readonly Limit?: number | undefined
}) => {
  const names = input.ExpressionAttributeNames ?? {}
  const values = input.ExpressionAttributeValues ?? {}
  const kc = /^(#\w+) = (:\w+)(?: AND (.*))?$/.exec(input.KeyConditionExpression ?? "")!
  const pkAttr = names[kc[1]!]!
  const pkValue = values[kc[2]!]!.S
  const keys = keysOf(input.TableName!)
  const skAttr = input.IndexName === undefined ? keys.sk : undefined
  let rows = [...store.entries()]
    .filter(([key, item]) => key.startsWith(`${input.TableName}|`) && item[pkAttr]?.S === pkValue)
    .map(([, item]) => item)
  const sortAttr = skAttr ?? Object.values(names).find((n) => n !== pkAttr) ?? keys.sk
  rows.sort((a, b) => compareKey(a[sortAttr], b[sortAttr]))
  const cond = kc[3]
  if (cond !== undefined) {
    const between = /^(#\w+) BETWEEN (:\w+) AND (:\w+)$/.exec(cond)
    const begins = /^begins_with\((#\w+), (:\w+)\)$/.exec(cond)
    const comparison = /^(#\w+) (<=|>=|=|<|>) (:\w+)$/.exec(cond)
    if (between) {
      const attr = names[between[1]!]!
      const low = values[between[2]!]!
      const high = values[between[3]!]!
      rows = rows.filter(
        (item) =>
          item[attr] !== undefined &&
          compareKey(item[attr], low) >= 0 &&
          compareKey(item[attr], high) <= 0,
      )
    } else if (begins) {
      const attr = names[begins[1]!]!
      const prefix = values[begins[2]!]!
      rows = rows.filter((item) => startsWithKey(item[attr], prefix))
    } else if (comparison) {
      const attr = names[comparison[1]!]!
      const operand = values[comparison[3]!]!
      const holdsFor = (order: number): boolean => {
        switch (comparison[2]) {
          case "=":
            return order === 0
          case "<":
            return order < 0
          case "<=":
            return order <= 0
          case ">":
            return order > 0
          default:
            return order >= 0
        }
      }
      rows = rows.filter(
        (item) => item[attr] !== undefined && holdsFor(compareKey(item[attr], operand)),
      )
    } else throw new Error(`mock: unsupported key condition ${cond}`)
  }
  if (input.FilterExpression !== undefined) {
    rows = rows.filter((item) => holds(input.FilterExpression, item, names, values))
  }
  if (input.ScanIndexForward === false) rows.reverse()
  if (input.Limit !== undefined) rows = rows.slice(0, input.Limit)
  return { Items: rows }
}

const conditionFails = (
  table: string,
  item: Item | undefined,
  key: string,
  condition: string | undefined,
  names: Record<string, string> | undefined,
  values: Record<string, AttributeValue> | undefined,
): boolean => {
  if (condition === undefined) return false
  if (rejection.all) return true
  if (rejection.next > 0) {
    rejection.next--
    return true
  }
  void table
  void item
  return !holds(condition, store.get(key), names ?? {}, values ?? {})
}

export const InMemoryClient = mockDynamoClientLayer({
  query: (input) =>
    Effect.sync(() => {
      calls.query++
      queried.push(input.ExpressionAttributeValues ?? {})
      return runQuery(input) as never
    }),
  getItem: (input) =>
    Effect.sync(() => {
      calls.getItem++
      sent.getItem.push(input)
      const item = store.get(keyOf(input.TableName!, input.Key!))
      const run = hooks.afterGet
      hooks.afterGet = []
      for (const hook of run) hook(input.TableName!)
      return (item === undefined ? {} : { Item: item }) as never
    }),
  putItem: (input) =>
    Effect.suspend(() => {
      calls.putItem++
      const key = keyOf(input.TableName!, input.Item!)
      if (
        conditionFails(
          input.TableName!,
          input.Item,
          key,
          input.ConditionExpression,
          input.ExpressionAttributeNames,
          input.ExpressionAttributeValues,
        )
      ) {
        return Effect.fail(conditionalCheckFailed("PutItem"))
      }
      store.set(key, input.Item!)
      return Effect.succeed({} as never)
    }),
  updateItem: (input) =>
    Effect.suspend(() => {
      calls.updateItem++
      const key = keyOf(input.TableName!, input.Key!)
      if (
        conditionFails(
          input.TableName!,
          undefined,
          key,
          input.ConditionExpression,
          input.ExpressionAttributeNames,
          input.ExpressionAttributeValues,
        )
      ) {
        return Effect.fail(conditionalCheckFailed("UpdateItem"))
      }
      const outcome = updateOutcome(store.get(key) ?? { ...input.Key! }, input)
      if (outcome._tag === "Refused") return Effect.fail(classifyError("UpdateItem")(outcome.error))
      store.set(key, outcome.item)
      return Effect.succeed({} as never)
    }),
  deleteItem: (input) =>
    Effect.suspend(() => {
      calls.deleteItem++
      const key = keyOf(input.TableName!, input.Key!)
      if (
        conditionFails(
          input.TableName!,
          undefined,
          key,
          input.ConditionExpression,
          input.ExpressionAttributeNames,
          input.ExpressionAttributeValues,
        )
      ) {
        return Effect.fail(conditionalCheckFailed("DeleteItem"))
      }
      store.delete(key)
      return Effect.succeed({} as never)
    }),
  transactWriteItems: (input) =>
    Effect.suspend(() => {
      calls.transactWriteItems++
      sent.transactWriteItems.push(input)
      const ops = input.TransactItems ?? []
      if (contention.next > 0) {
        contention.next--
        return Effect.fail(
          new DynamoError({
            operation: "TransactWriteItems",
            cause: Object.assign(new Error("Transaction cancelled"), {
              name: "TransactionCanceledException",
              CancellationReasons: ops.map((_, i) => ({
                Code: i === 0 ? "TransactionConflict" : "None",
              })),
            }),
          }),
        )
      }
      const keys = ops.map((op) => {
        const write = (op.Put ?? op.Update ?? op.Delete ?? op.ConditionCheck)!
        return keyOf(write.TableName!, op.Put?.Item ?? (write as { Key: Item }).Key)
      })
      if (new Set(keys).size !== keys.length) {
        return Effect.fail(
          classifyError("TransactWriteItems")(awsValidationException(DDB_REPEATED_ITEM)),
        )
      }
      // All conditions first; then every write.
      const reasons = ops.map((op, i) => {
        const write = (op.Put ?? op.Update ?? op.Delete ?? op.ConditionCheck)!
        return conditionFails(
          write.TableName!,
          op.Put?.Item,
          keys[i]!,
          write.ConditionExpression,
          write.ExpressionAttributeNames,
          write.ExpressionAttributeValues,
        )
          ? { Code: "ConditionalCheckFailed" }
          : { Code: "None" }
      })
      // An update whose condition passed but whose expression the item can't take rejects
      // the whole request, ahead of any other item's failed condition.
      const updated = ops.map((op, i) =>
        op.Update === undefined || reasons[i]!.Code !== "None"
          ? undefined
          : updateOutcome(store.get(keys[i]!) ?? { ...op.Update.Key! }, op.Update),
      )
      const refusal = updated.find((outcome) => outcome?._tag === "Refused")
      if (refusal?._tag === "Refused") {
        return Effect.fail(classifyError("TransactWriteItems")(refusal.error))
      }
      if (reasons.some((r) => r.Code !== "None")) {
        return Effect.fail(
          new DynamoError({
            operation: "TransactWriteItems",
            cause: Object.assign(new Error("Transaction cancelled"), {
              name: "TransactionCanceledException",
              CancellationReasons: reasons,
            }),
          }),
        )
      }
      for (const [i, op] of ops.entries()) {
        const outcome = updated[i]
        if (op.Put?.Item !== undefined) store.set(keys[i]!, op.Put.Item)
        if (outcome?._tag === "Updated") store.set(keys[i]!, outcome.item)
        if (op.Delete !== undefined) store.delete(keys[i]!)
      }
      return Effect.succeed({} as never)
    }),
})
