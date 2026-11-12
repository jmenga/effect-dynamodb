/**
 * The in-memory tables the unit tests run on, against DynamoDB Local (#243).
 *
 * `helpers/RecordingTable.ts` and `helpers/InMemoryTables.ts` answer every request through
 * `helpers/DynamoExpressions.ts`, as DynamoDB Local answers it. Each row here sends one request, on
 * the same stored items, to DynamoDB Local, to the recording table and (for the operations it
 * serves) to `InMemoryClient`, and compares the answers: the output, or the error's name, message,
 * cancellation reasons and returned item, and every item each table holds afterwards. A condition
 * row is also put to `holds` itself. Numbers are compared as spelled, sets in any order, a scan's
 * and a batch read's items in any order.
 *
 * Rows the tables answer differently on purpose are in `KNOWN`, each with its reason, and each is
 * asserted still to differ (and one that differs only in how a number is spelled, to agree by
 * value): the number of differences is the number of entries there.
 *
 * - updates: every update action and operand, numbers, sets, list indexes, overlapping paths, the
 *   grammar's spacing, case and clause order, and refusals;
 * - the order in which DynamoDB Local reports one of several problems in one update;
 * - conditions, through a `DeleteItem` and through `holds`: comparisons across types, numbers,
 *   strings, bytes, sets, lists, maps, functions, list-index paths and refusals;
 * - transactions and batches: items taken in order, a repeated item, a failed condition, a refused
 *   update, one key in two tables, keys whose text would join to the same text;
 * - key and request checks, unused and undefined placeholders, return values, queries on the
 *   table and on a secondary index, scans, a top-level `__proto__` attribute;
 * - every reserved word, as an attribute name;
 * - the absent sparse-map entry operations `SparseEntryOps.test.ts` runs (refused, and written
 *   whole), through the library on DynamoDB Local and on the recording table.
 *
 * Run: `pnpm --filter effect-dynamodb test:connected` with DynamoDB Local on `DYNAMODB_ENDPOINT`.
 */

import {
  type AttributeValue,
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { SecureRandom } from "effect/crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Lib from "../src/index.js"
import { asRead, holds, isRefusal, reservedWords } from "./helpers/DynamoExpressions.js"
import {
  InMemoryClient,
  resetStore,
  store,
  keyOf as storeKey,
  tableIndexes,
} from "./helpers/InMemoryTables.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { entryOps, primaryKey } from "./helpers/SparseEntryOps.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)
const dynamoAvailable = await fetch(ENDPOINT, {
  method: "POST",
  signal: AbortSignal.timeout(1000),
}).then(
  () => true,
  () => false,
)
const describeConnected = dynamoAvailable ? describe : describe.skip

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const stamp = Date.now()

type Item = Record<string, AttributeValue>
const N = (v: string): AttributeValue => ({ N: v })
const S = (v: string): AttributeValue => ({ S: v })
const bytes = (...values: Array<number>) => new Uint8Array(values)

// ---------------------------------------------------------------------------
// The tables, and what a row is
// ---------------------------------------------------------------------------

/** The tables' names, the same on DynamoDB Local and in the helpers. Rows name them `$T` / `$T2`. */
const TABLES: Readonly<Record<string, string>> = {
  $T: `conformance-${stamp}`,
  $T2: `conformance-${stamp}-two`,
}
type TableName = "$T" | "$T2"
/** `$T`'s secondary index. */
const INDEXES = { gsi1: { pk: "gpk", sk: "gsk" } }

const COMMANDS = {
  GetItem: GetItemCommand,
  PutItem: PutItemCommand,
  UpdateItem: UpdateItemCommand,
  DeleteItem: DeleteItemCommand,
  Query: QueryCommand,
  Scan: ScanCommand,
  BatchGetItem: BatchGetItemCommand,
  BatchWriteItem: BatchWriteItemCommand,
  TransactGetItems: TransactGetItemsCommand,
  TransactWriteItems: TransactWriteItemsCommand,
} as const
type Command = keyof typeof COMMANDS
const METHODS: Record<Command, string> = {
  GetItem: "getItem",
  PutItem: "putItem",
  UpdateItem: "updateItem",
  DeleteItem: "deleteItem",
  Query: "query",
  Scan: "scan",
  BatchGetItem: "batchGetItem",
  BatchWriteItem: "batchWriteItem",
  TransactGetItems: "transactGetItems",
  TransactWriteItems: "transactWriteItems",
}
/** The operations `InMemoryClient` serves. */
const IN_MEMORY: ReadonlySet<Command> = new Set<Command>([
  "GetItem",
  "PutItem",
  "UpdateItem",
  "DeleteItem",
  "Query",
  "TransactWriteItems",
])

interface Seed {
  readonly table: TableName
  readonly item: Item
}

interface Row {
  readonly label: string
  readonly command: Command
  /** The request, naming its tables `$T` / `$T2`. */
  readonly input: Record<string, unknown>
  /** The items stored before the request. */
  readonly seed: ReadonlyArray<Seed>
  /** For a condition row: the condition, as `holds` is asked about it. */
  readonly condition?: {
    readonly expression: string
    readonly item: Item | undefined
    readonly names: Record<string, string>
    readonly values: Record<string, AttributeValue>
  }
}

/** A copy of `value` naming the tables by their names (keys and strings `$T` / `$T2`). */
const tableNamed = (text: string) => (Object.hasOwn(TABLES, text) ? TABLES[text]! : text)
const named = (value: unknown): any => {
  if (typeof value === "string") return tableNamed(value)
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value)) return value.map(named)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.getOwnPropertyNames(value).map((key) => [
        tableNamed(key),
        named((value as Record<string, unknown>)[key]),
      ]),
    )
  }
  return value
}

const seeded = (items: ReadonlyArray<Item>, table: TableName = "$T"): ReadonlyArray<Seed> =>
  items.map((item) => ({ table, item }))

/** The placeholders `text` names, as attribute names: `#a` names `a`. */
const namesIn = (text: string): Record<string, string> =>
  Object.fromEntries([...text.matchAll(/#(\w+)/g)].map((match) => [`#${match[1]}`, match[1]!]))
/** The values `text` names, from `values`. */
const valuesIn = (
  text: string,
  values: Record<string, AttributeValue>,
): Record<string, AttributeValue> =>
  Object.fromEntries(
    Object.entries(values).filter(([key]) => new RegExp(`${key}(?!\\w)`).test(text)),
  )
const show = (value: unknown) =>
  JSON.stringify(value, (_key, held) =>
    held instanceof Uint8Array ? `0x${Buffer.from(held).toString("hex")}` : held,
  )
const placeholders = (
  names: Record<string, string>,
  values: Record<string, AttributeValue> | undefined,
) => ({
  ...(Object.keys(names).length > 0 && { ExpressionAttributeNames: names }),
  ...(values !== undefined &&
    Object.keys(values).length > 0 && { ExpressionAttributeValues: values }),
})

// ---------------------------------------------------------------------------
// Updates and conditions on one item
// ---------------------------------------------------------------------------

const KEY: Item = { pk: S("p"), sk: S("s") }
const SEED: Item = {
  ...KEY,
  n: N("5"),
  big: N("9007199254740993"),
  dec: N("0.1"),
  s: S("x"),
  m: { M: { k: N("1"), l: { L: [N("1"), N("2")] }, inner: { M: {} } } },
  l: { L: [N("1"), N("2"), { M: { a: N("1") } }] },
  ss: { SS: ["a", "b"] },
  ns: { NS: ["1", "2"] },
  bs: { BS: [bytes(1), bytes(2)] },
  b: { B: bytes(1, 2) },
  nul: { NULL: true },
  bool: { BOOL: true },
  version: N("1"),
}
const names = (...ns: Array<string>) => Object.fromEntries(ns.map((n) => [`#${n}`, n]))

/** An update of `SEED` (`seed: null`: of an item that isn't there). */
interface Case {
  readonly label: string
  readonly seed?: Item | null
  readonly expr: string
  readonly names: Record<string, string>
  readonly values?: Record<string, AttributeValue>
  readonly cond?: string
}

const updateRow = (c: Case): Row => ({
  label: `update: ${c.label}`,
  command: "UpdateItem",
  input: {
    TableName: "$T",
    Key: KEY,
    UpdateExpression: c.expr,
    ExpressionAttributeNames: c.names,
    ...(c.values === undefined ? {} : { ExpressionAttributeValues: c.values }),
    ...(c.cond === undefined ? {} : { ConditionExpression: c.cond }),
  },
  seed: c.seed === null ? [] : seeded([c.seed ?? SEED]),
})

const U: Array<Case> = [
  {
    label: "SET a = a - n (missing)",
    expr: "SET #a = #a - :n",
    names: names("a"),
    values: { ":n": N("1") },
  },
  {
    label: "SET big = big + 1",
    expr: "SET #big = #big + :n",
    names: names("big"),
    values: { ":n": N("1") },
  },
  {
    label: "SET dec = dec + 0.2",
    expr: "SET #dec = #dec + :n",
    names: names("dec"),
    values: { ":n": N("0.2") },
  },
  {
    label: "SET n = n + 1e30",
    expr: "SET #n = #n + :n",
    names: names("n"),
    values: { ":n": N("1e30") },
  },
  {
    label: "SET n = n - 5 (zero)",
    expr: "SET #n = #n - :n",
    names: names("n"),
    values: { ":n": N("5") },
  },
  {
    label: "SET m.x.y = v (missing mid)",
    expr: "SET #m.#x.#y = :v",
    names: names("m", "x", "y"),
    values: { ":v": N("1") },
  },
  {
    label: "SET m.k.y = v (below number)",
    expr: "SET #m.#k.#y = :v",
    names: names("m", "k", "y"),
    values: { ":v": N("1") },
  },
  {
    label: "SET m.x = v (new key)",
    expr: "SET #m.#x = :v",
    names: names("m", "x"),
    values: { ":v": N("1") },
  },
  {
    label: "SET l[5] = v (beyond)",
    expr: "SET #l[5] = :v",
    names: names("l"),
    values: { ":v": N("9") },
  },
  { label: "SET l[1] = v", expr: "SET #l[1] = :v", names: names("l"), values: { ":v": N("9") } },
  {
    label: "SET l[2].a = v",
    expr: "SET #l[2].#a = :v",
    names: names("l", "a"),
    values: { ":v": N("9") },
  },
  {
    label: "SET l[0].a = v (elem is number)",
    expr: "SET #l[0].#a = :v",
    names: names("l", "a"),
    values: { ":v": N("9") },
  },
  {
    label: "SET m[0] = v (index into map)",
    expr: "SET #m[0] = :v",
    names: names("m"),
    values: { ":v": N("9") },
  },
  {
    label: "SET l.a = v (name into list)",
    expr: "SET #l.#a = :v",
    names: names("l", "a"),
    values: { ":v": N("9") },
  },
  {
    label: "SET zz[0] = v (missing list)",
    expr: "SET #zz[0] = :v",
    names: names("zz"),
    values: { ":v": N("9") },
  },
  {
    label: "SET s[0] = v (index into string)",
    expr: "SET #s[0] = :v",
    names: names("s"),
    values: { ":v": N("9") },
  },
  { label: "REMOVE m.x.y (missing mid)", expr: "REMOVE #m.#x.#y", names: names("m", "x", "y") },
  { label: "REMOVE zz.y (missing top)", expr: "REMOVE #zz.#y", names: names("zz", "y") },
  { label: "REMOVE l[7]", expr: "REMOVE #l[7]", names: names("l") },
  { label: "REMOVE l[0]", expr: "REMOVE #l[0]", names: names("l") },
  { label: "REMOVE l[0], l[1]", expr: "REMOVE #l[0], #l[1]", names: names("l") },
  { label: "REMOVE m.zz", expr: "REMOVE #m.#zz", names: names("m", "zz") },
  { label: "REMOVE zz", expr: "REMOVE #zz", names: names("zz") },
  { label: "REMOVE n.y (below number)", expr: "REMOVE #n.#y", names: names("n", "y") },
  { label: "REMOVE zz[0] (missing list)", expr: "REMOVE #zz[0]", names: names("zz") },
  { label: "REMOVE m[0] (index into map)", expr: "REMOVE #m[0]", names: names("m") },
  { label: "REMOVE l.a (name into list)", expr: "REMOVE #l.#a", names: names("l", "a") },
  { label: "ADD zz 1", expr: "ADD #zz :n", names: names("zz"), values: { ":n": N("1") } },
  { label: "ADD m.zz 1", expr: "ADD #m.#zz :n", names: names("m", "zz"), values: { ":n": N("1") } },
  { label: "ADD m.k 1", expr: "ADD #m.#k :n", names: names("m", "k"), values: { ":n": N("1") } },
  {
    label: "ADD zz.k 1 (missing parent)",
    expr: "ADD #zz.#k :n",
    names: names("zz", "k"),
    values: { ":n": N("1") },
  },
  {
    label: "ADD n.k 1 (below number)",
    expr: "ADD #n.#k :n",
    names: names("n", "k"),
    values: { ":n": N("1") },
  },
  { label: "ADD big 1", expr: "ADD #big :n", names: names("big"), values: { ":n": N("1") } },
  { label: "ADD dec 0.2", expr: "ADD #dec :n", names: names("dec"), values: { ":n": N("0.2") } },
  { label: "ADD s 1", expr: "ADD #s :n", names: names("s"), values: { ":n": N("1") } },
  {
    label: "ADD ss {a,c}",
    expr: "ADD #ss :v",
    names: names("ss"),
    values: { ":v": { SS: ["a", "c"] } },
  },
  { label: "ADD ss NS", expr: "ADD #ss :v", names: names("ss"), values: { ":v": { NS: ["1"] } } },
  {
    label: "ADD ns {1.0,3}",
    expr: "ADD #ns :v",
    names: names("ns"),
    values: { ":v": { NS: ["1.0", "3"] } },
  },
  { label: "ADD zz SS", expr: "ADD #zz :v", names: names("zz"), values: { ":v": { SS: ["a"] } } },
  { label: "ADD n SS", expr: "ADD #n :v", names: names("n"), values: { ":v": { SS: ["a"] } } },
  {
    label: "ADD bs BS",
    expr: "ADD #bs :v",
    names: names("bs"),
    values: { ":v": { BS: [new Uint8Array([3])] } },
  },
  { label: "ADD l L", expr: "ADD #l :v", names: names("l"), values: { ":v": { L: [N("1")] } } },
  { label: "ADD n S", expr: "ADD #n :v", names: names("n"), values: { ":v": { S: "a" } } },
  {
    label: "DELETE ss {a,b}",
    expr: "DELETE #ss :v",
    names: names("ss"),
    values: { ":v": { SS: ["a", "b"] } },
  },
  {
    label: "DELETE ss {a}",
    expr: "DELETE #ss :v",
    names: names("ss"),
    values: { ":v": { SS: ["a"] } },
  },
  {
    label: "DELETE ss NS",
    expr: "DELETE #ss :v",
    names: names("ss"),
    values: { ":v": { NS: ["1"] } },
  },
  {
    label: "DELETE zz SS",
    expr: "DELETE #zz :v",
    names: names("zz"),
    values: { ":v": { SS: ["a"] } },
  },
  {
    label: "DELETE s SS",
    expr: "DELETE #s :v",
    names: names("s"),
    values: { ":v": { SS: ["a"] } },
  },
  {
    label: "DELETE ns {1.0}",
    expr: "DELETE #ns :v",
    names: names("ns"),
    values: { ":v": { NS: ["1.0"] } },
  },
  {
    label: "DELETE m.zz SS",
    expr: "DELETE #m.#zz :v",
    names: names("m", "zz"),
    values: { ":v": { SS: ["a"] } },
  },
  {
    label: "DELETE zz.x SS (missing parent)",
    expr: "DELETE #zz.#x :v",
    names: names("zz", "x"),
    values: { ":v": { SS: ["a"] } },
  },
  { label: "DELETE ss N", expr: "DELETE #ss :v", names: names("ss"), values: { ":v": N("1") } },
  {
    label: "SET a = ine(a, v)",
    expr: "SET #a = if_not_exists(#a, :v)",
    names: names("a"),
    values: { ":v": N("1") },
  },
  {
    label: "SET a = ine(m.x.y, v)",
    expr: "SET #a = if_not_exists(#m.#x.#y, :v)",
    names: names("a", "m", "x", "y"),
    values: { ":v": N("1") },
  },
  {
    label: "SET m.x.y = ine(m.x.y, v)",
    expr: "SET #m.#x.#y = if_not_exists(#m.#x.#y, :v)",
    names: names("m", "x", "y"),
    values: { ":v": N("1") },
  },
  {
    label: "SET a = ine(a, zz) both missing",
    expr: "SET #a = if_not_exists(#a, #zz)",
    names: names("a", "zz"),
  },
  {
    label: "SET a = ine(n, zz) second missing",
    expr: "SET #a = if_not_exists(#n, #zz)",
    names: names("a", "n", "zz"),
  },
  {
    label: "SET a = ine(a, v) + 1",
    expr: "SET #a = if_not_exists(#a, :v) + :n",
    names: names("a"),
    values: { ":v": N("0"), ":n": N("1") },
  },
  {
    label: "SET l = list_append(l, L)",
    expr: "SET #l = list_append(#l, :v)",
    names: names("l"),
    values: { ":v": { L: [N("3")] } },
  },
  {
    label: "SET l = list_append(L, l)",
    expr: "SET #l = list_append(:v, #l)",
    names: names("l"),
    values: { ":v": { L: [N("3")] } },
  },
  {
    label: "SET zz = list_append(zz, L)",
    expr: "SET #zz = list_append(#zz, :v)",
    names: names("zz"),
    values: { ":v": { L: [N("3")] } },
  },
  {
    label: "SET s = list_append(s, L)",
    expr: "SET #s = list_append(#s, :v)",
    names: names("s"),
    values: { ":v": { L: [N("3")] } },
  },
  {
    label: "SET l = list_append(l, S)",
    expr: "SET #l = list_append(#l, :v)",
    names: names("l"),
    values: { ":v": { S: "q" } },
  },
  {
    label: "SET zz = list_append(ine(zz, e), L)",
    expr: "SET #zz = list_append(if_not_exists(#zz, :e), :v)",
    names: names("zz"),
    values: { ":e": { L: [] }, ":v": { L: [N("3")] } },
  },
  { label: "SET a = n - s (type)", expr: "SET #a = #n - #s", names: names("a", "n", "s") },
  {
    label: "SET a = zz + s (missing+type)",
    expr: "SET #a = #zz + #s",
    names: names("a", "zz", "s"),
  },
  {
    label: "SET a = s + zz (type+missing)",
    expr: "SET #a = #s + #zz",
    names: names("a", "zz", "s"),
  },
  {
    label: "SET a = v - n",
    expr: "SET #a = :v - #n",
    names: names("a", "n"),
    values: { ":v": N("7") },
  },
  {
    label: "SET x = v, a = zz + 1 (2nd refused)",
    expr: "SET #x = :v, #a = #zz + :n",
    names: names("x", "a", "zz"),
    values: { ":v": N("7"), ":n": N("1") },
  },
  {
    label: "SET a = s + 1 , c = zz + 1 (type then missing)",
    expr: "SET #a = #s + :n, #c = #zz + :n",
    names: names("a", "c", "s", "zz"),
    values: { ":n": N("1") },
  },
  {
    label: "SET a = zz + 1 REMOVE qq.y (missing then path)",
    expr: "SET #a = #zz + :n REMOVE #qq.#y",
    names: names("a", "zz", "qq", "y"),
    values: { ":n": N("1") },
  },
  {
    label: "REMOVE qq.y SET a = zz + 1 (path then missing)",
    expr: "REMOVE #qq.#y SET #a = #zz + :n",
    names: names("a", "zz", "qq", "y"),
    values: { ":n": N("1") },
  },
  {
    label: "SET a = s + 1 REMOVE qq.y (type then path)",
    expr: "SET #a = #s + :n REMOVE #qq.#y",
    names: names("a", "s", "qq", "y"),
    values: { ":n": N("1") },
  },
  {
    label: "SET m.zz = m.k + 1",
    expr: "SET #m.#zz = #m.#k + :n",
    names: names("m", "zz", "k"),
    values: { ":n": N("1") },
  },
  {
    label: "SET n = n + 1, c = n (before value)",
    expr: "SET #n = #n + :n, #c = #n",
    names: names("n", "c"),
    values: { ":n": N("1") },
  },
  { label: "SET c = l[1]", expr: "SET #c = #l[1]", names: names("c", "l") },
  { label: "SET c = l[9] (missing elem)", expr: "SET #c = #l[9]", names: names("c", "l") },
  { label: "SET c = m.zz (missing key)", expr: "SET #c = #m.#zz", names: names("c", "m", "zz") },
  { label: "SET c = zz", expr: "SET #c = #zz", names: names("c", "zz") },
  {
    label: "SET m = v REMOVE m.k (overlap)",
    expr: "SET #m = :v REMOVE #m.#k",
    names: names("m", "k"),
    values: { ":v": N("1") },
  },
  {
    label: "SET a = v REMOVE a (same path)",
    expr: "SET #a = :v REMOVE #a",
    names: names("a"),
    values: { ":v": N("1") },
  },
  { label: "SET n = n + n", expr: "SET #n = #n + #n", names: names("n") },
  {
    label: "SET a = n + 1.5e-3",
    expr: "SET #a = #n + :n",
    names: names("a", "n"),
    values: { ":n": N("1.5e-3") },
  },
  {
    label: "SET a = 0.000001 - 0.0000009",
    expr: "SET #a = :x - :y",
    names: names("a"),
    values: { ":x": N("0.000001"), ":y": N("0.0000009") },
  },
  {
    label: "SET a = 1e21 + 1",
    expr: "SET #a = :x + :y",
    names: names("a"),
    values: { ":x": N("1e21"), ":y": N("1") },
  },
  { label: "ADD n 1e-7", expr: "ADD #n :n", names: names("n"), values: { ":n": N("1e-7") } },
  // missing item
  {
    label: "[no item] SET v = v + 1 under attribute_not_exists",
    seed: null,
    expr: "SET #v = #v + :n",
    names: names("v", "pk"),
    values: { ":n": N("1") },
    cond: "attribute_not_exists(#pk)",
  },
  {
    label: "[no item] SET v = ine(v, 0) + 1",
    seed: null,
    expr: "SET #v = if_not_exists(#v, :z) + :n",
    names: names("v"),
    values: { ":n": N("1"), ":z": N("0") },
  },
  {
    label: "[no item] ADD a 1",
    seed: null,
    expr: "ADD #a :n",
    names: names("a"),
    values: { ":n": N("1") },
  },
  { label: "[no item] REMOVE a", seed: null, expr: "REMOVE #a", names: names("a") },
  {
    label: "[no item] DELETE ss SS",
    seed: null,
    expr: "DELETE #ss :v",
    names: names("ss"),
    values: { ":v": { SS: ["a"] } },
  },
  {
    label: "[no item] SET m.k = v",
    seed: null,
    expr: "SET #m.#k = :v",
    names: names("m", "k"),
    values: { ":v": N("1") },
  },
  // condition first
  {
    label: "cond fails + update invalid",
    expr: "SET #a = #zz + :n",
    names: names("a", "zz", "n"),
    values: { ":n": N("1"), ":c": N("99") },
    cond: "#n = :c",
  },
  {
    label: "cond passes + update invalid",
    expr: "SET #a = #zz + :n",
    names: names("a", "zz", "n"),
    values: { ":n": N("1"), ":c": N("5") },
    cond: "#n = :c",
  },
  // inherited names
  {
    label: "SET a = ine(constructor, v)",
    expr: "SET #a = if_not_exists(#constructor, :v)",
    names: names("a", "constructor"),
    values: { ":v": N("1") },
  },
  {
    label: "SET __proto__ = v",
    expr: "SET #p = :v",
    names: { "#p": "__proto__" },
    values: { ":v": N("1") },
  },
  {
    label: "SET m.__proto__ = v",
    expr: "SET #m.#p = :v",
    names: { "#p": "__proto__", "#m": "m" },
    values: { ":v": N("1") },
  },
]

/** The values an update or condition below may name; each row sends the ones it names. */
const V: Record<string, AttributeValue> = {
  ":L": { L: [N("3")] },
  ":five": N("5"),
  ":n": N("1"),
  ":one": N("1"),
  ":s": S("q"),
  ":m": { M: {} },
  ":ss": { SS: ["a"] },
  ":ns": { NS: ["1"] },
  ":bs": { BS: [bytes(3)] },
  ":b": { B: bytes(3) },
  ":nul": { NULL: true },
  ":bool": { BOOL: true },
  ":v": N("7"),
  ":w": N("8"),
}
const NS = (...v: Array<string>): AttributeValue => ({ NS: v })
/** An item of nested lists, for paths below a list element an outer `REMOVE` moves. */
const NESTED_LISTS: Item = {
  ...KEY,
  ll: { L: [{ L: [N("0")] }, { L: [N("1")] }, { L: [N("2")] }] },
  lm: {
    L: [
      { M: { a: N("0"), t: { SS: ["x", "y"] } } },
      { M: { a: N("1"), t: { SS: ["x", "y"] } } },
      { M: { a: N("2") } },
    ],
  },
}

/**
 * An update in brief: its expression, then any values beyond `V`, the stored item (`null`: none;
 * left out: `SEED`) and a condition.
 */
type Brief =
  | string
  | readonly [
      expression: string,
      values?: Record<string, AttributeValue> | undefined,
      seed?: Item | null | undefined,
      condition?: string | undefined,
    ]

const briefUpdate = (brief: Brief): Row => {
  const [expr, extra, seed, cond] = typeof brief === "string" ? [brief] : brief
  const text = `${expr} ${cond ?? ""}`
  return {
    label: `update: ${expr}${cond === undefined ? "" : ` IF ${cond}`}${extra === undefined ? "" : ` ${show(extra)}`}${seed === null ? " [no item]" : seed === undefined ? "" : ` [seed ${show(seed)}]`}`,
    command: "UpdateItem",
    input: {
      TableName: "$T",
      Key: KEY,
      UpdateExpression: expr,
      ...placeholders(namesIn(text), valuesIn(text, { ...V, ...extra })),
      ...(cond === undefined ? {} : { ConditionExpression: cond }),
    },
    seed: seed === null ? [] : seeded([seed ?? SEED]),
  }
}

/** Updates: list indexes, overlapping paths, sets, numbers, `if_not_exists`, the grammar. */
const UPDATES: ReadonlyArray<Brief> = [
  // lists
  "SET #l[5] = :v",
  "SET #l[5] = :v, #l[3] = :w",
  "SET #l[3] = :v, #l[5] = :w",
  "SET #l[3] = :v, #l[4] = :w",
  "SET #l[9] = :v, #l[0] = :w",
  "REMOVE #l[0], #l[1]",
  "REMOVE #l[1], #l[0]",
  "REMOVE #l[0] SET #l[1] = :v",
  "SET #l[0] = :v REMOVE #l[1]",
  "REMOVE #l[0], #l[7]",
  "SET #l[1].#a = :v",
  "SET #l[5].#a = :v",
  "REMOVE #l[1].#a",
  "REMOVE #l[5].#a",
  "ADD #l[0] :one",
  "ADD #l[5] :one",
  "SET #l[0] = :v REMOVE #l[0]",
  "SET #m.#a = :v, #m[0] = :w",
  "SET #m.#k = :v, #m = :w",
  "SET #m.#k = :v REMOVE #m.#l",
  "SET #a = :v, #a = :w",
  "REMOVE #a, #a",
  "ADD #n :one SET #n = :v",
  "SET #l[0] = :v, #l[0] = :w",
  "SET #m.#l[0] = :v REMOVE #m.#l",
  // same top-level name: which error
  "SET #m.#a = #zz + :n, #m.#b = #s + :n",
  "SET #m.#b = #s + :n, #m.#a = #zz + :n",
  // condition vs parse-time
  ["ADD #n :s", {}, undefined, "#n = :w"],
  ["ADD #n :s", {}, null],
  ["SET #a = :v REMOVE #a", {}, undefined, "#n = :w"],
  ["SET #a = #n + :s", {}, undefined, "#n = :w"],
  ["SET #a = :v", { ":mm": { M: {} } }, undefined, "#n < :mm"],
  ["SET #a = :v", { ":mm": { M: {} } }, null, "#n < :mm"],
  ["SET #a = #zz + :n", { ":mm": { M: {} } }, undefined, "#n < :mm"],
  ["SET #a = :v", {}, undefined, "#m <= #m"],
  // numbers
  ["SET #a = :x + :y", { ":x": N("99999999999999999999999999999999999999"), ":y": N("1") }],
  ["SET #a = :x + :y", { ":x": N("12345678901234567890123456789012345678"), ":y": N("0.1") }],
  ["SET #a = :x + :y", { ":x": N("1e125"), ":y": N("1e125") }],
  ["SET #a = :x - :y", { ":x": N("-1e125"), ":y": N("1e125") }],
  ["SET #a = :x + :y", { ":x": N("1e-130"), ":y": N("0") }],
  ["SET #a = :x - :y", { ":x": N("1e-130"), ":y": N("1e-130") }],
  ["SET #a = :x + :y", { ":x": N("1.50"), ":y": N("0") }],
  ["SET #a = :x", { ":x": N("1.50") }],
  ["SET #a = :x", { ":x": N("01.50e1") }],
  ["SET #a = :x + :y", { ":x": N("-0"), ":y": N("0") }],
  ["SET #a = :x - :y", { ":x": N("5"), ":y": N("5") }],
  ["SET #a = :x - :y", { ":x": N("0.3"), ":y": N("0.1") }],
  ["SET #a = :x + :y", { ":x": N("1E+2"), ":y": N("1") }],
  ["ADD #ns :x", { ":x": { NS: ["3.0", "1.0"] } }],
  ["ADD #ns :x", { ":x": { NS: ["3.00"] } }],
  ["ADD #zz :x", { ":x": { NS: ["3.00", "1e1"] } }],
  ["DELETE #ns :x", { ":x": { NS: ["1.0", "2.00"] } }],
  ["ADD #zz :x", { ":x": N("1.50") }],
  ["ADD #n :x", { ":x": N("0.50") }],
  ["ADD #ss :x", { ":x": { SS: [] } }],
  ["ADD #zz :x", { ":x": { SS: [] } }],
  ["DELETE #ss :x", { ":x": { SS: [] } }],
  ["SET #a = :x", { ":x": { SS: [] } }],
  ["ADD #ss :x", { ":x": { SS: ["a", "a"] } }],
  ["ADD #bs :x", { ":x": { BS: [new Uint8Array([2]), new Uint8Array([3])] } }],
  ["DELETE #bs :x", { ":x": { BS: [new Uint8Array([2]), new Uint8Array([9])] } }],
  ["DELETE #bs :x", { ":x": { BS: [new Uint8Array([1]), new Uint8Array([2])] } }],
  ["DELETE #ss :x", { ":x": { SS: ["a", "b"] } }],
  // nested ADD / DELETE
  "ADD #m.#k :one",
  "ADD #m.#zz :one",
  "ADD #m.#inner.#q :one",
  ["DELETE #m.#t :x", { ":x": { SS: ["a"] } }],
  ["ADD #m.#t :x", { ":x": { SS: ["a"] } }],
  // if_not_exists
  "SET #a = if_not_exists(#zz, :v)",
  "SET #a = if_not_exists(#m.#zz, :v)",
  "SET #a = if_not_exists(#l[9], :v)",
  "SET #a = if_not_exists(#n.#q, :v)",
  "SET #a = if_not_exists(#zz.#q, :v)",
  "SET #a = list_append(if_not_exists(#zz, :L), :L)",
  // missing item
  ["SET #a = #a + :one", {}, null],
  ["SET #m.#k = :v", {}, null],
  ["REMOVE #m.#k", {}, null],
  ["ADD #m.#k :one", {}, null],
  ["SET #l[0] = :v", {}, null],
  // set on key attributes
  "SET #pk = :s",
  "REMOVE #sk",
  "ADD #pk :one",
  // whitespace / case
  "SET #a=:v",
  "set #a = :v",
  "SET #a=#n+:v,#c=#n-:v",
  "SET #a = :v remove #n",
  "SET #a = list_append( #l , :L )",
  "SET #a = :v SET #c = :w",
  "SET #a = (:v)",
  "SET #a = if_not_exists (#zz, :v)",
  // nested list paths, every one naming the item as it was before the update
  ...[
    "SET #ll[1][0] = :v REMOVE #ll[0]",
    "REMOVE #ll[0] SET #ll[1][0] = :v",
    "SET #ll[2][0] = :v REMOVE #ll[0], #ll[1]",
    "REMOVE #ll[0] SET #ll[2][5] = :v",
    "REMOVE #ll[1][0], #ll[0]",
    "REMOVE #ll[2][0], #ll[1]",
    "REMOVE #ll[2][0], #ll[0], #ll[1][0]",
    "SET #ll[0][5] = :v, #ll[2][0] = :w REMOVE #ll[1]",
    "SET #ll[5] = :v REMOVE #ll[3]",
    "SET #ll[3] = :v REMOVE #ll[0]",
    "SET #ll[1][1] = :v REMOVE #ll[0]",
    "SET #ll[0][0] = :v REMOVE #ll[0]",
    "ADD #lm[1].#a :one REMOVE #lm[0]",
    "ADD #lm[1].#t :x REMOVE #lm[0]",
    "DELETE #lm[1].#t :x REMOVE #lm[0]",
    "DELETE #lm[0].#t :x, #lm[1].#t :x REMOVE #lm[2]",
    "REMOVE #lm[0].#a, #lm[1]",
    "REMOVE #lm[1].#t, #lm[0]",
    "SET #lm[1].#t = :v REMOVE #lm[0]",
    "SET #lm[2].#b = :v REMOVE #lm[0], #lm[1]",
    "SET #a = #ll[1][0] REMOVE #ll[0]",
    "SET #ll[2] = #ll[0] REMOVE #ll[0]",
    "REMOVE #ll[0] SET #ll[1] = list_append(#ll[1], :L)",
    "REMOVE #ll[0] SET #ll[1][0] = list_append(#ll[2], :L)",
  ].map((expression): Brief => [expression, { ":x": { SS: ["x"] } }, NESTED_LISTS]),
]

/** Numbers and number sets. */
const NUMBERS: ReadonlyArray<Brief> = [
  ["ADD #ns :x", { ":x": NS("10") }],
  ["ADD #ns :x", { ":x": NS("10", "2.50") }, { ...KEY, ns: NS("1.0", "2.5") }],
  ["ADD #ns :x", { ":x": NS("7") }, { ...KEY, ns: NS("1.0", "2.50", "1E+1", "100") }],
  ["DELETE #ns :x", { ":x": NS("7") }, { ...KEY, ns: NS("1.0", "2.50", "1E+1", "100") }],
  ["DELETE #ns :x", { ":x": NS("1") }, { ...KEY, ns: NS("1.0", "2.50", "100") }],
  ["ADD #zz :x", { ":x": NS("100", "0.10", "1e-7", "1e21") }],
  ["SET #zz = :x", { ":x": NS("100", "0.10", "1e-7", "1e21") }],
  ["ADD #ss :x", { ":x": { SS: ["c", "a"] } }],
  ["ADD #zz :x", { ":x": N("1e1") }],
  ["ADD #zz :x", { ":x": N("100") }],
  ["ADD #n :x", { ":x": N("1e1") }],
  ["ADD #n :x", { ":x": N("1e-7") }],
  ["SET #a = #n + :x", { ":x": N("1e-7") }],
  ["SET #a = #n + :x", { ":x": N("1e2") }],
  ["SET #a = :x + :y", { ":x": N("1e2"), ":y": N("1e2") }],
  ["SET #a = :x - :y", { ":x": N("1e2"), ":y": N("100") }],
  ["SET #a = :x + :y", { ":x": N("9.9e125"), ":y": N("9.9e125") }],
  ["SET #a = :x - :y", { ":x": N("1e-130"), ":y": N("0.9e-130") }],
  ["SET #a = :x", { ":x": N("1e126") }],
  ["SET #a = :x", { ":x": N("1e-131") }],
  ["SET #a = :x", { ":x": N("123456789012345678901234567890123456789") }],
  ["SET #a = :x", { ":x": N("1234567890123456789012345678901234567800") }],
  ["SET #a = :x", { ":x": N("+5") }],
  ["SET #a = :x", { ":x": N(" 5") }],
  ["SET #a = :x", { ":x": N("5.") }],
  ["SET #a = :x", { ":x": N(".5") }],
  ["SET #a = :x", { ":x": N("0x10") }],
  ["SET #a = :x + :y", { ":x": N(".5"), ":y": N("5.") }],
  ["SET #a = :x + :y", { ":x": N("-0.0"), ":y": N("0") }],
  ["SET #a = :x - :y", { ":x": N("0"), ":y": N("0.00") }],
  ["SET #a = :x + :y", { ":x": N("1e-7"), ":y": N("0") }],
  [
    "SET #a = :x + :y",
    {
      ":x": N("12345678901234567890123456789012345678"),
      ":y": N("12345678901234567890123456789012345678"),
    },
  ],
  [
    "SET #a = :x + :y",
    {
      ":x": N("99999999999999999999999999999999999999"),
      ":y": N("99999999999999999999999999999999999999"),
    },
  ],
]

/** An operand of the wrong type, and which of two problems is reported. */
const OPERANDS: ReadonlyArray<Brief> = [
  "SET #a = #s + #zz",
  "SET #a = #zz + #s",
  "SET #a = #s + :n, #c = #zz + :n",
  "SET #a = #zz + :n, #c = #s + :n",
  "SET #c = #s + :n, #a = #zz + :n",
  "SET #c = #zz + :n, #a = #s + :n",
  "SET #a = #zz + :n, #c = #qq + :n",
  "REMOVE #qq.#y SET #a = #s + :n",
  "SET #a = :v REMOVE #qq.#y",
  "REMOVE #qq.#y SET #a = :v",
  "SET #x.#y = :v, #a = #zz + :n",
  "SET #a = #zz + :n, #x.#y = :v",
  "SET #x.#y = :v, #a = #s + :n",
  "ADD #s :one SET #a = #zz + :n",
  "SET #a = #zz + :n ADD #s :one",
  "ADD #s :one SET #a = #s + :n",
  "ADD #s :one REMOVE #qq.#y",
  "REMOVE #qq.#y ADD #s :one",
  "DELETE #zz.#x :ss SET #a = #zz + :n",
  "DELETE #s :ss SET #a = #zz + :n",
  "DELETE #s :ss ADD #zz.#y :one",
  "ADD #zz.#y :one DELETE #s :ss",
  "SET #a = #n + :s",
  "SET #a = :s + #n",
  "SET #a = :s + :n",
  "SET #a = #n - :m",
  "SET #a = #zz + :s",
  "SET #a = #s + :s",
  "SET #l = list_append(:s, #l)",
  "SET #l = list_append(#s, :L)",
  "SET #l = list_append(#zz, :s)",
  "SET #l = list_append(#l, :n)",
  "SET #l = list_append(#zz, #l)",
  "SET #l = list_append(#l, #zz)",
  "SET #l = list_append(#s, #zz)",
  "SET #l = list_append(#zz, #s)",
  "SET #a = if_not_exists(#n, :v) + :s",
  "SET #a = if_not_exists(#zz, :s) + :n",
  "SET #a = if_not_exists(#n, #zz)",
  "SET #a = if_not_exists(#zz, #qq)",
  "SET #a = if_not_exists(#n, :s)",
  "SET #a = if_not_exists(:v, #n)",
  "ADD #n :m",
  "ADD #n :bool",
  "ADD #n :nul",
  "ADD #n :b",
  "ADD #zz :L",
  "ADD #n :s",
  "ADD #zz :m",
  "ADD #ss :ns",
  "ADD #ns :ss",
  "ADD #n :ss",
  "ADD #ss :one",
  "ADD #s :one",
  "ADD #l :one",
  "ADD #bs :b",
  "DELETE #ss :s",
  "DELETE #ss :L",
  "DELETE #ss :one",
  "DELETE #bs :b",
  "DELETE #ss :m",
  "DELETE #ss :ns",
  "DELETE #n :ss",
  "DELETE #zz :ss",
  "DELETE #s :ss",
  "SET #a = :s + #zz",
  "SET #a = #zz - :m",
  "REMOVE #s SET #a = #n + :s",
]

/** A condition on `SEED`, through a `DeleteItem` and through `holds`. */
interface Cond {
  readonly label: string
  readonly expr: string
  readonly names: Record<string, string>
  readonly values?: Record<string, AttributeValue>
  readonly seed?: Item | null
}

const conditionRow = (c: Cond): Row => {
  const item = c.seed === null ? undefined : (c.seed ?? SEED)
  return {
    label: `condition: ${c.label}`,
    command: "DeleteItem",
    input: {
      TableName: "$T",
      Key: KEY,
      ConditionExpression: c.expr,
      ...placeholders(c.names, c.values),
    },
    seed: item === undefined ? [] : seeded([item]),
    condition: { expression: c.expr, item, names: c.names, values: c.values ?? {} },
  }
}

const big = "\u{10000}"
const C: Array<Cond> = [
  {
    label: "m = m reordered",
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { M: { inner: { M: {} }, l: { L: [N("1"), N("2.0")] }, k: N("1.0") } } },
  },
  {
    label: "m = m minus key",
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { M: { l: { L: [N("1"), N("2")] }, k: N("1") } } },
  },
  { label: "n = 5.0", expr: "#n = :v", names: names("n"), values: { ":v": N("5.0") } },
  { label: "n = 50e-1", expr: "#n = :v", names: names("n"), values: { ":v": N("50e-1") } },
  { label: "n = S 5", expr: "#n = :v", names: names("n"), values: { ":v": { S: "5" } } },
  { label: "n <> S 5", expr: "#n <> :v", names: names("n"), values: { ":v": { S: "5" } } },
  { label: "n < S 9", expr: "#n < :v", names: names("n"), values: { ":v": { S: "9" } } },
  { label: "n > S 1", expr: "#n > :v", names: names("n"), values: { ":v": { S: "1" } } },
  { label: "s < y", expr: "#s < :v", names: names("s"), values: { ":v": { S: "y" } } },
  { label: "s < N", expr: "#s < :v", names: names("s"), values: { ":v": N("9") } },
  { label: "m < m", expr: "#m < :v", names: names("m"), values: { ":v": { M: {} } } },
  { label: "l < l", expr: "#l < :v", names: names("l"), values: { ":v": { L: [] } } },
  { label: "ss < ss", expr: "#ss < :v", names: names("ss"), values: { ":v": { SS: ["z"] } } },
  {
    label: "bool < bool",
    expr: "#bool < :v",
    names: names("bool"),
    values: { ":v": { BOOL: true } },
  },
  {
    label: "bool <= bool",
    expr: "#bool <= :v",
    names: names("bool"),
    values: { ":v": { BOOL: true } },
  },
  {
    label: "nul <= nul",
    expr: "#nul <= :v",
    names: names("nul"),
    values: { ":v": { NULL: true } },
  },
  {
    label: "n < m (attr vs map value)",
    expr: "#n < :v",
    names: names("n"),
    values: { ":v": { M: {} } },
  },
  { label: "n < bool value", expr: "#n < :v", names: names("n"), values: { ":v": { BOOL: true } } },
  {
    label: "m < n value (map attr, number value)",
    expr: "#m < :v",
    names: names("m"),
    values: { ":v": N("1") },
  },
  { label: "bool < n value", expr: "#bool < :v", names: names("bool"), values: { ":v": N("1") } },
  { label: "n < s (two attrs)", expr: "#n < #s", names: names("n", "s") },
  { label: "m < l (two attrs)", expr: "#m < #l", names: names("m", "l") },
  { label: "m <= m (attr vs itself)", expr: "#m <= #m", names: names("m") },
  {
    label: "ss = ss reordered",
    expr: "#ss = :v",
    names: names("ss"),
    values: { ":v": { SS: ["b", "a"] } },
  },
  {
    label: "ns = ns respelled",
    expr: "#ns = :v",
    names: names("ns"),
    values: { ":v": { NS: ["2.0", "1"] } },
  },
  {
    label: "bs = bs reordered",
    expr: "#bs = :v",
    names: names("bs"),
    values: { ":v": { BS: [new Uint8Array([2]), new Uint8Array([1])] } },
  },
  { label: "ss = ns", expr: "#ss = :v", names: names("ss"), values: { ":v": { NS: ["1"] } } },
  {
    label: "l = l",
    expr: "#l = :v",
    names: names("l"),
    values: { ":v": { L: [N("1"), N("2"), { M: { a: N("1.0") } }] } },
  },
  {
    label: "l = l reordered",
    expr: "#l = :v",
    names: names("l"),
    values: { ":v": { L: [N("2"), N("1"), { M: { a: N("1") } }] } },
  },
  { label: "zz <> v", expr: "#zz <> :v", names: names("zz"), values: { ":v": N("1") } },
  { label: "zz = v", expr: "#zz = :v", names: names("zz"), values: { ":v": N("1") } },
  { label: "zz <> qq (both missing)", expr: "#zz <> #qq", names: names("zz", "qq") },
  { label: "zz = qq (both missing)", expr: "#zz = #qq", names: names("zz", "qq") },
  { label: "zz < v", expr: "#zz < :v", names: names("zz"), values: { ":v": N("1") } },
  { label: "NOT zz = v", expr: "NOT #zz = :v", names: names("zz"), values: { ":v": N("1") } },
  {
    label: "b = b",
    expr: "#b = :v",
    names: names("b"),
    values: { ":v": { B: new Uint8Array([1, 2]) } },
  },
  {
    label: "b < b",
    expr: "#b < :v",
    names: names("b"),
    values: { ":v": { B: new Uint8Array([1, 3]) } },
  },
  {
    label: "b < longer b",
    expr: "#b < :v",
    names: names("b"),
    values: { ":v": { B: new Uint8Array([1, 2, 0]) } },
  },
  {
    label: "b > 0x80.. (unsigned?)",
    expr: "#b < :v",
    names: names("b"),
    values: { ":v": { B: new Uint8Array([0x80]) } },
  },
  {
    label: "bool = true",
    expr: "#bool = :v",
    names: names("bool"),
    values: { ":v": { BOOL: true } },
  },
  {
    label: "bool = false",
    expr: "#bool = :v",
    names: names("bool"),
    values: { ":v": { BOOL: false } },
  },
  { label: "nul = nul", expr: "#nul = :v", names: names("nul"), values: { ":v": { NULL: true } } },
  { label: "nul = bool", expr: "#nul = :v", names: names("nul"), values: { ":v": { BOOL: true } } },
  {
    label: "big = 9007199254740992",
    expr: "#big = :v",
    names: names("big"),
    values: { ":v": N("9007199254740992") },
  },
  {
    label: "big > 9007199254740992",
    expr: "#big > :v",
    names: names("big"),
    values: { ":v": N("9007199254740992") },
  },
  { label: "n < 1e1", expr: "#n < :v", names: names("n"), values: { ":v": N("1e1") } },
  { label: "n > -1e1", expr: "#n > :v", names: names("n"), values: { ":v": N("-1e1") } },
  { label: "n > 0.5e1", expr: "#n > :v", names: names("n"), values: { ":v": N("0.5e1") } },
  { label: "n >= 0.5e1", expr: "#n >= :v", names: names("n"), values: { ":v": N("0.5e1") } },
  { label: "n > -0", expr: "#n > :v", names: names("n"), values: { ":v": N("-0") } },
  { label: "dec < 0.25", expr: "#dec < :v", names: names("dec"), values: { ":v": N("0.25") } },
  { label: "dec < .2", expr: "#dec < :v", names: names("dec"), values: { ":v": N(".2") } },
  { label: "dec > 0.09", expr: "#dec > :v", names: names("dec"), values: { ":v": N("0.09") } },
  { label: "dec > 1e-2", expr: "#dec > :v", names: names("dec"), values: { ":v": N("1e-2") } },
  { label: "dec > -5", expr: "#dec > :v", names: names("dec"), values: { ":v": N("-5") } },
  { label: "dec < 0", expr: "#dec < :v", names: names("dec"), values: { ":v": N("0") } },
  { label: "dec > 0", expr: "#dec > :v", names: names("dec"), values: { ":v": N("0") } },
  { label: "dec > 0.0", expr: "#dec > :v", names: names("dec"), values: { ":v": N("0.0") } },
  { label: "dec > 0e5", expr: "#dec > :v", names: names("dec"), values: { ":v": N("0e5") } },
  { label: "m.k = 1", expr: "#m.#k = :v", names: names("m", "k"), values: { ":v": N("1") } },
  { label: "l[0] = 1", expr: "#l[0] = :v", names: names("l"), values: { ":v": N("1") } },
  { label: "m.l[1] = 2", expr: "#m.#l[1] = :v", names: names("m", "l"), values: { ":v": N("2") } },
  { label: "attribute_exists(m.k)", expr: "attribute_exists(#m.#k)", names: names("m", "k") },
  { label: "attribute_exists(m.zz)", expr: "attribute_exists(#m.#zz)", names: names("m", "zz") },
  { label: "attribute_not_exists(l[5])", expr: "attribute_not_exists(#l[5])", names: names("l") },
  { label: "attribute_exists(l[0])", expr: "attribute_exists(#l[0])", names: names("l") },
  {
    label: "s unicode: U+FFFF < U+10000 (utf8)",
    seed: { ...KEY, s: { S: "￿" } },
    expr: "#s < :v",
    names: names("s"),
    values: { ":v": { S: big } },
  },
  {
    label: "s: 'a' < 'ab'",
    seed: { ...KEY, s: { S: "a" } },
    expr: "#s < :v",
    names: names("s"),
    values: { ":v": { S: "ab" } },
  },
  {
    label: "s: 'B' < 'a'",
    seed: { ...KEY, s: { S: "B" } },
    expr: "#s < :v",
    names: names("s"),
    values: { ":v": { S: "a" } },
  },
  {
    label: "neg: -5 < -3",
    seed: { ...KEY, n: N("-5") },
    expr: "#n < :v",
    names: names("n"),
    values: { ":v": N("-3") },
  },
  {
    label: "neg: -5 < -30",
    seed: { ...KEY, n: N("-5") },
    expr: "#n < :v",
    names: names("n"),
    values: { ":v": N("-30") },
  },
  {
    label: "neg: -0.5 > -0.25",
    seed: { ...KEY, n: N("-0.5") },
    expr: "#n > :v",
    names: names("n"),
    values: { ":v": N("-0.25") },
  },
  {
    label: "0 = -0",
    seed: { ...KEY, n: N("0") },
    expr: "#n = :v",
    names: names("n"),
    values: { ":v": N("-0") },
  },
  {
    label: "0 < 1e-130",
    seed: { ...KEY, n: N("0") },
    expr: "#n < :v",
    names: names("n"),
    values: { ":v": N("1e-130") },
  },
  {
    label: "0 > -1e-130",
    seed: { ...KEY, n: N("0") },
    expr: "#n > :v",
    names: names("n"),
    values: { ":v": N("-1e-130") },
  },
  {
    label: "38 digits equal",
    seed: { ...KEY, n: N("12345678901234567890123456789012345678") },
    expr: "#n = :v",
    names: names("n"),
    values: { ":v": N("1.2345678901234567890123456789012345678e37") },
  },
  {
    label: "38 digits differ in last",
    seed: { ...KEY, n: N("12345678901234567890123456789012345678") },
    expr: "#n < :v",
    names: names("n"),
    values: { ":v": N("12345678901234567890123456789012345679") },
  },
  {
    label: "empty M = empty M",
    seed: { ...KEY, m: { M: {} } },
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { M: {} } },
  },
  {
    label: "empty L = empty L",
    seed: { ...KEY, m: { L: [] } },
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { L: [] } },
  },
  {
    label: "empty L = empty M",
    seed: { ...KEY, m: { L: [] } },
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { M: {} } },
  },
  {
    label: "empty S = empty S",
    seed: { ...KEY, m: { S: "" } },
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { S: "" } },
  },
  {
    label: "M with NULL member",
    seed: { ...KEY, m: { M: { a: { NULL: true } } } },
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { M: { a: { NULL: true } } } },
  },
  {
    label: "M: {a:1} = {b:1}",
    seed: { ...KEY, m: { M: { a: N("1") } } },
    expr: "#m = :v",
    names: names("m"),
    values: { ":v": { M: { b: N("1") } } },
  },
  {
    label: "no item: zz <> v",
    seed: null,
    expr: "#zz <> :v",
    names: names("zz"),
    values: { ":v": N("1") },
  },
  {
    label: "no item: attribute_not_exists(pk)",
    seed: null,
    expr: "attribute_not_exists(#pk)",
    names: names("pk"),
  },
  {
    label: "n = 5 AND (s = x OR zz = 1)",
    expr: "#n = :a AND (#s = :b OR #zz = :c)",
    names: names("n", "s", "zz"),
    values: { ":a": N("5"), ":b": { S: "x" }, ":c": N("1") },
  },
  {
    label: "NOT n = 5 OR s = x",
    expr: "NOT #n = :a OR #s = :b",
    names: names("n", "s"),
    values: { ":a": N("5"), ":b": { S: "x" } },
  },
  {
    label: "NOT (n = 5 OR s = x)",
    expr: "NOT (#n = :a OR #s = :b)",
    names: names("n", "s"),
    values: { ":a": N("5"), ":b": { S: "x" } },
  },
  {
    label: "n = 4 OR n = 5 AND s = q",
    expr: "#n = :a OR #n = :b AND #s = :c",
    names: names("n", "s"),
    values: { ":a": N("5"), ":b": N("4"), ":c": { S: "q" } },
  },
]

/** A condition in brief: its expression, then any values beyond `V`, and the stored item. */
type BriefCondition =
  | string
  | readonly [expression: string, values?: Record<string, AttributeValue>, seed?: Item | null]

const briefCondition = (brief: BriefCondition): Row => {
  const [expr, extra, seed] = typeof brief === "string" ? [brief] : brief
  return conditionRow({
    label: `${expr}${extra === undefined ? "" : ` ${show(extra)}`}${seed === null ? " [no item]" : seed === undefined ? "" : ` [seed ${show(seed)}]`}`,
    expr,
    names: namesIn(expr),
    values: valuesIn(expr, { ...V, ...extra }),
    ...(seed === undefined ? {} : { seed }),
  })
}

const CONDITIONS: ReadonlyArray<BriefCondition> = [
  "#n < :m",
  ":m < #n",
  "#n < :ss",
  "#n < :ns",
  "#n < :bs",
  "#n < :L",
  "#n < :nul",
  "#n < :bool",
  "#n < :b",
  "#s < :n",
  ":ss < :m",
  "#n = #n",
  "#n <> #n",
  ":v = :v",
  "#n < #n",
  "#m = #m",
  ":v < :v",
  "#n = :v AND #n = :v",
  "#n BETWEEN :one AND :v",
  "#n BETWEEN :v AND :one",
  "#n BETWEEN :one AND :s",
  "#n BETWEEN :one AND :m",
  "#n BETWEEN #n AND :v",
  "#s BETWEEN :one AND :v",
  "#zz BETWEEN :one AND :v",
  "#n IN (:one, :v)",
  ["#n IN (:one, :five)", { ":five": N("5.0") }],
  "#n IN (#n)",
  "#m IN (:m)",
  "#n IN (:m)",
  "#zz IN (:one)",
  ["#n IN (:one, :one)"],
  "size(#s) = :one",
  ["size(#u) = :two", { ":two": N("2"), ":three": N("3") }, { ...KEY, u: { S: "a€" } }],
  ["size(#u) = :three", { ":two": N("2"), ":three": N("3") }, { ...KEY, u: { S: "a€" } }],
  ["size(#b) = :two", { ":two": N("2") }],
  ["size(#ss) = :two", { ":two": N("2") }],
  ["size(#l) = :three", { ":three": N("3") }],
  ["size(#m) = :three", { ":three": N("3") }],
  "size(#n) = :one",
  "size(#zz) = :one",
  "size(#zz) <> :one",
  "size(#bool) = :one",
  "size(#nul) = :one",
  ["size(#m.#l) > :one"],
  ":one < size(#s)",
  "size(#s) = size(#s)",
  ["attribute_type(#n, :t)", { ":t": { S: "N" } }],
  ["attribute_type(#n, :t)", { ":t": { S: "S" } }],
  ["attribute_type(#n, :t)", { ":t": { S: "X" } }],
  ["attribute_type(#zz, :t)", { ":t": { S: "N" } }],
  ["attribute_type(#n, :t)", { ":t": N("1") }],
  ["contains(#ss, :a)", { ":a": { S: "a" } }],
  ["contains(#ss, :a)", { ":a": { S: "z" } }],
  ["contains(#l, :one)"],
  ["contains(#l, :mm)", { ":mm": { M: { a: N("1") } } }],
  ["contains(#s, :a)", { ":a": { S: "x" } }],
  ["contains(#ns, :x)", { ":x": N("1.0") }],
  ["contains(#b, :x)", { ":x": { B: new Uint8Array([2]) } }],
  ["contains(#n, :one)"],
  ["contains(#zz, :one)"],
  ["contains(#ss, :one)"],
  ["contains(#s, :one)"],
  ["contains(#ss, :ss)"],
  ["begins_with(#b, :x)", { ":x": { B: new Uint8Array([1]) } }],
  ["begins_with(#s, :one)"],
  ["begins_with(#n, :one)"],
  ["begins_with(#s, :x)", { ":x": { S: "" } }],
  ["begins_with(#zz, :x)", { ":x": { S: "x" } }],
  ["begins_with(#ss, :x)", { ":x": { S: "a" } }],
  "#l[0] = :one",
  ["#m.#l[1] = :two", { ":two": N("2") }],
  "attribute_not_exists(#l[5])",
  "attribute_exists(#l[0])",
  "attribute_exists(#l[2].#a)",
  "attribute_exists(#m.#l[1])",
  "attribute_exists(#l.#a)",
  "attribute_exists(#m[0])",
  "attribute_exists(#s.#a)",
  "#l[9] = :one",
  "#l[9] <> :one",
  "#zz <> #qq",
  "#zz = #qq",
  "#zz <> :v",
  "#zz = :v",
  "NOT #zz = :v",
  "#zz < :v",
  "NOT #zz < :v",
  "#n = :v and #s = :s",
  "not #n = :v",
  ["#n between :one and :v"],
  ["#n in (:one)"],
  "NOT #n = :one AND #n = :v",
  "#n = :one OR #n = :five AND #s = :s",
  ["(#n = :five)"],
  ["((#n = :five))"],
  ["#n=:five", { ":five": N("5") }],
  ["#n<>:one"],
  ["attribute_exists(#n)AND#n>:one"],
  ["#n >:one"],
  "#n = ",
  "foo(#n)",
  "attribute_exists(:v)",
  "#n = :undefined",
  "#undefined = :one",
  ["#n = :one", { ":unused": N("1") }],
  "attribute_exists(#n, #s)",
  "size(#n)",
  "#n",
  "begins_with(#s)",
  "attribute_type(#n)",
  "#n = :one = :one",
]

// ---------------------------------------------------------------------------
// Which of two problems in one update DynamoDB Local reports
// ---------------------------------------------------------------------------

const ORDER_NAMES = ["a", "b", "c", "x", "y", "aa", "ab", "B", "Z", "a1"]
const ORDER_SEED: Item = {
  ...KEY,
  s: S("str"),
  ...Object.fromEntries(ORDER_NAMES.map((name) => [name, S("str")])),
}
/** One action on attribute `n` and its problem: a missing operand, a wrong type, a bad path. */
const KINDS: Record<string, (n: string) => readonly [string, string, "M" | "T" | "P"]> = {
  SM: (n) => ["SET", `#${n} = #zz + :one`, "M"],
  ST: (n) => ["SET", `#${n} = #s + :one`, "T"],
  SP: (n) => ["SET", `#${n}.#y.#y = :one`, "P"],
  RP: (n) => ["REMOVE", `#${n}.#y.#y`, "P"],
  AT: (n) => ["ADD", `#${n} :one`, "T"],
  AP: (n) => ["ADD", `#${n}.#y.#y :one`, "P"],
  DT: (n) => ["DELETE", `#${n} :ss`, "T"],
  DP: (n) => ["DELETE", `#${n}.#y.#y :ss`, "P"],
}
/** The actions as one expression, a clause per keyword in the order the actions come. */
const clauses = (actions: ReadonlyArray<readonly [string, string, string]>) => {
  const groups: Array<[string, Array<string>]> = []
  for (const [keyword, text] of actions) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last[0] === keyword) last[1].push(text)
    else groups.push([keyword, [text]])
  }
  return groups.map(([keyword, texts]) => `${keyword} ${texts.join(", ")}`).join(" ")
}
const orderRow = (expression: string): Row => ({
  label: `order: ${expression}`,
  command: "UpdateItem",
  input: {
    TableName: "$T",
    Key: KEY,
    UpdateExpression: expression,
    ...placeholders(
      namesIn(expression),
      valuesIn(expression, { ":one": N("1"), ":ss": { SS: ["q"] } }),
    ),
  },
  seed: seeded([ORDER_SEED]),
})
const ORDER: ReadonlyArray<Row> = [
  // Two kinds of problem, on two attributes, both ways round.
  ...Object.keys(KINDS).flatMap((first) =>
    Object.keys(KINDS).flatMap((second) =>
      first === second || KINDS[first]!("a")[2] === KINDS[second]!("a")[2]
        ? []
        : [
            ["a", "c"],
            ["c", "a"],
            ["a", "x"],
            ["x", "a"],
          ].map(([one, two]) => orderRow(clauses([KINDS[first]!(one!), KINDS[second]!(two!)]))),
    ),
  ),
  // A missing operand and a wrong type, on every pair of names, in either order.
  ...ORDER_NAMES.flatMap((one, i) =>
    ORDER_NAMES.slice(i + 1).flatMap((two) => [
      orderRow(clauses([KINDS.SM!(one), KINDS.ST!(two)])),
      orderRow(clauses([KINDS.ST!(two), KINDS.SM!(one)])),
      orderRow(clauses([KINDS.ST!(one), KINDS.SM!(two)])),
    ]),
  ),
]

// ---------------------------------------------------------------------------
// Transactions and batches
// ---------------------------------------------------------------------------

const K = (id: string): Item => ({ pk: { S: id }, sk: { S: "s" } })

const SEEDS: ReadonlyArray<Item> = [
  { ...K("a"), n: N("1"), s: { S: "x" } },
  { ...K("b"), n: N("2") },
]

interface Tx {
  readonly label: string
  readonly kind: "tw" | "tg" | "bg" | "bw"
  readonly input: (table: string) => any
}
const upd = (table: string, id: string, expr: string, extra: any = {}) => {
  const all: Record<string, string> = { "#n": "n", "#zz": "zz", "#s": "s" }
  const text = `${expr} ${extra.ConditionExpression ?? ""}`
  return {
    Update: {
      TableName: table,
      Key: K(id),
      UpdateExpression: expr,
      ExpressionAttributeValues: { ":one": N("1") },
      ...extra,
      ExpressionAttributeNames: Object.fromEntries(
        Object.entries(all).filter(([k]) => text.includes(k)),
      ),
    },
  }
}
const failing = {
  ConditionExpression: "#n = :c",
  ExpressionAttributeNames: { "#n": "n" },
  ExpressionAttributeValues: { ":c": N("99") },
}
const passing = {
  ConditionExpression: "#n = :c",
  ExpressionAttributeNames: { "#n": "n" },
  ExpressionAttributeValues: { ":c": N("1") },
}
const TX: Array<Tx> = [
  {
    label: "tw: refused update alone",
    kind: "tw",
    input: (t) => ({ TransactItems: [upd(t, "a", "SET #zz = #zz + :one")] }),
  },
  {
    label: "tw: refused update, then other's failed condition",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        upd(t, "a", "SET #zz = #zz + :one"),
        { Put: { TableName: t, Item: { ...K("b"), n: N("7") }, ...failing } },
      ],
    }),
  },
  {
    label: "tw: other's failed condition, then refused update",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("b"), n: N("7") }, ...failing } },
        upd(t, "a", "SET #zz = #zz + :one"),
      ],
    }),
  },
  {
    label: "tw: update own condition fails + expression invalid",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        upd(t, "a", "SET #zz = #zz + :one", {
          ConditionExpression: "#n = :c",
          ExpressionAttributeValues: { ":one": N("1"), ":c": N("99") },
        }),
      ],
    }),
  },
  {
    label: "tw: operand type in update + ok put",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        upd(t, "a", "SET #zz = #s + :one"),
        { Put: { TableName: t, Item: { ...K("c"), n: N("7") } } },
      ],
    }),
  },
  {
    label: "tw: invalid path in update",
    kind: "tw",
    input: (t) => ({ TransactItems: [upd(t, "a", "SET #zz.#n = :one")] }),
  },
  {
    label: "tw: repeated item + refused update",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        upd(t, "a", "SET #zz = #zz + :one"),
        { ConditionCheck: { TableName: t, Key: K("a"), ...passing } },
      ],
    }),
  },
  {
    label: "tw: repeated item put+check",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("a"), n: N("5") } } },
        { ConditionCheck: { TableName: t, Key: K("a"), ...passing } },
      ],
    }),
  },
  {
    label: "tw: repeated put+check, check passes on stored and on put",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("a"), n: N("1") } } },
        { ConditionCheck: { TableName: t, Key: K("a"), ...passing } },
      ],
    }),
  },
  {
    label: "tw: repeated check+put, check fails",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { ConditionCheck: { TableName: t, Key: K("a"), ...failing } },
        { Put: { TableName: t, Item: { ...K("a"), n: N("1") } } },
      ],
    }),
  },
  {
    label: "tw: repeated put+put no conditions",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("a"), n: N("5") } } },
        { Put: { TableName: t, Item: { ...K("a"), n: N("6") } } },
      ],
    }),
  },
  {
    label: "tw: repeated put(failing cond)+put",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("a"), n: N("5") }, ...failing } },
        { Put: { TableName: t, Item: { ...K("a"), n: N("6") } } },
      ],
    }),
  },
  {
    label: "tw: repeated put+put(failing cond)",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("a"), n: N("5") } } },
        { Put: { TableName: t, Item: { ...K("a"), n: N("6") }, ...failing } },
      ],
    }),
  },
  {
    label: "tw: repeated update+update",
    kind: "tw",
    input: (t) => ({
      TransactItems: [upd(t, "a", "SET #n = #n + :one"), upd(t, "a", "SET #n = #n + :one")],
    }),
  },
  {
    label: "tw: repeated pair + another item's failed condition",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("b"), n: N("7") }, ...failing } },
        { Put: { TableName: t, Item: { ...K("a"), n: N("5") } } },
        { Delete: { TableName: t, Key: K("a") } },
      ],
    }),
  },
  {
    label: "tw: another item's failed condition after repeated pair",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Put: { TableName: t, Item: { ...K("a"), n: N("5") } } },
        { Delete: { TableName: t, Key: K("a") } },
        { Put: { TableName: t, Item: { ...K("b"), n: N("7") }, ...failing } },
      ],
    }),
  },
  {
    label: "tw: repeated item (missing key) delete+delete",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Delete: { TableName: t, Key: K("q") } },
        { Delete: { TableName: t, Key: { sk: { S: "s" }, pk: { S: "q" } } } },
      ],
    }),
  },
  {
    label: "tw: delete with failing condition",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Delete: { TableName: t, Key: K("a"), ...failing } },
        { Put: { TableName: t, Item: { ...K("c"), n: N("7") } } },
      ],
    }),
  },
  {
    label: "tw: delete with passing condition + put",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { Delete: { TableName: t, Key: K("a"), ...passing } },
        { Put: { TableName: t, Item: { ...K("c"), n: N("7") } } },
      ],
    }),
  },
  {
    label: "tw: check failing + put",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { ConditionCheck: { TableName: t, Key: K("a"), ...failing } },
        { Put: { TableName: t, Item: { ...K("c"), n: N("7") } } },
      ],
    }),
  },
  {
    label: "tw: check passing + put",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        { ConditionCheck: { TableName: t, Key: K("a"), ...passing } },
        { Put: { TableName: t, Item: { ...K("c"), n: N("7") } } },
      ],
    }),
  },
  {
    label: "tw: delete of missing item, no condition",
    kind: "tw",
    input: (t) => ({ TransactItems: [{ Delete: { TableName: t, Key: K("q") } }] }),
  },
  {
    label: "tw: update of missing item ADD",
    kind: "tw",
    input: (t) => ({ TransactItems: [upd(t, "q", "ADD #n :one")] }),
  },
  {
    label: "tw: two refused updates (missing, then type)",
    kind: "tw",
    input: (t) => ({
      TransactItems: [
        upd(t, "a", "SET #zz = #zz + :one"),
        upd(t, "b", "SET #zz = #n + #n, #s = #zz"),
      ],
    }),
  },
  {
    label: "tg: repeated key",
    kind: "tg",
    input: (t) => ({
      TransactItems: [
        { Get: { TableName: t, Key: K("a") } },
        { Get: { TableName: t, Key: K("a") } },
      ],
    }),
  },
  {
    label: "tg: repeated missing key",
    kind: "tg",
    input: (t) => ({
      TransactItems: [
        { Get: { TableName: t, Key: K("q") } },
        { Get: { TableName: t, Key: K("q") } },
      ],
    }),
  },
  {
    label: "tg: distinct",
    kind: "tg",
    input: (t) => ({
      TransactItems: [
        { Get: { TableName: t, Key: K("a") } },
        { Get: { TableName: t, Key: K("q") } },
      ],
    }),
  },
  {
    label: "bg: repeated key",
    kind: "bg",
    input: (t) => ({ RequestItems: { [t]: { Keys: [K("a"), K("a")] } } }),
  },
  {
    label: "bg: repeated missing key, other attr order",
    kind: "bg",
    input: (t) => ({
      RequestItems: { [t]: { Keys: [K("q"), { sk: { S: "s" }, pk: { S: "q" } }] } },
    }),
  },
  {
    label: "bg: distinct",
    kind: "bg",
    input: (t) => ({ RequestItems: { [t]: { Keys: [K("a"), K("b")] } } }),
  },
  {
    label: "bw: put+put same key",
    kind: "bw",
    input: (t) => ({
      RequestItems: {
        [t]: [
          { PutRequest: { Item: { ...K("a"), n: N("3") } } },
          { PutRequest: { Item: { ...K("a"), n: N("4") } } },
        ],
      },
    }),
  },
  {
    label: "bw: put+delete same key",
    kind: "bw",
    input: (t) => ({
      RequestItems: {
        [t]: [
          { PutRequest: { Item: { ...K("a"), n: N("3") } } },
          { DeleteRequest: { Key: K("a") } },
        ],
      },
    }),
  },
  {
    label: "bw: delete+delete missing key",
    kind: "bw",
    input: (t) => ({
      RequestItems: {
        [t]: [{ DeleteRequest: { Key: K("q") } }, { DeleteRequest: { Key: K("q") } }],
      },
    }),
  },
  {
    label: "bw: distinct",
    kind: "bw",
    input: (t) => ({
      RequestItems: {
        [t]: [
          { PutRequest: { Item: { ...K("a"), n: N("3") } } },
          { DeleteRequest: { Key: K("b") } },
        ],
      },
    }),
  },
]

const txRow = (tx: Tx): Row => ({
  label: tx.label,
  command: (
    {
      tw: "TransactWriteItems",
      tg: "TransactGetItems",
      bg: "BatchGetItem",
      bw: "BatchWriteItem",
    } as const
  )[tx.kind],
  input: tx.input("$T"),
  seed: seeded(SEEDS),
})

/** A transaction's items, built on `SEEDS`. */
const nEq = (v: string) => ({
  ConditionExpression: "#n = :c",
  ExpressionAttributeNames: { "#n": "n" },
  ExpressionAttributeValues: { ":c": N(v) },
})
const cond = (expression: string, values: Record<string, AttributeValue> = {}) => ({
  ConditionExpression: expression,
  ...placeholders(namesIn(expression), values),
})
const put = (id: string, attributes: Item, extra: object = {}) => ({
  Put: { TableName: "$T", Item: { ...K(id), ...attributes }, ...extra },
})
const check = (id: string, extra: object) => ({
  ConditionCheck: { TableName: "$T", Key: K(id), ...extra },
})
const del = (id: string, extra: object = {}) => ({
  Delete: { TableName: "$T", Key: K(id), ...extra },
})
const update = (
  id: string,
  expression: string,
  values?: Record<string, AttributeValue>,
  extra: { ConditionExpression?: string; ExpressionAttributeValues?: object } = {},
) => {
  const text = `${expression} ${extra.ConditionExpression ?? ""}`
  const all = { ...values, ...extra.ExpressionAttributeValues }
  return {
    Update: {
      TableName: "$T",
      Key: K(id),
      UpdateExpression: expression,
      ...(extra.ConditionExpression === undefined
        ? {}
        : { ConditionExpression: extra.ConditionExpression }),
      ...placeholders(namesIn(text), Object.keys(all).length > 0 ? all : undefined),
    },
  }
}
const tw = (
  label: string,
  items: ReadonlyArray<object>,
  seed: ReadonlyArray<Seed> = seeded(SEEDS),
): Row => ({
  label: `tw: ${label}`,
  command: "TransactWriteItems",
  input: { TransactItems: items },
  seed,
})

const TRANSACTIONS: ReadonlyArray<Row> = [
  // One item twice, its own condition failing, or its update refused (D1).
  tw("one item: Put (condition fails) + Put", [
    put("a", { n: N("5") }, nEq("99")),
    put("a", { n: N("6") }),
  ]),
  tw("one item: Put + ConditionCheck (fails on what the Put wrote)", [
    put("a", { n: N("5") }),
    check("a", nEq("1")),
  ]),
  tw("one item: ConditionCheck (fails) + Put", [check("a", nEq("99")), put("a", { n: N("5") })]),
  tw("one item: Update (refused: missing attribute) + ConditionCheck (passes)", [
    update("a", "SET #zz = #zz + :one", { ":one": N("1") }),
    check("a", nEq("1")),
  ]),
  tw("put a n=5, check a n=5 (passes only on the put)", [
    put("a", { n: N("5") }),
    check("a", nEq("5")),
  ]),
  tw("put a n=5, check a n=1 ALL_OLD", [
    put("a", { n: N("5") }),
    check("a", { ...nEq("1"), ReturnValuesOnConditionCheckFailure: "ALL_OLD" }),
  ]),
  tw("put a zz=1, update a zz=zz+1", [
    put("a", { zz: N("1") }),
    update("a", "SET #zz = #zz + :one", { ":one": N("1") }),
  ]),
  tw("put a (no zz), update a zz=zz+1", [
    put("a", { n: N("3") }),
    update("a", "SET #zz = #zz + :one", { ":one": N("1") }),
  ]),
  tw("put a (no s), update a SET c = s", [put("a", { n: N("3") }), update("a", "SET #c = #s")]),
  tw("put a, put a, update b refused", [
    put("a", {}),
    put("a", {}),
    update("b", "SET #zz = #zz + :one", { ":one": N("1") }),
  ]),
  tw("update b refused, put a, put a", [
    update("b", "SET #zz = #zz + :one", { ":one": N("1") }),
    put("a", {}),
    put("a", {}),
  ]),
  tw("put a failing, put a, put a", [
    put("a", { n: N("5") }, nEq("99")),
    put("a", { n: N("6") }),
    put("a", { n: N("7") }),
  ]),
  tw("delete a, check a attribute_not_exists(pk)", [
    del("a"),
    check("a", cond("attribute_not_exists(#pk)")),
  ]),
  tw("delete a, check a attribute_exists(pk)", [
    del("a"),
    check("a", cond("attribute_exists(#pk)")),
  ]),
  tw("update a n=5, check a n=5", [
    update("a", "SET #n = :v", { ":v": N("5") }),
    check("a", nEq("5")),
  ]),
  tw("update a n=5, check a n=1", [
    update("a", "SET #n = :v", { ":v": N("5") }),
    check("a", nEq("1")),
  ]),
  tw("check a fails, check a passes", [check("a", nEq("99")), check("a", nEq("1"))]),
  tw("check a passes, check a fails", [check("a", nEq("1")), check("a", nEq("99"))]),
  tw("check a passes, check a passes", [check("a", nEq("1")), check("a", nEq("1"))]),
  tw("check a fails, check a fails", [check("a", nEq("99")), check("a", nEq("98"))]),
  tw("put a failing, update a refused", [
    put("a", { n: N("5") }, nEq("99")),
    update("a", "SET #zz = #zz + :one", { ":one": N("1") }),
  ]),
  tw("put a n=5, update a SET x=1 if n=1", [
    put("a", { n: N("5") }),
    update("a", "SET #x = :one", { ":one": N("1") }, nEq("1")),
  ]),
  tw("update b cond fails, put a, put a", [
    update("b", "SET #x = :one", { ":one": N("1") }, nEq("99")),
    put("a", {}),
    put("a", {}),
  ]),
  tw("put b failing, put a, check a passes", [
    put("b", {}, nEq("99")),
    put("a", { n: N("1") }),
    check("a", nEq("1")),
  ]),
  tw("put a, put b failing, check a passes", [
    put("a", { n: N("1") }),
    put("b", {}, nEq("99")),
    check("a", nEq("1")),
  ]),
  tw("put a, check a fails, put b failing", [
    put("a", { n: N("1") }),
    check("a", nEq("99")),
    put("b", {}, nEq("99")),
  ]),
  tw("put a n=5, update a SET n = n + 1 cond n=5", [
    put("a", { n: N("5") }),
    update("a", "SET #n = #n + :one", { ":one": N("1") }, nEq("5")),
  ]),
  tw("delete missing q, put q", [del("q"), put("q", {})]),
  tw("delete missing q with attribute_exists, put q", [
    del("q", cond("attribute_exists(#pk)")),
    put("q", {}),
  ]),
  tw("put a, delete a with attribute_not_exists(pk)", [
    put("a", {}),
    del("a", cond("attribute_not_exists(#pk)")),
  ]),
  tw("delete with failing condition ALL_OLD", [
    del("a", { ...nEq("99"), ReturnValuesOnConditionCheckFailure: "ALL_OLD" }),
  ]),
  tw("update with failing condition ALL_OLD", [
    update("a", "SET #x = :one", { ":one": N("1") }, nEq("99")),
    put("c", {}),
  ]),
  // One key in two tables (N6), and keys whose text joins to the same `<pk>|<sk>`.
  tw("same key, two tables", [
    put("a", { n: N("5") }),
    { Put: { TableName: "$T2", Item: { ...K("a"), n: N("6") } } },
  ]),
  tw("same key, two tables: delete in one, put in the other", [
    del("a"),
    { Put: { TableName: "$T2", Item: { ...K("a"), n: N("6") } } },
  ]),
  tw("keys whose text joins to the same text", [
    { Put: { TableName: "$T", Item: { pk: S("a|b"), sk: S("c") } } },
    { Put: { TableName: "$T", Item: { pk: S("a"), sk: S("b|c") } } },
  ]),
  {
    label: "tg: same key, two tables",
    command: "TransactGetItems",
    input: {
      TransactItems: [
        { Get: { TableName: "$T", Key: K("a") } },
        { Get: { TableName: "$T2", Key: K("a") } },
      ],
    },
    seed: seeded(SEEDS),
  },
  {
    label: "bg: same key, two tables",
    command: "BatchGetItem",
    input: { RequestItems: { $T: { Keys: [K("a")] }, $T2: { Keys: [K("a")] } } },
    seed: seeded(SEEDS),
  },
  {
    label: "bw: same key, two tables",
    command: "BatchWriteItem",
    input: { RequestItems: { $T2: [{ PutRequest: { Item: { ...K("a"), n: N("6") } } }] } },
    seed: seeded(SEEDS),
  },
  {
    label: "bg: keys whose text joins to the same text",
    command: "BatchGetItem",
    input: {
      RequestItems: {
        $T: {
          Keys: [
            { pk: S("a|b"), sk: S("c") },
            { pk: S("a"), sk: S("b|c") },
          ],
        },
      },
    },
    seed: seeded(SEEDS),
  },
]

// ---------------------------------------------------------------------------
// Requests in full: placeholders, keys, return values
// ---------------------------------------------------------------------------

type FullBrief = readonly [
  label: string,
  command: Command,
  input: Record<string, unknown>,
  seed?: Item | null,
]
const RU = (
  expression: string,
  names: Record<string, string> | undefined,
  values: Record<string, AttributeValue> | undefined,
  extra: object = {},
) =>
  [
    "UpdateItem",
    {
      TableName: "$T",
      Key: KEY,
      UpdateExpression: expression,
      ...(names === undefined ? {} : { ExpressionAttributeNames: names }),
      ...(values === undefined ? {} : { ExpressionAttributeValues: values }),
      ...extra,
    },
  ] as const
const RV = (
  expression: string,
  names: Record<string, string>,
  values: Record<string, AttributeValue> | undefined,
  returnValues: string,
) => RU(expression, names, values, { ReturnValues: returnValues })

const REQUESTS: ReadonlyArray<FullBrief> = [
  ["update: unused value", ...RU("SET #a = :v", { "#a": "a" }, { ":v": N("1"), ":w": N("2") })],
  [
    "update: two unused values",
    ...RU("SET #a = :v", { "#a": "a" }, { ":v": N("1"), ":w": N("2"), ":x": N("3") }),
  ],
  ["update: unused name", ...RU("SET #a = :v", { "#a": "a", "#b": "b" }, { ":v": N("1") })],
  [
    "update: unused name and value",
    ...RU("SET #a = :v", { "#a": "a", "#b": "b" }, { ":v": N("1"), ":w": N("2") }),
  ],
  ["update: undefined value", ...RU("SET #a = :v", { "#a": "a" }, { ":w": N("2") })],
  ["update: undefined name", ...RU("SET #a = :v", { "#b": "b" }, { ":v": N("1") })],
  ["update: no names at all, placeholder used", ...RU("SET #a = :v", undefined, { ":v": N("1") })],
  ["update: empty names map", ...RU("SET #a = :v", {}, { ":v": N("1") })],
  ["update: empty values map", ...RU("REMOVE #a", { "#a": "a" }, {})],
  [
    "update: value used only in condition",
    ...RU(
      "SET #a = :v",
      { "#a": "a", "#n": "n" },
      { ":v": N("1"), ":c": N("5") },
      { ConditionExpression: "#n = :c" },
    ),
  ],
  [
    "update: name used only in condition",
    ...RU(
      "SET #a = :v",
      { "#a": "a", "#n": "n" },
      { ":v": N("1") },
      { ConditionExpression: "attribute_exists(#n)" },
    ),
  ],
  [
    "update: undefined value in condition",
    ...RU(
      "SET #a = :v",
      { "#a": "a", "#n": "n" },
      { ":v": N("1") },
      { ConditionExpression: "#n = :c" },
    ),
  ],
  [
    "update: key attribute, failing condition",
    ...RU(
      "SET #pk = :v",
      { "#pk": "pk", "#n": "n" },
      { ":v": { S: "q" }, ":c": N("9") },
      { ConditionExpression: "#n = :c" },
    ),
  ],
  [
    "update: key attribute, no item",
    ...RU("SET #pk = :v", { "#pk": "pk" }, { ":v": { S: "q" } }),
    null,
  ],
  [
    "update: SET x.y = zz + 1 (path and missing)",
    ...RU("SET #x.#y = #zz + :one", { "#x": "x", "#y": "y", "#zz": "zz" }, { ":one": N("1") }),
  ],
  [
    "update: SET x.y = s + 1 (path and type)",
    ...RU("SET #x.#y = #s + :one", { "#x": "x", "#y": "y", "#s": "s" }, { ":one": N("1") }),
  ],
  ["update: bare name", ...RU("SET a = :v", undefined, { ":v": N("1") })],
  ["update: bare reserved name", ...RU("SET status = :v", undefined, { ":v": N("1") })],
  [
    "update: unused value + static operand type",
    ...RU("ADD #n :s", { "#n": "n" }, { ":s": { S: "x" }, ":w": N("1") }),
  ],
  [
    "update: overlap + unused value",
    ...RU("SET #a = :v REMOVE #a", { "#a": "a" }, { ":v": N("1"), ":w": N("1") }),
  ],
  [
    "update: empty set value unused",
    ...RU("SET #a = :v", { "#a": "a" }, { ":v": N("1"), ":e": { SS: [] } }),
  ],
  [
    "delete: unused value",
    "DeleteItem",
    {
      TableName: "$T",
      Key: KEY,
      ConditionExpression: "#n = :c",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":c": N("5"), ":w": N("1") },
    },
  ],
  [
    "delete: names without expression",
    "DeleteItem",
    { TableName: "$T", Key: KEY, ExpressionAttributeNames: { "#n": "n" } },
  ],
  [
    "put: unused name",
    "PutItem",
    {
      TableName: "$T",
      Item: { ...KEY, n: N("1") },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk", "#x": "x" },
    },
  ],
  [
    "get: projection with unused name",
    "GetItem",
    {
      TableName: "$T",
      Key: KEY,
      ProjectionExpression: "#n",
      ExpressionAttributeNames: { "#n": "n", "#x": "x" },
    },
  ],
  [
    "query: unused value",
    "Query",
    {
      TableName: "$T",
      KeyConditionExpression: "#pk = :p",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":p": { S: "p" }, ":w": N("1") },
    },
  ],
  [
    "tx: one item with unused value, other fine",
    "TransactWriteItems",
    {
      TransactItems: [
        { Put: { TableName: "$T", Item: { ...KEY, n: N("1") } } },
        {
          ConditionCheck: {
            TableName: "$T",
            Key: { pk: { S: "q" }, sk: { S: "s" } },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":w": N("1") },
          },
        },
      ],
    },
  ],
  [
    "tx: one item's condition with a map literal <, other's condition fails",
    "TransactWriteItems",
    {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: "$T",
            Key: KEY,
            ConditionExpression: "#n = :c",
            ExpressionAttributeNames: { "#n": "n" },
            ExpressionAttributeValues: { ":c": N("9") },
          },
        },
        {
          ConditionCheck: {
            TableName: "$T",
            Key: { pk: { S: "q" }, sk: { S: "s" } },
            ConditionExpression: "#n < :m",
            ExpressionAttributeNames: { "#n": "n" },
            ExpressionAttributeValues: { ":m": { M: {} } },
          },
        },
      ],
    },
  ],
  [
    "tx: update static error (ADD string) + other fails",
    "TransactWriteItems",
    {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: "$T",
            Key: KEY,
            ConditionExpression: "#n = :c",
            ExpressionAttributeNames: { "#n": "n" },
            ExpressionAttributeValues: { ":c": N("9") },
          },
        },
        {
          Update: {
            TableName: "$T",
            Key: { pk: { S: "q" }, sk: { S: "s" } },
            UpdateExpression: "ADD #n :s",
            ExpressionAttributeNames: { "#n": "n" },
            ExpressionAttributeValues: { ":s": { S: "x" } },
          },
        },
      ],
    },
  ],
  [
    "tx: repeated item, the second has an unused value",
    "TransactWriteItems",
    {
      TransactItems: [
        { Put: { TableName: "$T", Item: { ...KEY, n: N("1") } } },
        {
          ConditionCheck: {
            TableName: "$T",
            Key: KEY,
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":w": N("1") },
          },
        },
      ],
    },
  ],
  [
    "tx: key attribute update",
    "TransactWriteItems",
    {
      TransactItems: [
        {
          Update: {
            TableName: "$T",
            Key: KEY,
            UpdateExpression: "SET #pk = :v",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":v": { S: "q" } },
          },
        },
      ],
    },
  ],

  ["NS dup by value", ...RU("SET #a = :v", { "#a": "a" }, { ":v": { NS: ["1", "1.0"] } })],
  ["NS dup exact", ...RU("SET #a = :v", { "#a": "a" }, { ":v": { NS: ["1", "1"] } })],
  [
    "BS dup",
    ...RU(
      "SET #a = :v",
      { "#a": "a" },
      { ":v": { BS: [new Uint8Array([1]), new Uint8Array([1])] } },
    ),
  ],
  ["NS empty", ...RU("SET #a = :v", { "#a": "a" }, { ":v": { NS: [] } })],
  ["BS empty", ...RU("SET #a = :v", { "#a": "a" }, { ":v": { BS: [] } })],
  [
    "SS dup nested in map",
    ...RU("SET #a = :v", { "#a": "a" }, { ":v": { M: { x: { SS: ["a", "a"] } } } }),
  ],
  ["N invalid nested in list", ...RU("SET #a = :v", { "#a": "a" }, { ":v": { L: [N("x")] } })],
  [
    "unused values order :x then :w",
    ...RU("SET #a = :v", { "#a": "a" }, { ":v": N("1"), ":x": N("2"), ":w": N("3") }),
  ],
  [
    "unused names order #z then #b",
    ...RU("SET #a = :v", { "#a": "a", "#z": "z", "#b": "b" }, { ":v": N("1") }),
  ],
  [
    "two invalid values",
    ...RU("SET #a = :v, #b = :w", { "#a": "a", "#b": "b" }, { ":v": { SS: [] }, ":w": N("x") }),
  ],
  [
    "undefined two values",
    ...RU("SET #a = :v, #b = :w", { "#a": "a", "#b": "b" }, { ":q": N("1") }),
  ],
  ["invalid value and undefined name", ...RU("SET #a = :v", { "#b": "b" }, { ":v": { SS: [] } })],
  [
    "undefined name and unused value",
    ...RU("SET #a = :v", { "#b": "b" }, { ":v": N("1"), ":w": N("1") }),
  ],
  ["put item NS dup", "PutItem", { TableName: "$T", Item: { ...KEY, a: { NS: ["1", "1.0"] } } }],
  ["put item invalid number", "PutItem", { TableName: "$T", Item: { ...KEY, a: N("1e126") } }],
  ["put item empty SS", "PutItem", { TableName: "$T", Item: { ...KEY, a: { SS: [] } } }],
  [
    "put item number 39 digits",
    "PutItem",
    { TableName: "$T", Item: { ...KEY, a: N("123456789012345678901234567890123456789") } },
  ],
  ["put item S empty key", "PutItem", { TableName: "$T", Item: { pk: { S: "" }, sk: { S: "s" } } }],
  ["key with NS", "GetItem", { TableName: "$T", Key: { pk: { N: "1" }, sk: { S: "s" } } }],
  ["key extra attribute", "GetItem", { TableName: "$T", Key: { ...KEY, x: { S: "s" } } }],
  ["key missing sk", "GetItem", { TableName: "$T", Key: { pk: { S: "p" } } }],
  [
    "key S vs B for pk",
    "DeleteItem",
    { TableName: "$T", Key: { pk: { B: new Uint8Array([1]) }, sk: { S: "s" } } },
  ],
  [
    "batch get dup across tables same key",
    "BatchGetItem",
    { RequestItems: { $T: { Keys: [KEY] } } },
  ],
  [
    "condition on missing item with undefined value",
    "DeleteItem",
    {
      TableName: "$T",
      Key: { pk: { S: "zz" }, sk: { S: "s" } },
      ConditionExpression: "#n = :c",
      ExpressionAttributeNames: { "#n": "n" },
    },
  ],

  [
    "UPDATED_NEW nested",
    ...RV(
      "SET #m.#k = :v, #a = :v REMOVE #s",
      { "#m": "m", "#k": "k", "#a": "a", "#s": "s" },
      { ":v": N("9") },
      "UPDATED_NEW",
    ),
  ],
  [
    "UPDATED_OLD nested",
    ...RV(
      "SET #m.#k = :v, #a = :v REMOVE #s",
      { "#m": "m", "#k": "k", "#a": "a", "#s": "s" },
      { ":v": N("9") },
      "UPDATED_OLD",
    ),
  ],
  [
    "UPDATED_NEW list index",
    ...RV("SET #l[0] = :v, #l[5] = :v", { "#l": "l" }, { ":v": N("9") }, "UPDATED_NEW"),
  ],
  [
    "UPDATED_OLD list index",
    ...RV("SET #l[0] = :v, #l[5] = :v", { "#l": "l" }, { ":v": N("9") }, "UPDATED_OLD"),
  ],
  ["UPDATED_OLD nothing old", ...RV("SET #a = :v", { "#a": "a" }, { ":v": N("9") }, "UPDATED_OLD")],
  ["ALL_OLD no item", ...RV("SET #a = :v", { "#a": "a" }, { ":v": N("9") }, "ALL_OLD"), null],
  [
    "UPDATED_NEW ADD set",
    ...RV(
      "ADD #ns :x DELETE #ss :y",
      { "#ns": "ns", "#ss": "ss" },
      { ":x": { NS: ["3"] }, ":y": { SS: ["a"] } },
      "UPDATED_NEW",
    ),
  ],
  [
    "UPDATED_NEW DELETE emptying",
    ...RV("DELETE #ss :y", { "#ss": "ss" }, { ":y": { SS: ["a", "b"] } }, "UPDATED_NEW"),
  ],
  [
    "UPDATED_OLD m.k and m.j",
    ...RV(
      "SET #m.#k = :v, #m.#j = :v",
      { "#m": "m", "#k": "k", "#j": "j" },
      { ":v": N("9") },
      "UPDATED_OLD",
    ),
  ],
]

/** The key and request checks, on an item `a`. */
const KA: Item = { pk: S("a"), sk: S("s") }
const KEYED: ReadonlyArray<FullBrief> = (
  [
    ["get: missing sk", "GetItem", { TableName: "$T", Key: { pk: S("a") } }],
    ["get: extra attribute", "GetItem", { TableName: "$T", Key: { ...KA, x: S("1") } }],
    ["get: N pk", "GetItem", { TableName: "$T", Key: { pk: N("1"), sk: S("s") } }],
    ["get: B pk", "GetItem", { TableName: "$T", Key: { pk: { B: bytes(1) }, sk: S("s") } }],
    ["get: empty sk", "GetItem", { TableName: "$T", Key: { pk: S("a"), sk: S("") } }],
    ["get: no such table", "GetItem", { TableName: "nope-no-such-table", Key: KA }],
    [
      "get: projection of a missing attribute",
      "GetItem",
      {
        TableName: "$T",
        Key: KA,
        ProjectionExpression: "#z",
        ExpressionAttributeNames: { "#z": "zz" },
      },
    ],
    [
      "get: projection",
      "GetItem",
      {
        TableName: "$T",
        Key: KA,
        ProjectionExpression: "#n, #pk",
        ExpressionAttributeNames: { "#n": "n", "#pk": "pk" },
      },
    ],
    [
      "get: item that isn't there",
      "GetItem",
      { TableName: "$T", Key: { pk: S("zz"), sk: S("s") } },
    ],
    ["put: missing sk", "PutItem", { TableName: "$T", Item: { pk: S("a") } }],
    ["put: N sk", "PutItem", { TableName: "$T", Item: { pk: S("a"), sk: N("1") } }],
    ["put: empty pk", "PutItem", { TableName: "$T", Item: { pk: S(""), sk: S("s") } }],
    [
      "update: a key attribute",
      "UpdateItem",
      {
        TableName: "$T",
        Key: KA,
        UpdateExpression: "SET #sk = :v",
        ExpressionAttributeNames: { "#sk": "sk" },
        ExpressionAttributeValues: { ":v": S("t") },
      },
    ],
    [
      "tw: update of a key attribute",
      "TransactWriteItems",
      {
        TransactItems: [
          {
            Update: {
              TableName: "$T",
              Key: KA,
              UpdateExpression: "SET #sk = :v",
              ExpressionAttributeNames: { "#sk": "sk" },
              ExpressionAttributeValues: { ":v": S("t") },
            },
          },
          { Put: { TableName: "$T", Item: { pk: S("b"), sk: S("s") } } },
        ],
      },
    ],
    [
      "tw: condition fails",
      "TransactWriteItems",
      {
        TransactItems: [
          {
            ConditionCheck: {
              TableName: "$T",
              Key: KA,
              ConditionExpression: "attribute_not_exists(#p)",
              ExpressionAttributeNames: { "#p": "pk" },
            },
          },
          { Put: { TableName: "$T", Item: { pk: S("b"), sk: S("s") } } },
        ],
      },
    ],
    [
      "tw: put missing sk",
      "TransactWriteItems",
      { TransactItems: [{ Put: { TableName: "$T", Item: { pk: S("b") } } }] },
    ],
    [
      "tw: put N pk",
      "TransactWriteItems",
      { TransactItems: [{ Put: { TableName: "$T", Item: { pk: N("1"), sk: S("s") } } }] },
    ],
    [
      "tg: missing sk",
      "TransactGetItems",
      { TransactItems: [{ Get: { TableName: "$T", Key: { pk: S("a") } } }] },
    ],
    ["bg: missing sk", "BatchGetItem", { RequestItems: { $T: { Keys: [{ pk: S("a") }] } } }],
    // Binary sort keys [1] and [2] under one partition key: never one item twice.
    [
      "bg: binary sort keys",
      "BatchGetItem",
      {
        RequestItems: {
          $T: {
            Keys: [
              { pk: S("a"), sk: { B: bytes(1) } },
              { pk: S("a"), sk: { B: bytes(2) } },
            ],
          },
        },
      },
    ],
    [
      "tg: binary sort keys",
      "TransactGetItems",
      {
        TransactItems: [
          { Get: { TableName: "$T", Key: { pk: S("a"), sk: { B: bytes(1) } } } },
          { Get: { TableName: "$T", Key: { pk: S("a"), sk: { B: bytes(2) } } } },
        ],
      },
    ],
    [
      "bw: binary sort keys",
      "BatchWriteItem",
      {
        RequestItems: {
          $T: [
            { DeleteRequest: { Key: { pk: S("a"), sk: { B: bytes(1) } } } },
            { DeleteRequest: { Key: { pk: S("a"), sk: { B: bytes(2) } } } },
          ],
        },
      },
    ],
    [
      "bw: missing sk",
      "BatchWriteItem",
      { RequestItems: { $T: [{ PutRequest: { Item: { pk: S("a") } } }] } },
    ],
    ["put: RV UPDATED_NEW", "PutItem", { TableName: "$T", Item: KA, ReturnValues: "UPDATED_NEW" }],
    [
      "put: RV ALL_OLD",
      "PutItem",
      { TableName: "$T", Item: { ...KA, n: N("2") }, ReturnValues: "ALL_OLD" },
    ],
    [
      "put: RV ALL_OLD, nothing there",
      "PutItem",
      { TableName: "$T", Item: { pk: S("new"), sk: S("s") }, ReturnValues: "ALL_OLD" },
    ],
    [
      "put: condition fails, ALL_OLD",
      "PutItem",
      {
        TableName: "$T",
        Item: KA,
        ConditionExpression: "attribute_not_exists(#p)",
        ExpressionAttributeNames: { "#p": "pk" },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    ],
    [
      "put: condition fails",
      "PutItem",
      {
        TableName: "$T",
        Item: KA,
        ConditionExpression: "attribute_not_exists(#p)",
        ExpressionAttributeNames: { "#p": "pk" },
      },
    ],
    [
      "delete: RV ALL_NEW",
      "DeleteItem",
      { TableName: "$T", Key: { pk: S("z"), sk: S("s") }, ReturnValues: "ALL_NEW" },
    ],
    ["delete: RV ALL_OLD", "DeleteItem", { TableName: "$T", Key: KA, ReturnValues: "ALL_OLD" }],
    [
      "delete: condition fails on nothing, ALL_OLD",
      "DeleteItem",
      {
        TableName: "$T",
        Key: { pk: S("z"), sk: S("s") },
        ConditionExpression: "attribute_exists(#p)",
        ExpressionAttributeNames: { "#p": "pk" },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    ],
    [
      "update: condition fails, ALL_OLD",
      "UpdateItem",
      {
        TableName: "$T",
        Key: KA,
        UpdateExpression: "SET #x = :v",
        ConditionExpression: "#n = :c",
        ExpressionAttributeNames: { "#x": "x", "#n": "n" },
        ExpressionAttributeValues: { ":v": N("1"), ":c": N("9") },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    ],
    [
      "update: RV ALL_NEW, nothing there",
      "UpdateItem",
      {
        TableName: "$T",
        Key: { pk: S("new"), sk: S("s") },
        UpdateExpression: "SET #x = :v",
        ExpressionAttributeNames: { "#x": "x" },
        ExpressionAttributeValues: { ":v": N("1") },
        ReturnValues: "ALL_NEW",
      },
    ],
    [
      "update: RV NONE",
      "UpdateItem",
      {
        TableName: "$T",
        Key: KA,
        UpdateExpression: "SET #x = :v",
        ExpressionAttributeNames: { "#x": "x" },
        ExpressionAttributeValues: { ":v": N("1") },
        ReturnValues: "NONE",
      },
    ],
    ["update: no UpdateExpression", "UpdateItem", { TableName: "$T", Key: KA }],
  ] as ReadonlyArray<readonly [string, Command, Record<string, unknown>]>
).map(([label, command, input]): FullBrief => [label, command, input, { ...KA, n: N("1") }])

const fullRow = ([label, command, input, seed]: FullBrief): Row => ({
  label: `${command}: ${label}`,
  command,
  input,
  seed: seed === null ? [] : seeded([seed ?? SEED]),
})

// ---------------------------------------------------------------------------
// Queries and scans
// ---------------------------------------------------------------------------

const Q = (sk: string, attributes: Item = {}, pk = "q"): Item => ({
  pk: S(pk),
  sk: S(sk),
  ...attributes,
})
const QUERY_SEED: ReadonlyArray<Item> = [
  Q("1", { n: N("1"), gpk: S("g"), gsk: S("3") }),
  Q("2", { n: N("2"), gpk: S("g"), gsk: S("1") }),
  Q("3", { n: N("3") }),
  Q("4", { n: N("4"), gpk: S("g"), gsk: S("2") }),
  Q("5", { n: N("5"), gpk: S("h"), gsk: S("1") }),
  Q("1", { n: N("9"), gpk: S("g"), gsk: S("4") }, "r"),
]
const byPartition = {
  KeyConditionExpression: "#pk = :p",
  ExpressionAttributeNames: { "#pk": "pk" },
  ExpressionAttributeValues: { ":p": S("q") },
}
const byIndex = {
  IndexName: "gsi1",
  KeyConditionExpression: "#g = :g",
  ExpressionAttributeNames: { "#g": "gpk" },
  ExpressionAttributeValues: { ":g": S("g") },
}
const range = (expression: string, values: Record<string, AttributeValue>, extra: object = {}) => ({
  KeyConditionExpression: `#pk = :p AND ${expression}`,
  ExpressionAttributeNames: namesIn(`#pk ${expression}`),
  ExpressionAttributeValues: { ":p": S("q"), ...values },
  ...extra,
})
const queryRow = (label: string, input: object, command: Command = "Query"): Row => ({
  label: `${command === "Query" ? "query" : "scan"}: ${label}`,
  command,
  input: { TableName: "$T", ...input },
  seed: seeded(QUERY_SEED),
})
const QUERIES: ReadonlyArray<Row> = [
  queryRow("by partition", byPartition),
  queryRow("reversed", { ...byPartition, ScanIndexForward: false }),
  queryRow("Limit 2", { ...byPartition, Limit: 2 }),
  queryRow("Limit 2 from a start key", { ...byPartition, Limit: 2, ExclusiveStartKey: Q("2") }),
  queryRow("reversed from a start key", {
    ...byPartition,
    ScanIndexForward: false,
    ExclusiveStartKey: { pk: S("q"), sk: S("4") },
  }),
  queryRow("Limit 5 reads the last item, and says so", { ...byPartition, Limit: 5 }),
  queryRow("BETWEEN", range("#sk BETWEEN :a AND :b", { ":a": S("2"), ":b": S("4") })),
  queryRow(
    "BETWEEN the wrong way round",
    range("#sk BETWEEN :a AND :b", { ":a": S("4"), ":b": S("2") }),
  ),
  queryRow("begins_with", range("begins_with(#sk, :a)", { ":a": S("3") })),
  queryRow(
    "sk >, a filter, Limit",
    range(
      "#sk > :a",
      { ":a": S("1"), ":n": N("3") },
      {
        FilterExpression: "#n > :n",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#n": "n" },
        Limit: 3,
      },
    ),
  ),
  queryRow("Select COUNT", { ...byPartition, Select: "COUNT" }),
  queryRow("Select COUNT with a filter", {
    ...byPartition,
    Select: "COUNT",
    FilterExpression: "#n > :n",
    ExpressionAttributeNames: { "#pk": "pk", "#n": "n" },
    ExpressionAttributeValues: { ":p": S("q"), ":n": N("2") },
  }),
  queryRow("projection", {
    ...byPartition,
    ProjectionExpression: "#n, #sk",
    ExpressionAttributeNames: { "#pk": "pk", "#n": "n", "#sk": "sk" },
  }),
  queryRow("the index", byIndex),
  queryRow("the index, Limit 2", { ...byIndex, Limit: 2 }),
  queryRow("the index from a start key", {
    ...byIndex,
    ExclusiveStartKey: { pk: S("q"), sk: S("4"), gpk: S("g"), gsk: S("2") },
  }),
  queryRow("the index, reversed", { ...byIndex, ScanIndexForward: false }),
  queryRow("the index, consistent read", { ...byIndex, ConsistentRead: true }),
  queryRow("the index, a filter on the table's sort key", {
    ...byIndex,
    FilterExpression: "#sk = :s",
    ExpressionAttributeNames: { "#g": "gpk", "#sk": "sk" },
    ExpressionAttributeValues: { ":g": S("g"), ":s": S("4") },
  }),
  queryRow("the index, a filter on the index's sort key", {
    ...byIndex,
    FilterExpression: "#gs = :s",
    ExpressionAttributeNames: { "#g": "gpk", "#gs": "gsk" },
    ExpressionAttributeValues: { ":g": S("g"), ":s": S("2") },
  }),
  queryRow("the index, its sort key", {
    IndexName: "gsi1",
    KeyConditionExpression: "#g = :g AND #gs > :s",
    ExpressionAttributeNames: { "#g": "gpk", "#gs": "gsk" },
    ExpressionAttributeValues: { ":g": S("g"), ":s": S("1") },
  }),
  queryRow("an N partition value", { ...byPartition, ExpressionAttributeValues: { ":p": N("1") } }),
  queryRow("the sort key only", {
    KeyConditionExpression: "#sk = :s",
    ExpressionAttributeNames: { "#sk": "sk" },
    ExpressionAttributeValues: { ":s": S("1") },
  }),
  queryRow("a non-key attribute", range("#n = :n", { ":n": N("1") })),
  queryRow("sk <>", range("#sk <> :a", { ":a": S("1") })),
  queryRow("OR", {
    KeyConditionExpression: "#pk = :p OR #sk = :s",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: { ":p": S("q"), ":s": S("1") },
  }),
  queryRow("the sort key first", {
    KeyConditionExpression: "#sk = :s AND #pk = :p",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: { ":p": S("q"), ":s": S("1") },
  }),
  queryRow(":p = #pk", { ...byPartition, KeyConditionExpression: ":p = #pk" }),
  queryRow("a filter on a key attribute", {
    ...byPartition,
    FilterExpression: "#sk = :s",
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: { ":p": S("q"), ":s": S("1") },
  }),
  queryRow("all items", {}, "Scan"),
  queryRow(
    "a filter",
    {
      FilterExpression: "#n > :n",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":n": N("3") },
    },
    "Scan",
  ),
]

// ---------------------------------------------------------------------------
// A top-level `__proto__` (N5)
// ---------------------------------------------------------------------------

/** An item holding `__proto__` as its own attribute, top-level and in a map. */
const PROTO_ITEM: Item = JSON.parse(
  '{"pk":{"S":"p"},"sk":{"S":"s"},"__proto__":{"N":"1"},"m":{"M":{"__proto__":{"S":"x"},"k":{"N":"2"}}}}',
)
const protoRow = (label: string, command: Command, input: object): Row => ({
  label: `__proto__: ${label}`,
  command,
  input: Object.fromEntries(
    Object.entries({ TableName: "$T", ...input }).filter(([, value]) => value !== undefined),
  ),
  seed: seeded([PROTO_ITEM]),
})
const PROTO: ReadonlyArray<Row> = [
  protoRow("get", "GetItem", { Key: KEY }),
  protoRow("query", "Query", {
    KeyConditionExpression: "#pk = :p",
    ExpressionAttributeNames: { "#pk": "pk" },
    ExpressionAttributeValues: { ":p": S("p") },
  }),
  protoRow("scan", "Scan", {}),
  protoRow("update ALL_NEW", "UpdateItem", {
    Key: KEY,
    UpdateExpression: "SET #a = :v",
    ExpressionAttributeNames: { "#a": "a" },
    ExpressionAttributeValues: { ":v": N("1") },
    ReturnValues: "ALL_NEW",
  }),
  protoRow("update of it, UPDATED_OLD", "UpdateItem", {
    Key: KEY,
    UpdateExpression: "SET #p = :v, #m.#p = :v",
    ExpressionAttributeNames: { "#p": "__proto__", "#m": "m" },
    ExpressionAttributeValues: { ":v": N("3") },
    ReturnValues: "UPDATED_OLD",
  }),
  protoRow("delete ALL_OLD", "DeleteItem", { Key: KEY, ReturnValues: "ALL_OLD" }),
  protoRow("condition on it", "DeleteItem", {
    Key: KEY,
    ConditionExpression: "#p = :v AND #m.#p = :s",
    ExpressionAttributeNames: { "#p": "__proto__", "#m": "m" },
    ExpressionAttributeValues: { ":v": N("1"), ":s": S("x") },
  }),
  protoRow("batch get", "BatchGetItem", {
    TableName: undefined,
    RequestItems: { $T: { Keys: [KEY] } },
  }),
  protoRow("transact get", "TransactGetItems", {
    TableName: undefined,
    TransactItems: [{ Get: { TableName: "$T", Key: KEY } }],
  }),
  protoRow("a failed condition's item", "PutItem", {
    Item: KEY,
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
  }),
  protoRow("a cancellation reason's item", "TransactWriteItems", {
    TableName: undefined,
    TransactItems: [
      {
        ConditionCheck: {
          TableName: "$T",
          Key: KEY,
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
    ],
  }),
  protoRow("projection of it", "GetItem", {
    Key: KEY,
    ProjectionExpression: "#p, #m.#p",
    ExpressionAttributeNames: { "#p": "__proto__", "#m": "m" },
  }),
]

// ---------------------------------------------------------------------------
// All the rows, and the ones the tables answer differently on purpose
// ---------------------------------------------------------------------------

/** Every row, once: a row repeating an earlier row's label and request is left out. */
const ROWS: ReadonlyArray<Row> = (() => {
  const all = [
    ...U.map(updateRow),
    ...UPDATES.map(briefUpdate),
    ...NUMBERS.map(briefUpdate),
    ...OPERANDS.map(briefUpdate),
    ...ORDER,
    ...C.map(conditionRow),
    ...CONDITIONS.map(briefCondition),
    ...TX.map(txRow),
    ...TRANSACTIONS,
    ...REQUESTS.map(fullRow),
    ...KEYED.map(fullRow),
    ...QUERIES,
    ...PROTO,
  ]
  const byLabel = new Map<string, Row>()
  for (const row of all) {
    const held = byLabel.get(row.label)
    if (held === undefined) byLabel.set(row.label, row)
    else if (
      show([held.command, held.input, held.seed]) !== show([row.command, row.input, row.seed])
    ) {
      throw new Error(`two rows are labelled ${row.label}`)
    }
  }
  return [...byLabel.values()]
})()

type Backend = "recording" | "inMemory" | "holds"
/**
 * Rows a helper answers differently from DynamoDB Local, on purpose, and why. `byValue`: the
 * answers differ only in how a number is spelled, and agree compared by value.
 */
const KNOWN: Readonly<
  Record<
    string,
    {
      readonly reason: string
      readonly on: ReadonlyArray<Backend>
      readonly byValue?: true
    }
  >
> = {
  'update: SET #zz = :x {":x":{"NS":["100","0.10","1e-7","1e21"]}}': {
    reason:
      "DynamoDB Local stores a number set written from a request's value as Java's BigDecimal prints each member (1e21 as 1E+21, 1e-7 as 1E-7); the tables keep the request's spelling",
    on: ["recording", "inMemory"],
    byValue: true,
  },
  "__proto__: a failed condition's item": {
    reason:
      "the AWS SDK fails to read an error's item holding a top-level __proto__ attribute (a TypeError, 'Deserialization error'); the tables return the item as the SDK reads a successful answer's",
    on: ["recording", "inMemory"],
  },
  "__proto__: a cancellation reason's item": {
    reason:
      "the AWS SDK fails to read a cancellation reason's item holding a top-level __proto__ attribute (a TypeError, 'Deserialization error'); the tables return the item as the SDK reads a successful answer's",
    on: ["recording", "inMemory"],
  },
  "GetItem: get: no such table": {
    reason:
      "the tables keep no list of tables: any name a request gives is a table, empty until written; DynamoDB Local refuses a table that doesn't exist (ResourceNotFoundException)",
    on: ["recording", "inMemory"],
  },
  "TransactWriteItems: tw: put N pk": {
    reason:
      "DynamoDB Local cancels a transaction whose key is of the wrong type with one ValidationError reason; not modelled, so the tables name the request as one they don't read",
    on: ["recording", "inMemory"],
  },
  "TransactWriteItems: tw: update of a key attribute": {
    reason:
      "DynamoDB Local cancels a transaction updating a key attribute with one ValidationError reason, however many items it has; not modelled, so the tables name the request as one they don't read",
    on: ["recording", "inMemory"],
  },
  "TransactWriteItems: tx: key attribute update": {
    reason:
      "DynamoDB Local cancels a transaction updating a key attribute with one ValidationError reason; not modelled, so the tables name the request as one they don't read",
    on: ["recording", "inMemory"],
  },
  "tw: same key, two tables": {
    reason:
      "the recording table holds every table's items in one map keyed <pk>|<sk>, so it can't hold one key in two tables: writing another table's item under the same key is a defect, never a merge (InMemoryClient keys items by table, and agrees)",
    on: ["recording"],
  },
  "bw: same key, two tables": {
    reason:
      "the recording table holds every table's items in one map keyed <pk>|<sk>: writing another table's item under the same key is a defect, never a merge",
    on: ["recording"],
  },
  "tw: keys whose text joins to the same text": {
    reason:
      "the tables keep items under their key text <pk>|<sk>, where a key holding | would name another item too: such a key is a defect, never a merge",
    on: ["recording", "inMemory"],
  },
  "bg: keys whose text joins to the same text": {
    reason:
      "the recording table keeps items under their key text <pk>|<sk>, where a key holding | would name another item too: such a key is a defect",
    on: ["recording"],
  },
}

// ---------------------------------------------------------------------------
// Answers, as compared
// ---------------------------------------------------------------------------

const canonNumber = (text: string): string => {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (match === null) return `not a number: ${text}`
  const frac = match[3] ?? ""
  let exp = Number(match[4] ?? 0) - frac.length
  let digits = `${match[2] ?? ""}${frac}`.replace(/^0+/, "")
  if (digits === "") return "0"
  const trail = digits.length - digits.replace(/0+$/, "").length
  digits = digits.slice(0, digits.length - trail)
  exp += trail
  return `${match[1] === "-" ? "-" : ""}${digits}e${exp}`
}
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex")
/** A value as compared: sets in any order, bytes as hex, numbers by value or (`exact`) as spelled. */
const canon = (value: any, exact = false): unknown => {
  const number = exact ? (text: string) => text : canonNumber
  if (value === undefined) return "<undefined>"
  if (value.N !== undefined) return { N: number(value.N) }
  if (value.S !== undefined) return { S: value.S }
  if (value.B !== undefined) return { B: hex(value.B) }
  if (value.BOOL !== undefined) return { BOOL: value.BOOL }
  if (value.NULL !== undefined) return { NULL: value.NULL }
  if (value.SS !== undefined) return { SS: [...value.SS].sort() }
  if (value.NS !== undefined) return { NS: value.NS.map(number).sort() }
  if (value.BS !== undefined) return { BS: value.BS.map(hex).sort() }
  if (value.L !== undefined) {
    return { L: Array.from(value.L as Array<unknown>, (each) => canon(each, exact)) }
  }
  if (value.M !== undefined) return { M: canonItem(value.M, exact) }
  return { unknown: show(value) }
}
/** An item's attributes in name order; an own `__proto__` is named so it can't be lost. */
const canonItem = (item: Record<string, unknown>, exact = false) =>
  Object.fromEntries(
    Object.getOwnPropertyNames(item)
      .sort()
      .map((key) => [key === "__proto__" ? "__proto__ (own)" : key, canon(item[key], exact)]),
  )
const unordered = (items: ReadonlyArray<Record<string, unknown>>, exact = false) =>
  items.map((item) => show(canonItem(item, exact))).sort()

const outputOf = (command: Command, output: any, exact = false) => {
  const item = (each: Record<string, unknown>) => canonItem(each, exact)
  const answer: Record<string, unknown> = {}
  if (output.Item !== undefined) answer.Item = item(output.Item)
  if (output.Attributes !== undefined) answer.Attributes = item(output.Attributes)
  if (output.Items !== undefined) {
    answer.Items = command === "Scan" ? unordered(output.Items, exact) : output.Items.map(item)
  }
  for (const field of ["Count", "ScannedCount"]) {
    if (output[field] !== undefined) answer[field] = output[field]
  }
  if (output.LastEvaluatedKey !== undefined) {
    answer.LastEvaluatedKey = item(output.LastEvaluatedKey)
  }
  if (Array.isArray(output.Responses)) {
    answer.Responses = output.Responses.map((each: any) =>
      each.Item === undefined ? {} : { Item: item(each.Item) },
    )
  } else if (output.Responses !== undefined) {
    answer.Responses = Object.fromEntries(
      Object.entries(output.Responses as Record<string, Array<Item>>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([table, items]) => [table, unordered(items, exact)]),
    )
  }
  for (const field of ["UnprocessedItems", "UnprocessedKeys"]) {
    if (output[field] !== undefined && Object.keys(output[field]).length > 0) {
      answer[field] = show(output[field])
    }
  }
  return { ok: answer }
}
const errorOf = (error: any, exact = false) => ({
  error: error.name,
  message: error.message,
  ...(error.CancellationReasons === undefined
    ? {}
    : {
        reasons: error.CancellationReasons.map((reason: any) => ({
          Code: reason.Code,
          ...(reason.Message === undefined ? {} : { Message: reason.Message }),
          ...(reason.Item === undefined ? {} : { Item: canonItem(reason.Item, exact) }),
        })),
      }),
  ...(error.Item === undefined ? {} : { Item: canonItem(error.Item, exact) }),
})
/** An answer as it came back: the output, the DynamoDB error, or the request a helper doesn't read. */
type Result =
  | { readonly ok: unknown }
  | { readonly error: unknown }
  | { readonly unreadable: string }

/** What a request was answered with, and every item each table holds afterwards. */
interface Answer {
  readonly result: Result
  readonly tables: Record<string, ReadonlyArray<Item>>
}

/** A helper's result. */
const resultOf = (exit: Exit.Exit<unknown, unknown>): Result => {
  if (Exit.isSuccess(exit)) return { ok: exit.value }
  const failure = Cause.squash(exit.cause) as any
  if (failure?.cause !== undefined && typeof failure.cause.name === "string") {
    return { error: failure.cause }
  }
  return { unreadable: `${failure?.name}: ${failure?.message ?? String(failure)}` }
}
const viewResult = (command: Command, result: Result, exact = false) =>
  "ok" in result
    ? outputOf(command, result.ok, exact)
    : "error" in result
      ? errorOf(result.error, exact)
      : result
/** An answer as compared. */
const view = (command: Command, answer: Answer, exact = false) => ({
  answer: viewResult(command, answer.result, exact),
  tables: Object.fromEntries(
    Object.entries(answer.tables).map(([alias, items]) => [alias, unordered(items, exact)]),
  ),
})

const scanAll = async (table: string): Promise<ReadonlyArray<Item>> => {
  const items: Array<Item> = []
  let start: Item | undefined
  do {
    const page = await raw.send(
      new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }),
    )
    items.push(...(page.Items ?? []))
    start = page.LastEvaluatedKey
  } while (start !== undefined)
  return items
}

const onLocal = async (row: Row): Promise<Answer> => {
  for (const table of Object.values(TABLES)) {
    for (const item of await scanAll(table)) {
      await raw.send(
        new DeleteItemCommand({ TableName: table, Key: { pk: item.pk!, sk: item.sk! } }),
      )
    }
  }
  for (const seed of row.seed) {
    await raw.send(new PutItemCommand({ TableName: TABLES[seed.table]!, Item: named(seed.item) }))
  }
  let result: Result
  try {
    const Command = COMMANDS[row.command] as new (input: unknown) => any
    result = { ok: await raw.send(new Command(named(row.input))) }
  } catch (error) {
    result = { error }
  }
  const tables: Record<string, ReadonlyArray<Item>> = {}
  for (const [alias, table] of Object.entries(TABLES)) tables[alias] = await scanAll(table)
  return { result, tables }
}

const onRecording = async (row: Row): Promise<Answer> => {
  const table = makeRecordingTable({ indexes: INDEXES })
  const client = table.client as unknown as Record<
    string,
    (input: unknown) => Effect.Effect<any, unknown>
  >
  for (const seed of row.seed) {
    await Effect.runPromise(
      client.putItem!({ TableName: TABLES[seed.table], Item: named(seed.item) }),
    )
  }
  const exit = await Effect.runPromiseExit(
    Effect.suspend(() => client[METHODS[row.command]]!(named(row.input))),
  )
  const tables: Record<string, ReadonlyArray<Item>> = {}
  for (const [alias, name] of Object.entries(TABLES)) {
    tables[alias] = (await Effect.runPromise(client.scan!({ TableName: name }))).Items ?? []
  }
  return { result: resultOf(exit), tables }
}

const onInMemory = async (row: Row): Promise<Answer | undefined> => {
  if (!IN_MEMORY.has(row.command)) return undefined
  resetStore()
  for (const seed of row.seed) {
    const name = TABLES[seed.table]!
    store.set(storeKey(name, seed.item), named(seed.item))
  }
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = (yield* DynamoClient) as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, unknown>
      >
      return yield* client[METHODS[row.command]]!(named(row.input))
    }).pipe(Effect.provide(InMemoryClient)),
  )
  const tables: Record<string, ReadonlyArray<Item>> = {}
  for (const [alias, name] of Object.entries(TABLES)) {
    // As a read through the client returns them, as DynamoDB Local's are read.
    tables[alias] = [...store.entries()]
      .filter(([key]) => key.startsWith(`${name}|`))
      .map(([, item]) => asRead(item))
  }
  return { result: resultOf(exit), tables }
}

/** `holds`'s answer to a condition row, as DynamoDB Local's is read off its `DeleteItem`. */
const holdsOf = (condition: NonNullable<Row["condition"]>) => {
  try {
    return holds(condition.expression, condition.item, condition.names, condition.values)
      ? "holds"
      : "fails"
  } catch (error) {
    return isRefusal(error)
      ? `${error.name}: ${error.message}`
      : `unreadable: ${(error as Error).message}`
  }
}
const localHolds = (answer: any) =>
  "ok" in answer
    ? "holds"
    : answer.error === "ConditionalCheckFailedException"
      ? "fails"
      : `${answer.error}: ${answer.message}`

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const createTable = (name: string, indexed: boolean) =>
  raw.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        ...(indexed
          ? [
              { AttributeName: "gpk", AttributeType: "S" as const },
              { AttributeName: "gsk", AttributeType: "S" as const },
            ]
          : []),
      ],
      ...(indexed && {
        GlobalSecondaryIndexes: [
          {
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gpk", KeyType: "HASH" as const },
              { AttributeName: "gsk", KeyType: "RANGE" as const },
            ],
            Projection: { ProjectionType: "ALL" as const },
          },
        ],
      }),
    }),
  )

describeConnected("the in-memory tables answer every request as DynamoDB Local does", () => {
  beforeAll(async () => {
    await createTable(TABLES.$T!, true)
    await createTable(TABLES.$T2!, false)
    tableIndexes.set(TABLES.$T!, INDEXES)
  }, 60000)
  afterAll(async () => {
    tableIndexes.delete(TABLES.$T!)
    for (const table of Object.values(TABLES)) {
      await raw.send(new DeleteTableCommand({ TableName: table }))
    }
  }, 60000)

  it("every known difference names a row and a helper the row reaches", () => {
    const labels = new Set(ROWS.map((row) => row.label))
    for (const [label, known] of Object.entries(KNOWN)) {
      expect(labels.has(label), label).toBe(true)
      const row = ROWS.find((each) => each.label === label)!
      for (const backend of known.on) {
        if (backend === "inMemory") expect(IN_MEMORY.has(row.command), label).toBe(true)
        if (backend === "holds") expect(row.condition, label).toBeDefined()
      }
    }
  })

  for (const row of ROWS) {
    it(row.label, async () => {
      const known = KNOWN[row.label]
      /** Numbers as spelled, unless the row is known to differ, in spelling or otherwise. */
      const compare = (
        backend: Backend,
        got: (exact: boolean) => unknown,
        expected: (exact: boolean) => unknown,
      ) => {
        if (!known?.on.includes(backend)) {
          expect({ [backend]: got(true) }).toEqual({ [backend]: expected(true) })
        } else if (known.byValue) {
          expect(show(got(true)), `${backend}: ${known.reason}`).not.toBe(show(expected(true)))
          expect({ [backend]: got(false) }).toEqual({ [backend]: expected(false) })
        } else {
          expect(show(got(false)), `${backend}: ${known.reason}`).not.toBe(show(expected(false)))
        }
      }
      const local = await onLocal(row)
      const expected = (exact: boolean) => view(row.command, local, exact)
      const recording = await onRecording(row)
      compare("recording", (exact) => view(row.command, recording, exact), expected)
      const inMemory = await onInMemory(row)
      if (inMemory !== undefined) {
        compare("inMemory", (exact) => view(row.command, inMemory, exact), expected)
      }
      if (row.condition !== undefined) {
        const condition = row.condition
        compare(
          "holds",
          () => holdsOf(condition),
          () => localHolds(viewResult(row.command, local.result)),
        )
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Every reserved word
// ---------------------------------------------------------------------------

/** Words tried as a name in an update, a removal and a condition too, not only in a projection. */
const IN_EVERY_KIND = [
  "add",
  "and",
  "between",
  "delete",
  "in",
  "not",
  "or",
  "remove",
  "set",
  "size",
  "convert",
  "values",
  "status",
  "data",
  "name",
  "if_not_exists",
  "attribute_exists",
  "list_append",
]

describeConnected("a reserved word is reserved in the tables as in DynamoDB Local", () => {
  const table = `conformance-${stamp}-words`
  beforeAll(() => createTable(table, false), 60000)
  afterAll(() => raw.send(new DeleteTableCommand({ TableName: table })), 60000)

  it("every word the tables refuse as a name, and words they don't, in either case", async () => {
    const words = [
      ...new Set(
        [
          ...reservedWords,
          ...IN_EVERY_KIND,
          "foo",
          "views",
          "note",
          "pk",
          "id",
          "ab",
          "a1",
          "x",
        ].flatMap((word) => [word, word.toLowerCase()]),
      ),
    ]
    const recording = makeRecordingTable()
    const key = { pk: S("a"), sk: S("s") }
    const requests = words.flatMap(
      (word): ReadonlyArray<readonly [Command, Record<string, unknown>]> => [
        ["GetItem", { TableName: table, Key: key, ProjectionExpression: word }],
        ...(IN_EVERY_KIND.includes(word.toLowerCase())
          ? ([
              [
                "UpdateItem",
                {
                  TableName: table,
                  Key: key,
                  UpdateExpression: `SET ${word} = :v`,
                  ExpressionAttributeValues: { ":v": N("1") },
                },
              ],
              ["UpdateItem", { TableName: table, Key: key, UpdateExpression: `REMOVE ${word}` }],
              [
                "DeleteItem",
                {
                  TableName: table,
                  Key: { pk: S("none"), sk: S("s") },
                  ConditionExpression: `attribute_not_exists(${word})`,
                },
              ],
            ] as const)
          : []),
      ],
    )
    const differ: Array<string> = []
    for (const [command, input] of requests) {
      const Command = COMMANDS[command] as new (input: unknown) => any
      const local = await raw.send(new Command(input)).then(
        (output) => outputOf(command, output),
        (error) => errorOf(error),
      )
      const helper = viewResult(
        command,
        resultOf(
          await Effect.runPromiseExit(
            (
              recording.client as unknown as Record<
                string,
                (input: unknown) => Effect.Effect<unknown, unknown>
              >
            )[METHODS[command]]!(input),
          ),
        ),
      )
      if (show(local) !== show(helper))
        differ.push(`${show(input)}: ${show(local)} / ${show(helper)}`)
    }
    expect(differ).toEqual([])
  }, 120000)
})

// ---------------------------------------------------------------------------
// The absent sparse-map entry operations, through the library
// ---------------------------------------------------------------------------

describeConnected("an absent sparse-map entry's operation ends as on DynamoDB Local", () => {
  const table = `conformance-${stamp}-entries`
  const clientLayer = Lib.DynamoClient.layer({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials,
  })
  const random = Layer.succeed(
    SecureRandom.SecureRandom,
    SecureRandom.make((n) => new Uint8Array(n).fill(7)),
  )
  const ROW_KEY = { pk: S("$ops#v1#doc#id_a"), sk: S("$ops#v1#doc") }
  beforeAll(() => createTable(table, false), 60000)
  afterAll(() => raw.send(new DeleteTableCommand({ TableName: table })), 60000)

  /** Runs `each` on `layer`, then reads the row it's about with `stored`. */
  const run = (
    each: (typeof entryOps)[number],
    layer: Layer.Layer<DynamoClient>,
    stored: () => Promise<Item | undefined>,
  ) => {
    const Docs = (Lib.Entity.make as any)({
      entityType: "Doc",
      primaryKey,
      ...each.entity(Lib as never),
    })
    const Main = (Lib.Table.make as any)({
      schema: Lib.DynamoSchema.make({ name: "ops", version: 1 }),
      entities: { Docs },
    })
    return Effect.runPromise(
      Effect.gen(function* () {
        const db: any = yield* (Lib.DynamoClient.make as any)({
          entities: { Docs },
          tables: { Main },
        })
        yield* each.seed(db)
        const exit = yield* Effect.exit(Effect.suspend(() => each.run(db, Lib as never)))
        const read = yield* Effect.exit(db.entities.Docs.get({ id: "a" }))
        const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
        const row = yield* Effect.promise(stored)
        return {
          ok: Exit.isSuccess(exit),
          error: failure === undefined ? undefined : `${failure._tag} ${failure.operation}`,
          message: failure?.cause?.message,
          stored:
            row?.[each.attribute!] === undefined ? undefined : canon(row[each.attribute!], true),
          row: row !== undefined,
          read: Exit.isSuccess(read),
        }
      }).pipe(
        Effect.provide(Main.layer({ name: table })),
        Effect.provide(layer),
        Effect.provide(random),
      ) as Effect.Effect<unknown>,
    )
  }

  for (const each of entryOps.filter((entry) => entry.expected === undefined)) {
    it(each.key, async () => {
      for (const item of await scanAll(table)) {
        await raw.send(
          new DeleteItemCommand({ TableName: table, Key: { pk: item.pk!, sk: item.sk! } }),
        )
      }
      const local = await run(
        each,
        clientLayer as never,
        async () =>
          (
            await raw.send(
              new GetItemCommand({ TableName: table, Key: ROW_KEY, ConsistentRead: true }),
            )
          ).Item,
      )
      const recording = makeRecordingTable()
      const helper = await run(each, recording.layer, async () =>
        recording.items.get(`${ROW_KEY.pk.S}|${ROW_KEY.sk.S}`),
      )
      expect(helper).toEqual(local)
    })
  }
})
