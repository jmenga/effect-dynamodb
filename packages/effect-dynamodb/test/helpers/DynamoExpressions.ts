/**
 * DynamoDB's requests as DynamoDB Local answers them, for the in-memory tables (`InMemoryTables`,
 * `RecordingTable`) and `MockDynamoClient.applyUpdate`: expressions read and evaluated, requests
 * checked, items written, transactions run.
 *
 * The rule: every request the library sends is answered as DynamoDB Local (`amazon/dynamodb-local`)
 * answers it, and anything this doesn't model throws {@link UnreadableRequest}, which the tables
 * surface as a defect naming it, before anything is written: never an approximation. The answers
 * were measured on DynamoDB Local, and `connected.helper-conformance.test.ts` sends the same
 * requests to DynamoDB Local and to both tables and compares the answers, every item each table
 * holds afterwards included; a row answered differently on purpose is listed there (`KNOWN`) with
 * both answers, exactly. What it reads:
 *
 * - Condition, filter and key condition expressions: comparisons, `BETWEEN`, `IN`, `AND` / `OR` /
 *   `NOT`, parentheses, `attribute_exists`, `attribute_not_exists`, `attribute_type`,
 *   `begins_with`, `contains` and `size`, on document paths (`#a`, `#a.#b`, `#a[0]`, or a bare name
 *   that isn't a reserved word).
 * - Update expressions: `SET` (`+`, `-`, `if_not_exists`, `list_append`), `REMOVE`, `ADD` and
 *   `DELETE`, sections in any order and keywords in any case, whitespace optional.
 * - Projection expressions of attribute and map-key paths.
 * - Reads: `GetItem`, `Query` of the table or a declared index (local or global, its projection,
 *   `Select`, `ConsistentRead`, `Limit` counting rows examined, `ExclusiveStartKey` /
 *   `LastEvaluatedKey`), `Scan`, `BatchGetItem`, `TransactGetItems`.
 * - Writes: `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`, `TransactWriteItems` (checked
 *   whole, its items taken in order, then written whole), each checking the table's and every
 *   declared index's key attributes as DynamoDB Local does.
 *
 * A request DynamoDB refuses throws DynamoDB Local's `ValidationException`, worded as it words it.
 *
 * Numbers are exact, as DynamoDB Local's (Java's `BigDecimal`): `+` / `-` keep the larger scale
 * and are written in plain notation (`5 + 0.50` stores `5.50`), a set `ADD` or `DELETE` writes is
 * sorted with its numbers normalised, and numbers compare by value everywhere. A number a request
 * gives is stored as DynamoDB Local stores it: a put's top-level number, and each member of a
 * top-level number set, normalised (`1.50` as `1.5`, `1e21` as `1000000000000000000000`); a number
 * set from `ExpressionAttributeValues`, or nested in a put's item, spelt as `BigDecimal.toString()`
 * prints it (`1E+21`); any other number as written.
 *
 * What this doesn't model, in one place. These are answered, not refused, each for the reason given:
 *
 * - Tables: none is listed, so a request naming a table that doesn't exist is answered as an
 *   empty table where DynamoDB Local refuses it (`ResourceNotFoundException`); the tests name
 *   their tables freely.
 * - Rows of one index key returned in one answer come back in table-key order; DynamoDB Local
 *   returns them in an order of its own. Every row is still returned once, and tests that list an
 *   aggregate's rows read them together. A request whose answer depends on that order is refused
 *   by name: an `ExclusiveStartKey` among such rows (other than its own row), or a `Limit` that
 *   stops between them.
 * - A `Scan` reads rows in key order and splits `Segment`s by a hash of the key; DynamoDB Local's
 *   order and split are its own. Read to its end, a scan returns the same rows; which rows one page
 *   holds differs. The tests that page a scan (`rekey`'s resume tokens) check what the pages hold
 *   together.
 * - Sizes: nothing is refused or cut for its size (an item over 400 KB, a key over its length, a
 *   transaction over 4 MB, an expression over its length), and a `Query` or `Scan` page is never
 *   cut at 1 MB. `RecordingTable`'s `refuseBodiesOver` refuses a request body over a given size,
 *   as DynamoDB Local refuses one over 16 MiB.
 * - Capacity: `ReturnConsumedCapacity` is accepted and nothing is reported.
 * - Several problems in one request: of one kind (two index keys of the wrong type, …) it is
 *   refused by name, as which DynamoDB Local reports first is unmeasured; of different kinds, the
 *   problem this module checks first is reported, in the order measured for the pairs the
 *   conformance rows send.
 * - An empty value of an attribute that keys several indexes is reported naming the first index
 *   declared; which one DynamoDB Local names is unmeasured.
 * - An item holding a top-level `__proto__` attribute, in an error (a failed condition's item, a
 *   cancellation reason's): the AWS SDK fails to read it (a `TypeError`); the tables return it as
 *   the SDK reads one in a successful answer.
 *
 * Refused by name, as not modelled: a request field `checkFields` doesn't list (a `Scan`'s
 * `IndexName` among them: the library sends none), a projection of a list element, an
 * `attribute_type` whose type is a path, a `Select` or `Limit` DynamoDB Local refuses in words
 * unmeasured, and each check marked "unmeasured" below.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"

export type Item = Record<string, AttributeValue>
type Segment = string | number
type Path = ReadonlyArray<Segment>

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** DynamoDB's `ValidationException`, as the AWS SDK throws it. */
export const validationException = (message: string): Error =>
  Object.assign(new Error(message), { name: "ValidationException" })

const refuse = (message: string): never => {
  throw validationException(message)
}

/**
 * Whether `error` is DynamoDB's refusal of the request, as opposed to a defect: a
 * `ValidationException`, or the `TransactionCanceledException` a `TransactGetItems` key check
 * fails with.
 */
export const isRefusal = (error: unknown): error is Error =>
  error instanceof Error &&
  (error.name === "ValidationException" || error.name === "TransactionCanceledException")

/** A request the in-memory tables don't read: a defect naming it, never an approximation. */
export class UnreadableRequest extends Error {
  override readonly name = "UnreadableRequest"
}

const unreadable = (what: string, text: string, detail: string): never => {
  throw new UnreadableRequest(
    `The in-memory table doesn't read ${what} ${JSON.stringify(text)}: ${detail}`,
  )
}

const shown = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v instanceof Uint8Array ? `<bytes ${Buffer.from(v).toString("hex")}>` : v,
  )

// Rejections of an update the item can't take, as DynamoDB Local words them. Each is a
// request-wide `ValidationException` (in a transaction too), checked once the condition passed.

/** An operand naming an attribute, map key or list element the item doesn't hold. */
export const DDB_UPDATE_MISSING_ATTRIBUTE =
  "The provided expression refers to an attribute that does not exist in the item"
/** A path below an attribute or map key the item doesn't hold, or below one that isn't a map or list. */
export const DDB_UPDATE_INVALID_PATH =
  "The document path provided in the update expression is invalid for update"
/** `+` / `-` on an operand that isn't a number, `list_append` on one that isn't a list, … */
export const DDB_UPDATE_OPERAND_TYPE =
  "An operand in the update expression has an incorrect data type"
/** A failed condition, standalone (`ConditionalCheckFailedException`) and as a cancellation reason. */
export const DDB_CONDITION_FAILED = "The conditional request failed"
/** Two operations on one item in a transaction (or `TransactGetItems`). */
export const DDB_REPEATED_ITEM =
  "Transaction request cannot include multiple operations on one item"
/** Two requests for one item in a `BatchWriteItem` / `BatchGetItem`. */
export const DDB_REPEATED_BATCH_ITEM = "Provided list of item keys contains duplicates"

const NUMBER_OVERFLOW =
  "Number overflow. Attempting to store a number with magnitude larger than supported range"
const NUMBER_UNDERFLOW =
  "Number underflow. Attempting to store a number with magnitude smaller than supported range"
const NUMBER_PRECISION = "DynamoDB only supports precision up to 38 digits"
const NOT_A_NUMBER = "A value provided cannot be converted into a number"

// ---------------------------------------------------------------------------
// Own properties: never a name `Object.prototype` supplies
// ---------------------------------------------------------------------------

/** `obj[key]` when `obj` holds `key` itself (`constructor`, `__proto__`, … are names like any other). */
export const own = <V>(obj: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(obj, key) ? obj[key] : undefined

/** Set `obj[key]` as an own property, `__proto__` included. */
export const setOwn = <V>(obj: Record<string, V>, key: string, value: V): void => {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true })
}

const clone = <A>(value: A): A => structuredClone(value)

/**
 * An item as the AWS SDK's client hands it back. Its reader keeps a top-level attribute named
 * `__proto__` as an own key with no value (`undefined`); in a map, such an attribute reads back
 * whole. Measured with `@aws-sdk/client-dynamodb` 3.1111.0 on DynamoDB Local, which stores the
 * attribute and evaluates conditions on it (`connected.helper-conformance.test.ts`). Every item
 * these tables return goes through this.
 */
export const asRead = (item: Item): Item => {
  const copy = clone(item)
  if (Object.hasOwn(copy, "__proto__")) {
    Object.defineProperty(copy, "__proto__", {
      value: undefined,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return copy
}

// ---------------------------------------------------------------------------
// Java's HashMap order: the order DynamoDB Local reports among several problems
// ---------------------------------------------------------------------------

const javaHash = (key: string | number): number => {
  if (typeof key === "number") return key
  let h = 0
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
  return h
}

/**
 * `keys` in the order a `java.util.HashMap` holding them (inserted in this order) iterates them:
 * by bucket, then by insertion. DynamoDB Local picks one of several problems in a request by this
 * order (measured: which of two refused actions an update reports, the order it lists unused
 * placeholders in, which invalid value it names).
 */
const javaHashOrder = <K extends string | number>(keys: ReadonlyArray<K>): Array<K> => {
  let capacity = 16
  while (keys.length > capacity * 0.75) capacity *= 2
  const bucket = (key: K) => {
    const h = javaHash(key)
    return (h ^ (h >>> 16)) & (capacity - 1)
  }
  return keys
    .map((key, at) => ({ key, at, bucket: bucket(key) }))
    .sort((a, b) => a.bucket - b.bucket || a.at - b.at)
    .map((each) => each.key)
}

// ---------------------------------------------------------------------------
// Numbers: exact, as Java's BigDecimal
// ---------------------------------------------------------------------------

/** A number as `unscaled × 10^-scale`. */
interface Decimal {
  readonly unscaled: bigint
  readonly scale: number
}

const NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

const parseDecimal = (text: string): Decimal | undefined => {
  const m = NUMBER.exec(text)
  if (m === null) return undefined
  const int = m[2] ?? ""
  const frac = m[3]
  if (int === "" && (frac === undefined || frac === "")) return undefined
  const digits = BigInt(`${int}${frac ?? ""}`)
  return {
    unscaled: m[1] === "-" ? -digits : digits,
    scale: (frac?.length ?? 0) - Number(m[4] ?? 0),
  }
}

const decimalOf = (text: string): Decimal =>
  parseDecimal(text) ?? unreadable("the number", text, "not a number DynamoDB stores")

const abs = (n: bigint) => (n < 0n ? -n : n)

const stripZeros = (d: Decimal): Decimal => {
  if (d.unscaled === 0n) return { unscaled: 0n, scale: 0 }
  let { unscaled, scale } = d
  while (unscaled % 10n === 0n) {
    unscaled /= 10n
    scale -= 1
  }
  return { unscaled, scale }
}

/** Why DynamoDB refuses to store this number, if it does. */
const numberProblem = (d: Decimal): string | undefined => {
  if (d.unscaled === 0n) return undefined
  const stripped = stripZeros(d)
  const digits = abs(stripped.unscaled).toString().length
  if (digits > 38) return NUMBER_PRECISION
  const exponent = digits - 1 - stripped.scale
  if (exponent >= 126) return NUMBER_OVERFLOW
  if (exponent < -130) return NUMBER_UNDERFLOW
  return undefined
}

const compareDecimals = (a: Decimal, b: Decimal): number => {
  const scale = Math.max(a.scale, b.scale)
  const x = a.unscaled * 10n ** BigInt(scale - a.scale)
  const y = b.unscaled * 10n ** BigInt(scale - b.scale)
  return x < y ? -1 : x > y ? 1 : 0
}

/** Order two DynamoDB numbers by value. */
export const compareNumbers = (a: string, b: string): number =>
  compareDecimals(decimalOf(a), decimalOf(b))

/** Java's `BigDecimal.toPlainString()`. */
const plainText = (d: Decimal): string => {
  if (d.unscaled === 0n && d.scale <= 0) return "0"
  const sign = d.unscaled < 0n ? "-" : ""
  const digits = abs(d.unscaled).toString()
  if (d.scale <= 0) return `${sign}${digits}${"0".repeat(-d.scale)}`
  const padded = digits.padStart(d.scale + 1, "0")
  const point = padded.length - d.scale
  return `${sign}${padded.slice(0, point)}.${padded.slice(point)}`
}

/** Java's `BigDecimal.toString()`: plain, or scientific when the scale is negative or the exponent below -6. */
const scientificText = (d: Decimal): string => {
  const coefficient = abs(d.unscaled).toString()
  const exponent = -d.scale + (coefficient.length - 1)
  if (d.scale >= 0 && exponent >= -6) return plainText(d)
  const sign = d.unscaled < 0n ? "-" : ""
  const mantissa =
    coefficient.length > 1 ? `${coefficient[0]}.${coefficient.slice(1)}` : coefficient
  return `${sign}${mantissa}E${exponent >= 0 ? "+" : ""}${exponent}`
}

/** `a + b` or `a - b` as DynamoDB Local computes and stores it, or its refusal. */
const arithmetic = (a: string, b: string, operator: "+" | "-"): string => {
  const [x, y] = [decimalOf(a), decimalOf(b)]
  const scale = Math.max(x.scale, y.scale)
  const left = x.unscaled * 10n ** BigInt(scale - x.scale)
  const right = y.unscaled * 10n ** BigInt(scale - y.scale)
  const sum = { unscaled: operator === "+" ? left + right : left - right, scale }
  const problem = numberProblem(sum)
  if (problem !== undefined) refuse(problem)
  return plainText(sum)
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const TYPES = ["S", "N", "B", "SS", "NS", "BS", "M", "L", "NULL", "BOOL"] as const

/** An attribute value's type, as DynamoDB names it (`S`, `N`, `SS`, `M`, …). */
export const typeOf = (value: AttributeValue): string => {
  for (const type of TYPES) {
    if ((value as unknown as Record<string, unknown>)[type] !== undefined) return type
  }
  return unreadable("the attribute value", shown(value), "it holds no type")
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/** Order bytes unsigned, as DynamoDB orders binary values. */
const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

/** Order strings by their UTF-8 bytes, as DynamoDB orders them. */
const compareStrings = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))

const sameMembers = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>, same: (x: A, y: A) => boolean) =>
  a.every((x) => b.some((y) => same(x, y))) && b.every((y) => a.some((x) => same(x, y)))

/**
 * Whether two attribute values are equal as DynamoDB compares them: by content. A map by its
 * keys and their values (in any order), a list by its elements in order, a set by its members
 * (in any order), a number by its value, bytes by bytes; values of different types are never
 * equal.
 */
export const sameValue = (a: AttributeValue, b: AttributeValue): boolean => {
  const type = typeOf(a)
  if (type !== typeOf(b)) return false
  switch (type) {
    case "S":
      return a.S === b.S
    case "N":
      return compareNumbers(a.N!, b.N!) === 0
    case "B":
      return sameBytes(a.B!, b.B!)
    case "BOOL":
      return a.BOOL === b.BOOL
    case "NULL":
      return true
    case "SS":
      return sameMembers(a.SS!, b.SS!, (x, y) => x === y)
    case "NS":
      return sameMembers(a.NS!, b.NS!, (x, y) => compareNumbers(x, y) === 0)
    case "BS":
      return sameMembers(a.BS!, b.BS!, sameBytes)
    case "L":
      return a.L!.length === b.L!.length && a.L!.every((x, i) => sameValue(x, b.L![i]!))
    default: {
      const [x, y] = [a.M!, b.M!]
      const keys = Object.keys(x)
      return (
        keys.length === Object.keys(y).length &&
        keys.every((k) => Object.hasOwn(y, k) && sameValue(x[k]!, y[k]!))
      )
    }
  }
}

/** Order two values of one type that `<` orders (N, S, B); `undefined` for any other pair. */
const order = (a: AttributeValue, b: AttributeValue): number | undefined => {
  const type = typeOf(a)
  if (type !== typeOf(b)) return undefined
  if (type === "N") return compareNumbers(a.N!, b.N!)
  if (type === "S") return compareStrings(a.S!, b.S!)
  if (type === "B") return compareBytes(a.B!, b.B!)
  return undefined
}

/** Order two key values as DynamoDB orders keys: numbers by value, strings by UTF-8, bytes unsigned. */
export const compareKeyValues = (a: AttributeValue, b: AttributeValue): number =>
  order(a, b) ?? unreadable("the key values", shown([a, b]), "not of one key type")

/**
 * A key as an identity: the table, then each key attribute's type and value. Two keys name one
 * item exactly when their identities are equal. Every key these tables take is an `S`
 * ({@link checkKey}); any other is a defect here, as DynamoDB doesn't compare every kind of key
 * alike (on DynamoDB Local, `BatchGetItem` takes the number keys `1` and `1.0` as two keys where
 * `BatchWriteItem` and both transactions take them as one item).
 */
export const keyIdentity = (table: string, key: Item, attributes: ReadonlyArray<string>): string =>
  JSON.stringify([
    table,
    ...attributes.map((name) => {
      const value = own(key, name)
      if (value === undefined) return null
      if (typeOf(value) === "S") return ["S", value.S]
      return unreadable("the key", shown(key), `${name} is not a string`)
    }),
  ])

const SET_EMPTY: Record<string, string> = {
  SS: "One or more parameter values were invalid: An string set  may not be empty",
  NS: "One or more parameter values were invalid: An number set  may not be empty",
  BS: "One or more parameter values were invalid: Binary sets should not be empty",
}

/** Why DynamoDB refuses to store `value`, if it does (a number it can't store, an empty or repeating set). */
export const valueProblem = (value: AttributeValue): string | undefined => {
  const type = typeOf(value)
  switch (type) {
    case "N": {
      const d = parseDecimal(value.N!)
      return d === undefined ? NOT_A_NUMBER : numberProblem(d)
    }
    case "SS": {
      const members = value.SS!
      if (members.length === 0) return SET_EMPTY.SS
      if (new Set(members).size !== members.length) {
        return `One or more parameter values were invalid: Input collection [${members.join(", ")}] contains duplicates`
      }
      return undefined
    }
    case "NS": {
      const members = value.NS!
      if (members.length === 0) return SET_EMPTY.NS
      for (const member of members) {
        const d = parseDecimal(member)
        const problem = d === undefined ? NOT_A_NUMBER : numberProblem(d)
        if (problem !== undefined) return problem
      }
      if (members.some((x, i) => members.some((y, j) => j > i && compareNumbers(x, y) === 0))) {
        return "Input collection contains duplicates"
      }
      return undefined
    }
    case "BS": {
      const members = value.BS!
      if (members.length === 0) return SET_EMPTY.BS
      if (members.some((x, i) => members.some((y, j) => j > i && sameBytes(x, y)))) {
        return "One or more parameter values were invalid: Input collection of type BS contains duplicates."
      }
      return undefined
    }
    case "L":
      for (const element of value.L!) {
        const problem = valueProblem(element)
        if (problem !== undefined) return problem
      }
      return undefined
    case "M":
      for (const key of Object.keys(value.M!)) {
        const problem = valueProblem(value.M![key]!)
        if (problem !== undefined) return problem
      }
      return undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const pathText = (path: Path) =>
  `[${path.map((s) => (typeof s === "number" ? `[${s}]` : s)).join(", ")}]`

/** The value at `path`, or `undefined` when the item doesn't hold it. */
export const readPath = (root: Item | undefined, path: Path): AttributeValue | undefined => {
  let value: AttributeValue | undefined
  for (const [at, segment] of path.entries()) {
    if (at === 0) {
      value = root === undefined ? undefined : own(root, segment as string)
    } else if (typeof segment === "number") {
      value = value?.L === undefined ? undefined : value.L[segment]
    } else {
      value = value?.M === undefined ? undefined : own(value.M, segment)
    }
    if (value === undefined) return undefined
  }
  return value
}

type Container = Item | Array<AttributeValue>

/** The map or list holding `path`'s last segment, or `undefined` when the item has no such container. */
const containerOf = (root: Item, path: Path): Container | undefined => {
  if (path.length === 1) return root
  const parent = readPath(root, path.slice(0, -1))
  return typeof path[path.length - 1] === "number" ? parent?.L : parent?.M
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind = "name" | "value" | "word" | "int" | "op"
interface Token {
  readonly kind: TokenKind
  readonly text: string
  readonly start: number
  readonly end: number
}

const TOKEN =
  /\s*(?:(#[A-Za-z0-9_]+)|(:[A-Za-z0-9_]+)|([A-Za-z_][A-Za-z0-9_]*)|(\d+)|(<>|<=|>=|[=<>(),.[\]+-]))/y

const tokenize = (kind: string, expression: string): Array<Token> => {
  const tokens: Array<Token> = []
  TOKEN.lastIndex = 0
  for (;;) {
    const at = TOKEN.lastIndex
    if (expression.slice(at).trim() === "") return tokens
    const m = TOKEN.exec(expression)
    if (m === null) {
      return unreadable(`the ${kind}Expression`, expression, `nothing it reads at ${at}`)
    }
    const text = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]!
    const tokenKind: TokenKind =
      m[1] !== undefined
        ? "name"
        : m[2] !== undefined
          ? "value"
          : m[3] !== undefined
            ? "word"
            : m[4] !== undefined
              ? "int"
              : "op"
    tokens.push({
      kind: tokenKind,
      text,
      start: TOKEN.lastIndex - text.length,
      end: TOKEN.lastIndex,
    })
  }
}

/**
 * DynamoDB's reserved words, which an expression can't use as a bare attribute name: AWS's published
 * list, less `CONVERT` and `SIZE`, which DynamoDB Local reads as names.
 */
const RESERVED = new Set(
  (
    "ABORT ABSOLUTE ACTION ADD AFTER AGENT AGGREGATE ALL ALLOCATE ALTER ANALYZE AND ANY ARCHIVE " +
    "ARE ARRAY AS ASC ASCII ASENSITIVE ASSERTION ASYMMETRIC AT ATOMIC ATTACH ATTRIBUTE AUTH " +
    "AUTHORIZATION AUTHORIZE AUTO AVG BACK BACKUP BASE BATCH BEFORE BEGIN BETWEEN BIGINT BINARY " +
    "BIT BLOB BLOCK BOOLEAN BOTH BREADTH BUCKET BULK BY BYTE CALL CALLED CALLING CAPACITY CASCADE " +
    "CASCADED CASE CAST CATALOG CHAR CHARACTER CHECK CLASS CLOB CLOSE CLUSTER CLUSTERED CLUSTERING " +
    "CLUSTERS COALESCE COLLATE COLLATION COLLECTION COLUMN COLUMNS COMBINE COMMENT COMMIT COMPACT " +
    "COMPILE COMPRESS CONDITION CONFLICT CONNECT CONNECTION CONSISTENCY CONSISTENT CONSTRAINT " +
    "CONSTRAINTS CONSTRUCTOR CONSUMED CONTINUE COPY CORRESPONDING COUNT COUNTER CREATE " +
    "CROSS CUBE CURRENT CURSOR CYCLE DATA DATABASE DATE DATETIME DAY DEALLOCATE DEC DECIMAL " +
    "DECLARE DEFAULT DEFERRABLE DEFERRED DEFINE DEFINED DEFINITION DELETE DELIMITED DEPTH DEREF " +
    "DESC DESCRIBE DESCRIPTOR DETACH DETERMINISTIC DIAGNOSTICS DIRECTORIES DISABLE DISCONNECT " +
    "DISTINCT DISTRIBUTE DO DOMAIN DOUBLE DROP DUMP DURATION DYNAMIC EACH ELEMENT ELSE ELSEIF " +
    "EMPTY ENABLE END EQUAL EQUALS ERROR ESCAPE ESCAPED EVAL EVALUATE EXCEEDED EXCEPT EXCEPTION " +
    "EXCEPTIONS EXCLUSIVE EXEC EXECUTE EXISTS EXIT EXPLAIN EXPLODE EXPORT EXPRESSION EXTENDED " +
    "EXTERNAL EXTRACT FAIL FALSE FAMILY FETCH FIELDS FILE FILTER FILTERING FINAL FINISH FIRST " +
    "FIXED FLATTERN FLOAT FOR FORCE FOREIGN FORMAT FORWARD FOUND FREE FROM FULL FUNCTION FUNCTIONS " +
    "GENERAL GENERATE GET GLOB GLOBAL GO GOTO GRANT GREATER GROUP GROUPING HANDLER HASH HAVE " +
    "HAVING HEAP HIDDEN HOLD HOUR IDENTIFIED IDENTITY IF IGNORE IMMEDIATE IMPORT IN INCLUDING " +
    "INCLUSIVE INCREMENT INCREMENTAL INDEX INDEXED INDEXES INDICATOR INFINITE INITIALLY INLINE " +
    "INNER INNTER INOUT INPUT INSENSITIVE INSERT INSTEAD INT INTEGER INTERSECT INTERVAL INTO " +
    "INVALIDATE IS ISOLATION ITEM ITEMS ITERATE JOIN KEY KEYS LAG LANGUAGE LARGE LAST LATERAL " +
    "LEAD LEADING LEAVE LEFT LENGTH LESS LEVEL LIKE LIMIT LIMITED LINES LIST LOAD LOCAL LOCALTIME " +
    "LOCALTIMESTAMP LOCATION LOCATOR LOCK LOCKS LOG LOGED LONG LOOP LOWER MAP MATCH MATERIALIZED " +
    "MAX MAXLEN MEMBER MERGE METHOD METRICS MIN MINUS MINUTE MISSING MOD MODE MODIFIES MODIFY " +
    "MODULE MONTH MULTI MULTISET NAME NAMES NATIONAL NATURAL NCHAR NCLOB NEW NEXT NO NONE NOT " +
    "NULL NULLIF NUMBER NUMERIC OBJECT OF OFFLINE OFFSET OLD ON ONLINE ONLY OPAQUE OPEN OPERATOR " +
    "OPTION OR ORDER ORDINALITY OTHER OTHERS OUT OUTER OUTPUT OVER OVERLAPS OVERRIDE OWNER PAD " +
    "PARALLEL PARAMETER PARAMETERS PARTIAL PARTITION PARTITIONED PARTITIONS PATH PERCENT " +
    "PERCENTILE PERMISSION PERMISSIONS PIPE PIPELINED PLAN POOL POSITION PRECISION PREPARE " +
    "PRESERVE PRIMARY PRIOR PRIVATE PRIVILEGES PROCEDURE PROCESSED PROJECT PROJECTION PROPERTY " +
    "PROVISIONING PUBLIC PUT QUERY QUIT QUORUM RAISE RANDOM RANGE RANK RAW READ READS REAL " +
    "REBUILD RECORD RECURSIVE REDUCE REF REFERENCE REFERENCES REFERENCING REGEXP REGION REINDEX " +
    "RELATIVE RELEASE REMAINDER RENAME REPEAT REPLACE REQUEST RESET RESIGNAL RESOURCE RESPONSE " +
    "RESTORE RESTRICT RESULT RETURN RETURNING RETURNS REVERSE REVOKE RIGHT ROLE ROLES ROLLBACK " +
    "ROLLUP ROUTINE ROW ROWS RULE RULES SAMPLE SATISFIES SAVE SAVEPOINT SCAN SCHEMA SCOPE SCROLL " +
    "SEARCH SECOND SECTION SEGMENT SEGMENTS SELECT SELF SEMI SENSITIVE SEPARATE SEQUENCE " +
    "SERIALIZABLE SESSION SET SETS SHARD SHARE SHARED SHORT SHOW SIGNAL SIMILAR SKEWED " +
    "SMALLINT SNAPSHOT SOME SOURCE SPACE SPACES SPARSE SPECIFIC SPECIFICTYPE SPLIT SQL SQLCODE " +
    "SQLERROR SQLEXCEPTION SQLSTATE SQLWARNING START STATE STATIC STATUS STORAGE STORE STORED " +
    "STREAM STRING STRUCT STYLE SUB SUBMULTISET SUBPARTITION SUBSTRING SUBTYPE SUM SUPER " +
    "SYMMETRIC SYNONYM SYSTEM TABLE TABLESAMPLE TEMP TEMPORARY TERMINATED TEXT THAN THEN " +
    "THROUGHPUT TIME TIMESTAMP TIMEZONE TINYINT TO TOKEN TOTAL TOUCH TRAILING TRANSACTION " +
    "TRANSFORM TRANSLATE TRANSLATION TREAT TRIGGER TRIM TRUE TRUNCATE TTL TUPLE TYPE UNDER UNDO " +
    "UNION UNIQUE UNIT UNKNOWN UNLOGGED UNNEST UNPROCESSED UNSIGNED UNTIL UPDATE UPPER URL USAGE " +
    "USE USER USERS USING UUID VACUUM VALUE VALUED VALUES VARCHAR VARIABLE VARIANCE VARINT " +
    "VARYING VIEW VIEWS VIRTUAL VOID WAIT WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT " +
    "WORK WRAPPED WRITE YEAR ZONE"
  ).split(" "),
)

/**
 * The expression grammar's own words: DynamoDB Local reads one where a name should be as a syntax
 * error, not as a reserved word.
 */
const KEYWORDS = new Set(["ADD", "AND", "BETWEEN", "DELETE", "IN", "NOT", "OR", "REMOVE", "SET"])

/** The words the tables refuse as a bare name, which the conformance suite checks against DynamoDB Local. */
export const reservedWords: ReadonlyArray<string> = [...new Set([...RESERVED, ...KEYWORDS])]

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** The placeholders a request defines, and those its expressions use. */
interface Placeholders {
  readonly names: Readonly<Record<string, string>>
  readonly values: Readonly<Record<string, AttributeValue>>
  readonly usedNames: Set<string>
  readonly usedValues: Set<string>
}

const placeholdersOf = (
  names: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, AttributeValue>> | undefined,
): Placeholders => ({
  names: names ?? {},
  values: values ?? {},
  usedNames: new Set(),
  usedValues: new Set(),
})

/** A value placeholder; `value` is `undefined` while a placeholder the request doesn't define is reported later. */
interface ValueNode {
  readonly kind: "value"
  readonly name: string
  readonly value: AttributeValue | undefined
}

type Operand =
  | { readonly kind: "path"; readonly path: Path }
  | ValueNode
  | { readonly kind: "size"; readonly path: Path }

type Condition =
  | { readonly kind: "and" | "or"; readonly left: Condition; readonly right: Condition }
  | { readonly kind: "not"; readonly inner: Condition }
  | {
      readonly kind: "compare"
      readonly op: string
      readonly left: Operand
      readonly right: Operand
    }
  | {
      readonly kind: "between"
      readonly subject: Operand
      readonly low: Operand
      readonly high: Operand
    }
  | { readonly kind: "in"; readonly subject: Operand; readonly options: ReadonlyArray<Operand> }
  | { readonly kind: "exists"; readonly negate: boolean; readonly path: Path }
  | { readonly kind: "type"; readonly path: Path; readonly type: string }
  | {
      readonly kind: "begins_with" | "contains"
      readonly subject: Operand
      readonly operand: Operand
    }

type UpdateValue =
  | { readonly kind: "path"; readonly path: Path }
  | ValueNode
  | { readonly kind: "if_not_exists"; readonly path: Path; readonly fallback: UpdateValue }
  | { readonly kind: "list_append"; readonly first: UpdateValue; readonly second: UpdateValue }
  | {
      readonly kind: "arithmetic"
      readonly op: "+" | "-"
      readonly left: UpdateValue
      readonly right: UpdateValue
    }

type Action =
  | { readonly kind: "SET"; readonly path: Path; readonly value: UpdateValue }
  | { readonly kind: "REMOVE"; readonly path: Path }
  | { readonly kind: "ADD" | "DELETE"; readonly path: Path; readonly value: ValueNode }

/** A recursive-descent reader over one expression's tokens. */
class Reader {
  readonly tokens: Array<Token>
  at = 0
  constructor(
    readonly kind: string,
    readonly expression: string,
    readonly placeholders: Placeholders,
    /** Leave a value placeholder the request doesn't define for a later check, rather than refuse it now. */
    readonly deferUndefinedValues = false,
  ) {
    this.tokens = tokenize(kind, expression)
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset]
  }

  /** Whether the next token is `text` (a keyword, compared without case). */
  is(text: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token !== undefined && token.text.toUpperCase() === text.toUpperCase()
  }

  /** DynamoDB's syntax error at the current token. */
  syntaxError(): never {
    const token = this.peek()
    const previous = this.tokens[this.at - 1]
    const next = this.tokens[this.at + 1]
    const from = previous?.start ?? token?.start ?? 0
    const to = token === undefined ? this.expression.length : (next ?? token).end
    return refuse(
      `Invalid ${this.kind}Expression: Syntax error; token: "${token?.text ?? "<EOF>"}", near: "${this.expression.slice(from, to)}"`,
    )
  }

  take(): Token {
    const token = this.peek()
    if (token === undefined) return this.syntaxError()
    this.at++
    return token
  }

  expect(text: string): void {
    if (!this.is(text)) this.syntaxError()
    this.at++
  }

  done(): void {
    if (this.peek() !== undefined) this.syntaxError()
  }

  invalid(message: string): never {
    return refuse(`Invalid ${this.kind}Expression: ${message}`)
  }

  /** A placeholder's or bare word's attribute name. */
  attributeName(token: Token): string {
    if (token.kind === "name") {
      const name = own(this.placeholders.names, token.text)
      if (name === undefined) {
        return this.invalid(
          `An expression attribute name used in the document path is not defined; attribute name: ${token.text}`,
        )
      }
      this.placeholders.usedNames.add(token.text)
      return name
    }
    if (token.kind === "word") {
      const upper = token.text.toUpperCase()
      if (KEYWORDS.has(upper)) {
        this.at--
        return this.syntaxError()
      }
      if (RESERVED.has(upper)) {
        this.invalid(`Attribute name is a reserved keyword; reserved keyword: ${token.text}`)
      }
      return token.text
    }
    this.at--
    return this.syntaxError()
  }

  valueNode(token: Token): ValueNode {
    const value = own(this.placeholders.values, token.text)
    if (value === undefined && !this.deferUndefinedValues) this.invalid(undefinedValue(token.text))
    this.placeholders.usedValues.add(token.text)
    return { kind: "value", name: token.text, value }
  }

  /** Whether a path starts here: a placeholder name, or a word that isn't a function call. */
  atPath(): boolean {
    const token = this.peek()
    if (token === undefined) return false
    if (token.kind === "name") return true
    return token.kind === "word" && !this.is("(", 1)
  }

  path(): Path {
    const segments: Array<Segment> = [this.attributeName(this.take())]
    for (;;) {
      if (this.is("[")) {
        this.at++
        const index = this.take()
        if (index.kind !== "int") {
          this.at--
          this.syntaxError()
        }
        segments.push(Number(index.text))
        this.expect("]")
      } else if (this.is(".")) {
        this.at++
        segments.push(this.attributeName(this.take()))
      } else {
        return segments
      }
    }
  }
}

const undefinedValue = (name: string) =>
  `An expression attribute value used in expression is not defined; attribute value: ${name}`

// --- conditions -------------------------------------------------------------

const COMPARATORS = new Set(["=", "<>", "<", "<=", ">", ">="])
const ORDERED_TYPES = new Set(["N", "S", "B"])
const FUNCTIONS = new Set([
  "attribute_exists",
  "attribute_not_exists",
  "attribute_type",
  "begins_with",
  "contains",
  "size",
])
const TYPE_NAMES = ["N", "BS", "L", "B", "NULL", "M", "S", "SS", "NS", "BOOL"]

const samePath = (a: Path, b: Path) => a.length === b.length && a.every((s, i) => s === b[i])

const literal = (operand: Operand | UpdateValue): AttributeValue | undefined =>
  operand.kind === "value" ? operand.value : undefined

class ConditionReader extends Reader {
  condition(): Condition {
    const result = this.or()
    this.done()
    return result
  }

  or(): Condition {
    let left = this.and()
    while (this.is("OR")) {
      this.at++
      left = { kind: "or", left, right: this.and() }
    }
    return left
  }

  and(): Condition {
    let left = this.not()
    while (this.is("AND")) {
      this.at++
      left = { kind: "and", left, right: this.not() }
    }
    return left
  }

  not(): Condition {
    if (this.is("NOT")) {
      this.at++
      return { kind: "not", inner: this.not() }
    }
    return this.primary()
  }

  primary(): Condition {
    if (this.is("(")) {
      if (this.is("(", 1) && this.closes(this.at + 1) + 1 === this.closes(this.at)) {
        this.invalid("The expression has redundant parentheses;")
      }
      this.at++
      const inner = this.or()
      this.expect(")")
      return inner
    }
    const token = this.peek()
    if (token?.kind === "word" && this.is("(", 1) && token.text !== "size") {
      if (!FUNCTIONS.has(token.text)) this.invalid(`Invalid function name; function: ${token.text}`)
      return this.function(token.text)
    }
    const subject = this.operand()
    if (this.is("BETWEEN")) {
      this.at++
      const low = this.operand()
      this.expect("AND")
      const high = this.operand()
      return this.between(subject, low, high)
    }
    if (this.is("IN")) {
      this.at++
      this.expect("(")
      const options = [this.operand()]
      while (this.is(",")) {
        this.at++
        options.push(this.operand())
      }
      this.expect(")")
      if (options.length > 100) {
        this.invalid(
          `The IN operator is provided with too many operands; number of operands: ${options.length}`,
        )
      }
      this.distinct("IN", subject, options)
      return { kind: "in", subject, options }
    }
    const op = this.peek()
    if (op === undefined || !COMPARATORS.has(op.text)) {
      if (subject.kind === "size") {
        this.invalid(
          "The function is not allowed to be used this way in an expression; function: size",
        )
      }
      return this.syntaxError()
    }
    this.at++
    const right = this.operand()
    if (op.text !== "=" && op.text !== "<>") {
      for (const side of [subject, right]) this.orderable(op.text, side)
    }
    this.distinct(op.text, subject, [right])
    return { kind: "compare", op: op.text, left: subject, right }
  }

  /** The index of the `)` closing the `(` at `open`. */
  closes(open: number): number {
    let depth = 0
    for (let at = open; at < this.tokens.length; at++) {
      if (this.tokens[at]!.text === "(") depth++
      if (this.tokens[at]!.text === ")" && --depth === 0) return at
    }
    return -1
  }

  /** `<`, `<=`, `>`, `>=` and `BETWEEN` refuse a literal operand they can't order. */
  orderable(op: string, side: Operand): void {
    const value = literal(side)
    if (value !== undefined && !ORDERED_TYPES.has(typeOf(value))) {
      this.invalid(
        `Incorrect operand type for operator or function; operator or function: ${op}, operand type: ${typeOf(value)}`,
      )
    }
  }

  distinct(op: string, first: Operand, rest: ReadonlyArray<Operand>): void {
    if (first.kind !== "path") return
    if (rest.some((other) => other.kind === "path" && samePath(other.path, first.path))) {
      this.invalid(
        `The first operand must be distinct from the remaining operands for this operator or function; operator: ${op}, first operand: ${pathText(first.path)}`,
      )
    }
  }

  between(subject: Operand, low: Operand, high: Operand): Condition {
    for (const side of [subject, low, high]) this.orderable("BETWEEN", side)
    this.distinct("BETWEEN", subject, [low, high])
    const [a, b] = [literal(low), literal(high)]
    if (a !== undefined && b !== undefined) {
      const bounds = () => {
        const text = (v: AttributeValue) =>
          v.B !== undefined
            ? unreadable(
                `the ${this.kind}Expression`,
                this.expression,
                "a refused BETWEEN on bytes (unmeasured wording)",
              )
            : `AttributeValue: {${typeOf(v)}:${v.N ?? v.S}}`
        return `lower bound operand: ${text(a)}, upper bound operand: ${text(b)}`
      }
      if (typeOf(a) !== typeOf(b)) {
        this.invalid(
          `The BETWEEN operator requires same data type for lower and upper bounds; ${bounds()}`,
        )
      }
      if (order(a, b)! > 0) {
        this.invalid(
          `The BETWEEN operator requires upper bound to be greater than or equal to lower bound; ${bounds()}`,
        )
      }
    }
    return { kind: "between", subject, low, high }
  }

  arguments(name: string): Array<Operand> {
    this.expect("(")
    const args = [this.operand()]
    while (this.is(",")) {
      this.at++
      args.push(this.operand())
    }
    this.expect(")")
    const wanted = ["attribute_exists", "attribute_not_exists", "size"].includes(name) ? 1 : 2
    if (args.length !== wanted) {
      this.invalid(
        `Incorrect number of operands for operator or function; operator or function: ${name}, number of operands: ${args.length}`,
      )
    }
    return args
  }

  pathArgument(name: string, operand: Operand): Path {
    if (operand.kind !== "path") {
      return this.invalid(
        `Operator or function requires a document path; operator or function: ${name}`,
      )
    }
    return operand.path
  }

  function(name: string): Condition {
    this.at++
    const args = this.arguments(name)
    switch (name) {
      case "attribute_exists":
      case "attribute_not_exists":
        return {
          kind: "exists",
          negate: name === "attribute_not_exists",
          path: this.pathArgument(name, args[0]!),
        }
      case "attribute_type": {
        const path = this.pathArgument(name, args[0]!)
        const type = literal(args[1]!)
        if (type?.S === undefined) {
          return type === undefined
            ? unreadable(`the ${this.kind}Expression`, this.expression, "attribute_type of a path")
            : this.invalid(
                `Incorrect operand type for operator or function; operator or function: attribute_type, operand type: ${typeOf(type)}`,
              )
        }
        if (!TYPE_NAMES.includes(type.S)) {
          this.invalid(
            `Invalid attribute type name found; type: ${type.S}, valid types: {${TYPE_NAMES.join(",")}}`,
          )
        }
        return { kind: "type", path, type: type.S }
      }
      default: {
        const [subject, operand] = args as [Operand, Operand]
        if (name === "begins_with") {
          for (const side of [subject, operand]) {
            const value = literal(side)
            if (value !== undefined && value.S === undefined && value.B === undefined) {
              this.invalid(
                `Incorrect operand type for operator or function; operator or function: begins_with, operand type: ${typeOf(value)}`,
              )
            }
          }
        }
        return { kind: name as "begins_with" | "contains", subject, operand }
      }
    }
  }

  operand(): Operand {
    const token = this.peek()
    if (token === undefined) return this.syntaxError()
    if (token.kind === "value") {
      this.at++
      return this.valueNode(token)
    }
    if (token.kind === "word" && this.is("(", 1)) {
      if (token.text !== "size") {
        if (!FUNCTIONS.has(token.text))
          this.invalid(`Invalid function name; function: ${token.text}`)
        return unreadable(
          `the ${this.kind}Expression`,
          this.expression,
          `${token.text}() as an operand`,
        )
      }
      this.at++
      const [arg] = this.arguments("size")
      return { kind: "size", path: this.pathArgument("size", arg!) }
    }
    if (this.atPath()) return { kind: "path", path: this.path() }
    return this.syntaxError()
  }
}

// --- update expressions -----------------------------------------------------

const OPERAND_TYPE_NAMES: Record<string, string> = {
  S: "STRING",
  N: "NUMBER",
  B: "BINARY",
  BOOL: "BOOLEAN",
  NULL: "NULL",
  L: "LIST",
  M: "MAP",
}

class UpdateReader extends Reader {
  constructor(expression: string, placeholders: Placeholders) {
    super("Update", expression, placeholders, true)
  }

  update(): ReadonlyArray<Action> {
    const actions: Array<Action> = []
    const seen = new Set<string>()
    while (this.peek() !== undefined) {
      const section = this.take().text.toUpperCase()
      if (!["SET", "REMOVE", "ADD", "DELETE"].includes(section)) {
        this.at--
        this.syntaxError()
      }
      if (seen.has(section)) {
        this.invalid(`The "${section}" section can only be used once in an update expression;`)
      }
      seen.add(section)
      for (;;) {
        actions.push(this.action(section))
        if (!this.is(",")) break
        this.at++
      }
    }
    if (actions.length === 0) this.syntaxError()
    return actions
  }

  action(section: string): Action {
    const path = this.path()
    if (section === "REMOVE") return { kind: "REMOVE", path }
    if (section === "SET") {
      this.expect("=")
      return { kind: "SET", path, value: this.value() }
    }
    const token = this.take()
    if (token.kind !== "value") {
      this.at--
      this.syntaxError()
    }
    return { kind: section as "ADD" | "DELETE", path, value: this.valueNode(token) }
  }

  value(): UpdateValue {
    const left = this.term()
    if (this.is("+") || this.is("-")) {
      const op = this.take().text as "+" | "-"
      return { kind: "arithmetic", op, left, right: this.term() }
    }
    return left
  }

  term(): UpdateValue {
    if (this.is("(")) {
      this.at++
      const inner = this.value()
      this.expect(")")
      return inner
    }
    const token = this.peek()
    if (token === undefined) return this.syntaxError()
    if (token.kind === "value") {
      this.at++
      return this.valueNode(token)
    }
    if (token.kind === "word" && this.is("(", 1)) {
      const name = token.text
      if (name !== "if_not_exists" && name !== "list_append") {
        return FUNCTIONS.has(name)
          ? this.invalid(`The function is not allowed in an update expression; function: ${name}`)
          : this.invalid(`Invalid function name; function: ${name}`)
      }
      this.at += 2
      const first = this.value()
      this.expect(",")
      const second = this.value()
      this.expect(")")
      if (name === "list_append") return { kind: "list_append", first, second }
      if (first.kind !== "path") {
        return this.invalid(
          "Operator or function requires a document path; operator or function: if_not_exists",
        )
      }
      return { kind: "if_not_exists", path: first.path, fallback: second }
    }
    if (this.atPath()) return { kind: "path", path: this.path() }
    return this.syntaxError()
  }
}

/** The first problem DynamoDB finds in one action before reading the item (an undefined value, a literal of the wrong type). */
const actionProblem = (action: Action): string | undefined => {
  const operandType = (op: string, value: AttributeValue) =>
    `Invalid UpdateExpression: Incorrect operand type for operator or function; operator or function: ${op}, operand type: ${typeOf(value)}`
  const walk = (value: UpdateValue): string | undefined => {
    switch (value.kind) {
      case "value":
        return value.value === undefined
          ? `Invalid UpdateExpression: ${undefinedValue(value.name)}`
          : undefined
      case "path":
        return undefined
      case "if_not_exists":
        return walk(value.fallback)
      case "list_append":
      case "arithmetic": {
        const [op, sides, wanted] =
          value.kind === "list_append"
            ? (["list_append", [value.first, value.second], "L"] as const)
            : ([value.op, [value.left, value.right], "N"] as const)
        for (const side of sides) {
          const problem = walk(side)
          if (problem !== undefined) return problem
          const given = literal(side)
          if (given !== undefined && typeOf(given) !== wanted) return operandType(op, given)
        }
        return undefined
      }
    }
  }
  switch (action.kind) {
    case "REMOVE":
      return undefined
    case "SET":
      return walk(action.value)
    default: {
      const given = action.value.value
      if (given === undefined)
        return `Invalid UpdateExpression: ${undefinedValue(action.value.name)}`
      const type = typeOf(given)
      const allowed = action.kind === "ADD" ? ["N", "SS", "NS", "BS"] : ["SS", "NS", "BS"]
      return allowed.includes(type)
        ? undefined
        : `Invalid UpdateExpression: Incorrect operand type for operator or function; operator: ${action.kind}, operand type: ${OPERAND_TYPE_NAMES[type] ?? type}, typeSet: ALLOWED_FOR_${action.kind}_OPERAND`
    }
  }
}

/** Two of an update's paths that overlap (one holds the other) or conflict (a name and an index at one place). */
const checkOverlaps = (kind: string, paths: ReadonlyArray<Path>): void => {
  for (const [i, one] of paths.entries()) {
    for (const two of paths.slice(i + 1)) {
      const n = Math.min(one.length, two.length)
      let at = 0
      while (at < n && one[at] === two[at]) at++
      const clash =
        at === n ? "overlap" : typeof one[at] !== typeof two[at] ? "conflict" : undefined
      if (clash !== undefined) {
        refuse(
          `Invalid ${kind}Expression: Two document paths ${clash} with each other; must remove or rewrite one of these paths; path one: ${pathText(one)}, path two: ${pathText(two)}`,
        )
      }
    }
  }
}

/**
 * The actions in the order DynamoDB Local visits them: a tree of the actions' paths, each level a
 * `HashMap` by segment, walked in that map's order. Of several refused actions it reports the
 * last one it visits (measured: `SET #a = #s + :n, #c = #zz + :n` reports `#zz` missing, and so
 * does `SET #c = #zz + :n, #a = #s + :n`).
 */
const visitOrder = (actions: ReadonlyArray<Action>): ReadonlyArray<Action> => {
  type Node = { readonly children: Map<Segment, Node>; action?: Action }
  const root: Node = { children: new Map() }
  for (const action of actions) {
    let node = root
    for (const segment of action.path) {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
    node.action = action
  }
  const ordered: Array<Action> = []
  const walk = (node: Node) => {
    for (const segment of javaHashOrder([...node.children.keys()])) {
      const child = node.children.get(segment)!
      if (child.action !== undefined) ordered.push(child.action)
      walk(child)
    }
  }
  walk(root)
  return ordered
}

/** Read an update expression: its actions, refused as DynamoDB refuses them before reading the item. */
const readUpdate = (expression: string, placeholders: Placeholders): ReadonlyArray<Action> => {
  const actions = new UpdateReader(expression, placeholders).update()
  checkOverlaps(
    "Update",
    actions.map((action) => action.path),
  )
  let problem: string | undefined
  for (const action of visitOrder(actions)) problem = actionProblem(action) ?? problem
  if (problem !== undefined) refuse(problem)
  return actions
}

// ---------------------------------------------------------------------------
// A request's expressions
// ---------------------------------------------------------------------------

/** What a request's expressions say, read and checked as DynamoDB checks them before reading the item. */
export interface Expressions {
  readonly condition?: Condition | undefined
  readonly filter?: Condition | undefined
  readonly keyCondition?: Condition | undefined
  readonly update?: ReadonlyArray<Action> | undefined
  readonly projection?: ReadonlyArray<Path> | undefined
}

export interface ExpressionInput {
  readonly ConditionExpression?: string | undefined
  readonly FilterExpression?: string | undefined
  readonly KeyConditionExpression?: string | undefined
  readonly UpdateExpression?: string | undefined
  readonly ProjectionExpression?: string | undefined
  readonly ExpressionAttributeNames?: Record<string, string> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
}

/**
 * Read and check a request's expressions as DynamoDB does before it reads the item: the
 * placeholder maps, each value's content, each expression's syntax and operand types, and that
 * every placeholder defined is used. Throws DynamoDB Local's `ValidationException`, or
 * {@link UnreadableRequest} for an expression this doesn't read.
 */
export const readExpressions = (input: ExpressionInput): Expressions => {
  const names = input.ExpressionAttributeNames
  const values = input.ExpressionAttributeValues
  if (names !== undefined && Object.keys(names).length === 0) {
    refuse("ExpressionAttributeNames must not be empty")
  }
  if (values !== undefined && Object.keys(values).length === 0) {
    refuse("ExpressionAttributeValues must not be empty")
  }
  const expressions = [
    input.UpdateExpression,
    input.ConditionExpression,
    input.KeyConditionExpression,
    input.FilterExpression,
    input.ProjectionExpression,
  ]
  if (expressions.every((e) => e === undefined)) {
    if (names !== undefined) {
      refuse("ExpressionAttributeNames can only be specified when using expressions")
    }
    if (values !== undefined) {
      refuse("ExpressionAttributeValues can only be specified when using expressions")
    }
  }
  for (const key of javaHashOrder(Object.keys(values ?? {}))) {
    const problem = valueProblem(values![key]!)
    if (problem !== undefined) {
      refuse(`ExpressionAttributeValues contains invalid value: ${problem} for key ${key}`)
    }
  }
  const placeholders = placeholdersOf(names, values)
  const read = (kind: string, expression: string | undefined) =>
    expression === undefined
      ? undefined
      : new ConditionReader(kind, expression, placeholders).condition()
  const update =
    input.UpdateExpression === undefined
      ? undefined
      : readUpdate(input.UpdateExpression, placeholders)
  const condition = read("Condition", input.ConditionExpression)
  const keyCondition = read("KeyCondition", input.KeyConditionExpression)
  const filter = read("Filter", input.FilterExpression)
  let projection: Array<Path> | undefined
  if (input.ProjectionExpression !== undefined) {
    const reader = new Reader("Projection", input.ProjectionExpression, placeholders)
    projection = [reader.path()]
    while (reader.is(",")) {
      reader.at++
      projection.push(reader.path())
    }
    reader.done()
    checkOverlaps("Projection", projection)
  }
  const unusedNames = Object.keys(names ?? {}).filter((k) => !placeholders.usedNames.has(k))
  if (unusedNames.length > 0) {
    refuse(
      `Value provided in ExpressionAttributeNames unused in expressions: keys: {${javaHashOrder(unusedNames).join(", ")}}`,
    )
  }
  const unusedValues = Object.keys(values ?? {}).filter((k) => !placeholders.usedValues.has(k))
  if (unusedValues.length > 0) {
    refuse(
      `Value provided in ExpressionAttributeValues unused in expressions: keys: {${javaHashOrder(unusedValues).join(", ")}}`,
    )
  }
  return { update, condition, keyCondition, filter, projection }
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const operandValue = (operand: Operand, item: Item | undefined): AttributeValue | undefined => {
  if (operand.kind === "value") return operand.value
  const value = readPath(item, operand.path)
  if (operand.kind === "path" || value === undefined) return value
  const type = typeOf(value)
  const size =
    type === "S"
      ? value.S!.length
      : type === "B"
        ? value.B!.length
        : type === "SS" || type === "NS" || type === "BS" || type === "L"
          ? (value[type] as ReadonlyArray<unknown>).length
          : type === "M"
            ? Object.keys(value.M!).length
            : undefined
  return size === undefined ? undefined : { N: String(size) }
}

/** Evaluate a read condition against `item` (`undefined`: no item). */
const evaluate = (condition: Condition, item: Item | undefined): boolean => {
  switch (condition.kind) {
    case "and":
      return evaluate(condition.left, item) && evaluate(condition.right, item)
    case "or":
      return evaluate(condition.left, item) || evaluate(condition.right, item)
    case "not":
      return !evaluate(condition.inner, item)
    case "exists":
      return (readPath(item, condition.path) !== undefined) !== condition.negate
    case "type": {
      const value = readPath(item, condition.path)
      return value !== undefined && typeOf(value) === condition.type
    }
    case "compare": {
      const [a, b] = [operandValue(condition.left, item), operandValue(condition.right, item)]
      if (a === undefined || b === undefined) return condition.op === "<>"
      if (condition.op === "=") return sameValue(a, b)
      if (condition.op === "<>") return !sameValue(a, b)
      const ordered = order(a, b)
      if (ordered === undefined) return false
      return condition.op === "<"
        ? ordered < 0
        : condition.op === "<="
          ? ordered <= 0
          : condition.op === ">"
            ? ordered > 0
            : ordered >= 0
    }
    case "between": {
      const subject = operandValue(condition.subject, item)
      const low = operandValue(condition.low, item)
      const high = operandValue(condition.high, item)
      if (subject === undefined || low === undefined || high === undefined) return false
      const above = order(subject, low)
      const below = order(subject, high)
      return above !== undefined && below !== undefined && above >= 0 && below <= 0
    }
    case "in": {
      const subject = operandValue(condition.subject, item)
      return (
        subject !== undefined &&
        condition.options.some((option) => {
          const value = operandValue(option, item)
          return value !== undefined && sameValue(subject, value)
        })
      )
    }
    case "begins_with": {
      const [a, b] = [operandValue(condition.subject, item), operandValue(condition.operand, item)]
      if (a?.S !== undefined && b?.S !== undefined) return a.S.startsWith(b.S)
      if (a?.B !== undefined && b?.B !== undefined) {
        return b.B.length <= a.B.length && sameBytes(a.B.subarray(0, b.B.length), b.B)
      }
      return false
    }
    case "contains": {
      const [a, b] = [operandValue(condition.subject, item), operandValue(condition.operand, item)]
      if (a === undefined || b === undefined) return false
      if (a.S !== undefined) return b.S !== undefined && a.S.includes(b.S)
      if (a.B !== undefined) {
        return b.B !== undefined && Buffer.from(a.B).includes(Buffer.from(b.B))
      }
      if (a.SS !== undefined) return b.S !== undefined && a.SS.includes(b.S)
      if (a.NS !== undefined) {
        return b.N !== undefined && a.NS.some((member) => compareNumbers(member, b.N!) === 0)
      }
      if (a.BS !== undefined) return b.B !== undefined && a.BS.some((m) => sameBytes(m, b.B!))
      if (a.L !== undefined) return a.L.some((element) => sameValue(element, b))
      return false
    }
  }
}

/**
 * Whether `expression` holds for `current` (`undefined`: no item), read as DynamoDB reads it
 * (`kind` names the expression in its refusals). A condition DynamoDB refuses throws its
 * `ValidationException`; one this doesn't read throws {@link UnreadableRequest}.
 */
export const holds = (
  expression: string | undefined,
  current: Item | undefined,
  names: Record<string, string>,
  values: Record<string, AttributeValue>,
  kind = "Condition",
): boolean => {
  if (expression === undefined) return true
  const placeholders = placeholdersOf(names, values)
  return evaluate(new ConditionReader(kind, expression, placeholders).condition(), current)
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** A value an update computes, read from the item as it was before the update. */
const computeValue = (value: UpdateValue, before: Item): AttributeValue => {
  switch (value.kind) {
    case "value":
      return literalWritten(value.value!)
    case "path":
      return readPath(before, value.path) ?? refuse(DDB_UPDATE_MISSING_ATTRIBUTE)
    case "if_not_exists": {
      const held = readPath(before, value.path)
      const fallback = computeValue(value.fallback, before)
      return held ?? fallback
    }
    case "list_append": {
      const first = computeValue(value.first, before)
      if (first.L === undefined) refuse(DDB_UPDATE_OPERAND_TYPE)
      const second = computeValue(value.second, before)
      if (second.L === undefined) refuse(DDB_UPDATE_OPERAND_TYPE)
      return { L: [...first.L!, ...second.L!] }
    }
    case "arithmetic": {
      const left = computeValue(value.left, before)
      if (left.N === undefined) refuse(DDB_UPDATE_OPERAND_TYPE)
      const right = computeValue(value.right, before)
      if (right.N === undefined) refuse(DDB_UPDATE_OPERAND_TYPE)
      return { N: arithmetic(left.N!, right.N!, value.op) }
    }
  }
}

type SetType = "SS" | "NS" | "BS"
type Member = string | Uint8Array

const sameMember = (type: SetType) => (x: Member, y: Member) =>
  type === "SS"
    ? x === y
    : type === "NS"
      ? compareNumbers(x as string, y as string) === 0
      : sameBytes(x as Uint8Array, y as Uint8Array)

/** A set as DynamoDB Local writes one an `ADD` or `DELETE` leaves: sorted, numbers spelt by `spell`. */
const writtenSet = (
  type: SetType,
  members: ReadonlyArray<Member>,
  spell: (d: Decimal) => string,
): AttributeValue => {
  if (type === "SS") return { SS: [...(members as ReadonlyArray<string>)].sort() }
  if (type === "BS") return { BS: [...(members as ReadonlyArray<Uint8Array>)].sort(compareBytes) }
  return {
    NS: (members as ReadonlyArray<string>)
      .map((member) => decimalOf(member))
      .sort(compareDecimals)
      .map((d) => spell(d)),
  }
}

const normalised = (d: Decimal) => plainText(stripZeros(d))

/** `value` with each of its map's or list's values replaced by `each` of it. */
const mapValues = (
  value: AttributeValue,
  each: (inner: AttributeValue) => AttributeValue,
): AttributeValue => {
  if (value.L !== undefined) return { L: value.L.map(each) }
  if (value.M !== undefined) {
    const out: Item = {}
    for (const key of Object.keys(value.M)) setOwn(out, key, each(value.M[key]!))
    return { M: out }
  }
  return value
}

/**
 * A value as DynamoDB Local stores it from a request's `ExpressionAttributeValues` (`SET`, at any
 * depth, through `if_not_exists` and `list_append` too), or nested in a put's item: every number
 * set's members spelt as Java's `BigDecimal.toString()` prints them (`1e21` as `1E+21`, `1.50` as
 * written) and sorted; a number as written. A value copied from the item keeps its spelling.
 */
const literalWritten = (value: AttributeValue): AttributeValue =>
  value.NS !== undefined
    ? writtenSet("NS", value.NS, scientificText)
    : mapValues(value, literalWritten)

/**
 * An item as DynamoDB Local stores it from a put (`PutItem`, a transaction's or a batch's): a
 * top-level number, and each member of a top-level number set, normalised (`1.50` as `1.5`, `1e21`
 * as `1000000000000000000000`, `007` as `7`, `-0` as `0`); nested values as {@link literalWritten}.
 */
const putWritten = (item: Item): Item => {
  const source = clone(item)
  const out: Item = {}
  for (const name of Object.keys(source)) {
    const value = source[name]!
    setOwn(
      out,
      name,
      value.N !== undefined
        ? { N: normalised(decimalOf(value.N)) }
        : value.NS !== undefined
          ? writtenSet("NS", value.NS, normalised)
          : mapValues(value, literalWritten),
    )
  }
  return out
}

/** What one action writes at its path: a value, or (`undefined`) its removal. */
interface Write {
  readonly path: Path
  readonly value: AttributeValue | undefined
}

const actionWrite = (action: Action, before: Item): Write | undefined => {
  if (containerOf(before, action.path) === undefined) refuse(DDB_UPDATE_INVALID_PATH)
  const current = readPath(before, action.path)
  switch (action.kind) {
    case "SET":
      return { path: action.path, value: computeValue(action.value, before) }
    case "REMOVE":
      return current === undefined ? undefined : { path: action.path, value: undefined }
    case "ADD": {
      const given = action.value.value!
      const type = typeOf(given)
      if (current !== undefined && typeOf(current) !== type) refuse(DDB_UPDATE_OPERAND_TYPE)
      if (type === "N") {
        const sum = current === undefined ? given : { N: arithmetic(current.N!, given.N!, "+") }
        return { path: action.path, value: sum }
      }
      const kind = type as SetType
      const added = given[kind] as ReadonlyArray<Member>
      if (current === undefined) {
        return { path: action.path, value: writtenSet(kind, added, scientificText) }
      }
      const stored = current[kind] as ReadonlyArray<Member>
      const same = sameMember(kind)
      const merged = [...stored, ...added.filter((x) => !stored.some((y) => same(x, y)))]
      return { path: action.path, value: writtenSet(kind, merged, normalised) }
    }
    case "DELETE": {
      if (current === undefined) return undefined
      const given = action.value.value!
      const kind = typeOf(given) as SetType
      if (typeOf(current) !== kind) refuse(DDB_UPDATE_OPERAND_TYPE)
      const same = sameMember(kind)
      const removed = given[kind] as ReadonlyArray<Member>
      const kept = (current[kind] as ReadonlyArray<Member>).filter(
        (x) => !removed.some((y) => same(x, y)),
      )
      const value = kept.length === 0 ? undefined : writtenSet(kind, kept, normalised)
      return { path: action.path, value }
    }
  }
}

/** DynamoDB's refusal of an update naming a key attribute. */
const keyAttributeRefusal = (attribute: string) =>
  `One or more parameter values were invalid: Cannot update attribute ${attribute}. This attribute is part of the key`

/**
 * Apply an update's actions to `item` as DynamoDB Local applies them: every operand read from the
 * item as it was, and every path naming a place in the item as it was, nested list positions
 * included (`SET l[1][0] = :v REMOVE l[0]` writes the element that was `l[1]`). An index past a
 * list's end appends, in index order; the indexes `REMOVE` names are the list's positions before
 * the update. Of several refused actions, throws the `ValidationException` of the last one Local
 * visits (see {@link visitOrder}).
 */
const applyActions = (actions: ReadonlyArray<Action>, before: Item): Item => {
  const writes: Array<Write> = []
  let refusal: unknown
  for (const action of visitOrder(actions)) {
    try {
      const write = actionWrite(action, before)
      if (write !== undefined) writes.push(write)
    } catch (error) {
      if (!isRefusal(error)) throw error
      refusal = error
    }
  }
  if (refusal !== undefined) throw refusal
  const next = clone(before)
  // Every write's container, found before anything moves: a map or list is the same object
  // wherever a removal from an outer list leaves it, so each write lands where its path named.
  // Paths don't overlap (refused when read), so no write replaces another's container.
  const keyed: Array<{ readonly map: Item; readonly key: string; readonly write: Write }> = []
  const lists = new Map<Array<AttributeValue>, { readonly length: number; writes: Array<Write> }>()
  for (const write of writes) {
    const container = containerOf(next, write.path)!
    const last = write.path[write.path.length - 1]!
    if (typeof last === "string") {
      keyed.push({ map: container as Item, key: last, write })
    } else {
      const list = container as Array<AttributeValue>
      const group = lists.get(list) ?? { length: list.length, writes: [] }
      group.writes.push(write)
      lists.set(list, group)
    }
  }
  for (const { map, key, write } of keyed) {
    if (write.value === undefined) delete map[key]
    else setOwn(map, key, clone(write.value))
  }
  const index = (write: Write) => write.path[write.path.length - 1] as number
  for (const [list, { length, writes: group }] of lists) {
    const replaced = group.filter((w) => w.value !== undefined && index(w) < length)
    const appended = group.filter((w) => w.value !== undefined && index(w) >= length)
    const removed = group.filter((w) => w.value === undefined && index(w) < length)
    for (const write of replaced) list[index(write)] = clone(write.value!)
    for (const write of appended.sort((a, b) => index(a) - index(b))) list.push(clone(write.value!))
    for (const at of removed.map(index).sort((a, b) => b - a)) list.splice(at, 1)
  }
  return next
}

/**
 * Apply an update request's expression to `item`, read and checked as DynamoDB reads it, then
 * applied as DynamoDB Local applies it. Throws DynamoDB Local's `ValidationException` for an
 * update it refuses, and {@link UnreadableRequest} for one this doesn't read.
 */
export const updatedItem = (item: Item, input: ExpressionInput): Item =>
  applyActions(readExpressions(input).update ?? [], item)

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** The parts of `item` a projection names, placed at their paths. */
const project = (item: Item, paths: ReadonlyArray<Path>): Item => {
  const out: Item = {}
  for (const path of paths) {
    if (path.some((segment) => typeof segment === "number")) {
      unreadable("the ProjectionExpression", pathText(path), "a list element")
    }
    const value = readPath(item, path)
    if (value === undefined) continue
    let target: Record<string, AttributeValue> = out
    for (const segment of path.slice(0, -1) as ReadonlyArray<string>) {
      let inner = own(target, segment)
      if (inner === undefined) {
        inner = { M: {} }
        setOwn(target, segment, inner)
      }
      target = inner.M!
    }
    setOwn(target, path[path.length - 1] as string, clone(value))
  }
  return out
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** The request fields each operation reads; any other field is a request this doesn't read. */
const FIELDS: Record<string, ReadonlyArray<string>> = {
  GetItem: [
    "TableName",
    "Key",
    "ConsistentRead",
    "ProjectionExpression",
    "ExpressionAttributeNames",
    "ReturnConsumedCapacity",
  ],
  PutItem: [
    "TableName",
    "Item",
    "ConditionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ReturnValues",
    "ReturnValuesOnConditionCheckFailure",
    "ReturnConsumedCapacity",
    "ReturnItemCollectionMetrics",
  ],
  UpdateItem: [
    "TableName",
    "Key",
    "UpdateExpression",
    "ConditionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ReturnValues",
    "ReturnValuesOnConditionCheckFailure",
    "ReturnConsumedCapacity",
    "ReturnItemCollectionMetrics",
  ],
  DeleteItem: [
    "TableName",
    "Key",
    "ConditionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ReturnValues",
    "ReturnValuesOnConditionCheckFailure",
    "ReturnConsumedCapacity",
    "ReturnItemCollectionMetrics",
  ],
  Query: [
    "TableName",
    "IndexName",
    "KeyConditionExpression",
    "FilterExpression",
    "ProjectionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ScanIndexForward",
    "Limit",
    "ExclusiveStartKey",
    "ConsistentRead",
    "Select",
    "ReturnConsumedCapacity",
  ],
  Scan: [
    "TableName",
    "FilterExpression",
    "ProjectionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "Limit",
    "ExclusiveStartKey",
    "Segment",
    "TotalSegments",
    "ConsistentRead",
    "Select",
    "ReturnConsumedCapacity",
  ],
  BatchGetItem: ["RequestItems", "ReturnConsumedCapacity"],
  "BatchGetItem table": [
    "Keys",
    "ConsistentRead",
    "ProjectionExpression",
    "ExpressionAttributeNames",
  ],
  BatchWriteItem: ["RequestItems", "ReturnConsumedCapacity", "ReturnItemCollectionMetrics"],
  TransactGetItems: ["TransactItems", "ReturnConsumedCapacity"],
  Get: ["TableName", "Key", "ProjectionExpression", "ExpressionAttributeNames"],
  TransactWriteItems: [
    "TransactItems",
    "ClientRequestToken",
    "ReturnConsumedCapacity",
    "ReturnItemCollectionMetrics",
  ],
  Put: [
    "TableName",
    "Item",
    "ConditionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ReturnValuesOnConditionCheckFailure",
  ],
  Update: [
    "TableName",
    "Key",
    "UpdateExpression",
    "ConditionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ReturnValuesOnConditionCheckFailure",
  ],
  Delete: [
    "TableName",
    "Key",
    "ConditionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ReturnValuesOnConditionCheckFailure",
  ],
  ConditionCheck: [
    "TableName",
    "Key",
    "ConditionExpression",
    "ExpressionAttributeNames",
    "ExpressionAttributeValues",
    "ReturnValuesOnConditionCheckFailure",
  ],
}

/**
 * A request's fields are ones `operation` reads. `ReturnConsumedCapacity` and
 * `ReturnItemCollectionMetrics` are accepted and not answered: the tables report no capacity.
 */
export const checkFields = (operation: string, input: object): void => {
  const known = FIELDS[operation]!
  for (const [field, value] of Object.entries(input)) {
    if (value !== undefined && !known.includes(field)) {
      unreadable(`the ${operation} field`, field, "not modelled")
    }
  }
}

/** A table's (or index's) key attributes; every table key these tables hold is an `S`. */
export interface KeySchema {
  readonly pk: string
  readonly sk: string
}

/** A key attribute's type. */
export type KeyType = "S" | "N" | "B"

/** A secondary index: its key attributes and their types, its kind, and the attributes it holds. */
export interface IndexSchema extends KeySchema {
  /**
   * `local` (an LSI) or `global` (a GSI). Left out: local when its partition key is the table's,
   * global otherwise; a GSI on the table's partition key says so.
   */
  readonly kind?: "local" | "global" | undefined
  /** The partition key's type (default `S`). */
  readonly pkType?: KeyType | undefined
  /** The sort key's type (default `S`; a Z-order sort key is `B`). */
  readonly skType?: KeyType | undefined
  /** What a read of the index holds: every attribute (the default), the keys only, or the keys and these. */
  readonly projection?: "ALL" | "KEYS_ONLY" | ReadonlyArray<string> | undefined
}

/** A table's secondary indexes, by name, in the order its `CreateTable` declares them. */
export type Indexes = Readonly<Record<string, IndexSchema>>

interface CreateTableIndex {
  readonly IndexName?: string | undefined
  readonly KeySchema?: ReadonlyArray<{ readonly AttributeName?: string; readonly KeyType?: string }>
  readonly Projection?: {
    readonly ProjectionType?: string | undefined
    readonly NonKeyAttributes?: ReadonlyArray<string> | undefined
  }
}

/**
 * The secondary indexes a `CreateTable` input declares (`Table.definition`'s, say), as the
 * in-memory tables take them: local indexes first, then global ones, as DynamoDB Local is created
 * with them. An index this doesn't read (no sort key, a key attribute of no declared type) is a
 * defect.
 */
export const indexesOf = (definition: {
  readonly AttributeDefinitions?: ReadonlyArray<{
    readonly AttributeName?: string | undefined
    readonly AttributeType?: string | undefined
  }>
  readonly LocalSecondaryIndexes?: ReadonlyArray<CreateTableIndex> | undefined
  readonly GlobalSecondaryIndexes?: ReadonlyArray<CreateTableIndex> | undefined
}): Indexes => {
  const declared = (attribute: string): KeyType => {
    const type = definition.AttributeDefinitions?.find(
      (each) => each.AttributeName === attribute,
    )?.AttributeType
    if (type !== "S" && type !== "N" && type !== "B") {
      return unreadable("the index key attribute", attribute, "of no declared type")
    }
    return type
  }
  const out: Record<string, IndexSchema> = {}
  const add = (index: CreateTableIndex, kind: "local" | "global") => {
    const key = (type: string) =>
      index.KeySchema?.find((each) => each.KeyType === type)?.AttributeName
    const pk = key("HASH")
    const sk = key("RANGE")
    if (index.IndexName === undefined || pk === undefined || sk === undefined) {
      return unreadable("the index", shown(index), "not a partition and sort key")
    }
    const projection = index.Projection?.ProjectionType ?? "ALL"
    setOwn(out, index.IndexName, {
      pk,
      sk,
      kind,
      pkType: declared(pk),
      skType: declared(sk),
      projection:
        projection === "INCLUDE"
          ? [...(index.Projection?.NonKeyAttributes ?? [])]
          : projection === "KEYS_ONLY"
            ? "KEYS_ONLY"
            : "ALL",
    })
  }
  for (const index of definition.LocalSecondaryIndexes ?? []) add(index, "local")
  for (const index of definition.GlobalSecondaryIndexes ?? []) add(index, "global")
  return out
}

const keyAttributes = (schema: KeySchema) => [schema.pk, schema.sk]

/** Whether `index` is a local secondary index of `table`; a local one on another partition key is a defect. */
const isLocal = (name: string, index: IndexSchema, table: KeySchema): boolean => {
  const local = (index.kind ?? (index.pk === table.pk ? "local" : "global")) === "local"
  if (local && index.pk !== table.pk) {
    unreadable("the index", name, `a local index keyed by ${index.pk}, not the table's ${table.pk}`)
  }
  return local
}

/** The type of one of `index`'s key attributes; the table's own are `S`. */
const keyTypeIn = (index: IndexSchema | undefined, table: KeySchema, attribute: string): KeyType =>
  attribute === table.pk || attribute === table.sk || index === undefined
    ? "S"
    : ((attribute === index.pk ? index.pkType : index.skType) ?? "S")

/** The attributes a read of `index` holds: `undefined` for every attribute. */
const projectedBy = (index: IndexSchema, table: KeySchema): ReadonlySet<string> | undefined => {
  const projection = index.projection ?? "ALL"
  if (projection === "ALL") return undefined
  return new Set([
    table.pk,
    table.sk,
    index.pk,
    index.sk,
    ...(projection === "KEYS_ONLY" ? [] : projection),
  ])
}

/** The one problem of several DynamoDB Local might report first, or a defect when there are more. */
const theProblem = (problems: ReadonlyArray<string>, what: string): string | undefined => {
  const distinct = [...new Set(problems)]
  if (distinct.length > 1) {
    unreadable(what, shown(distinct), "more than one problem, reported in an order not measured")
  }
  return distinct[0]
}

const INDEX_TYPE_MISMATCH = "One or more parameter values were invalid: Type mismatch for Index Key"
const INVALID_VALUE_TYPE = "Invalid attribute value type"
const indexEmpty = (index: string, attribute: string, binary: boolean) =>
  "One or more parameter values are not valid. A value specified for a secondary index key is " +
  `not supported. The AttributeValue for a key attribute cannot contain an empty ${binary ? "binary" : "string"} value. IndexName: ${index}, IndexKey: ${attribute}`
const UPDATE_INDEX_EMPTY =
  "One or more parameter values are not valid. The update expression attempted to update a " +
  "secondary index key to a value that is not supported. The AttributeValue for a key attribute " +
  "cannot contain an empty string value."

/**
 * The indexes' key attributes that aren't the table's: each with its type and the indexes it keys,
 * in their order. Two indexes declaring one attribute with two types are a defect.
 */
const indexKeysOf = (indexes: Indexes, table: KeySchema) => {
  const keys = new Map<
    string,
    { readonly type: KeyType; readonly indexes: Array<{ name: string; local: boolean }> }
  >()
  for (const [name, index] of Object.entries(indexes)) {
    const local = isLocal(name, index, table)
    for (const attribute of [index.pk, index.sk]) {
      if (attribute === table.pk || attribute === table.sk) continue
      const type = keyTypeIn(index, table, attribute)
      const held = keys.get(attribute) ?? { type, indexes: [] }
      if (held.type !== type) {
        unreadable("the indexes", name, `${attribute} declared both ${held.type} and ${type}`)
      }
      held.indexes.push({ name, local })
      keys.set(attribute, held)
    }
  }
  return keys
}

const isEmptyKeyValue = (value: AttributeValue) =>
  (value.S !== undefined && value.S === "") || (value.B !== undefined && value.B.length === 0)

/** A problem with an item's index keys: a wrong type (`typed`), or an empty value. */
interface IndexProblem {
  readonly typed: boolean
  readonly message: string
}

/**
 * Why DynamoDB Local refuses the index keys a put's item holds, if it does: a value of no key type
 * or of another type than the index's (`typed`, reported first), else an empty string or binary,
 * naming the first index it keys.
 */
const putIndexProblem = (
  item: Item,
  indexes: Indexes,
  table: KeySchema,
): IndexProblem | undefined => {
  const typed: Array<string> = []
  const empty: Array<string> = []
  for (const [attribute, key] of indexKeysOf(indexes, table)) {
    const value = own(item, attribute)
    if (value === undefined) continue
    const type = typeOf(value)
    if (!["S", "N", "B"].includes(type)) typed.push(INVALID_VALUE_TYPE)
    else if (type !== key.type) typed.push(INDEX_TYPE_MISMATCH)
    else if (isEmptyKeyValue(value)) {
      empty.push(indexEmpty(key.indexes[0]!.name, attribute, type === "B"))
    }
  }
  const problem = theProblem(typed, "the item's index keys")
  if (problem !== undefined) return { typed: true, message: problem }
  const blank = theProblem(empty, "the item's index keys")
  return blank === undefined ? undefined : { typed: false, message: blank }
}

/**
 * Why DynamoDB Local refuses the index keys an update writes (`SET` / `ADD` of one), once its
 * condition held: an empty string (reported first), else a value of no key type, or of another
 * type than a global index's (`typed`; a local index's key isn't checked on an update).
 */
const updateIndexProblem = (
  next: Item,
  actions: ReadonlyArray<Action>,
  indexes: Indexes,
  table: KeySchema,
): IndexProblem | undefined => {
  const keys = indexKeysOf(indexes, table)
  const written = new Set(
    actions.filter((action) => action.kind !== "REMOVE").map((action) => action.path[0] as string),
  )
  const typed: Array<string> = []
  let empty = false
  for (const attribute of written) {
    const key = keys.get(attribute)
    const value = own(next, attribute)
    if (key === undefined || value === undefined) continue
    const type = typeOf(value)
    const global = key.indexes.some((index) => !index.local)
    if (type === "S" && value.S === "") empty = true
    else if (type === "B" && value.B!.length === 0) {
      unreadable("the update of", attribute, "an empty binary index key (unmeasured)")
    } else if (!["S", "N", "B"].includes(type)) {
      if (!global)
        unreadable("the update of", attribute, "a local index key of no key type (unmeasured)")
      typed.push(INVALID_VALUE_TYPE)
    } else if (type !== key.type && global) typed.push(INDEX_TYPE_MISMATCH)
  }
  if (empty) return { typed: false, message: UPDATE_INDEX_EMPTY }
  const problem = theProblem(typed, "the update's index keys")
  return problem === undefined ? undefined : { typed: true, message: problem }
}

const EMPTY_KEY = (attribute: string) =>
  "One or more parameter values are not valid. The AttributeValue for a key attribute cannot " +
  `contain an empty string value. Key: ${attribute}`
const TYPE_MISMATCH = "One or more parameter values were invalid: Type mismatch for key"

/** A `Key` names exactly the table's key attributes, each a non-empty `S`. */
export const checkKey = (key: Item | undefined, schema: KeySchema): Item => {
  const attributes = keyAttributes(schema)
  if (
    key === undefined ||
    Object.keys(key).length !== attributes.length ||
    !attributes.every((attribute) => Object.hasOwn(key, attribute))
  ) {
    return refuse("The number of conditions on the keys is invalid")
  }
  for (const attribute of attributes) {
    const value = key[attribute]!
    if (typeOf(value) !== "S") refuse(TYPE_MISMATCH)
    if (value.S === "") refuse(EMPTY_KEY(attribute))
  }
  return key
}

/** An `Item` holds the table's key attributes, each a non-empty `S`, and only values DynamoDB stores. */
export const checkItem = (item: Item | undefined, schema: KeySchema): Item => {
  if (item === undefined) return refuse("One of the required keys was not given a value")
  for (const attribute of keyAttributes(schema)) {
    const value = own(item, attribute)
    if (value === undefined) refuse("One of the required keys was not given a value")
    if (typeOf(value!) !== "S") refuse(TYPE_MISMATCH)
    if (value!.S === "") refuse(EMPTY_KEY(attribute))
  }
  for (const attribute of Object.keys(item)) {
    const problem = valueProblem(item[attribute]!)
    if (problem !== undefined) refuse(problem)
  }
  return item
}

/** The key part of `item`. */
export const keyOfItem = (item: Item, schema: KeySchema): Item => ({
  [schema.pk]: item[schema.pk]!,
  [schema.sk]: item[schema.sk]!,
})

const returnValues = (given: string | undefined, allowed: ReadonlyArray<string>): string => {
  const value = given ?? "NONE"
  if (!allowed.includes(value)) refuse("Return values set to invalid value")
  return value
}

/** DynamoDB's `ConditionalCheckFailedException`, with the item when the request asked for it. */
export const conditionalCheckFailed = (
  input: { readonly ReturnValuesOnConditionCheckFailure?: string | undefined },
  current: Item | undefined,
): Error =>
  Object.assign(new Error(DDB_CONDITION_FAILED), {
    name: "ConditionalCheckFailedException",
    ...(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" &&
      current !== undefined && { Item: asRead(current) }),
  })

/** A single write's answer: the item to store (`undefined`: none) and the output, or a failed condition. */
export type WriteOutcome =
  | {
      readonly _tag: "Written"
      readonly item: Item | undefined
      readonly output: { readonly Attributes?: Item }
    }
  | { readonly _tag: "ConditionFailed"; readonly error: Error }

type WriteInput = ExpressionInput & {
  readonly TableName?: string | undefined
  readonly Key?: Item | undefined
  readonly Item?: Item | undefined
  readonly ReturnValues?: string | undefined
  readonly ReturnValuesOnConditionCheckFailure?: string | undefined
}

const attributes = (item: Item | undefined): { readonly Attributes?: Item } =>
  item === undefined ? {} : { Attributes: asRead(item) }

/** The top-level attributes of `item` an update's actions name. */
const touched = (item: Item | undefined, actions: ReadonlyArray<Action>): Item | undefined => {
  if (item === undefined) return undefined
  const picked: Item = {}
  for (const action of actions) {
    const name = action.path[0] as string
    const value = own(item, name)
    if (value !== undefined) setOwn(picked, name, value)
  }
  return Object.keys(picked).length === 0 ? undefined : picked
}

/**
 * Options the in-memory tables give a write: the table's secondary `indexes`, whose keys a write
 * is checked against; and `failCondition`, consulted for each write carrying a condition, which
 * makes that condition fail whatever it says (another writer won).
 */
export interface WriteOptions {
  readonly indexes?: Indexes | undefined
  readonly failCondition?: (() => boolean) | undefined
}

const conditionHolds = (
  condition: Condition | undefined,
  current: Item | undefined,
  options: WriteOptions | undefined,
): boolean =>
  condition === undefined || (options?.failCondition?.() !== true && evaluate(condition, current))

/** Reads the item stored under a key, once the request naming it has been checked. */
export type Read = (key: Item) => Item | undefined

/** A `PutItem` as DynamoDB Local answers it. */
export const putItem = (
  input: WriteInput,
  read: Read,
  schema: KeySchema,
  options?: WriteOptions,
): WriteOutcome => {
  checkFields("PutItem", input)
  const returned = returnValues(input.ReturnValues, ["NONE", "ALL_OLD"])
  const item = checkItem(input.Item, schema)
  const problem = putIndexProblem(item, options?.indexes ?? {}, schema)
  if (problem !== undefined) refuse(problem.message)
  const { condition } = readExpressions(input)
  const current = read(keyOfItem(item, schema))
  if (!conditionHolds(condition, current, options)) {
    return { _tag: "ConditionFailed", error: conditionalCheckFailed(input, current) }
  }
  return {
    _tag: "Written",
    item: putWritten(item),
    output: returned === "ALL_OLD" ? attributes(current) : {},
  }
}

/** An `UpdateItem` as DynamoDB Local answers it. */
export const updateItem = (
  input: WriteInput,
  read: Read,
  schema: KeySchema,
  options?: WriteOptions,
): WriteOutcome => {
  checkFields("UpdateItem", input)
  const returned = returnValues(input.ReturnValues, [
    "NONE",
    "ALL_OLD",
    "UPDATED_OLD",
    "ALL_NEW",
    "UPDATED_NEW",
  ])
  const key = checkKey(input.Key, schema)
  const { condition, update = [] } = readExpressions(input)
  const current = read(key)
  if (!conditionHolds(condition, current, options)) {
    return { _tag: "ConditionFailed", error: conditionalCheckFailed(input, current) }
  }
  for (const action of update) {
    if (keyAttributes(schema).includes(action.path[0] as string)) {
      refuse(keyAttributeRefusal(action.path[0] as string))
    }
  }
  const next = applyActions(update, current ?? clone(key))
  const problem = updateIndexProblem(next, update, options?.indexes ?? {}, schema)
  if (problem !== undefined) refuse(problem.message)
  const written = update.filter((action) => action.kind !== "REMOVE")
  const output =
    returned === "ALL_OLD"
      ? attributes(current)
      : returned === "ALL_NEW"
        ? attributes(next)
        : returned === "UPDATED_OLD"
          ? attributes(touched(current, update))
          : returned === "UPDATED_NEW"
            ? attributes(touched(next, written))
            : {}
  return { _tag: "Written", item: next, output }
}

/** A `DeleteItem` as DynamoDB Local answers it. */
export const deleteItem = (
  input: WriteInput,
  read: Read,
  schema: KeySchema,
  options?: WriteOptions,
): WriteOutcome => {
  checkFields("DeleteItem", input)
  const returned = returnValues(input.ReturnValues, ["NONE", "ALL_OLD"])
  const key = checkKey(input.Key, schema)
  const { condition } = readExpressions(input)
  const current = read(key)
  if (!conditionHolds(condition, current, options)) {
    return { _tag: "ConditionFailed", error: conditionalCheckFailed(input, current) }
  }
  return {
    _tag: "Written",
    item: undefined,
    output: returned === "ALL_OLD" ? attributes(current) : {},
  }
}

/** A `GetItem`'s output. */
export const getItem = (
  input: ExpressionInput & { readonly Key?: Item | undefined },
  read: Read,
  schema: KeySchema,
): { readonly Item?: Item } => {
  checkFields("GetItem", input)
  const key = checkKey(input.Key, schema)
  const { projection } = readExpressions(input)
  const current = read(key)
  if (current === undefined) return {}
  return { Item: asRead(projection === undefined ? current : project(current, projection)) }
}

/** Where a table finds an item, its key attributes and its secondary indexes. */
export interface Tables {
  readonly schema: (table: string) => KeySchema
  readonly indexes: (table: string) => Indexes
  readonly read: (table: string, key: Item) => Item | undefined
}

/** One write a committed transaction or batch makes: the item stored under `key` (`undefined`: deleted). */
export interface TableWrite {
  readonly table: string
  readonly key: Item
  readonly item: Item | undefined
}

export type TransactOutcome =
  | { readonly _tag: "Committed"; readonly writes: ReadonlyArray<TableWrite> }
  | { readonly _tag: "Cancelled"; readonly error: Error }

/** DynamoDB's `TransactionCanceledException`, with one reason per item. */
export const transactionCanceled = (
  reasons: ReadonlyArray<{
    readonly Code?: string
    readonly Message?: string
    readonly Item?: Item
  }>,
): Error =>
  Object.assign(
    new Error(
      `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((r) => r.Code).join(", ")}]`,
    ),
    { name: "TransactionCanceledException", CancellationReasons: reasons },
  )

const KINDS = ["Put", "Update", "Delete", "ConditionCheck"] as const
const MISSING_KEY = "One of the required keys was not given a value"
const KEY_COUNT = "The number of conditions on the keys is invalid"

/** DynamoDB Local's refusals of a request naming too many, or no, items. */
const TOO_MANY_TRANSACT_ITEMS = "Member must have length less than or equal to 100"
const NO_TRANSACT_WRITE_ITEMS =
  "Value [] at 'transactItems' failed to satisfy constraint: Member must have length greater than or equal to 1"
const NO_TRANSACT_GET_ITEMS =
  "Value null at 'transactItems' failed to satisfy constraint: Member must not be null"
const TOO_MANY_BATCH_WRITES = "Too many items requested for the BatchWriteItem call"
const TOO_MANY_BATCH_GETS = "Too many items requested for the BatchGetItem call"

/** A transaction's items: none, or over 100, refuse it before anything else. */
const transactItems = (
  items: ReadonlyArray<Record<string, any>> | undefined,
  none: string,
): ReadonlyArray<Record<string, any>> => {
  if (items === undefined)
    return unreadable("the transaction", "TransactItems", "missing (unmeasured)")
  if (items.length === 0) refuse(none)
  if (items.length > 100) refuse(TOO_MANY_TRANSACT_ITEMS)
  return items
}

/**
 * A transaction item's key. A key of another type than the table's is that item's
 * `ValidationError` reason (`reason`); a missing, extra or empty key attribute refuses the request.
 */
const transactKey = (
  check: () => Item,
  what: unknown,
): { readonly key?: Item | undefined; readonly reason?: string | undefined } => {
  try {
    return { key: check() }
  } catch (error) {
    if (!isRefusal(error)) throw error
    if (error.message === TYPE_MISMATCH) return { reason: TYPE_MISMATCH }
    if (
      error.message === MISSING_KEY ||
      error.message === KEY_COUNT ||
      error.message.startsWith(EMPTY_KEY(""))
    ) {
      throw error
    }
    return unreadable(
      "the transaction item",
      shown(what),
      `${error.message} (DynamoDB Local's answer to this in a transaction is not modelled)`,
    )
  }
}

/** A refusal raised as a cancellation reason in a transaction; one with no key type is unmeasured there. */
const asReason = (problem: IndexProblem, what: unknown): string => {
  if (problem.message === INVALID_VALUE_TYPE) {
    unreadable(
      "the transaction item",
      shown(what),
      `${problem.message} (unmeasured in a transaction)`,
    )
  }
  return problem.message
}

/**
 * A `TransactWriteItems` as DynamoDB Local answers it. None, or over 100, items refuse it. Every
 * item's request is checked first (a refusal is request-wide; a key of the wrong type, or a put's
 * index key of the wrong type, is that item's `ValidationError` reason). Then the items are taken
 * in order, each against the item as the items before it left it: a failed condition is that
 * item's `ConditionalCheckFailed` reason (with the item as it stands, under `ALL_OLD`) and
 * touches nothing; an update of a key attribute cancels the transaction with that one reason;
 * an update the item can't take, or an empty index key, refuses the request; an update's global
 * index key of the wrong type is its `ValidationError` reason; and an item already touched by an
 * earlier item refuses the request as naming one item twice. Any reason other than `None`
 * cancels the transaction. Nothing is written until every item is taken.
 */
export const transactWrite = (
  input: { readonly TransactItems?: ReadonlyArray<Record<string, any>> | undefined },
  tables: Tables,
  options?: WriteOptions,
): TransactOutcome => {
  checkFields("TransactWriteItems", input)
  const ops = transactItems(input.TransactItems, NO_TRANSACT_WRITE_ITEMS).map((op) => {
    const kinds = KINDS.filter((kind) => op[kind] !== undefined)
    if (
      kinds.length !== 1 ||
      Object.keys(op).some(
        (k) => op[k] !== undefined && !(KINDS as ReadonlyArray<string>).includes(k),
      )
    ) {
      return unreadable(
        "the TransactItems entry",
        shown(op),
        "not exactly one Put, Update, Delete or ConditionCheck",
      )
    }
    const kind = kinds[0]!
    const body = op[kind] as WriteInput
    checkFields(kind, body)
    if (kind === "ConditionCheck" && body.ConditionExpression === undefined) {
      unreadable("the ConditionCheck", shown(body), "no ConditionExpression (unmeasured)")
    }
    const schema = tables.schema(body.TableName!)
    const indexes = tables.indexes(body.TableName!)
    const keyed = transactKey(
      () =>
        kind === "Put"
          ? keyOfItem(checkItem(body.Item, schema), schema)
          : checkKey(body.Key, schema),
      body,
    )
    const expressions = readExpressions(body)
    let reason = keyed.reason
    if (kind === "Put" && reason === undefined) {
      const problem = putIndexProblem(body.Item!, indexes, schema)
      if (problem !== undefined && !problem.typed) refuse(problem.message)
      if (problem !== undefined) reason = asReason(problem, body)
    }
    return {
      kind,
      body,
      table: body.TableName!,
      key: keyed.key,
      schema,
      indexes,
      expressions,
      reason,
    }
  })
  const state = new Map<string, Item | undefined>()
  const done = new Set<string>()
  const writes: Array<TableWrite> = []
  const reasons: Array<{ Code: string; Message?: string; Item?: Item }> = []
  for (const op of ops) {
    if (op.reason !== undefined || op.key === undefined) {
      reasons.push({ Code: "ValidationError", Message: op.reason! })
      continue
    }
    const identity = keyIdentity(op.table, op.key, keyAttributes(op.schema))
    const current = state.has(identity) ? state.get(identity) : tables.read(op.table, op.key)
    if (!conditionHolds(op.expressions.condition, current, options)) {
      reasons.push({
        Code: "ConditionalCheckFailed",
        // A `ConditionCheck`'s reason ends in a full stop; a write's doesn't.
        Message: op.kind === "ConditionCheck" ? `${DDB_CONDITION_FAILED}.` : DDB_CONDITION_FAILED,
        ...(op.body.ReturnValuesOnConditionCheckFailure === "ALL_OLD" &&
          current !== undefined && { Item: asRead(current) }),
      })
      continue
    }
    let next: Item | undefined
    let reason: string | undefined
    if (op.kind === "Update") {
      const update = op.expressions.update ?? []
      const named = update.find((action) =>
        keyAttributes(op.schema).includes(action.path[0] as string),
      )
      if (named !== undefined) {
        // Measured: one reason, however many items the transaction has.
        return {
          _tag: "Cancelled",
          error: transactionCanceled([
            { Code: "ValidationError", Message: keyAttributeRefusal(named.path[0] as string) },
          ]),
        }
      }
      next = applyActions(update, current ?? clone(op.key))
      const problem = updateIndexProblem(next, update, op.indexes, op.schema)
      if (problem !== undefined && !problem.typed) refuse(problem.message)
      if (problem !== undefined) reason = asReason(problem, op.body)
    } else {
      next =
        op.kind === "Put" ? putWritten(op.body.Item!) : op.kind === "Delete" ? undefined : current
    }
    if (done.has(identity)) refuse(DDB_REPEATED_ITEM)
    done.add(identity)
    if (reason !== undefined) {
      reasons.push({ Code: "ValidationError", Message: reason })
      continue
    }
    state.set(identity, next)
    if (op.kind !== "ConditionCheck") writes.push({ table: op.table, key: op.key, item: next })
    reasons.push({ Code: "None" })
  }
  if (reasons.some((reason) => reason.Code !== "None")) {
    return { _tag: "Cancelled", error: transactionCanceled(reasons) }
  }
  return { _tag: "Committed", writes }
}

/** A `TransactGetItems`'s output: one response per item, in order. */
export const transactGet = (
  input: { readonly TransactItems?: ReadonlyArray<Record<string, any>> | undefined },
  tables: Tables,
): { readonly Responses: ReadonlyArray<{ readonly Item?: Item }> } => {
  checkFields("TransactGetItems", input)
  const seen = new Set<string>()
  const gets = transactItems(input.TransactItems, NO_TRANSACT_GET_ITEMS).map((op) => {
    if (op.Get === undefined || Object.keys(op).some((k) => k !== "Get" && op[k] !== undefined)) {
      return unreadable("the TransactItems entry", shown(op), "not a Get")
    }
    const body = op.Get as ExpressionInput & { TableName: string; Key: Item }
    checkFields("Get", body)
    const schema = tables.schema(body.TableName)
    try {
      checkKey(body.Key, schema)
    } catch (error) {
      // DynamoDB Local cancels the read, with the check's message and no reasons.
      if (!isRefusal(error)) throw error
      throw Object.assign(new Error(error.message), { name: "TransactionCanceledException" })
    }
    const { projection } = readExpressions(body)
    return { body, schema, projection }
  })
  for (const { body, schema } of gets) {
    const identity = keyIdentity(body.TableName, body.Key, keyAttributes(schema))
    if (seen.has(identity)) refuse(DDB_REPEATED_ITEM)
    seen.add(identity)
  }
  return {
    Responses: gets.map(({ body, projection }) => {
      const item = tables.read(body.TableName, body.Key)
      if (item === undefined) return {}
      return { Item: asRead(projection === undefined ? item : project(item, projection)) }
    }),
  }
}

/** A `BatchGetItem`'s output: the items found, per table, in request order. */
export const batchGet = (
  input: { readonly RequestItems?: Record<string, Record<string, any>> | undefined },
  tables: Tables,
): { readonly Responses: Record<string, Array<Item>>; readonly UnprocessedKeys: {} } => {
  checkFields("BatchGetItem", input)
  const entries = Object.entries(input.RequestItems ?? {})
  if (entries.length === 0) refuse("BatchGetItem must have some requests set")
  for (const [table, request] of entries) {
    if ((request.Keys ?? []).length === 0) {
      refuse(
        `The list of keys in RequestItems for BatchGetItem is required: ${table} has empty list`,
      )
    }
  }
  const total = entries.reduce((sum, [, request]) => sum + request.Keys.length, 0)
  if (total > 100) refuse(TOO_MANY_BATCH_GETS)
  const Responses: Record<string, Array<Item>> = {}
  const requests = entries.map(([table, request]) => {
    checkFields("BatchGetItem table", request)
    const schema = tables.schema(table)
    const keys = request.Keys as ReadonlyArray<Item>
    for (const key of keys) checkKey(key, schema)
    const identities = keys.map((key) => keyIdentity(table, key, keyAttributes(schema)))
    if (new Set(identities).size !== identities.length) refuse(DDB_REPEATED_BATCH_ITEM)
    const { projection } = readExpressions(request)
    return { table, keys, projection }
  })
  for (const { table, keys, projection } of requests) {
    Responses[table] = keys.flatMap((key) => {
      const item = tables.read(table, key)
      if (item === undefined) return []
      return [asRead(projection === undefined ? item : project(item, projection))]
    })
  }
  return { Responses, UnprocessedKeys: {} }
}

/** A `BatchWriteItem`'s writes, in request order, every request checked before any is returned. */
export const batchWrite = (
  input: { readonly RequestItems?: Record<string, ReadonlyArray<Record<string, any>>> | undefined },
  tables: Tables,
): ReadonlyArray<TableWrite> => {
  checkFields("BatchWriteItem", input)
  const entries = Object.entries(input.RequestItems ?? {})
  if (entries.length === 0) refuse("BatchWriteItem cannot have a null or no requests set")
  const total = entries.reduce((sum, [, requests]) => sum + requests.length, 0)
  if (total > 25) refuse(TOO_MANY_BATCH_WRITES)
  const writes: Array<TableWrite> = []
  for (const [table, requests] of entries) {
    if (requests.length === 0) {
      refuse(`The batch write request list for a table cannot be null or empty: ${table}`)
    }
    const schema = tables.schema(table)
    const indexes = tables.indexes(table)
    const identities: Array<string> = []
    for (const request of requests) {
      const kinds = ["PutRequest", "DeleteRequest"].filter((kind) => request[kind] !== undefined)
      if (
        kinds.length !== 1 ||
        Object.keys(request).some((k) => request[k] !== undefined && !kinds.includes(k))
      ) {
        unreadable(
          "the BatchWriteItem request",
          shown(request),
          "not exactly one PutRequest or DeleteRequest",
        )
      }
      if (request.PutRequest !== undefined) {
        const item = checkItem(request.PutRequest.Item, schema)
        const problem = putIndexProblem(item, indexes, schema)
        if (problem?.message === INVALID_VALUE_TYPE) {
          unreadable(
            "the BatchWriteItem request",
            shown(request),
            `${problem.message} (unmeasured)`,
          )
        }
        if (problem !== undefined) refuse(problem.message)
        const key = keyOfItem(item, schema)
        identities.push(keyIdentity(table, key, keyAttributes(schema)))
        writes.push({ table, key, item: putWritten(item) })
      } else {
        const key = checkKey(request.DeleteRequest.Key, schema)
        identities.push(keyIdentity(table, key, keyAttributes(schema)))
        writes.push({ table, key, item: undefined })
      }
    }
    if (new Set(identities).size !== identities.length) refuse(DDB_REPEATED_BATCH_ITEM)
  }
  return writes
}

/** The attributes a condition names at its top level. */
const conditionAttributes = (condition: Condition): ReadonlyArray<string> => {
  const operandNames = (operand: Operand) =>
    operand.kind === "value" ? [] : [operand.path[0] as string]
  switch (condition.kind) {
    case "and":
    case "or":
      return [...conditionAttributes(condition.left), ...conditionAttributes(condition.right)]
    case "not":
      return conditionAttributes(condition.inner)
    case "exists":
    case "type":
      return [condition.path[0] as string]
    case "compare":
      return [...operandNames(condition.left), ...operandNames(condition.right)]
    case "between":
      return [condition.subject, condition.low, condition.high].flatMap(operandNames)
    case "in":
      return [condition.subject, ...condition.options].flatMap(operandNames)
    default:
      return [...operandNames(condition.subject), ...operandNames(condition.operand)]
  }
}

/** The parts of a key condition: `AND`ed comparisons, `BETWEEN`s and `begins_with`s, each on a key attribute. */
const keyConditionParts = (condition: Condition): ReadonlyArray<Condition> => {
  if (condition.kind === "and") {
    return [...keyConditionParts(condition.left), ...keyConditionParts(condition.right)]
  }
  if (condition.kind === "or" || condition.kind === "not") {
    return refuse(
      `Invalid operator used in KeyConditionExpression: ${condition.kind.toUpperCase()}`,
    )
  }
  if (condition.kind === "compare" && condition.op === "<>") {
    return refuse("Invalid operator used in KeyConditionExpression: <>")
  }
  if (
    condition.kind === "compare" ||
    condition.kind === "between" ||
    condition.kind === "begins_with"
  ) {
    return [condition]
  }
  return unreadable(
    "the KeyConditionExpression part",
    condition.kind,
    "not a key condition (unmeasured wording)",
  )
}

export interface QueryInput extends ExpressionInput {
  readonly TableName?: string | undefined
  readonly IndexName?: string | undefined
  readonly ScanIndexForward?: boolean | undefined
  readonly Limit?: number | undefined
  readonly ExclusiveStartKey?: Item | undefined
  readonly ConsistentRead?: boolean | undefined
  readonly Select?: string | undefined
  readonly Segment?: number | undefined
  readonly TotalSegments?: number | undefined
}

/** A read's index: its name, its keys and whether it is local. */
interface ReadIndex {
  readonly name: string
  readonly schema: IndexSchema
  readonly local: boolean
}

/**
 * What a read returns of each row, `Select` and `ProjectionExpression` checked as DynamoDB Local
 * checks them: `undefined` for a count; on an index, its projected attributes by default; a
 * global index's projection refuses `ALL_ATTRIBUTES` and names outside it; a local index's reads
 * any attribute (DynamoDB fetches it from the table).
 */
const shapeOf = (
  input: QueryInput,
  expressions: Expressions,
  table: KeySchema,
  index: ReadIndex | undefined,
): ((row: Item) => Item) | undefined => {
  const projection = expressions.projection
  const select = input.Select
  if (
    select !== undefined &&
    !["ALL_ATTRIBUTES", "ALL_PROJECTED_ATTRIBUTES", "COUNT", "SPECIFIC_ATTRIBUTES"].includes(select)
  ) {
    unreadable("the Select", select, "not a Select DynamoDB reads (unmeasured wording)")
  }
  if (select === "COUNT" && projection !== undefined) {
    refuse("Cannot specify the ProjectionExpression when choosing to get only the Count")
  }
  if (select === "SPECIFIC_ATTRIBUTES" && projection === undefined) {
    refuse(
      "Must specify the AttributesToGet or ProjectionExpression when choosing to get SPECIFIC_ATTRIBUTES",
    )
  }
  if (select === "ALL_ATTRIBUTES" && projection !== undefined) {
    refuse("Cannot specify the ProjectionExpression when choosing to get ALL_ATTRIBUTES")
  }
  if (select === "ALL_PROJECTED_ATTRIBUTES") {
    if (index === undefined) {
      refuse("ALL_PROJECTED_ATTRIBUTES can be used only when Querying using an IndexName")
    }
    if (projection !== undefined) {
      unreadable("the Select", select, "with a ProjectionExpression (unmeasured)")
    }
  }
  const projected = index === undefined ? undefined : projectedBy(index.schema, table)
  if (select === "COUNT") return undefined
  if (projection !== undefined) return (row) => project(row, projection)
  if (select === "ALL_ATTRIBUTES" || projected === undefined) return (row) => row
  return (row) => {
    const out: Item = {}
    for (const name of Object.keys(row)) {
      if (projected.has(name)) setOwn(out, name, row[name]!)
    }
    return out
  }
}

/**
 * A query of an index whose projection isn't `ALL`: a filter naming an attribute it doesn't hold
 * is refused, then (of a global index) `ALL_ATTRIBUTES`, then a `ProjectionExpression` naming one.
 */
const checkProjected = (
  input: QueryInput,
  expressions: Expressions,
  table: KeySchema,
  index: ReadIndex | undefined,
): void => {
  const projected = index === undefined ? undefined : projectedBy(index.schema, table)
  if (index === undefined || projected === undefined) return
  const outside = (names: ReadonlyArray<string>) =>
    theProblem(
      names.filter((name) => !projected.has(name)),
      `the attributes ${index.name} doesn't project`,
    )
  const filtered =
    expressions.filter === undefined ? undefined : outside(conditionAttributes(expressions.filter))
  if (filtered !== undefined) {
    refuse(
      `One or more parameter values were invalid: Secondary index ${index.name} does not project one or more filter attributes: [${filtered}]`,
    )
  }
  if (!index.local && input.Select === "ALL_ATTRIBUTES") {
    refuse(
      `One or more parameter values were invalid: Select type ALL_ATTRIBUTES is not supported for global secondary index ${index.name} because its projection type is not ALL`,
    )
  }
  if (!index.local && expressions.projection !== undefined) {
    const named = outside(expressions.projection.map((path) => path[0] as string))
    if (named !== undefined) {
      refuse(
        `One or more parameter values were invalid: Global secondary index ${index.name} does not project [${named}]`,
      )
    }
  }
}

const START_INVALID = "The provided starting key is invalid"
const START_SIZE = "Exclusive Start Key must have same size as table's key schema"
const START_TYPE = "Type mismatch for attribute to update"
const START_PREDICATE = "The provided starting key does not match the range key predicate"

/**
 * An `ExclusiveStartKey` checked as DynamoDB Local checks it: it names exactly the table's key
 * attributes (and, for an index, the index's), of their types and not empty. A read of the table
 * or a local index refuses a key of another size before one naming other attributes; a global
 * index's, any key not naming exactly those attributes.
 */
const checkStartKey = (start: Item, table: KeySchema, index: ReadIndex | undefined): void => {
  const given = Object.keys(start)
  if (given.length === 0) refuse(START_INVALID)
  const expected = [
    ...new Set([table.pk, table.sk, ...(index === undefined ? [] : keyAttributes(index.schema))]),
  ]
  const names = expected.every((attribute) => Object.hasOwn(start, attribute))
  if (index === undefined || index.local) {
    if (given.length !== expected.length) refuse(START_SIZE)
    if (!names) refuse(START_INVALID)
  } else if (given.length !== expected.length || !names) {
    refuse(START_INVALID)
  }
  const problems: Array<string> = []
  for (const attribute of expected) {
    const value = start[attribute]!
    const type = keyTypeIn(index?.schema, table, attribute)
    if (typeOf(value) !== type) problems.push(START_TYPE)
    else if (isEmptyKeyValue(value)) {
      const ofTable = attribute === table.pk || attribute === table.sk
      if (!ofTable && type === "B") {
        unreadable("the ExclusiveStartKey", shown(start), "an empty binary key (unmeasured)")
      }
      const partition = attribute === table.pk || attribute === index?.schema.pk
      problems.push(
        `${partition ? "The query can return at most one row and cannot be restarted. " : ""}${START_INVALID}: ${ofTable ? EMPTY_KEY(attribute) : indexEmpty(index!.name, attribute, false)}`,
      )
    }
  }
  const problem = theProblem(problems, "the ExclusiveStartKey")
  if (problem !== undefined) refuse(problem)
}

/**
 * A read's page: the rows it examined (after `ExclusiveStartKey`, up to `Limit`), filtered and
 * shaped. A read that stops at its `Limit` says where (`LastEvaluatedKey`), even when nothing is
 * left after that row, unless `endsAt` says the row is the last its key condition can reach.
 */
const page = (
  input: QueryInput,
  rows: ReadonlyArray<Item>,
  expressions: Expressions,
  shape: ((row: Item) => Item) | undefined,
  lastKey: (row: Item) => Item,
  endsAt: (row: Item) => boolean = () => false,
) => {
  if (input.Limit !== undefined && !(Number.isInteger(input.Limit) && input.Limit >= 1)) {
    unreadable("the Limit", String(input.Limit), "not a positive integer (unmeasured wording)")
  }
  const examined = input.Limit === undefined ? rows : rows.slice(0, input.Limit)
  const last = examined[examined.length - 1]
  const more =
    last !== undefined &&
    (examined.length < rows.length || (examined.length === input.Limit && !endsAt(last)))
  const kept = examined.filter(
    (row) => expressions.filter === undefined || evaluate(expressions.filter, row),
  )
  return {
    ...(shape !== undefined && { Items: kept.map((row) => asRead(shape(row))) }),
    Count: kept.length,
    ScannedCount: examined.length,
    ...(more && { LastEvaluatedKey: lastKey(last) }),
  }
}

const CONDITION_TYPE =
  "One or more parameter values were invalid: Condition parameter type does not match schema type"

/** The literal values a key condition part compares its attribute with, or a defect for any other operand. */
const keyOperands = (part: Condition): ReadonlyArray<AttributeValue> => {
  const operands =
    part.kind === "compare"
      ? [part.left, part.right]
      : part.kind === "between"
        ? [part.subject, part.low, part.high]
        : part.kind === "begins_with"
          ? [part.subject, part.operand]
          : []
  const values = operands.filter((operand) => operand.kind !== "path")
  if (values.some((operand) => operand.kind !== "value") || values.length !== operands.length - 1) {
    unreadable("the KeyConditionExpression part", shown(part), "an operand that isn't a value")
  }
  return values.map((operand) => (operand as ValueNode).value!)
}

/**
 * The sort key value a key condition part ends its range at, read in `forward` order, when the
 * range includes it: `<=` (or `BETWEEN`'s high value) forward, `>=` (or the low value) in reverse.
 * DynamoDB Local returns no `LastEvaluatedKey` when a table read's `Limit` stops on that row.
 */
const inclusiveEnd = (
  part: Condition | undefined,
  forward: boolean,
): AttributeValue | undefined => {
  if (part === undefined) return undefined
  if (part.kind === "between") return forward ? literal(part.high) : literal(part.low)
  if (part.kind !== "compare") return undefined
  const flipped: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" }
  const op = part.left.kind === "path" ? part.op : (flipped[part.op] ?? part.op)
  const value = literal(part.left) ?? literal(part.right)
  return (forward ? op === "<=" : op === ">=") ? value : undefined
}

/**
 * DynamoDB Local orders an index's rows of one key by something of its own (measured: no order of
 * their table keys). A read whose rows would depend on that order is a defect naming it: a `Limit`
 * stopping between two of them, or an `ExclusiveStartKey` among them. Rows of one key that one
 * answer returns together come in table-key order, where DynamoDB Local's differs (listed at the
 * top of this module).
 */
const unorderedTies = (
  input: QueryInput,
  matched: ReadonlyArray<Item>,
  schema: KeySchema,
  table: KeySchema,
  start: Item | undefined,
): void => {
  const tie = (a: Item, b: Item) => sameValue(a[schema.sk]!, b[schema.sk]!)
  const sameRow = (a: Item, b: Item) =>
    sameValue(a[table.pk]!, b[table.pk]!) && sameValue(a[table.sk]!, b[table.sk]!)
  const what = `rows of one ${schema.sk} (DynamoDB Local's order among them is not modelled)`
  if (start !== undefined && matched.some((row) => tie(row, start) && !sameRow(row, start))) {
    unreadable("the ExclusiveStartKey", shown(start), `among ${what}`)
  }
  const from =
    start === undefined
      ? matched
      : matched.filter((row) => compareKeyValues(row[schema.sk]!, start[schema.sk]!) !== 0)
  const limit = input.Limit ?? from.length
  const examined = from.slice(0, limit)
  const last = examined[examined.length - 1]
  const next = from[examined.length]
  if (last !== undefined && next !== undefined && tie(last, next)) {
    unreadable("the Limit", String(input.Limit), `stopping between ${what}`)
  }
}

/**
 * A `Query`'s output over `rows` (every item of the table), on the table's keys or one of
 * `indexes`: `Select`, the key condition, the projection and the `ExclusiveStartKey` checked as
 * DynamoDB Local checks them; rows in sort-key order (then by table key); paged by
 * `ExclusiveStartKey` / `Limit` (rows examined before the filter), filtered and shaped.
 */
export const query = (
  input: QueryInput,
  rows: ReadonlyArray<Item>,
  table: KeySchema,
  indexes: Indexes,
) => {
  checkFields("Query", input)
  const expressions = readExpressions(input)
  if (expressions.keyCondition === undefined) {
    return unreadable("the Query", shown(input), "no KeyConditionExpression")
  }
  let index: ReadIndex | undefined
  if (input.IndexName !== undefined) {
    const schema = own(indexes, input.IndexName)
    if (schema === undefined) {
      return unreadable("the IndexName", input.IndexName, "not an index the table declares")
    }
    index = { name: input.IndexName, schema, local: isLocal(input.IndexName, schema, table) }
  }
  const shape = shapeOf(input, expressions, table, index)
  if (index !== undefined && !index.local && input.ConsistentRead === true) {
    refuse("Consistent reads are not supported on global secondary indexes")
  }
  const schema = index?.schema ?? table
  const parts = keyConditionParts(expressions.keyCondition)
  const on = (part: Condition): string | undefined => {
    const attributes = conditionAttributes(part)
    return attributes.length === 1 ? attributes[0] : undefined
  }
  for (const attribute of keyAttributes(schema)) {
    if (parts.filter((part) => on(part) === attribute).length > 1) {
      refuse("KeyConditionExpressions must only contain one condition per key")
    }
  }
  const partition = parts.find((part) => on(part) === schema.pk)
  if (
    partition === undefined ||
    partition.kind !== "compare" ||
    partition.op !== "=" ||
    parts.length > 2 ||
    parts.some((part) => on(part) !== schema.pk && on(part) !== schema.sk)
  ) {
    return refuse("Query condition missed key schema element")
  }
  const sort = parts.find((part) => on(part) === schema.sk)
  for (const part of [partition, sort]) {
    if (part === undefined) continue
    const attribute = on(part)!
    const type = keyTypeIn(index?.schema, table, attribute)
    for (const value of keyOperands(part)) {
      if (isEmptyKeyValue(value)) {
        refuse(
          attribute === table.pk || attribute === table.sk
            ? EMPTY_KEY(attribute)
            : indexEmpty(index!.name, attribute, value.B !== undefined),
        )
      }
      if (typeOf(value) !== type) refuse(CONDITION_TYPE)
    }
  }
  if (expressions.filter !== undefined) {
    const named = conditionAttributes(expressions.filter).find(
      (attribute) => attribute === schema.pk || attribute === schema.sk,
    )
    if (named !== undefined) {
      refuse(
        `Filter Expression can only contain non-primary key attributes: Primary key attribute: ${named}`,
      )
    }
  }
  checkProjected(input, expressions, table, index)
  const forward = input.ScanIndexForward !== false
  // Measured: a read of the table's own keys treats its range's inclusive end, in the direction
  // it reads, as exclusive: it stops there without a key, and won't start from it.
  const end = index === undefined ? inclusiveEnd(sort, forward) : undefined
  const start = input.ExclusiveStartKey
  if (start !== undefined) {
    checkStartKey(start, table, index)
    if (
      !parts.every((part) => evaluate(part, start)) ||
      (end !== undefined && sameValue(start[schema.sk]!, end))
    ) {
      refuse(START_PREDICATE)
    }
  }
  const tableOrder = (a: Item, b: Item) =>
    compareKeyValues(a[table.pk]!, b[table.pk]!) || compareKeyValues(a[table.sk]!, b[table.sk]!)
  const compare = (a: Item, b: Item) =>
    compareKeyValues(a[schema.sk]!, b[schema.sk]!) || (index === undefined ? 0 : tableOrder(a, b))
  let matched = rows
    .filter(
      (row) =>
        own(row, schema.pk) !== undefined &&
        own(row, schema.sk) !== undefined &&
        parts.every((part) => evaluate(part, row)),
    )
    .sort(compare)
  if (!forward) matched.reverse()
  if (index !== undefined) unorderedTies(input, matched, schema, table, start)
  if (start !== undefined) {
    matched = matched.filter((row) => (forward ? compare(row, start) > 0 : compare(row, start) < 0))
  }
  const lastKey = (row: Item): Item => ({
    ...keyOfItem(row, table),
    ...(index !== undefined && keyOfItem(row, index.schema)),
  })
  const endsAt = (row: Item) => end !== undefined && sameValue(row[schema.sk]!, end)
  return page(input, matched, expressions, shape, lastKey, endsAt)
}

/**
 * A `Scan`'s output over `rows`, which the table gives in its own order with `Segment` /
 * `TotalSegments` already applied: `Select` and the `ExclusiveStartKey` checked as DynamoDB Local
 * checks them, paged by `ExclusiveStartKey` (`after` gives the rows past it) and `Limit`,
 * filtered and shaped.
 */
export const scan = (
  input: QueryInput,
  rows: ReadonlyArray<Item>,
  table: KeySchema,
  after: (start: Item) => ReadonlyArray<Item>,
) => {
  checkFields("Scan", input)
  const expressions = readExpressions(input)
  const shape = shapeOf(input, expressions, table, undefined)
  const start = input.ExclusiveStartKey
  if (start !== undefined) checkStartKey(start, table, undefined)
  const from = start === undefined ? rows : after(start)
  return page(input, from, expressions, shape, (row) => keyOfItem(row, table))
}

/** Run `answer`; a refusal becomes `onRefusal`'s failure, anything else thrown stays a defect. */
export const answering = <A, B>(answer: () => A, onRefusal: (error: Error) => B): A | B => {
  try {
    return answer()
  } catch (error) {
    if (isRefusal(error)) return onRefusal(error)
    throw error
  }
}
