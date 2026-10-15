/**
 * An in-memory DynamoDB for projection unit tests — the operations the
 * projection engine issues (GetItem, PutItem, UpdateItem, DeleteItem, Query,
 * TransactWriteItems), with condition expressions evaluated: `AND` / `OR` /
 * `NOT`, parentheses, `attribute_exists` / `attribute_not_exists`, and
 * `=` / `<>` / `<` / `<=` / `>` / `>=` on scalar attributes (`#a.#b` paths
 * included).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import { mockDynamoClientLayer } from "./MockDynamoClient.js"

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
/** Hooks run once after the next `getItem` — a concurrent writer between read and write. */
export const hooks = { afterGet: [] as Array<(table: string) => void> }
/** Fail every conditional write, as if another writer always won. */
export const rejection = { all: false, next: 0 }

export const resetStore = () => {
  store.clear()
  resetCalls()
  hooks.afterGet = []
  rejection.all = false
  rejection.next = 0
}

export const resetCalls = () => {
  queried.length = 0
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

const compare = (
  a: AttributeValue | undefined,
  b: AttributeValue | undefined,
  op: string,
): boolean => {
  if (a === undefined || b === undefined) return op === "<>" ? a !== b : false
  const av = a.N !== undefined ? Number(a.N) : a.S !== undefined ? a.S : JSON.stringify(a)
  const bv = b.N !== undefined ? Number(b.N) : b.S !== undefined ? b.S : JSON.stringify(b)
  switch (op) {
    case "=":
      return av === bv
    case "<>":
      return av !== bv
    case "<":
      return av < bv
    case "<=":
      return av <= bv
    case ">":
      return av > bv
    default:
      return av >= bv
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
  const path = (word: string): AttributeValue | undefined => {
    const parts = word.split(".").map((p) => (p.startsWith("#") ? names[p]! : p))
    let v: AttributeValue | undefined = current?.[parts[0]!]
    for (const p of parts.slice(1)) v = v?.M?.[p]
    return v
  }
  const operand = (word: string): AttributeValue | undefined =>
    word.startsWith(":") ? values[word] : path(word)
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
  rows.sort((a, b) => {
    const x = a[sortAttr]?.S ?? ""
    const y = b[sortAttr]?.S ?? ""
    return x < y ? -1 : x > y ? 1 : 0
  })
  const cond = kc[3]
  if (cond !== undefined) {
    const between = /^(#\w+) BETWEEN (:\w+) AND (:\w+)$/.exec(cond)
    const begins = /^begins_with\((#\w+), (:\w+)\)$/.exec(cond)
    if (between) {
      const attr = names[between[1]!]!
      const low = values[between[2]!]!.S!
      const high = values[between[3]!]!.S!
      rows = rows.filter((item) => item[attr]!.S! >= low && item[attr]!.S! <= high)
    } else if (begins) {
      const attr = names[begins[1]!]!
      rows = rows.filter((item) => item[attr]?.S?.startsWith(values[begins[2]!]!.S!))
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

const applyUpdate = (
  current: Item,
  expression: string,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
): Item => {
  const next: Item = { ...current }
  const set = /SET (.*?)(?: REMOVE |$)/.exec(expression)
  const remove = /REMOVE (.*)$/.exec(expression)
  if (set) {
    for (const assignment of set[1]!.split(",")) {
      const [l, r] = assignment.split("=").map((x) => x.trim())
      next[names[l!]!] = values[r!]!
    }
  }
  if (remove) {
    for (const n of remove[1]!.split(",")) delete next[names[n.trim()]!]
  }
  return next
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
      const current = store.get(key) ?? { ...input.Key! }
      store.set(
        key,
        applyUpdate(
          current,
          input.UpdateExpression!,
          input.ExpressionAttributeNames ?? {},
          input.ExpressionAttributeValues ?? {},
        ),
      )
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
      const ops = input.TransactItems ?? []
      // All conditions first; then every write.
      const reasons = ops.map((op) => {
        const put = op.Put
        if (put === undefined) return { Code: "None" }
        const key = keyOf(put.TableName!, put.Item!)
        return conditionFails(
          put.TableName!,
          put.Item,
          key,
          put.ConditionExpression,
          put.ExpressionAttributeNames,
          put.ExpressionAttributeValues,
        )
          ? { Code: "ConditionalCheckFailed" }
          : { Code: "None" }
      })
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
      for (const op of ops) {
        if (op.Put?.Item !== undefined)
          store.set(keyOf(op.Put.TableName!, op.Put.Item), op.Put.Item)
      }
      return Effect.succeed({} as never)
    }),
})
