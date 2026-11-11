/**
 * Condition expressions and what DynamoDB answers for them on one stored item (#238): the cases
 * `internal/ConditionHolds.ts` is checked against. `ConditionHolds.test.ts` runs the evaluator over
 * them; `connected.condition-holds.test.ts` asks DynamoDB Local the same questions, so an answer here
 * is DynamoDB's, not the evaluator's.
 *
 * `holds: "invalid"` is a condition DynamoDB rejects as a request (a `ValidationException`): the
 * evaluator says it can't tell (`undefined`).
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"

export const item: Record<string, AttributeValue> = {
  pk: { S: "condition-holds" },
  n: { N: "5" },
  neg: { N: "-0.25" },
  big: { N: "1200" },
  s: { S: "abc" },
  wide: { S: "～" },
  accent: { S: "é" },
  emoji: { S: "\u{1F600}" },
  b: { B: new Uint8Array([1, 2, 3]) },
  t: { BOOL: true },
  nil: { NULL: true },
  ss: { SS: ["x", "y"] },
  ns: { NS: ["1", "2.5"] },
  l: { L: [{ N: "1" }, { S: "two" }] },
  m: { M: { k: { S: "v" }, n: { N: "3" } } },
  empty: { M: {} },
}

export const names: Record<string, string> = {
  "#n": "n",
  "#neg": "neg",
  "#big": "big",
  "#s": "s",
  "#wide": "wide",
  "#accent": "accent",
  "#emoji": "emoji",
  "#b": "b",
  "#t": "t",
  "#nil": "nil",
  "#ss": "ss",
  "#ns": "ns",
  "#l": "l",
  "#m": "m",
  "#k": "k",
  "#empty": "empty",
  "#missing": "missing",
}

export const values: Record<string, AttributeValue> = {
  ":five": { N: "5.00" },
  ":fiveE": { N: "0.5e1" },
  ":four": { N: "4" },
  ":six": { N: "6" },
  ":negHalf": { N: "-0.5" },
  ":negTenth": { N: "-0.1" },
  ":thousand": { N: "1e3" },
  ":zero": { N: "0" },
  ":one": { N: "1" },
  ":two": { N: "2" },
  ":three": { N: "3" },
  ":fiveS": { S: "5" },
  ":abc": { S: "abc" },
  ":ab": { S: "ab" },
  ":abd": { S: "abd" },
  ":bc": { S: "bc" },
  ":smile": { S: "\u{1F600}" },
  ":x": { S: "x" },
  ":two_s": { S: "two" },
  ":v": { S: "v" },
  ":b12": { B: new Uint8Array([1, 2]) },
  ":b123": { B: new Uint8Array([1, 2, 3]) },
  ":b13": { B: new Uint8Array([1, 3]) },
  ":true": { BOOL: true },
  ":false": { BOOL: false },
  ":null": { NULL: true },
  ":yx": { SS: ["y", "x"] },
  ":ns": { NS: ["2.50", "1"] },
  ":list": { L: [{ N: "1.0" }, { S: "two" }] },
  ":map": { M: { n: { N: "3" }, k: { S: "v" } } },
  ":emptyMap": { M: {} },
  ":typeN": { S: "N" },
  ":typeS": { S: "S" },
  ":typeSS": { S: "SS" },
  ":typeM": { S: "M" },
  ":typeNULL": { S: "NULL" },
}

export type Case = {
  readonly expression: string
  readonly holds: boolean | "invalid"
  /** The evaluator can't tell this one (`undefined`), whatever DynamoDB answers. */
  readonly unsure?: true
}

export const cases: ReadonlyArray<Case> = [
  // Numbers compare by value, whatever their spelling.
  { expression: "#n = :five", holds: true },
  { expression: "#n = :fiveE", holds: true },
  { expression: "#n <> :five", holds: false },
  { expression: "#n < :six", holds: true },
  { expression: "#n <= :four", holds: false },
  { expression: "#n > :four", holds: true },
  { expression: "#n >= :five", holds: true },
  { expression: "#neg > :negHalf", holds: true },
  { expression: "#neg < :negTenth", holds: true },
  { expression: "#neg < :zero", holds: true },
  { expression: "#big > :thousand", holds: true },
  // Values of different types are never equal, and never ordered.
  { expression: "#n = :fiveS", holds: false },
  { expression: "#n <> :fiveS", holds: true },
  { expression: "#n < :fiveS", holds: false },
  { expression: "#n >= :fiveS", holds: false },
  // An operand naming nothing makes a comparison false, except `<>`, which it makes true.
  { expression: "#missing = :five", holds: false },
  { expression: "#missing <> :five", holds: true },
  { expression: ":five <> #missing", holds: true },
  { expression: "#missing <> #m.#missing", holds: true },
  { expression: "#missing = #m.#missing", holds: false },
  { expression: "#missing < :five", holds: false },
  { expression: ":five = #missing", holds: false },
  { expression: "#m.#missing = :v", holds: false },
  { expression: "#l[5] = :one", holds: false },
  // Strings order by their UTF-8 bytes (U+FF5E sorts below U+1F600, as UTF-16 would not).
  { expression: "#s = :abc", holds: true },
  { expression: "#s > :ab", holds: true },
  { expression: "#s < :abd", holds: true },
  { expression: "#wide < :smile", holds: true },
  // Binary orders bytewise.
  { expression: "#b > :b12", holds: true },
  { expression: "#b < :b13", holds: true },
  { expression: "#b = :b123", holds: true },
  // Other types: equality only.
  { expression: "#t = :true", holds: true },
  { expression: "#t = :false", holds: false },
  { expression: "#t <> :false", holds: true },
  { expression: "#nil = :null", holds: true },
  { expression: "#ss = :yx", holds: true },
  { expression: "#ns = :ns", holds: true },
  { expression: "#l = :list", holds: true },
  { expression: "#m = :map", holds: true },
  { expression: "#empty = :emptyMap", holds: true },
  { expression: "#m = :emptyMap", holds: false },
  // Paths into maps and lists.
  { expression: "#m.#k = :v", holds: true },
  { expression: "#l[0] = :one", holds: true },
  { expression: "#l[1] = :two_s", holds: true },
  // BETWEEN and IN.
  { expression: "#n BETWEEN :four AND :six", holds: true },
  { expression: "#n BETWEEN :six AND :four", holds: "invalid" },
  { expression: "#n BETWEEN :one AND :four", holds: false },
  { expression: "#missing BETWEEN :one AND :four", holds: false },
  { expression: "#n IN (:four, :five)", holds: true },
  { expression: "#n IN (:four, :six)", holds: false },
  { expression: "#s IN (:fiveS, :abc)", holds: true },
  // Functions.
  { expression: "attribute_exists(#n)", holds: true },
  { expression: "attribute_exists(#missing)", holds: false },
  { expression: "attribute_not_exists(#missing)", holds: true },
  { expression: "attribute_exists(#m.#k)", holds: true },
  { expression: "attribute_exists(#nil)", holds: true },
  { expression: "attribute_type(#n, :typeN)", holds: true },
  { expression: "attribute_type(#n, :typeS)", holds: false },
  { expression: "attribute_type(#ss, :typeSS)", holds: true },
  { expression: "attribute_type(#m, :typeM)", holds: true },
  { expression: "attribute_type(#nil, :typeNULL)", holds: true },
  { expression: "attribute_type(#missing, :typeN)", holds: false },
  { expression: "begins_with(#s, :ab)", holds: true },
  { expression: "begins_with(#s, :bc)", holds: false },
  { expression: "begins_with(#b, :b12)", holds: true },
  { expression: "begins_with(#missing, :ab)", holds: false },
  { expression: "contains(#s, :bc)", holds: true },
  { expression: "contains(#s, :abd)", holds: false },
  { expression: "contains(#ss, :x)", holds: true },
  { expression: "contains(#ns, :one)", holds: true },
  { expression: "contains(#ns, :two)", holds: false },
  { expression: "contains(#l, :two_s)", holds: true },
  { expression: "contains(#l, :one)", holds: true },
  { expression: "contains(#missing, :x)", holds: false },
  // size: a string's characters (on DynamoDB Local, UTF-16 code units; the evaluator can't tell
  // for a string beyond ASCII), a set's members, a list's elements, a map's keys, a binary's bytes.
  { expression: "size(#s) = :three", holds: true },
  { expression: "size(#accent) = :one", holds: true, unsure: true },
  { expression: "size(#accent) = :two", holds: false, unsure: true },
  { expression: "size(#emoji) = :one", holds: false, unsure: true },
  { expression: "size(#emoji) = :two", holds: true, unsure: true },
  { expression: "size(#ss) = :two", holds: true },
  { expression: "size(#l) = :two", holds: true },
  { expression: "size(#m) = :two", holds: true },
  { expression: "size(#b) = :three", holds: true },
  { expression: "size(#missing) = :zero", holds: false },
  { expression: "size(#missing) <> :zero", holds: true },
  // A value without a size: as if it were absent.
  { expression: "size(#n) = :one", holds: false },
  { expression: "size(#n) <> :one", holds: true },
  { expression: "size(#t) = :one", holds: false },
  { expression: "size(#nil) = :one", holds: false },
  // NOT binds tighter than AND, AND than OR.
  { expression: "NOT #n = :five", holds: false },
  { expression: "NOT #missing = :five", holds: true },
  { expression: "NOT #missing <> :five", holds: false },
  { expression: "NOT #n = :five OR #n = :five", holds: true },
  { expression: "#n = :four AND #n = :five OR #n = :five", holds: true },
  { expression: "#n = :five OR #n = :four AND #n = :four", holds: true },
  { expression: "(#n = :five OR #n = :four) AND #n = :four", holds: false },
  { expression: "NOT (#n = :four OR #n = :six)", holds: true },
  { expression: "(attribute_exists(#n)) AND (NOT (attribute_exists(#missing)))", holds: true },
]
