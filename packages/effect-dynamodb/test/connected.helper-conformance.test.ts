/**
 * The in-memory tables the unit tests run on, against DynamoDB Local (#243).
 *
 * `helpers/RecordingTable.ts` and `helpers/InMemoryTables.ts` answer requests through
 * `helpers/DynamoExpressions.ts`, as DynamoDB Local answers them. Each row here sends one request, on
 * the same stored items, to DynamoDB Local, to the recording table and (for the operations it
 * serves) to `InMemoryClient`, and compares the answers: the output, or the error's name, message,
 * cancellation reasons and returned item, and every item each table holds afterwards. A condition
 * row is also put to `holds` itself. Numbers are compared as spelled, sets in any order, a scan's
 * and a batch read's items in any order.
 *
 * Rows the tables answer differently on purpose are in `KNOWN`, each with its reason and both
 * answers, each asserted exactly, the tables afterwards still compared: the number of differences
 * is the number of entries there. What the helpers don't model at all is listed at the top of
 * `helpers/DynamoExpressions.ts`, and a request of that kind is a defect naming it.
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
 * - secondary index keys a write gives (types and empty values, on puts, updates, transactions and
 *   batches), the item counts a request may hold, key conditions and `Select`, what each kind of
 *   index projection returns, where a read stops (`LastEvaluatedKey` at the end of a range) and
 *   where it may start (`ExclusiveStartKey` of every shape), and numbers as each write stores them;
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
import {
  asRead,
  holds,
  type Indexes,
  isRefusal,
  reservedWords,
} from "./helpers/DynamoExpressions.js"
import { InMemoryClient, resetStore, store, tableIndexes } from "./helpers/InMemoryTables.js"
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
/**
 * `$T`'s secondary indexes, as the helpers are told of them and as `$T` is created with them, in
 * that order: local indexes of every projection, global ones of every projection, a binary sort
 * key, and indexes sharing a key attribute.
 */
const INDEXES = {
  lsi1: { pk: "pk", sk: "lsk" },
  lsi2: { pk: "pk", sk: "lsk2", projection: "KEYS_ONLY" },
  lsi3: { pk: "pk", sk: "lsk3", projection: ["inc"] },
  gsi1: { pk: "gpk", sk: "gsk" },
  gsib: { pk: "gpk", sk: "gbk", skType: "B" },
  gsik: { pk: "gpk2", sk: "gsk2", projection: "KEYS_ONLY" },
  gsii: { pk: "gpk2", sk: "lsk3", projection: ["inc", "other"] },
} satisfies Indexes

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
// Secondary index keys written, request sizes, reads of an index, numbers as stored
// ---------------------------------------------------------------------------

/** An item holding a key of every index of `$T`. */
const INDEXED: Item = {
  ...KEY,
  lsk: S("l"),
  lsk2: S("l2"),
  lsk3: S("l3"),
  gpk: S("g"),
  gsk: S("k"),
  gbk: { B: bytes(1) },
  gpk2: S("g2"),
  gsk2: S("k2"),
  inc: S("i"),
  other: S("o"),
  n: N("1"),
}
const brief = (
  label: string,
  command: Command,
  input: Record<string, unknown>,
  seed: ReadonlyArray<Seed> = seeded([INDEXED]),
): Row => ({ label, command, input, seed })
const QK: Item = { pk: S("q"), sk: S("s") }
const putIndexed = (label: string, attributes: Item) =>
  brief(`index keys: put ${label}`, "PutItem", { TableName: "$T", Item: { ...QK, ...attributes } })
const updateIndexed = (
  label: string,
  expression: string,
  values?: Record<string, AttributeValue>,
  extra: object = {},
  key: Item = KEY,
) =>
  brief(`index keys: update ${label}`, "UpdateItem", {
    TableName: "$T",
    Key: key,
    UpdateExpression: expression,
    ...(values !== undefined && { ExpressionAttributeValues: values }),
    ...extra,
  })
const twIndexed = (label: string, items: ReadonlyArray<object>) =>
  brief(`index keys: tw ${label}`, "TransactWriteItems", { TransactItems: items })
const tPut = (item: Item) => ({ Put: { TableName: "$T", Item: item } })
const tUpdate = (expression: string, values?: Record<string, AttributeValue>, extra = {}) => ({
  Update: {
    TableName: "$T",
    Key: KEY,
    UpdateExpression: expression,
    ...(values !== undefined && { ExpressionAttributeValues: values }),
    ...extra,
  },
})
const tCheck = (key: Item, expression: string) => ({
  ConditionCheck: { TableName: "$T", Key: key, ConditionExpression: expression },
})

const INDEX_WRITES: ReadonlyArray<Row> = [
  putIndexed("gsk N", { gpk: S("g"), gsk: N("1") }),
  putIndexed("gsk N, no gpk", { gsk: N("1") }),
  putIndexed("gpk N", { gpk: N("1") }),
  putIndexed("gsk ''", { gpk: S("g"), gsk: S("") }),
  putIndexed("gpk ''", { gpk: S(""), gsk: S("x") }),
  putIndexed("lsk ''", { lsk: S("") }),
  putIndexed("lsk N", { lsk: N("1") }),
  putIndexed("gbk S", { gbk: S("x") }),
  putIndexed("gbk empty B", { gbk: { B: bytes() } }),
  putIndexed("lsk N and gsk ''", { lsk: N("1"), gsk: S("") }),
  putIndexed("gsk '' and lsk N", { gsk: S(""), lsk: N("1") }),
  putIndexed("gsk M", { gsk: { M: {} } }),
  putIndexed("gsk NULL", { gsk: { NULL: true } }),
  putIndexed("lsk3 '' (two indexes)", { lsk3: S("") }),
  putIndexed("every key", { ...INDEXED, ...QK }),
  updateIndexed("SET gsk = N", "SET gsk = :v", { ":v": N("1") }),
  updateIndexed("SET gsk = ''", "SET gsk = :v", { ":v": S("") }),
  updateIndexed("SET gpk = ''", "SET gpk = :v", { ":v": S("") }),
  updateIndexed("SET lsk = N", "SET lsk = :v", { ":v": N("1") }),
  updateIndexed("SET lsk = ''", "SET lsk = :v", { ":v": S("") }),
  updateIndexed("SET lsk3 = N (local and global)", "SET lsk3 = :v", { ":v": N("1") }),
  updateIndexed("ADD gsk 1", "ADD gsk :v", { ":v": N("1") }),
  updateIndexed("SET gsk = N, no item", "SET gsk = :v", { ":v": N("1") }, {}, QK),
  updateIndexed("SET gsk = '', no item", "SET gsk = :v", { ":v": S("") }, {}, QK),
  updateIndexed(
    "SET gsk = N, its condition failing",
    "SET gsk = :v",
    { ":v": N("1"), ":x": S("zz") },
    { ConditionExpression: "pk = :x" },
  ),
  updateIndexed("SET gbk = S", "SET gbk = :v", { ":v": S("x") }),
  updateIndexed("SET gsk = n (a number copied)", "SET gsk = n"),
  updateIndexed("SET gsk = M", "SET gsk = :v", { ":v": { M: {} } }),
  updateIndexed("SET gsk = '' and lsk = N", "SET gsk = :a, lsk = :b", {
    ":a": S(""),
    ":b": N("1"),
  }),
  updateIndexed("SET gsk = '', n = n + 'x'", "SET gsk = :a, n = n + :b", {
    ":a": S(""),
    ":b": S("x"),
  }),
  updateIndexed("REMOVE gsk", "REMOVE gsk"),
  twIndexed("put gsk N", [tPut({ ...QK, gsk: N("1") })]),
  twIndexed("put gsk ''", [tPut({ ...QK, gsk: S("") })]),
  twIndexed("put, put gsk N", [tPut({ ...K("q1") }), tPut({ ...QK, gsk: N("1") })]),
  twIndexed("put gsk N, a failing check", [
    tPut({ ...QK, gsk: N("1") }),
    tCheck(KEY, "attribute_not_exists(pk)"),
  ]),
  twIndexed("a failing check, put gsk N", [
    tCheck(KEY, "attribute_not_exists(pk)"),
    tPut({ ...QK, gsk: N("1") }),
  ]),
  twIndexed("update SET gsk = N", [tUpdate("SET gsk = :v", { ":v": N("1") })]),
  twIndexed("update SET gsk = ''", [tUpdate("SET gsk = :v", { ":v": S("") })]),
  twIndexed("update SET lsk = N", [tUpdate("SET lsk = :v", { ":v": N("1") })]),
  twIndexed("put, update SET gsk = N", [
    tPut({ ...K("q1") }),
    tUpdate("SET gsk = :v", { ":v": N("1") }),
  ]),
  twIndexed("update SET gsk = N, its condition failing", [
    tUpdate("SET gsk = :v", { ":v": N("1") }, { ConditionExpression: "attribute_not_exists(pk)" }),
  ]),
  twIndexed("put pk N", [tPut({ pk: N("1"), sk: S("s") })]),
  twIndexed("put, put pk N", [tPut(K("q1")), tPut({ pk: N("1"), sk: S("s") })]),
  twIndexed("put pk ''", [tPut({ pk: S(""), sk: S("s") })]),
  twIndexed("put, put pk ''", [tPut(K("q1")), tPut({ pk: S(""), sk: S("s") })]),
  twIndexed("update of key pk N", [
    {
      Update: {
        ...tUpdate("SET a = :a", { ":a": N("1") }).Update,
        Key: { pk: N("1"), sk: S("s") },
      },
    },
  ]),
  twIndexed("delete of key pk N", [
    { Delete: { TableName: "$T", Key: { pk: N("1"), sk: S("s") } } },
  ]),
  twIndexed("check of key pk N", [tCheck({ pk: N("1"), sk: S("s") }, "attribute_exists(pk)")]),
  twIndexed("delete of key pk ''", [
    { Delete: { TableName: "$T", Key: { pk: S(""), sk: S("s") } } },
  ]),
  twIndexed("delete of a key with another attribute", [
    { Delete: { TableName: "$T", Key: { ...KEY, x: S("x") } } },
  ]),
  twIndexed("delete of a key without sk", [{ Delete: { TableName: "$T", Key: { pk: S("p") } } }]),
  twIndexed("update SET pk", [tUpdate("SET pk = :a", { ":a": S("x") })]),
  twIndexed("update REMOVE sk", [tUpdate("REMOVE sk")]),
  twIndexed("update SET pk, its condition failing", [
    tUpdate("SET pk = :a", { ":a": S("x") }, { ConditionExpression: "attribute_not_exists(pk)" }),
  ]),
  twIndexed("a failing check, update SET pk", [
    tCheck(K("q1"), "attribute_not_exists(pk)"),
    tUpdate("SET pk = :a", { ":a": S("x") }),
  ]),
  twIndexed("update SET pk, put pk N", [
    tUpdate("SET pk = :a", { ":a": S("x") }),
    tPut({ pk: N("1"), sk: S("s") }),
  ]),
  twIndexed("put pk N, update SET pk", [
    tPut({ pk: N("1"), sk: S("s") }),
    tUpdate("SET pk = :a", { ":a": S("x") }),
  ]),
  twIndexed("put pk N, one item twice", [tPut({ pk: N("1"), sk: S("s") }), tPut(KEY), tPut(KEY)]),
  twIndexed("put pk N, update SET a = n + 'x'", [
    tPut({ pk: N("1"), sk: S("s") }),
    tUpdate("SET a = n + :x", { ":x": S("x") }),
  ]),
  twIndexed("update SET a = n + 'x', put pk N", [
    tUpdate("SET a = n + :x", { ":x": S("x") }),
    tPut({ pk: N("1"), sk: S("s") }),
  ]),
  twIndexed("put gsk N, put pk N", [
    tPut({ ...QK, gsk: N("1") }),
    tPut({ pk: N("1"), sk: S("s") }),
  ]),
  brief("index keys: tg of key pk N", "TransactGetItems", {
    TransactItems: [{ Get: { TableName: "$T", Key: { pk: N("1"), sk: S("s") } } }],
  }),
  brief("index keys: bw put gsk N", "BatchWriteItem", {
    RequestItems: { $T: [{ PutRequest: { Item: { ...QK, gsk: N("1") } } }] },
  }),
  brief("index keys: bw put gsk ''", "BatchWriteItem", {
    RequestItems: { $T: [{ PutRequest: { Item: { ...QK, gsk: S("") } } }] },
  }),
]

/** `n` keys `c0`, `c1`, … (or under another prefix). */
const keysOf = (n: number, prefix = "c") =>
  Array.from({ length: n }, (_, i) => ({ pk: S(`${prefix}${i}`), sk: S("s") }))
const COUNTS: ReadonlyArray<Row> = [
  brief("counts: tw 101", "TransactWriteItems", {
    TransactItems: keysOf(101).map((Item) => ({ Put: { TableName: "$T", Item } })),
  }),
  brief("counts: tw 100", "TransactWriteItems", {
    TransactItems: keysOf(100, "t").map((Item) => ({ Put: { TableName: "$T", Item } })),
  }),
  brief("counts: tw 0", "TransactWriteItems", { TransactItems: [] }),
  brief("counts: tw 101, one of them refused", "TransactWriteItems", {
    TransactItems: [
      ...keysOf(100).map((Item) => ({ Put: { TableName: "$T", Item } })),
      { Put: { TableName: "$T", Item: { pk: N("1"), sk: S("s") } } },
    ],
  }),
  brief("counts: tg 101", "TransactGetItems", {
    TransactItems: keysOf(101).map((Key) => ({ Get: { TableName: "$T", Key } })),
  }),
  brief("counts: tg 0", "TransactGetItems", { TransactItems: [] }),
  brief("counts: bw 26", "BatchWriteItem", {
    RequestItems: { $T: keysOf(26).map((Item) => ({ PutRequest: { Item } })) },
  }),
  brief("counts: bw 26 over two tables", "BatchWriteItem", {
    RequestItems: {
      $T: keysOf(13).map((Item) => ({ PutRequest: { Item } })),
      $T2: keysOf(13).map((Item) => ({ PutRequest: { Item } })),
    },
  }),
  brief("counts: bw 26, one key twice", "BatchWriteItem", {
    RequestItems: {
      $T: [...keysOf(25), keysOf(1)[0]!].map((Item) => ({ PutRequest: { Item } })),
    },
  }),
  brief("counts: bw 0", "BatchWriteItem", { RequestItems: {} }),
  brief("counts: bw a table with 0", "BatchWriteItem", { RequestItems: { $T: [] } }),
  brief("counts: bg 101", "BatchGetItem", { RequestItems: { $T: { Keys: keysOf(101) } } }),
  brief("counts: bg 101 over two tables", "BatchGetItem", {
    RequestItems: { $T: { Keys: keysOf(50) }, $T2: { Keys: keysOf(51) } },
  }),
  brief("counts: bg 100", "BatchGetItem", { RequestItems: { $T: { Keys: keysOf(100) } } }),
  brief("counts: bg 0", "BatchGetItem", { RequestItems: {} }),
  brief("counts: bg a table with 0", "BatchGetItem", { RequestItems: { $T: { Keys: [] } } }),
]

const kc = (expression: string, values: Record<string, AttributeValue>, extra: object = {}) => ({
  TableName: "$T",
  KeyConditionExpression: expression,
  ExpressionAttributeValues: values,
  ...extra,
})
const queried = (label: string, input: Record<string, unknown>) =>
  brief(`reads: ${label}`, "Query", input)
const QUERY_CHECKS: ReadonlyArray<Row> = [
  queried(
    "begins_with sk ''",
    kc("pk = :p AND begins_with(sk, :e)", { ":p": S("p"), ":e": S("") }),
  ),
  queried("sk > ''", kc("pk = :p AND sk > :e", { ":p": S("p"), ":e": S("") })),
  queried("sk = ''", kc("pk = :p AND sk = :e", { ":p": S("p"), ":e": S("") })),
  queried(
    "sk BETWEEN '' AND b",
    kc("pk = :p AND sk BETWEEN :e AND :b", { ":p": S("p"), ":e": S(""), ":b": S("b") }),
  ),
  queried("pk = ''", kc("pk = :e", { ":e": S("") })),
  queried("pk = '', sk > N", kc("pk = :e AND sk > :n", { ":e": S(""), ":n": N("1") })),
  queried("gsi1 gpk = ''", kc("gpk = :e", { ":e": S("") }, { IndexName: "gsi1" })),
  queried(
    "gsi1 begins_with gsk ''",
    kc("gpk = :g AND begins_with(gsk, :e)", { ":g": S("g"), ":e": S("") }, { IndexName: "gsi1" }),
  ),
  queried(
    "lsi1 lsk > ''",
    kc("pk = :p AND lsk > :e", { ":p": S("p"), ":e": S("") }, { IndexName: "lsi1" }),
  ),
  queried(
    "gsib gbk > S",
    kc("gpk = :g AND gbk > :s", { ":g": S("g"), ":s": S("a") }, { IndexName: "gsib" }),
  ),
  queried(
    "gsib begins_with gbk S",
    kc("gpk = :g AND begins_with(gbk, :s)", { ":g": S("g"), ":s": S("a") }, { IndexName: "gsib" }),
  ),
  queried(
    "gsib gbk BETWEEN S",
    kc(
      "gpk = :g AND gbk BETWEEN :s AND :t",
      { ":g": S("g"), ":s": S("a"), ":t": S("b") },
      { IndexName: "gsib" },
    ),
  ),
  queried(
    "gsib gbk > B",
    kc("gpk = :g AND gbk > :s", { ":g": S("g"), ":s": { B: bytes(0) } }, { IndexName: "gsib" }),
  ),
  queried("sk > N", kc("pk = :p AND sk > :n", { ":p": S("p"), ":n": N("1") })),
  queried("sk > B", kc("pk = :p AND sk > :n", { ":p": S("p"), ":n": { B: bytes(1) } })),
  queried("pk = N", kc("pk = :n", { ":n": N("1") })),
  queried(
    "COUNT and a projection",
    kc("pk = :p", { ":p": S("p") }, { Select: "COUNT", ProjectionExpression: "n" }),
  ),
  queried(
    "SPECIFIC_ATTRIBUTES without a projection",
    kc("pk = :p", { ":p": S("p") }, { Select: "SPECIFIC_ATTRIBUTES" }),
  ),
  queried(
    "SPECIFIC_ATTRIBUTES with a projection",
    kc("pk = :p", { ":p": S("p") }, { Select: "SPECIFIC_ATTRIBUTES", ProjectionExpression: "n" }),
  ),
  queried(
    "ALL_ATTRIBUTES and a projection",
    kc("pk = :p", { ":p": S("p") }, { Select: "ALL_ATTRIBUTES", ProjectionExpression: "n" }),
  ),
  queried("ALL_ATTRIBUTES", kc("pk = :p", { ":p": S("p") }, { Select: "ALL_ATTRIBUTES" })),
  queried(
    "ALL_PROJECTED_ATTRIBUTES of the table",
    kc("pk = :p", { ":p": S("p") }, { Select: "ALL_PROJECTED_ATTRIBUTES" }),
  ),
  queried(
    "two sort key conditions",
    kc("pk = :p AND sk > :a AND sk < :b", { ":p": S("p"), ":a": S("a"), ":b": S("z") }),
  ),
  queried(
    "two sort key conditions, begins_with and >",
    kc("pk = :p AND begins_with(sk, :a) AND sk > :b", {
      ":p": S("p"),
      ":a": S("a"),
      ":b": S("z"),
    }),
  ),
  queried("two partition key conditions", kc("pk = :p AND pk = :p", { ":p": S("p") })),
  queried(
    "two sort key conditions, one empty",
    kc("pk = :p AND sk > :e AND sk < :b", { ":p": S("p"), ":e": S(""), ":b": S("z") }),
  ),
  queried(
    "lsi1, consistent",
    kc("pk = :p", { ":p": S("p") }, { IndexName: "lsi1", ConsistentRead: true }),
  ),
  queried(
    "gsi1, consistent",
    kc("gpk = :p", { ":p": S("g") }, { IndexName: "gsi1", ConsistentRead: true }),
  ),
  queried(
    "gsi1, consistent, an empty start key",
    kc(
      "gpk = :p",
      { ":p": S("g") },
      { IndexName: "gsi1", ConsistentRead: true, ExclusiveStartKey: {} },
    ),
  ),
  queried("the sort key value first", kc("pk = :p AND :b >= sk", { ":p": S("p"), ":b": S("t") })),
  brief("reads: scan, COUNT and a projection", "Scan", {
    TableName: "$T",
    Select: "COUNT",
    ProjectionExpression: "n",
  }),
  brief("reads: scan, ALL_PROJECTED_ATTRIBUTES", "Scan", {
    TableName: "$T",
    Select: "ALL_PROJECTED_ATTRIBUTES",
  }),
  brief("reads: scan, SPECIFIC_ATTRIBUTES", "Scan", {
    TableName: "$T",
    Select: "SPECIFIC_ATTRIBUTES",
    ProjectionExpression: "n, sk",
  }),
  brief("reads: scan, COUNT", "Scan", { TableName: "$T", Select: "COUNT" }),
]

const PROJECTIONS: ReadonlyArray<Row> = (
  [
    ["lsi2 KEYS_ONLY", kc("pk = :p", { ":p": S("p") }, { IndexName: "lsi2" })],
    ["lsi3 INCLUDE inc", kc("pk = :p", { ":p": S("p") }, { IndexName: "lsi3" })],
    ["gsik KEYS_ONLY", kc("gpk2 = :p", { ":p": S("g2") }, { IndexName: "gsik" })],
    ["gsii INCLUDE inc, other", kc("gpk2 = :p", { ":p": S("g2") }, { IndexName: "gsii" })],
    ["lsi1 ALL", kc("pk = :p", { ":p": S("p") }, { IndexName: "lsi1" })],
  ] as const
).flatMap(([name, base]) => {
  const values = base.ExpressionAttributeValues
  const filtered = (filter: string, value: Record<string, AttributeValue>, extra: object = {}) => ({
    ...base,
    FilterExpression: filter,
    ExpressionAttributeValues: { ...values, ...value },
    ...extra,
  })
  return [
    queried(`${name}`, base),
    queried(`${name}, ALL_ATTRIBUTES`, { ...base, Select: "ALL_ATTRIBUTES" }),
    queried(`${name}, ALL_PROJECTED_ATTRIBUTES`, { ...base, Select: "ALL_PROJECTED_ATTRIBUTES" }),
    queried(`${name}, COUNT`, { ...base, Select: "COUNT" }),
    queried(`${name}, projection n`, { ...base, ProjectionExpression: "n" }),
    queried(`${name}, projection inc, sk`, { ...base, ProjectionExpression: "inc, sk" }),
    queried(`${name}, projection m.x`, { ...base, ProjectionExpression: "m.x" }),
    queried(`${name}, filter n`, filtered("n = :one", { ":one": N("1") })),
    queried(`${name}, filter inc`, filtered("inc = :i", { ":i": S("i") })),
    queried(`${name}, filter sk`, filtered("sk = :i", { ":i": S("s") })),
    queried(
      `${name}, filter n, ALL_ATTRIBUTES`,
      filtered("n = :one", { ":one": N("1") }, { Select: "ALL_ATTRIBUTES" }),
    ),
    queried(
      `${name}, filter n, COUNT`,
      filtered("n = :one", { ":one": N("1") }, { Select: "COUNT" }),
    ),
    queried(`${name}, filter n.x`, filtered("n.x = :one", { ":one": N("1") })),
    queried(
      `${name}, filter n, projection inc`,
      filtered("n = :one", { ":one": N("1") }, { ProjectionExpression: "inc" }),
    ),
  ]
})

// Where a read stops: three partitions of three items, read to the end of a range.
const LEK_SEED: ReadonlyArray<Item> = ["p", "p2", "o"].flatMap((pk) =>
  ["a", "b", "c"].map((v, i) => ({
    pk: S(pk),
    sk: S(v),
    lsk: S(v),
    gpk: S(pk === "p" ? "g" : `g${pk}`),
    gsk: S(v),
    n: N(String(i)),
  })),
)
const LEK_KEYS = [
  ["the table", undefined, "pk", "sk", "p"],
  ["lsi1", "lsi1", "pk", "lsk", "p"],
  ["gsi1", "gsi1", "gpk", "gsk", "g"],
] as const
type Bound = readonly [label: string, clause: string, test: (v: string) => boolean, values: Item]
const LEK_BOUNDS: ReadonlyArray<Bound> = [
  ["none", "", () => true, {}],
  ...["a", "b", "c"].flatMap(
    (x): ReadonlyArray<Bound> => [
      [`= ${x}`, "AND #s = :x", (v) => v === x, { ":x": S(x) }],
      [`begins_with ${x}`, "AND begins_with(#s, :x)", (v) => v.startsWith(x), { ":x": S(x) }],
      [`< ${x}`, "AND #s < :x", (v) => v < x, { ":x": S(x) }],
      [`<= ${x}`, "AND #s <= :x", (v) => v <= x, { ":x": S(x) }],
      [`> ${x}`, "AND #s > :x", (v) => v > x, { ":x": S(x) }],
      [`>= ${x}`, "AND #s >= :x", (v) => v >= x, { ":x": S(x) }],
    ],
  ),
  ...(
    [
      ["a", "a"],
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
      ["b", "z"],
      ["0", "a"],
      ["c", "c"],
      ["0", "z"],
    ] as const
  ).map(
    ([lo, hi]): Bound => [
      `BETWEEN ${lo} AND ${hi}`,
      "AND #s BETWEEN :lo AND :hi",
      (v) => lo <= v && v <= hi,
      { ":lo": S(lo), ":hi": S(hi) },
    ],
  ),
  ["the value first, :x >= #s", "AND :x >= #s", (v) => v <= "b", { ":x": S("b") }],
  ["the value first, :x <= #s", "AND :x <= #s", (v) => v >= "b", { ":x": S("b") }],
]
/** Each range read with a `Limit` of the items it holds, so the read stops on its last one. */
const LAST_KEYS: ReadonlyArray<Row> = LEK_KEYS.flatMap(([name, index, pk, sk, p]) =>
  [true, false].flatMap((forward) =>
    LEK_BOUNDS.flatMap(([label, clause, test, values]) => {
      const matched = ["a", "b", "c"].filter(test).length
      if (matched === 0) return []
      const input = (filtered: boolean) => ({
        TableName: "$T",
        ...(index !== undefined && { IndexName: index }),
        KeyConditionExpression: `#p = :p ${clause}`,
        ExpressionAttributeNames: {
          "#p": pk,
          ...(clause !== "" && { "#s": sk }),
          ...(filtered && { "#n": "n" }),
        },
        ExpressionAttributeValues: {
          ":p": S(p),
          ...values,
          ...(filtered && { ":big": N("100") }),
        },
        ...(filtered && { FilterExpression: "#n < :big" }),
        ScanIndexForward: forward,
        Limit: matched,
      })
      const of = `${name}, ${forward ? "forward" : "reversed"}, ${label}, Limit ${matched}`
      return [
        brief(`last key: ${of}`, "Query", input(false), seeded(LEK_SEED)),
        ...(label.startsWith("<=") || label.startsWith(">=") || label.startsWith("BETWEEN")
          ? [brief(`last key: ${of}, a filter`, "Query", input(true), seeded(LEK_SEED))]
          : []),
      ]
    }),
  ),
)

// Where a read starts: `ExclusiveStartKey`s of every shape, on the table and on each index.
const startKey = (key: Record<string, string | AttributeValue>): Item =>
  Object.fromEntries(
    Object.entries(key).map(([name, value]) => [
      name,
      typeof value === "string" ? S(value) : value,
    ]),
  )
const startingAt = (
  label: string,
  extra: object,
  key: Record<string, string | AttributeValue>,
  command: Command = "Query",
) =>
  brief(
    `start key: ${label}: ${show(key)}`,
    command,
    command === "Query"
      ? {
          TableName: "$T",
          KeyConditionExpression: "#p = :p",
          ExpressionAttributeNames: { "#p": "pk" },
          ExpressionAttributeValues: { ":p": S("p") },
          ...extra,
          ExclusiveStartKey: startKey(key),
        }
      : { TableName: "$T", ...extra, ExclusiveStartKey: startKey(key) },
    seeded(LEK_SEED),
  )
const onSk = (expression: string, values: Item) => ({
  KeyConditionExpression: `#p = :p AND ${expression}`,
  ExpressionAttributeNames: { "#p": "pk", "#s": "sk" },
  ExpressionAttributeValues: { ":p": S("p"), ...values },
})
const viaLsi = { IndexName: "lsi1" }
const viaGsi = {
  IndexName: "gsi1",
  KeyConditionExpression: "#p = :p",
  ExpressionAttributeNames: { "#p": "gpk" },
  ExpressionAttributeValues: { ":p": S("g") },
}
const START_KEYS: ReadonlyArray<Row> = [
  ...[
    { pk: "p", sk: "a" },
    { pk: "p", sk: "zz" },
    { pk: "p2", sk: "a" },
    { pk: "o", sk: "a" },
    { pk: "p", sk: "a", x: "1" },
    { pk: "p", sk: "a", lsk: "a" },
    { pk: "p" },
    { sk: "a" },
    { gpk: "g", gsk: "a" },
    { pk: "p", gsk: "a" },
    { pk: N("1"), sk: "a" },
    { pk: "p", sk: N("1") },
    { pk: "", sk: "a" },
    { pk: "p", sk: "" },
    {},
    { pk: "p", sk: "a", x: N("1") },
    { pk: N("1") },
    { pk: "p2", sk: N("1") },
    { pk: "p", sk: { M: {} } },
  ].map((key) => startingAt("the table", {}, key)),
  ...[
    { pk: "p", sk: "z" },
    { pk: "p", sk: "a" },
    { pk: "p2", sk: "a" },
    { pk: "p", sk: "b" },
  ].map((key) => startingAt("the table, sk <= b", onSk("#s <= :b", { ":b": S("b") }), key)),
  ...[
    { pk: "p", sk: "z" },
    { pk: "p", sk: "0" },
  ].map((key) =>
    startingAt(
      "the table, sk <= b, reversed",
      { ...onSk("#s <= :b", { ":b": S("b") }), ScanIndexForward: false },
      key,
    ),
  ),
  ...[
    { pk: "p", sk: "a" },
    { pk: "p", sk: "c" },
    { pk: "p", sk: "b" },
    { pk: "p", sk: "bz" },
  ].map((key) =>
    startingAt("the table, begins_with b", onSk("begins_with(#s, :b)", { ":b": S("b") }), key),
  ),
  ...[
    { pk: "p", sk: "a" },
    { pk: "p", sk: "d" },
    { pk: "p", sk: "b" },
    { pk: "p", sk: "c" },
  ].map((key) =>
    startingAt(
      "the table, BETWEEN b AND c",
      onSk("#s BETWEEN :a AND :b", { ":a": S("b"), ":b": S("c") }),
      key,
    ),
  ),
  ...[
    { pk: "p", sk: "a" },
    { pk: "p", sk: "b" },
  ].map((key) => startingAt("the table, sk = b", onSk("#s = :b", { ":b": S("b") }), key)),
  startingAt("the table, Limit 1", { Limit: 1 }, { pk: "p", sk: "b" }),
  ...[
    { pk: "p", sk: "a", lsk: "a" },
    { pk: "p", sk: "a" },
    { pk: "p", lsk: "a" },
    { pk: "p", sk: "a", lsk: "a", x: "1" },
    { pk: "p2", sk: "a", lsk: "a" },
    { pk: "p", sk: "a", lsk: "zz" },
    { pk: "p", sk: "a", gsk: "a" },
    { pk: "p", sk: "a", lsk: N("1") },
    { pk: "p", sk: "a", lsk: "" },
    { pk: "p", sk: N("1"), lsk: "a" },
    { pk: "p", sk: "", lsk: "a" },
    { pk: "", sk: "a", lsk: "a" },
    {},
  ].map((key) => startingAt("lsi1", viaLsi, key)),
  startingAt(
    "lsi1, lsk <= b",
    {
      ...viaLsi,
      ...onSk("#s <= :b", { ":b": S("b") }),
      ExpressionAttributeNames: { "#p": "pk", "#s": "lsk" },
    },
    { pk: "p", sk: "a", lsk: "z" },
  ),
  ...[
    { pk: "p", sk: "a", gpk: "g", gsk: "a" },
    { gpk: "g", gsk: "a" },
    { pk: "p", sk: "a" },
    { pk: "p", sk: "a", gpk: "g" },
    { pk: "p", sk: "a", gpk: "g", gsk: "a", x: "1" },
    { pk: "p", sk: "a", gpk: "gp2", gsk: "a" },
    { pk: "p", sk: "a", gpk: "g", gsk: "zz" },
    { pk: "p", sk: "a", gpk: "g", lsk: "a" },
    { pk: "p", sk: "a", gpk: "g", gsk: N("1") },
    { pk: "p", sk: "a", gpk: N("1"), gsk: "a" },
    { pk: "p", sk: "a", gpk: "g", gsk: "" },
    { pk: "p", sk: "a", gpk: "", gsk: "a" },
    { pk: N("1"), sk: "a", gpk: "g", gsk: "a" },
    { pk: "", sk: "a", gpk: "g", gsk: "a" },
    { pk: "p", sk: "", gpk: "g", gsk: "a" },
    {},
  ].map((key) => startingAt("gsi1", viaGsi, key)),
  // Among rows of one index key, which DynamoDB Local orders by something of its own.
  startingAt("lsi1, COUNT", { ...viaLsi, Select: "COUNT" }, { pk: "p", sk: "zz", lsk: "a" }),
  startingAt(
    "gsi1, COUNT",
    { ...viaGsi, Select: "COUNT" },
    { pk: "zz", sk: "zz", gpk: "g", gsk: "a" },
  ),
  startingAt(
    "gsi1, gsk <= b",
    {
      ...viaGsi,
      KeyConditionExpression: "#p = :p AND #s <= :b",
      ExpressionAttributeNames: { "#p": "gpk", "#s": "gsk" },
      ExpressionAttributeValues: { ":p": S("g"), ":b": S("b") },
    },
    { pk: "p", sk: "a", gpk: "g", gsk: "z" },
  ),
  ...[
    { pk: "p", sk: "a" },
    { pk: "p", sk: "a", x: "1" },
    { pk: "p" },
    { gpk: "g", gsk: "a" },
    { pk: "nope", sk: "a" },
    {},
    { pk: N("1"), sk: "a" },
    { pk: "", sk: "a" },
    { pk: "p", sk: "" },
    { pk: "p", lsk: "a" },
  ].map((key) => startingAt("scan", {}, key, "Scan")),
]

// Rows of one index key, which DynamoDB Local orders by something of its own.
const TIED: ReadonlyArray<Seed> = seeded(
  ["a", "b", "c"].map((pk) => ({ pk: S(pk), sk: S("s"), gpk: S("t"), gsk: S("k") })),
)
const TIES: ReadonlyArray<Row> = [
  brief(
    "ties: gsi1 returns rows of one gsk",
    "Query",
    kc("gpk = :g", { ":g": S("t") }, { IndexName: "gsi1", ProjectionExpression: "pk" }),
    TIED,
  ),
  brief(
    "ties: gsi1, Limit 1, COUNT",
    "Query",
    kc("gpk = :g", { ":g": S("t") }, { IndexName: "gsi1", Limit: 1, Select: "COUNT" }),
    TIED,
  ),
  brief(
    "ties: gsi1, COUNT",
    "Query",
    kc("gpk = :g", { ":g": S("t") }, { IndexName: "gsi1", Select: "COUNT" }),
    TIED,
  ),
]

// Pages read past rows of one index key: ties before the start key are never read, so only ties on
// the page itself count. On gsi1 (gpk "w": gsk 1, 2, 3, 3, 4; gpk "v": 1, 1, 2, 3) and on lsi1
// (pk "l": lsk 1, 2, 3, 3, 4; pk "m": 1, 1, 2, 3).
const SPREAD = ["1", "2", "3", "3", "4"]
const EARLY = ["1", "1", "2", "3"]
const TIED_PAGES: ReadonlyArray<Seed> = seeded([
  ...SPREAD.map((gsk, i) => ({ pk: S(`w${i}`), sk: S("s"), gpk: S("w"), gsk: S(gsk) })),
  ...EARLY.map((gsk, i) => ({ pk: S(`v${i}`), sk: S("s"), gpk: S("v"), gsk: S(gsk) })),
  ...SPREAD.map((lsk, i) => ({ pk: S("l"), sk: S(`${i}`), lsk: S(lsk) })),
  ...EARLY.map((lsk, i) => ({ pk: S("m"), sk: S(`${i}`), lsk: S(lsk) })),
])
const pageAfter = (
  label: string,
  index: "gsi1" | "lsi1",
  partition: string,
  start: Item,
  extra: object,
) =>
  brief(
    `ties: ${index}, ${label}`,
    "Query",
    index === "gsi1"
      ? kc(
          "gpk = :g",
          { ":g": S(partition) },
          { IndexName: index, ExclusiveStartKey: start, ...extra },
        )
      : kc(
          "pk = :p",
          { ":p": S(partition) },
          { IndexName: index, ExclusiveStartKey: start, ...extra },
        ),
    TIED_PAGES,
  )
const gsiRow = (pk: string, gpk: string, gsk: string): Item => ({
  pk: S(pk),
  sk: S("s"),
  gpk: S(gpk),
  gsk: S(gsk),
})
const lsiRow = (pk: string, sk: string, lsk: string): Item => ({
  pk: S(pk),
  sk: S(sk),
  lsk: S(lsk),
})
const TIE_PAGES: ReadonlyArray<Row> = [
  pageAfter("ties before the start key, Limit 1", "gsi1", "v", gsiRow("v2", "v", "2"), {
    Limit: 1,
  }),
  pageAfter("ties before the start key", "gsi1", "v", gsiRow("v2", "v", "2"), {}),
  pageAfter("reverse, ties before the start key, Limit 1", "gsi1", "w", gsiRow("w1", "w", "2"), {
    Limit: 1,
    ScanIndexForward: false,
  }),
  pageAfter("ties inside the page, Limit 3, COUNT", "gsi1", "w", gsiRow("w1", "w", "2"), {
    Limit: 3,
    Select: "COUNT",
  }),
  pageAfter("reverse, ties inside the page, Limit 3, COUNT", "gsi1", "w", gsiRow("w4", "w", "4"), {
    Limit: 3,
    ScanIndexForward: false,
    Select: "COUNT",
  }),
  pageAfter("a Limit splitting ties past the start key", "gsi1", "w", gsiRow("w1", "w", "2"), {
    Limit: 1,
    Select: "COUNT",
  }),
  pageAfter("a Limit stopping on the last of ties", "gsi1", "w", gsiRow("w1", "w", "2"), {
    Limit: 2,
    Select: "COUNT",
  }),
  pageAfter("ties before the start key, Limit 1", "lsi1", "m", lsiRow("m", "2", "2"), { Limit: 1 }),
  pageAfter("reverse, ties before the start key, Limit 1", "lsi1", "l", lsiRow("l", "1", "2"), {
    Limit: 1,
    ScanIndexForward: false,
  }),
  pageAfter("ties inside the page, Limit 3, COUNT", "lsi1", "l", lsiRow("l", "1", "2"), {
    Limit: 3,
    Select: "COUNT",
  }),
  pageAfter(
    "reverse, a Limit splitting ties past the start key",
    "lsi1",
    "m",
    lsiRow("m", "2", "2"),
    {
      Limit: 1,
      ScanIndexForward: false,
      Select: "COUNT",
    },
  ),
]

// Numbers as each write stores them.
const SPELLINGS = [
  "1.50",
  "1e-7",
  "1e21",
  "007",
  "-0",
  "0.0",
  "1E+2",
  "100",
  "1.0e2",
  "-1.50",
  "123456789012345678901234567890.0",
  "0.000001",
  "0.0000001",
  "12.3e-8",
  "-007.10",
  "0e5",
  "1.23e+30",
  "+5",
]
const SPELLED: Item = {
  ...Object.fromEntries(SPELLINGS.map((v, i) => [`n${i}`, N(v)])),
  l: { L: SPELLINGS.map(N) },
  m: { M: Object.fromEntries(SPELLINGS.map((v, i) => [`m${i}`, N(v)])) },
  ns: { NS: ["1.50", "1e-7", "1e21", "007", "-0.5"] },
  lns: { L: [{ NS: ["1e21", "1.50", "1e-7"] }] },
}
const STORED_NUMBERS: ReadonlyArray<Row> = [
  brief("numbers: put", "PutItem", { TableName: "$T", Item: { ...QK, ...SPELLED } }, []),
  brief(
    "numbers: tw put",
    "TransactWriteItems",
    { TransactItems: [{ Put: { TableName: "$T", Item: { ...QK, ...SPELLED } } }] },
    [],
  ),
  brief(
    "numbers: bw put",
    "BatchWriteItem",
    { RequestItems: { $T: [{ PutRequest: { Item: { ...QK, ...SPELLED } } }] } },
    [],
  ),
  brief(
    "numbers: update SET",
    "UpdateItem",
    {
      TableName: "$T",
      Key: QK,
      UpdateExpression: "SET a = :a, b = :b, ns = :ns, l = :l, m = :m, c = if_not_exists(c, :ns)",
      ExpressionAttributeValues: {
        ":a": N("1.50"),
        ":b": N("1e21"),
        ":ns": { NS: ["1e21", "1.50", "007", "1e-7"] },
        ":l": { L: [N("1e21"), { NS: ["1e21", "1.50"] }] },
        ":m": { M: { x: N("007"), y: { NS: ["1e-7"] } } },
      },
    },
    [],
  ),
  brief(
    "numbers: update SET list_append",
    "UpdateItem",
    {
      TableName: "$T",
      Key: KEY,
      UpdateExpression: "SET l = list_append(l, :l), n0 = n0",
      ExpressionAttributeValues: { ":l": { L: [N("1e21"), { NS: ["1e21"] }] } },
    },
    seeded([{ ...KEY, ...SPELLED }]),
  ),
  brief(
    "numbers: put ALL_OLD",
    "PutItem",
    { TableName: "$T", Item: KEY, ReturnValues: "ALL_OLD" },
    seeded([{ ...KEY, ...SPELLED }]),
  ),
  brief(
    "numbers: query",
    "Query",
    kc("pk = :p", { ":p": S("p") }),
    seeded([{ ...KEY, ...SPELLED }]),
  ),
  brief(
    "numbers: a condition on 1.50 = 1.5",
    "PutItem",
    {
      TableName: "$T",
      Item: KEY,
      ConditionExpression: "n0 = :x",
      ExpressionAttributeValues: { ":x": N("1.5") },
    },
    seeded([{ ...KEY, ...SPELLED }]),
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
// Values DynamoDB refuses, nesting, operator counts, parentheses, key conditions, request members
// ---------------------------------------------------------------------------

/** `inner` inside `levels` lists (`L`), maps (`M`), or both by turns (`LM`). */
const nested = (
  levels: number,
  kind: "L" | "M" | "LM",
  inner: AttributeValue = S("x"),
): AttributeValue => {
  let value = inner
  for (let at = 0; at < levels; at++) {
    value = kind === "L" || (kind === "LM" && at % 2 === 0) ? { L: [value] } : { M: { k: value } }
  }
  return value
}
/** A value as the AWS SDK sends it, whatever its type says. */
const sent = (value: object) => value as AttributeValue
const VK = (id: string): Item => ({ pk: S(id), sk: S("s") })
const putOf = (label: string, attributes: Item, extra: object = {}): FullBrief => [
  label,
  "PutItem",
  { TableName: "$T", Item: { ...VK("v"), ...attributes }, ...extra },
]
const tw1 = (label: string, ...items: ReadonlyArray<object>): FullBrief => [
  label,
  "TransactWriteItems",
  { TransactItems: items },
]
const twPut = (item: Item, extra: object = {}) => ({
  Put: { TableName: "$T", Item: item, ...extra },
})
const twUpdate = (expression: string | undefined, values?: Item, extra: object = {}) => ({
  Update: {
    TableName: "$T",
    Key: KEY,
    ...(expression !== undefined && { UpdateExpression: expression }),
    ...(expression !== undefined && { ExpressionAttributeNames: namesIn(expression) }),
    ...(values !== undefined && { ExpressionAttributeValues: values }),
    ...extra,
  },
})

/** Values and names DynamoDB refuses, in items, keys and expressions; and nesting past its limits. */
const VALUES: ReadonlyArray<FullBrief> = [
  putOf("a map key that is empty", { m: { M: { "": N("1") } } }),
  putOf("an attribute name that is empty", { "": S("x") }),
  putOf("an empty map key in a list", { l: { L: [{ M: { "": N("1") } }] } }),
  putOf("an empty map key before a bad number", { m: { M: { "": N("1"), a: N("x") } } }),
  putOf("a bad number before an empty map key", { m: { M: { a: N("x"), "": N("1") } } }),
  putOf("an empty name before a bad number", { "": S("x"), a: N("x") }),
  putOf("a bad number before an empty name", { a: N("x"), "": S("x") }),
  putOf("NULL false", { x: sent({ NULL: false }) }),
  putOf("a value of two types", { x: sent({ S: "a", N: "1" }) }),
  putOf("a value of no type", { x: sent({}) }),
  putOf("a number sent as a number", { x: sent({ N: 5 }) }),
  putOf("a list holding a value of two types", { l: { L: [sent({ S: "a", N: "1" })] } }),
  putOf("a map holding NULL false", { m: { M: { k: sent({ NULL: false }) } } }),
  putOf("a key of no type", { pk: sent({}) }),
  putOf("lists 31 deep", { d: nested(31, "L") }),
  putOf("lists 32 deep", { d: nested(32, "L") }),
  putOf("maps 31 deep", { d: nested(31, "M") }),
  putOf("maps 32 deep", { d: nested(32, "M") }),
  putOf("lists and maps 32 deep", { d: nested(32, "LM") }),
  putOf("an empty map, 31 deep", { d: nested(30, "M", { M: {} }) }),
  putOf("an empty list, 32 deep", { d: nested(31, "M", { L: [] }) }),
  putOf("maps 32 deep before a bad number", { d: nested(32, "M"), e: N("x") }),
  putOf("a bad number before maps 32 deep", { e: N("x"), d: nested(32, "M") }),
  putOf("maps 32 deep holding a bad number", { d: nested(32, "M", N("x")) }),
  [
    "a key holding maps 32 deep, the key missing",
    "PutItem",
    { TableName: "$T", Item: { pk: S("v"), d: nested(32, "M") } },
  ],
  ["set a to maps 31 deep", ...RU("SET #a = :d", { "#a": "a" }, { ":d": nested(31, "M") })],
  ["set a to maps 32 deep", ...RU("SET #a = :d", { "#a": "a" }, { ":d": nested(32, "M") })],
  ["set a to maps 33 deep", ...RU("SET #a = :d", { "#a": "a" }, { ":d": nested(33, "M") })],
  [
    "set m.k to maps 30 deep",
    ...RU("SET #m.#k = :d", { "#m": "m", "#k": "k" }, { ":d": nested(30, "M") }),
  ],
  [
    "set m.k to maps 31 deep",
    ...RU("SET #m.#k = :d", { "#m": "m", "#k": "k" }, { ":d": nested(31, "M") }),
  ],
  [
    "set a to maps 32 deep, the condition failing",
    ...RU(
      "SET #a = :d",
      { "#a": "a", "#n": "n" },
      { ":d": nested(32, "M"), ":one": N("1") },
      { ConditionExpression: "#n = :one" },
    ),
  ],
  [
    "set a to maps 32 deep, and pk",
    ...RU(
      "SET #a = :d, #pk = :v",
      { "#a": "a", "#pk": "pk" },
      { ":d": nested(32, "M"), ":v": S("q") },
    ),
  ],
  [
    "set a to maps 32 deep, and x to a missing attribute",
    ...RU(
      "SET #a = :d, #x = #zz",
      { "#a": "a", "#x": "x", "#zz": "zz" },
      { ":d": nested(32, "M") },
    ),
  ],
  ["set m.e, #e an empty name", ...RU("SET #m.#e = :v", { "#m": "m", "#e": "" }, { ":v": N("1") })],
  [
    "a value 32 deep holding a bad number",
    ...RU("SET #a = :d", { "#a": "a" }, { ":d": nested(32, "M", N("x")) }),
  ],
  [
    "a value holding an empty map key",
    ...RU("SET #a = :d", { "#a": "a" }, { ":d": { M: { "": N("1") } } }),
  ],
  tw1("a put holding an empty map key", twPut({ ...VK("t1"), m: { M: { "": N("1") } } })),
  tw1("a put of maps 32 deep", twPut({ ...VK("t1"), d: nested(32, "M") })),
  tw1(
    "a check, then a put of a bad number",
    tCheck(KEY, "attribute_exists(pk)"),
    twPut({ ...VK("t2"), n: N("x") }),
  ),
  tw1("an update leaving maps 32 deep", twUpdate("SET #a = :d", { ":d": nested(32, "M") })),
  tw1(
    "a failing check, then an update leaving maps 32 deep",
    tCheck(KEY, "attribute_not_exists(pk)"),
    twUpdate("SET #a = :d", { ":d": nested(32, "M") }, { Key: VK("t3") }),
  ),
  tw1("a check of a value of two types", {
    ConditionCheck: {
      TableName: "$T",
      Key: KEY,
      ConditionExpression: "#n = :v",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":v": sent({ S: "a", N: "1" }) },
    },
  }),
  tw1("a delete of a key holding an empty name", {
    Delete: { TableName: "$T", Key: { ...KEY, "": S("x") } },
  }),
  [
    "a put holding an empty map key",
    "BatchWriteItem",
    { RequestItems: { $T: [{ PutRequest: { Item: { ...VK("b1"), m: { M: { "": N("1") } } } } }] } },
  ],
  [
    "a put of lists 32 deep",
    "BatchWriteItem",
    { RequestItems: { $T: [{ PutRequest: { Item: { ...VK("b1"), d: nested(32, "L") } } }] } },
  ],
  [
    "a key holding a bad number",
    "BatchGetItem",
    { RequestItems: { $T: { Keys: [{ pk: S("p"), sk: N("x") }] } } },
  ],
  [
    "a key of two types",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: { pk: S("p"), sk: sent({ S: "s", N: "1" }) } } },
      ],
    },
  ],
  [
    "a key with another attribute holding a bad number",
    "GetItem",
    { TableName: "$T", Key: { ...KEY, x: N("x") } },
  ],
  [
    "a start key of two types",
    "Query",
    {
      TableName: "$T",
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": S("p") },
      ExclusiveStartKey: { pk: S("p"), sk: sent({ S: "s", N: "1" }) },
    },
  ],
]

const ors = (n: number) => Array.from({ length: n }, () => "#n = :one").join(" OR ")
const sizes = (n: number) => Array.from({ length: n }, () => "size(#l) > :one").join(" AND ")
/** `n` actions of one `+` each, kept short: an update expression holds at most 4 KB. */
const sums = (n: number, from = 0) =>
  Array.from({ length: n }, (_, at) => `#${at + from}=:o+:o`).join(",")
const sumNames = (n: number, from = 0) =>
  Object.fromEntries(Array.from({ length: n }, (_, at) => [`#${at + from}`, `a${at + from}`]))
/** `n` actions of `if_not_exists` and `+` each (two operators). */
const guardedSums = (n: number) =>
  Array.from({ length: n }, (_, at) => `#i${at}=if_not_exists(#i${at},:o)+:o`).join(",")
const guardedNames = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, at) => [`#i${at}`, `i${at}`]))
const deepPath = (segments: number) =>
  ["#n", ...Array.from({ length: segments - 1 }, () => "#k")].join(".")
const conditioned = (label: string, expr: string, values: Record<string, AttributeValue> = {}) =>
  conditionRow({ label, expr, names: namesIn(expr), values: valuesIn(expr, { ...V, ...values }) })

/** Operator counts (300 at most) and document paths (32 segments at most). */
const LIMITS: ReadonlyArray<Row> = [
  conditioned("150 comparisons ORed (299 operators)", ors(150)),
  conditioned("NOT, then 150 comparisons ORed (300 operators)", `NOT (${ors(150)})`),
  conditioned("151 comparisons ORed (301 operators)", ors(151)),
  conditioned("201 comparisons ORed (401 operators)", ors(201)),
  conditioned("100 sizes compared (299 operators)", sizes(100)),
  conditioned("101 sizes compared (302 operators)", sizes(101)),
  conditioned("301 operators, then an undefined value", `${ors(151)} OR #n = :zz`),
  conditioned("301 operators, then a value of the wrong type", `${ors(151)} OR #n < :m`),
  conditionRow({
    label: "301 operators, a value unused",
    expr: ors(151),
    names: { "#n": "n" },
    values: { ":one": N("1"), ":unused": N("2") },
  }),
  conditioned("a path of 32 segments", `${deepPath(32)} = :one`),
  conditioned("a path of 33 segments", `${deepPath(33)} = :one`),
  conditionRow({
    label: "a path of 33 segments, holding an undefined name",
    expr: `${deepPath(32)}.#u = :one`,
    names: { "#n": "n", "#k": "k" },
    values: { ":one": N("1") },
  }),
  conditionRow({
    label: "an undefined name, then a path of 33 segments",
    expr: `#u = :one AND ${deepPath(33)} = :one`,
    names: { "#n": "n", "#k": "k" },
    values: { ":one": N("1") },
  }),
  conditioned(
    "a path of 33 segments, then an undefined value",
    `${deepPath(33)} = :one AND #n = :zz`,
  ),
  fullRow(["300 sums", ...RU(`SET ${sums(300)}`, sumNames(300), { ":o": N("1") })]),
  fullRow(["301 sums", ...RU(`SET ${sums(301)}`, sumNames(301), { ":o": N("1") })]),
  fullRow([
    "301 sums, then an undefined value",
    ...RU(`SET ${sums(301)},#n=:zz`, { ...sumNames(301), "#n": "n" }, { ":o": N("1") }),
  ]),
  fullRow([
    "280 sums and 10 if_not_exists sums (300 operators)",
    ...RU(
      `SET ${sums(280)},${guardedSums(10)}`,
      { ...sumNames(280), ...guardedNames(10) },
      { ":o": N("1") },
    ),
  ]),
  fullRow([
    "281 sums and 10 if_not_exists sums (301 operators)",
    ...RU(
      `SET ${sums(281)},${guardedSums(10)}`,
      { ...sumNames(281), ...guardedNames(10) },
      { ":o": N("1") },
    ),
  ]),
  fullRow([
    "a path of 33 segments",
    ...RU(`SET ${deepPath(33)} = :one`, { "#n": "n", "#k": "k" }, { ":one": N("1") }),
  ]),
  fullRow([
    "a path of 33 segments, after an undefined value",
    ...RU(
      `SET #a = :zz, ${deepPath(33)} = :one`,
      { "#a": "a", "#n": "n", "#k": "k" },
      { ":one": N("1") },
    ),
  ]),
  fullRow([
    "a projection of 33 segments",
    "GetItem",
    {
      TableName: "$T",
      Key: KEY,
      ProjectionExpression: deepPath(33),
      ExpressionAttributeNames: { "#n": "n", "#k": "k" },
    },
  ]),
  fullRow([
    "a projection of 32 segments",
    "GetItem",
    {
      TableName: "$T",
      Key: KEY,
      ProjectionExpression: deepPath(32),
      ExpressionAttributeNames: { "#n": "n", "#k": "k" },
    },
  ]),
  queryRow(
    "a filter of 301 operators",
    {
      FilterExpression: ors(151),
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":one": N("1") },
    },
    "Scan",
  ),
  queryRow("a key condition of 301 operators", {
    KeyConditionExpression: `pk = :p AND ${Array.from({ length: 150 }, () => "sk = :p").join(" AND ")} AND (${ors(75)})`,
    ExpressionAttributeNames: { "#n": "n" },
    ExpressionAttributeValues: { ":p": S("q"), ":one": N("1") },
  }),
  queryRow("a key condition of 301 operators, a nested key", {
    KeyConditionExpression: `pk.a = :p AND ${Array.from({ length: 300 }, () => "sk = :p").join(" AND ")}`,
    ExpressionAttributeValues: { ":p": S("q") },
  }),
]

/** Parentheses round operands, `size` of a value, functions where they can't be, empty expressions. */
const OPERAND_GROUPS: ReadonlyArray<BriefCondition> = [
  "(#n) = :five",
  "#n = (:five)",
  "size((#l)) > :one",
  "#n IN ((:one), :five)",
  "#n BETWEEN (:one) AND (:five)",
  "attribute_exists((#n))",
  "begins_with((#s), (:s))",
  "(size(#l)) > (:one)",
  "(:five) = #n",
  "NOT (#n) = :one",
  "(#n) BETWEEN :one AND :five",
  "(#n) IN (:five)",
  "(#m).k = :one",
  "(#l)[0] = :one",
  "(#n)",
  "((#n)) = :one",
  "#n = ()",
  "(:one, :one)",
  "(#n) AND #n = :one",
  "((#n = :five))",
  "(#n = :five)",
  "attribute_exists(#n) = :one",
  "attribute_exists(#n) BETWEEN :one AND :five",
  ":one = attribute_exists(#n)",
  "contains(#s, :s) IN (:one)",
  "attribute_exists(#n) AND #n = :five",
  "foo(#n) = :one",
  "foo(#n)",
  "(size(#l))",
  "size(#l)",
  ["size(:t) = :three", { ":t": S("é\u{1F600}"), ":three": N("3") }],
  ["size(:t) = :two", { ":t": S("é\u{1F600}"), ":two": N("2") }],
  "size(:five) > :one",
  "size(:bool) > :one",
  "size(:nul) > :one",
  "size(size(#l)) > :one",
  "size(:L) = :one",
  "size(:m) = :one",
  "size(:b) = :one",
  "size(:ss) = :one",
  "begins_with(size(#l), :s)",
  "contains(size(#l), :one)",
  "begins_with(:s, :s)",
  "#n = :zz AND foo(#n)",
  "#n = :zz AND size(:five) > :one",
  "size(:five) > :one AND #n = :zz",
]

/** Update expressions: operand groups, functions where they can't be, which problem is reported. */
const UPDATE_GROUPS: ReadonlyArray<Brief> = [
  "SET #a = (:v)",
  "SET #n = (#n) + (:v)",
  "SET #n = (#n + :v)",
  "SET #n = ((#n) + :v)",
  "SET #a = if_not_exists((#a), :v)",
  "SET #a = (if_not_exists(#a, :v))",
  "SET #a = (if_not_exists(#a, :v)) + :v",
  "SET #l = list_append((#l), :L)",
  "SET #a = ((:v))",
  "SET #a = :v + ((:v))",
  "SET #a = (:v + :v) + :v",
  "SET #a = :v + (:v + :v)",
  "SET #a = if_not_exists(#a, (:v + :v))",
  "SET #a = if_not_exists(#a, :v + :v)",
  "SET #l = list_append(#l, :v + :v)",
  "SET (#a) = :v",
  "REMOVE (#a)",
  "ADD #a (:v)",
  "SET #a = list_append(list_append(#l, :L), :L)",
  "SET #a = if_not_exists(#a, list_append(#l, :L))",
  "SET #a = list_append(if_not_exists(#l, :L), :L)",
  "SET #a = if_not_exists(#a, if_not_exists(#b, :v))",
  "SET #a = list_append(#l, :L) + :v",
  "SET #a = size(#l)",
  "SET #a = foo(#l)",
  "SET #a = foo(#l), #b = list_append(list_append(#l, :L), :L)",
  "SET #a = list_append(list_append(#l, :L), :L), #b = foo(#l)",
  "SET #a = :v, #a = :w, #b = foo(#l)",
]

/** The names `expression` uses, `#nope` and `#u` left undefined. */
const definedIn = (expression: string) =>
  Object.fromEntries(
    Object.entries(namesIn(expression)).filter(([key]) => key !== "#nope" && key !== "#u"),
  )
/** Which of several problems an update reports, read as written. */
const WALKS: ReadonlyArray<FullBrief> = [
  [
    "walk: undefined value, then undefined name",
    ...RU("SET #a = :zz, #b.#c = :v", names("a", "b"), { ":v": N("1") }),
  ],
  [
    "walk: undefined name, then undefined value",
    ...RU("SET #b.#c = :v, #a = :zz", names("a", "b"), { ":v": N("1") }),
  ],
  [
    "walk: if_not_exists of a value, then undefined name",
    ...RU("SET #a = if_not_exists(:v, :v), #b.#c = :v", names("a", "b"), { ":v": N("1") }),
  ],
  [
    "walk: undefined name, then if_not_exists of a value",
    ...RU("SET #b.#c = :v, #a = if_not_exists(:v, :v)", names("a", "b"), { ":v": N("1") }),
  ],
  [
    "walk: ADD of a string, then undefined name",
    ...RU("ADD #a :s, #b.#c :v", names("a", "b"), { ":v": N("1"), ":s": S("x") }),
  ],
  [
    "walk: wrong operand, then undefined value",
    ...RU("SET #a = :s + :v, #b = :zz", names("a", "b"), { ":v": N("1"), ":s": S("x") }),
  ],
  [
    "walk: undefined value, then wrong operand",
    ...RU("SET #b = :zz, #a = :s + :v", names("a", "b"), { ":v": N("1"), ":s": S("x") }),
  ],
  [
    "walk: undefined value, in the value and the path",
    ...RU("SET #b.#c = :zz", names("b"), { ":v": N("1") }),
  ],
  [
    "walk: a path too deep, then undefined name",
    ...RU(`SET ${deepPath(33)} = :v, #b.#c = :v`, names("n", "k", "b"), { ":v": N("1") }),
  ],
  [
    "walk: overlaps a,b,a,b",
    ...RU("SET #a = :v, #b = :v, #a = :w, #b = :w", names("a", "b"), {
      ":v": N("1"),
      ":w": N("2"),
    }),
  ],
  [
    "walk: overlaps a,a,b",
    ...RU("SET #a = :v, #a = :w, #b = :v", names("a", "b"), { ":v": N("1"), ":w": N("2") }),
  ],
  [
    "walk: overlap, then an undefined name",
    ...RU("SET #a = :v, #a = :w, #b = #nope", names("a", "b"), { ":v": N("1"), ":w": N("2") }),
  ],
  [
    "walk: overlap a, a.b, c",
    ...RU("SET #a = :v, #a.#b = :w, #c = :v", names("a", "b", "c"), { ":v": N("1"), ":w": N("2") }),
  ],
  [
    "walk: overlap, then a function misused",
    ...RU("SET #a = :v, #a = :w, #b = foo(#l)", names("a", "b", "l"), {
      ":v": N("1"),
      ":w": N("2"),
    }),
  ],
  [
    "walk: undefined name, then 301 operators",
    ...RU(`SET #b.#c=:o,${sums(301, 1)}`, { ...names("b"), ...sumNames(301, 1) }, { ":o": N("1") }),
  ],
  ...(
    [
      ["an overlap, then an undefined name", "#a, #a.#b, #nope"],
      ["an undefined name, then an overlap", "#nope, #a, #a.#b"],
      ["two overlaps", "#a, #b, #a.#c, #b.#c"],
      ["an overlap, then another path", "#a, #a.#b, #c"],
      ["a path too deep, then an overlap", `${deepPath(33)}, #a, #a.#b`],
      ["an overlap, then a path too deep", `#a, #a.#b, ${deepPath(33)}`],
      ["one path", "(#n)"],
    ] as const
  ).map(
    ([label, expression]): FullBrief => [
      `projection: ${label}`,
      "GetItem",
      {
        TableName: "$T",
        Key: KEY,
        ProjectionExpression: expression,
        ExpressionAttributeNames: definedIn(expression),
      },
    ],
  ),
]

const kq = (
  label: string,
  expression: string,
  values?: Record<string, AttributeValue>,
  extra: object = {},
) =>
  queried(`key condition ${label}`, {
    TableName: "$T",
    KeyConditionExpression: expression,
    ...(values !== undefined && { ExpressionAttributeValues: values }),
    ...extra,
  })
const P = { ":p": S("p") }
/** Key conditions DynamoDB Local refuses, and the order it finds their problems in. */
const KEY_CONDITIONS: ReadonlyArray<Row> = [
  kq("naming x twice, three parts", "pk = :p AND x = :a AND x = :b", {
    ...P,
    ":a": S("a"),
    ":b": S("b"),
  }),
  kq("on x", "pk = :p AND x = :a", { ...P, ":a": S("a") }),
  kq("naming pk twice", "pk = :p AND pk = :a", { ...P, ":a": S("a") }),
  kq("pk <", "pk < :p", P),
  kq("sk alone", "sk = :p", P),
  kq("of three parts", "pk = :p AND sk = :a AND x = :b", { ...P, ":a": S("a"), ":b": S("b") }),
  kq("pk <, and x", "pk < :p AND x = :a", { ...P, ":a": S("a") }),
  kq("begins_with(pk)", "begins_with(pk, :p)", P),
  kq("pk BETWEEN", "pk BETWEEN :p AND :a", { ...P, ":a": S("q") }),
  kq("pk IN", "pk IN (:p)", P),
  kq("contains(pk)", "contains(pk, :p)", P),
  kq("attribute_exists(pk)", "attribute_exists(pk)"),
  kq("attribute_not_exists(pk)", "attribute_not_exists(pk)"),
  kq("attribute_type(pk) of a type", "attribute_type(pk, :s)", { ":s": S("S") }),
  kq("attribute_type(pk) of no type", "attribute_type(pk, :p)", P),
  kq("size(pk)", "size(pk) = :p", { ":p": N("1") }),
  kq("pk.a", "pk.a = :p", P),
  kq("pk[0]", "pk[0] = :p", P),
  kq("pk = sk", "pk = sk"),
  kq(":p = :p", ":p = :p", P),
  kq(":a BETWEEN sk", "pk = :p AND :a BETWEEN sk AND :b", { ...P, ":a": S("a"), ":b": S("b") }),
  kq("begins_with(:a, sk)", "pk = :p AND begins_with(:a, sk)", { ...P, ":a": S("a") }),
  kq("naming sk twice, three parts", "pk = :p AND sk = :a AND sk = :b", {
    ...P,
    ":a": S("a"),
    ":b": S("b"),
  }),
  kq("size(pk), OR", "size(pk) = :p OR pk = :p", { ":p": N("1") }),
  kq("size(pk.a)", "size(pk.a) = :p", { ":p": N("1") }),
  kq("pk.a = sk", "pk.a = sk"),
  kq("pk.a <>", "pk.a <> :p", P),
  kq("x.a", "pk = :p AND x.a = :a", { ...P, ":a": S("a") }),
  kq("x.a alone", "x.a = :p", P),
  kq("pk.a, OR", "pk.a = :p OR x = :p", P),
  kq("OR, pk.a", "x = :p OR pk.a = :p", P),
  kq("an undefined name, pk.a", "#u = :p AND pk.a = :p", P),
  kq("pk.a, an undefined value", "pk.a = :p AND sk = :zz", P),
  kq("sk.a", "pk = :p AND sk.a = :p", P),
  kq("lsk.a on the table", "pk = :p AND lsk.a = :p", P),
  kq("gpk.a on gsi1", "gpk.a = :p", P, { IndexName: "gsi1" }),
  kq("pk.a on gsi1", "gpk = :p AND pk.a = :p", P, { IndexName: "gsi1" }),
  kq("x.a on gsi1", "gpk = :p AND x.a = :p", P, { IndexName: "gsi1" }),
  kq("begins_with(sk.a)", "pk = :p AND begins_with(sk.a, :p)", P),
  kq("sk.a BETWEEN", "pk = :p AND sk.a BETWEEN :p AND :p", P),
  kq("pk.a and sk.b", "pk.a = :p AND sk.b = :p", P),
  kq("sk.b and pk.a", "sk.b = :p AND pk.a = :p", P),
  kq("pk.a via a name", "#p.a = :p", P, { ExpressionAttributeNames: { "#p": "pk" } }),
  kq("pk = :p AND :a <= sk", "pk = :p AND :a <= sk", { ...P, ":a": S("a") }),
  kq("sk = :a AND pk = :p", "sk = :a AND pk = :p", { ...P, ":a": S("s") }),
  kq("(pk) = (:p) AND (sk) = (:a)", "(pk) = (:p) AND (sk) = (:a)", { ...P, ":a": S("s") }),
  kq("(pk = :p AND sk = :a)", "(pk = :p AND sk = :a)", { ...P, ":a": S("s") }),
  kq("((pk = :p))", "((pk = :p))", P),
  kq("begins_with((sk), (:a))", "pk = :p AND begins_with((sk), (:a))", { ...P, ":a": S("s") }),
  kq(
    "on lsk and sk of lsi1",
    "pk = :p AND lsk = :a AND sk = :a",
    { ...P, ":a": S("s") },
    { IndexName: "lsi1" },
  ),
  queried("no key condition", {
    TableName: "$T",
    FilterExpression: "#n = :one",
    ExpressionAttributeNames: { "#n": "n" },
    ExpressionAttributeValues: { ":one": N("1") },
  }),
  queried("no key condition, a filter's syntax error", {
    TableName: "$T",
    FilterExpression: "#n = (",
    ExpressionAttributeNames: { "#n": "n" },
  }),
]

/** Requests missing a member, naming no table, or asking for what an operation doesn't return. */
const MEMBERS: ReadonlyArray<FullBrief> = [
  ["no Item", "PutItem", { TableName: "$T" }],
  ["no Item, ReturnValues ALL_NEW", "PutItem", { TableName: "$T", ReturnValues: "ALL_NEW" }],
  ["no Key", "GetItem", { TableName: "$T" }],
  ["no Key", "DeleteItem", { TableName: "$T" }],
  [
    "no Key",
    "UpdateItem",
    {
      TableName: "$T",
      UpdateExpression: "SET #a = :v",
      ExpressionAttributeNames: { "#a": "a" },
      ExpressionAttributeValues: { ":v": N("1") },
    },
  ],
  ["table ''", "GetItem", { TableName: "", Key: KEY }],
  ["table ''", "PutItem", { TableName: "", Item: KEY }],
  ["table '', no Item", "PutItem", { TableName: "" }],
  [
    "table '', ReturnValuesOnConditionCheckFailure ALL_NEW",
    "PutItem",
    { TableName: "", Item: KEY, ReturnValuesOnConditionCheckFailure: "ALL_NEW" },
  ],
  ["table ''", "DeleteItem", { TableName: "", Key: KEY }],
  ["table ''", "UpdateItem", { TableName: "", Key: KEY }],
  [
    "table ''",
    "Query",
    { TableName: "", KeyConditionExpression: "pk = :p", ExpressionAttributeValues: P },
  ],
  ["table ''", "Scan", { TableName: "" }],
  [
    "table '' in a put",
    "TransactWriteItems",
    { TransactItems: [{ Put: { TableName: "", Item: KEY } }] },
  ],
  [
    "table '', then a put with no Item",
    "TransactWriteItems",
    { TransactItems: [{ Put: { TableName: "", Item: KEY } }, { Put: { TableName: "$T" } }] },
  ],
  ["table ''", "BatchGetItem", { RequestItems: { "": { Keys: [KEY] } } }],
  ["table ''", "BatchWriteItem", { RequestItems: { "": [{ PutRequest: { Item: KEY } }] } }],
  ["table ''", "TransactGetItems", { TransactItems: [{ Get: { TableName: "", Key: KEY } }] }],
  ["no table", "GetItem", { Key: KEY }],
  ["no table, no Key", "GetItem", {}],
  ["no table, names {}", "GetItem", { Key: KEY, ExpressionAttributeNames: {} }],
  ["no table", "PutItem", { Item: KEY }],
  ["no table, ReturnValues bogus", "PutItem", { Item: KEY, ReturnValues: "bogus" }],
  ["no table, no Item", "PutItem", {}],
  ["no table", "UpdateItem", { Key: KEY, UpdateExpression: "SET a = :v" }],
  ["no table", "DeleteItem", { Key: KEY }],
  ["no table", "Query", { KeyConditionExpression: "pk = :p", ExpressionAttributeValues: P }],
  [
    "no table, Limit 0",
    "Query",
    { KeyConditionExpression: "pk = :p", ExpressionAttributeValues: P, Limit: 0 },
  ],
  ["no table", "Scan", {}],
  tw1("a put naming no table", { Put: { Item: VK("nt1") } }),
  tw1("a delete naming no table", { Delete: { Key: KEY } }),
  tw1("an update naming no table", {
    Update: {
      Key: KEY,
      UpdateExpression: "SET #a = :v",
      ExpressionAttributeNames: { "#a": "a" },
      ExpressionAttributeValues: { ":v": N("1") },
    },
  }),
  tw1("a check naming no table", {
    ConditionCheck: { Key: KEY, ConditionExpression: "attribute_exists(pk)" },
  }),
  tw1("a check naming no table, no condition", { ConditionCheck: { Key: KEY } }),
  tw1("a put naming no table, no Item", { Put: {} }),
  tw1("a put, then a put naming no table", twPut(VK("nt2")), { Put: { Item: VK("nt3") } }),
  tw1("two items naming no table", { Put: { Item: VK("nt4") } }, { Delete: { Key: KEY } }),
  tw1("a bad number, then no table", twPut({ ...VK("nt5"), n: N("x") }), {
    Put: { Item: VK("nt6") },
  }),
  tw1(
    "no table, then a bad number",
    { Put: { Item: VK("nt7") } },
    twPut({ ...VK("nt8"), n: N("x") }),
  ),
  tw1(
    "a condition's syntax error, then no table",
    twPut(VK("nt9"), { ConditionExpression: "(((" }),
    { Put: { Item: VK("nt10") } },
  ),
  tw1(
    "table '', then no table",
    { Put: { TableName: "", Item: KEY } },
    { Put: { Item: VK("nt11") } },
  ),
  tw1("a key missing sk, then no table", twPut({ pk: S("nt12") }), { Put: { Item: VK("nt13") } }),
  tw1(
    "an update with no Key, then no table",
    {
      Update: {
        TableName: "$T",
        UpdateExpression: "SET #a = :v",
        ExpressionAttributeNames: { "#a": "a" },
        ExpressionAttributeValues: { ":v": N("1") },
      },
    },
    { Put: { Item: VK("nt14") } },
  ),
  ["no table", "TransactGetItems", { TransactItems: [{ Get: { Key: KEY } }] }],
  ["no table, no Key", "TransactGetItems", { TransactItems: [{ Get: {} }] }],
  [
    "no table, a bad key value",
    "TransactGetItems",
    { TransactItems: [{ Get: { Key: { pk: { NULL: false }, sk: S("s") } } }] },
  ],
  [
    "table '', a bad key value",
    "TransactGetItems",
    { TransactItems: [{ Get: { TableName: "", Key: { pk: { NULL: false }, sk: S("s") } } }] },
  ],
  [
    "no table, an undefined name in the projection",
    "TransactGetItems",
    { TransactItems: [{ Get: { Key: KEY, ProjectionExpression: "#nope" } }] },
  ],
  [
    "no table, then table ''",
    "TransactGetItems",
    { TransactItems: [{ Get: { Key: KEY } }, { Get: { TableName: "", Key: KEY } }] },
  ],
  [
    "table '', then no table",
    "TransactGetItems",
    { TransactItems: [{ Get: { TableName: "", Key: KEY } }, { Get: { Key: KEY } }] },
  ],
  [
    "table '', then an undefined name in the projection",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "", Key: KEY } },
        { Get: { TableName: "$T", Key: KEY, ProjectionExpression: "#nope" } },
      ],
    },
  ],
  [
    "an undefined name in the projection, then table ''",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: KEY, ProjectionExpression: "#nope" } },
        { Get: { TableName: "", Key: KEY } },
      ],
    },
  ],
  [
    "an undefined name in the projection, then no table",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: KEY, ProjectionExpression: "#nope" } },
        { Get: { Key: KEY } },
      ],
    },
  ],
  [
    "no table, then an undefined name in the projection",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { Key: KEY } },
        { Get: { TableName: "$T", Key: KEY, ProjectionExpression: "#nope" } },
      ],
    },
  ],
  [
    "no Key, then no table",
    "TransactGetItems",
    { TransactItems: [{ Get: { TableName: "$T" } }, { Get: { Key: KEY } }] },
  ],
  [
    "no table, then no Key",
    "TransactGetItems",
    { TransactItems: [{ Get: { Key: KEY } }, { Get: { TableName: "$T" } }] },
  ],
  [
    "no Key, then an undefined name in the projection",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T" } },
        { Get: { TableName: "$T", Key: KEY, ProjectionExpression: "#nope" } },
      ],
    },
  ],
  [
    "a bad key value, then no table",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: { pk: { NULL: false }, sk: S("s") } } },
        { Get: { Key: KEY } },
      ],
    },
  ],
  [
    "a bad key value, then an undefined name in the projection",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: { pk: { NULL: false }, sk: S("s") } } },
        { Get: { TableName: "$T", Key: KEY, ProjectionExpression: "#nope" } },
      ],
    },
  ],
  [
    "a bad key value, then no Key",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: { pk: { NULL: false }, sk: S("s") } } },
        { Get: { TableName: "$T" } },
      ],
    },
  ],
  [
    "a key missing sk, then no table",
    "TransactGetItems",
    { TransactItems: [{ Get: { TableName: "$T", Key: { pk: S("p") } } }, { Get: { Key: KEY } }] },
  ],
  [
    "a key missing sk, then table ''",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: { pk: S("p") } } },
        { Get: { TableName: "", Key: KEY } },
      ],
    },
  ],
  [
    "a key missing sk, then an undefined name in the projection",
    "TransactGetItems",
    {
      TransactItems: [
        { Get: { TableName: "$T", Key: { pk: S("p") } } },
        { Get: { TableName: "$T", Key: KEY, ProjectionExpression: "#nope" } },
      ],
    },
  ],
  [
    "ReturnValuesOnConditionCheckFailure ALL_NEW",
    ...RU(
      "SET #a = :v",
      { "#a": "a" },
      { ":v": N("1") },
      { ReturnValuesOnConditionCheckFailure: "ALL_NEW" },
    ),
  ],
  [
    "ReturnValuesOnConditionCheckFailure ALL_NEW, an undefined name",
    ...RU(
      "SET #a = :v",
      { "#b": "b" },
      { ":v": N("1") },
      { ReturnValuesOnConditionCheckFailure: "ALL_NEW" },
    ),
  ],
  [
    "ReturnValuesOnConditionCheckFailure ALL_NEW",
    "PutItem",
    { TableName: "$T", Item: KEY, ReturnValuesOnConditionCheckFailure: "ALL_NEW" },
  ],
  [
    "ReturnValuesOnConditionCheckFailure ALL_NEW",
    "DeleteItem",
    { TableName: "$T", Key: KEY, ReturnValuesOnConditionCheckFailure: "ALL_NEW" },
  ],
  [
    "ReturnValuesOnConditionCheckFailure ALL_NEW, a key missing sk",
    "DeleteItem",
    { TableName: "$T", Key: { pk: S("p") }, ReturnValuesOnConditionCheckFailure: "ALL_NEW" },
  ],
  [
    "ReturnValuesOnConditionCheckFailure none",
    "DeleteItem",
    { TableName: "$T", Key: KEY, ReturnValuesOnConditionCheckFailure: "none" },
  ],
  tw1(
    "an update's ReturnValuesOnConditionCheckFailure ALL_NEW",
    twUpdate("SET #a = :v", { ":v": N("1") }, { ReturnValuesOnConditionCheckFailure: "ALL_NEW" }),
  ),
  tw1("a put with no Item", { Put: { TableName: "$T" } }),
  tw1("an update with no Key", {
    Update: {
      TableName: "$T",
      UpdateExpression: "SET #a = :v",
      ExpressionAttributeNames: { "#a": "a" },
      ExpressionAttributeValues: { ":v": N("1") },
    },
  }),
  tw1("a delete with no Key", { Delete: { TableName: "$T" } }),
  tw1("a check with no Key", {
    ConditionCheck: { TableName: "$T", ConditionExpression: "attribute_exists(pk)" },
  }),
  tw1("a check with no Key and no condition", { ConditionCheck: { TableName: "$T" } }),
  tw1("a check with no condition", { ConditionCheck: { TableName: "$T", Key: KEY } }),
  tw1("a check with values and no condition", {
    ConditionCheck: { TableName: "$T", Key: KEY, ExpressionAttributeValues: { ":v": N("1") } },
  }),
  tw1("an update with values and no expression", twUpdate(undefined, { ":v": N("1") })),
  tw1(
    "an update with a condition only",
    twUpdate(undefined, undefined, { ConditionExpression: "attribute_exists(pk)" }),
  ),
  tw1(
    "an update with a condition and its values",
    twUpdate(undefined, { ":n": N("5") }, { ConditionExpression: "n = :n" }),
  ),
  tw1(
    "an update with names only",
    twUpdate(undefined, undefined, { ExpressionAttributeNames: { "#a": "a" } }),
  ),
  tw1("an update with no expression", twUpdate(undefined, undefined, { Key: VK("fresh") })),
  tw1(
    "a put with values and no condition",
    twPut(VK("t4"), { ExpressionAttributeValues: { ":v": N("1") } }),
  ),
  tw1("two items with no Key", { Delete: { TableName: "$T" } }, { Delete: { TableName: "$T" } }),
  tw1("a check, then a put with no Item", tCheck(KEY, "attribute_exists(pk)"), {
    Put: { TableName: "$T" },
  }),
  tw1("a put of a bad number, then a delete with no Key", twPut({ ...VK("t5"), n: N("x") }), {
    Delete: { TableName: "$T" },
  }),
  ["a put with no Item", "BatchWriteItem", { RequestItems: { $T: [{ PutRequest: {} }] } }],
  ["a delete with no Key", "BatchWriteItem", { RequestItems: { $T: [{ DeleteRequest: {} }] } }],
  [
    "a put with no Item, then a bad number",
    "BatchWriteItem",
    {
      RequestItems: {
        $T: [{ PutRequest: {} }, { PutRequest: { Item: { ...VK("b2"), n: N("x") } } }],
      },
    },
  ],
  ["a Get with no Key", "TransactGetItems", { TransactItems: [{ Get: { TableName: "$T" } }] }],
  [
    "Limit 0",
    "Query",
    { TableName: "$T", KeyConditionExpression: "pk = :p", ExpressionAttributeValues: P, Limit: 0 },
  ],
  [
    "Limit 0, a filter's syntax error",
    "Scan",
    { TableName: "$T", Limit: 0, FilterExpression: "n = (" },
  ],
  ["Limit 0, Segment 3 of 2", "Scan", { TableName: "$T", Limit: 0, Segment: 3, TotalSegments: 2 }],
  ["TotalSegments 2 alone", "Scan", { TableName: "$T", TotalSegments: 2 }],
  ["Segment 0 alone", "Scan", { TableName: "$T", Segment: 0 }],
  ["Segment 2 of 2", "Scan", { TableName: "$T", Segment: 2, TotalSegments: 2 }],
  ["Segment -1 of 1", "Scan", { TableName: "$T", Segment: -1, TotalSegments: 1 }],
  ["Segment 0 of 0", "Scan", { TableName: "$T", Segment: 0, TotalSegments: 0 }],
  ["Segment 5 of 1000001", "Scan", { TableName: "$T", Segment: 5, TotalSegments: 1000001 }],
  ["TotalSegments 1000001 alone", "Scan", { TableName: "$T", TotalSegments: 1000001 }],
  [
    "Segment 3 of 2, a filter's syntax error",
    "Scan",
    { TableName: "$T", Segment: 3, TotalSegments: 2, FilterExpression: "n = (" },
  ],
  [
    "Segment 3 of 2, an undefined name",
    "Scan",
    {
      TableName: "$T",
      Segment: 3,
      TotalSegments: 2,
      FilterExpression: "#u = :one",
      ExpressionAttributeValues: { ":one": N("1") },
    },
  ],
  [
    "values and no condition",
    "PutItem",
    { TableName: "$T", Item: KEY, ExpressionAttributeValues: { ":v": N("1") } },
  ],
  [
    "names and no condition",
    "PutItem",
    { TableName: "$T", Item: KEY, ExpressionAttributeNames: { "#a": "a" } },
  ],
  [
    "an empty names map and no condition",
    "PutItem",
    { TableName: "$T", Item: KEY, ExpressionAttributeNames: {} },
  ],
  [
    "a names key without # and no condition",
    "PutItem",
    { TableName: "$T", Item: KEY, ExpressionAttributeNames: { a: "a" } },
  ],
  [
    "values and no condition, a bad value",
    "PutItem",
    { TableName: "$T", Item: KEY, ExpressionAttributeValues: { ":v": N("x") } },
  ],
  [
    "values and no condition",
    "DeleteItem",
    { TableName: "$T", Key: KEY, ExpressionAttributeValues: { ":v": N("1") } },
  ],
  [
    "values and no expression",
    "UpdateItem",
    { TableName: "$T", Key: KEY, ExpressionAttributeValues: { ":v": N("1") } },
  ],
  [
    "values and no filter",
    "Scan",
    { TableName: "$T", ExpressionAttributeValues: { ":v": N("1") } },
  ],
  [
    "values and no key condition",
    "Query",
    { TableName: "$T", ExpressionAttributeValues: { ":v": N("1") } },
  ],
  [
    "an empty names map",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "n = :one",
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: { ":one": N("1") },
    },
  ],
  [
    "a names key without #",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "n = :one",
      ExpressionAttributeNames: { a: "a" },
      ExpressionAttributeValues: { ":one": N("1") },
    },
  ],
  [
    "a names key holding -",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "#n = :one",
      ExpressionAttributeNames: { "#n": "n", "#a-b": "x" },
      ExpressionAttributeValues: { ":one": N("1") },
    },
  ],
  [
    "a values key without :",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "n = :one",
      ExpressionAttributeValues: { ":one": N("1"), v: N("1") },
    },
  ],
  [
    "an empty values map",
    "Scan",
    { TableName: "$T", FilterExpression: "attribute_exists(n)", ExpressionAttributeValues: {} },
  ],
  [
    "a value 33 deep",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "n = :d",
      ExpressionAttributeValues: { ":d": nested(33, "M") },
    },
  ],
  [
    "a value 32 deep",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "n = :d",
      ExpressionAttributeValues: { ":d": nested(32, "M") },
    },
  ],
  [
    "a names value that is empty",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "#n = :one",
      ExpressionAttributeNames: { "#n": "" },
      ExpressionAttributeValues: { ":one": N("1") },
    },
  ],
  [
    "an empty names map, a bad values key",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "n = :one",
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: { v: N("1") },
    },
  ],
  [
    "a bad values key, a bad value",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "n = :one",
      ExpressionAttributeValues: { ":one": N("x"), v: N("1") },
    },
  ],
  [
    "a bad value, an empty name",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "#n = :one",
      ExpressionAttributeNames: { "#n": "" },
      ExpressionAttributeValues: { ":one": N("x") },
    },
  ],
  [
    "an empty ConditionExpression",
    "DeleteItem",
    { TableName: "$T", Key: KEY, ConditionExpression: "" },
  ],
  [
    "a blank ConditionExpression",
    "DeleteItem",
    { TableName: "$T", Key: KEY, ConditionExpression: " " },
  ],
  ["an empty UpdateExpression", "UpdateItem", { TableName: "$T", Key: KEY, UpdateExpression: "" }],
  [
    "an empty UpdateExpression, with values",
    "UpdateItem",
    {
      TableName: "$T",
      Key: KEY,
      UpdateExpression: "",
      ExpressionAttributeValues: { ":v": N("1") },
    },
  ],
  ["an empty FilterExpression", "Scan", { TableName: "$T", FilterExpression: "" }],
  ["an empty KeyConditionExpression", "Query", { TableName: "$T", KeyConditionExpression: "" }],
  [
    "an empty ProjectionExpression",
    "GetItem",
    { TableName: "$T", Key: KEY, ProjectionExpression: "" },
  ],
  [
    "a filter #n = (:one)",
    "Scan",
    {
      TableName: "$T",
      FilterExpression: "#n = (:one)",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":one": N("1") },
    },
  ],
]

const UPDATED = (
  expression: string,
  mode: "UPDATED_NEW" | "UPDATED_OLD",
  values?: Item,
): FullBrief => [`${mode} of ${expression}`, ...RV(expression, namesIn(expression), values, mode)]
/** `UPDATED_NEW` / `UPDATED_OLD` of paths below a top-level attribute. */
const UPDATED_VALUES: ReadonlyArray<FullBrief> = (
  [
    ["REMOVE #l[0]"],
    ["REMOVE #m.#l[0]"],
    ["REMOVE #l[0], #l[1]"],
    ["SET #a = :x REMOVE #l[0]", { ":x": N("9") }],
    ["SET #l[10] = :x", { ":x": N("9") }],
    ["SET #m.#l[5] = :x", { ":x": N("9") }],
    ["SET #l[3] = :x", { ":x": N("9") }],
    ["SET #l[2] = :x", { ":x": N("9") }],
    ["SET #m.#new = :x", { ":x": N("9") }],
    ["SET #m.#k = :x", { ":x": N("9") }],
    ["ADD #m.#cnt :one", { ":one": N("1") }],
    ["ADD #m.#k :one", { ":one": N("1") }],
    ["REMOVE #l[10]"],
    ["REMOVE #m.#nope"],
    ["REMOVE #m.#l[0], #m.#l[1]"],
    ["REMOVE #n"],
    ["REMOVE #zz"],
    ["SET #a = :x", { ":x": N("9") }],
    ["SET #n = :x", { ":x": N("9") }],
    ["DELETE #ss :ss", { ":ss": { SS: ["a"] } }],
    ["DELETE #ss :all", { ":all": { SS: ["a", "b"] } }],
  ] as ReadonlyArray<readonly [string, Item?]>
).flatMap(([expression, values]) => [
  UPDATED(expression, "UPDATED_NEW", values),
  UPDATED(expression, "UPDATED_OLD", values),
])

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
    ...INDEX_WRITES,
    ...COUNTS,
    ...QUERY_CHECKS,
    ...PROJECTIONS,
    ...LAST_KEYS,
    ...START_KEYS,
    ...TIES,
    ...TIE_PAGES,
    ...STORED_NUMBERS,
    ...PROTO,
    ...VALUES.map(fullRow),
    ...LIMITS,
    ...OPERAND_GROUPS.map(briefCondition),
    ...UPDATE_GROUPS.map(briefUpdate),
    ...WALKS.map(fullRow),
    ...KEY_CONDITIONS,
    ...MEMBERS.map(fullRow),
    ...UPDATED_VALUES.map(fullRow),
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
/** The AWS SDK's failure reading an error's item that holds a top-level `__proto__`. */
const SDK_PROTO_FAILURE =
  "Cannot read properties of undefined (reading 'B')\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object."
/**
 * The `__proto__` item as the AWS SDK reads it from a successful answer, as compared: the
 * top-level attribute an own property without a value, the nested one as stored.
 */
const PROTO_AS_READ = {
  "__proto__ (own)": "<undefined>",
  m: { M: { "__proto__ (own)": S("x"), k: N("2") } },
  pk: S("p"),
  sk: S("s"),
}
/** The tables' refusal of a `Limit` stopping among rows of one index key. */
const limitAmongTies = (limit: number, attribute: string) =>
  `UnreadableRequest: The in-memory table doesn't read the Limit "${limit}": stopping among rows of one ${attribute} (DynamoDB Local's order among them is not modelled)`
/** The tables' refusal of a request that reads among rows of one index key. */
const amongTies = (field: string, key: Item, attribute: string) =>
  `UnreadableRequest: The in-memory table doesn't read the ${field} ${JSON.stringify(JSON.stringify(key))}: among rows of one ${attribute} (DynamoDB Local's order among them is not modelled)`
/**
 * Rows a helper answers differently from DynamoDB Local, on purpose, and why: DynamoDB Local's
 * answer and the helper's, each exactly (numbers as spelled). Every item each table holds
 * afterwards is the same.
 */
const KNOWN: Readonly<
  Record<
    string,
    {
      readonly reason: string
      readonly on: ReadonlyArray<Backend>
      readonly local: unknown
      readonly helper: unknown
    }
  >
> = {
  "__proto__: a failed condition's item": {
    reason:
      "the AWS SDK fails to read an error's item holding a top-level __proto__ attribute (a TypeError, 'Deserialization error'); the tables return the item as the SDK reads a successful answer's",
    on: ["recording", "inMemory"],
    local: { error: "TypeError", message: SDK_PROTO_FAILURE },
    helper: {
      error: "ConditionalCheckFailedException",
      message: "The conditional request failed",
      Item: PROTO_AS_READ,
    },
  },
  "__proto__: a cancellation reason's item": {
    reason:
      "the AWS SDK fails to read a cancellation reason's item holding a top-level __proto__ attribute (a TypeError, 'Deserialization error'); the tables return the item as the SDK reads a successful answer's",
    on: ["recording", "inMemory"],
    local: { error: "TypeError", message: SDK_PROTO_FAILURE },
    helper: {
      error: "TransactionCanceledException",
      message:
        "Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed]",
      reasons: [
        {
          Code: "ConditionalCheckFailed",
          Message: "The conditional request failed.",
          Item: PROTO_AS_READ,
        },
      ],
    },
  },
  "GetItem: get: no such table": {
    reason:
      "the tables keep no list of tables: any name a request gives is a table, empty until written; DynamoDB Local refuses a table that doesn't exist (ResourceNotFoundException)",
    on: ["recording", "inMemory"],
    local: {
      error: "ResourceNotFoundException",
      message: "Cannot do operations on a non-existent table",
    },
    helper: { ok: {} },
  },
  'start key: lsi1, COUNT: {"pk":"p","sk":"zz","lsk":"a"}': {
    reason:
      "a start key among rows of one index sort key (other than its own row): DynamoDB Local places it by its own order among them, which the tables don't model, so they refuse to answer",
    on: ["recording", "inMemory"],
    local: { ok: { Count: 3, ScannedCount: 3 } },
    helper: {
      unreadable: amongTies("ExclusiveStartKey", { pk: S("p"), sk: S("zz"), lsk: S("a") }, "lsk"),
    },
  },
  'start key: gsi1, COUNT: {"pk":"zz","sk":"zz","gpk":"g","gsk":"a"}': {
    reason:
      "a start key among rows of one index sort key (other than its own row): DynamoDB Local places it by its own order among them, which the tables don't model, so they refuse to answer",
    on: ["recording", "inMemory"],
    local: { ok: { Count: 3, ScannedCount: 3 } },
    helper: {
      unreadable: amongTies(
        "ExclusiveStartKey",
        { pk: S("zz"), sk: S("zz"), gpk: S("g"), gsk: S("a") },
        "gsk",
      ),
    },
  },
  "ties: gsi1 returns rows of one gsk": {
    reason:
      "DynamoDB Local returns rows of one index key in an order of its own (here c, b, a); the tables return them in table-key order, as every item is still returned once",
    on: ["recording", "inMemory"],
    local: {
      ok: { Count: 3, ScannedCount: 3, Items: ["c", "b", "a"].map((pk) => ({ pk: S(pk) })) },
    },
    helper: {
      ok: { Count: 3, ScannedCount: 3, Items: ["a", "b", "c"].map((pk) => ({ pk: S(pk) })) },
    },
  },
  "ties: gsi1, Limit 1, COUNT": {
    reason:
      "a Limit that stops between rows of one index key: which of them DynamoDB Local reads first is its own order, which the tables don't model, so they refuse to answer",
    on: ["recording", "inMemory"],
    local: {
      ok: {
        Count: 1,
        ScannedCount: 1,
        LastEvaluatedKey: { gpk: S("t"), gsk: S("k"), pk: S("c"), sk: S("s") },
      },
    },
    helper: {
      unreadable: limitAmongTies(1, "gsk"),
    },
  },
  "ties: gsi1, a Limit splitting ties past the start key": {
    reason:
      "a Limit that stops between rows of one index key past the start key: which of them DynamoDB Local reads first is its own order (here w3, where table-key order reads w2), which the tables don't model, so they refuse to answer",
    on: ["recording", "inMemory"],
    local: {
      ok: { Count: 1, ScannedCount: 1, LastEvaluatedKey: gsiRow("w3", "w", "3") },
    },
    helper: { unreadable: limitAmongTies(1, "gsk") },
  },
  "ties: gsi1, a Limit stopping on the last of ties": {
    reason:
      "a Limit that stops on the last of rows of one index key: which of them DynamoDB Local reads last, and so names in its LastEvaluatedKey, is its own order (here w2, where table-key order ends on w3), which the tables don't model, so they refuse to answer",
    on: ["recording", "inMemory"],
    local: {
      ok: { Count: 2, ScannedCount: 2, LastEvaluatedKey: gsiRow("w2", "w", "3") },
    },
    helper: { unreadable: limitAmongTies(2, "gsk") },
  },
  "ties: lsi1, reverse, a Limit splitting ties past the start key": {
    reason:
      "a Limit that stops between rows of one index key past the start key, read in reverse: which of them DynamoDB Local reads first is its own order (here sk 0, where reverse table-key order reads sk 1), which the tables don't model, so they refuse to answer",
    on: ["recording", "inMemory"],
    local: {
      ok: { Count: 1, ScannedCount: 1, LastEvaluatedKey: lsiRow("m", "0", "1") },
    },
    helper: { unreadable: limitAmongTies(1, "lsk") },
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
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = (yield* DynamoClient) as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<unknown, unknown>
      >
      // Stored as DynamoDB Local stores them: through a put.
      for (const seed of row.seed) {
        yield* Effect.orDie(
          client.putItem!({ TableName: TABLES[seed.table], Item: named(seed.item) }),
        )
      }
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

/** A `CreateTable` index's key schema and projection, from its `INDEXES` entry. */
const indexDefinition = ([name, index]: readonly [string, Indexes[string]]) => ({
  IndexName: name,
  KeySchema: [
    { AttributeName: index.pk, KeyType: "HASH" as const },
    { AttributeName: index.sk, KeyType: "RANGE" as const },
  ],
  Projection:
    index.projection === undefined || typeof index.projection === "string"
      ? { ProjectionType: index.projection ?? "ALL" }
      : { ProjectionType: "INCLUDE" as const, NonKeyAttributes: [...index.projection] },
})

const createTable = (name: string, indexed: boolean) => {
  const indexes: ReadonlyArray<readonly [string, Indexes[string]]> = indexed
    ? Object.entries(INDEXES as Indexes)
    : []
  const local = indexes.filter(([, index]) => index.pk === "pk")
  const global = indexes.filter(([, index]) => index.pk !== "pk")
  const types = new Map<string, "S" | "N" | "B">([
    ["pk", "S"],
    ["sk", "S"],
  ])
  for (const [, index] of indexes) {
    types.set(index.pk, index.pkType ?? "S")
    types.set(index.sk, index.skType ?? "S")
  }
  return raw.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [...types].map(([AttributeName, AttributeType]) => ({
        AttributeName,
        AttributeType,
      })),
      ...(local.length > 0 && { LocalSecondaryIndexes: local.map(indexDefinition) }),
      ...(global.length > 0 && { GlobalSecondaryIndexes: global.map(indexDefinition) }),
    }),
  )
}

describeConnected("the in-memory tables, request by request, against DynamoDB Local", () => {
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
      /**
       * Numbers as spelled. A row known to differ: DynamoDB Local's answer and the helper's are
       * each exactly the ones listed, and the tables are the same.
       */
      const compare = (
        backend: Backend,
        got: (exact: boolean) => unknown,
        expected: (exact: boolean) => unknown,
      ) => {
        if (!known?.on.includes(backend)) {
          expect({ [backend]: got(true) }).toEqual({ [backend]: expected(true) })
          return
        }
        const helper = got(true) as { answer: unknown; tables: unknown }
        const local = expected(true) as { answer: unknown; tables: unknown }
        expect({ [backend]: helper.tables }).toEqual({ [backend]: local.tables })
        expect({ local: local.answer }, known.reason).toEqual({ local: known.local })
        expect({ [backend]: helper.answer }, known.reason).toEqual({ [backend]: known.helper })
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
