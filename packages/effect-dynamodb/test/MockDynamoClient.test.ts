/**
 * `helpers/MockDynamoClient.ts`'s `applyUpdate`, which the in-memory tables answer `UpdateItem`
 * (and a transaction's `Update`) with (#243):
 *
 * - **Names are looked up as the item's own attributes.** On a plain object, `constructor`,
 *   `toString` and `__proto__` are names every item inherits: an `if_not_exists` on a missing
 *   `constructor` read `Object`'s constructor and stored it, and a `SET` of `__proto__` replaced
 *   the item's prototype instead of storing an attribute.
 * - **An update DynamoDB rejects is rejected**, with DynamoDB Local's `ValidationException` and
 *   message, and the item is left as it was. Measured on DynamoDB Local: an operand naming an
 *   attribute, map key or list element the item doesn't hold ("The provided expression refers to
 *   an attribute that does not exist in the item"), a path below one it doesn't hold or below one
 *   that isn't a map or list ("The document path provided in the update expression is invalid for
 *   update"), `-` on a string, `list_append` of one, or an `ADD` / `DELETE` whose value isn't of the
 *   attribute's type ("An operand in the update expression has an incorrect data type"). Before, the update was taken, and only the `version` attribute moved.
 * - **It computes as DynamoDB Local does**: numbers exactly (`9007199254740993 + 1`, `0.1 + 0.2`),
 *   a number set's members by value, a list index past the end as an append and `REMOVE`s of
 *   several indexes on the list as it was, `ADD` below a map and of a binary set. It refuses an
 *   operand of a type the action can't take, an empty set, overlapping paths and an
 *   `if_not_exists` whose fallback is missing, with DynamoDB Local's message, and of two problems
 *   in one update reports the one DynamoDB Local reports. Before, it computed with doubles, left
 *   holes in a list, removed the wrong elements and took the rest.
 * - **An expression it can't read is a defect, never approximated**; before, one only bumped
 *   `version`.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "vitest"
import {
  applyUpdate,
  DDB_UPDATE_INVALID_PATH,
  DDB_UPDATE_MISSING_ATTRIBUTE,
  DDB_UPDATE_OPERAND_TYPE,
  updateOutcome,
} from "./helpers/MockDynamoClient.js"

type Item = Record<string, AttributeValue>

const row = (attributes: Item = {}): Item => ({
  pk: { S: "p" },
  sk: { S: "s" },
  version: { N: "1" },
  ...attributes,
})

const update = (
  item: Item,
  expression: string,
  names: Record<string, string>,
  values?: Record<string, AttributeValue>,
) =>
  updateOutcome(item, {
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    // DynamoDB refuses an empty `ExpressionAttributeValues`, so a value-free update sends none.
    ...(values !== undefined && { ExpressionAttributeValues: values }),
  })

const updated = (outcome: ReturnType<typeof update>): Item => {
  if (outcome._tag !== "Updated") throw outcome.error
  return outcome.item
}

const refusal = (outcome: ReturnType<typeof update>) =>
  outcome._tag === "Refused"
    ? { name: outcome.error.name, message: outcome.error.message }
    : { updated: outcome.item }

describe("applyUpdate looks a name up as the item's own attribute", () => {
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    it(`if_not_exists on a missing \`${name}\` writes the value given`, () => {
      const next = updated(
        update(row(), "SET #f = if_not_exists(#f, :v)", { "#f": name }, { ":v": { N: "3" } }),
      )
      expect(Object.hasOwn(next, name)).toBe(true)
      expect(next[name]).toEqual({ N: "3" })
    })

    it(`if_not_exists on a held \`${name}\` keeps it`, () => {
      const next = updated(
        update(
          row({ [name]: { N: "1" } }),
          "SET #f = if_not_exists(#f, :v)",
          { "#f": name },
          { ":v": { N: "3" } },
        ),
      )
      expect(next[name]).toEqual({ N: "1" })
    })

    it(`\`${name}\` + :n on an item without it is refused`, () => {
      expect(
        refusal(update(row(), "SET #f = #f + :n", { "#f": name }, { ":n": { N: "1" } })),
      ).toEqual({ name: "ValidationException", message: DDB_UPDATE_MISSING_ATTRIBUTE })
    })

    it(`ADD to a missing \`${name}\` starts from zero, and a map key \`${name}\` likewise`, () => {
      const next = updated(
        update(
          row({ m: { M: {} } }),
          "ADD #f :n, #m.#f :n",
          { "#f": name, "#m": "m" },
          { ":n": { N: "2" } },
        ),
      )
      expect(next[name]).toEqual({ N: "2" })
      expect(next.m).toEqual({ M: { [name]: { N: "2" } } })
    })

    it(`a condition-free REMOVE of a missing \`${name}\` changes nothing`, () => {
      const before = row({ m: { M: {} } })
      const next = updated(update(before, "REMOVE #f, #m.#f", { "#f": name, "#m": "m" }))
      expect(next).toEqual(before)
    })
  }

  it("a SET of `__proto__` stores an attribute, and leaves the prototype alone", () => {
    const next = updated(
      update(
        row(),
        "SET #f = :v, #m = :m",
        { "#f": "__proto__", "#m": "m" },
        {
          ":v": { S: "x" },
          ":m": { M: {} },
        },
      ),
    )
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype)
    expect(Object.hasOwn(next, "__proto__")).toBe(true)
    expect(Object.getOwnPropertyDescriptor(next, "__proto__")?.value).toEqual({ S: "x" })
    const nested = updated(
      update(next, "SET #m.#f = :v", { "#f": "__proto__", "#m": "m" }, { ":v": { N: "1" } }),
    )
    expect(Object.getPrototypeOf(nested.m!.M)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(nested.m!.M, "__proto__")?.value).toEqual({ N: "1" })
  })

  it("an update DynamoDB refuses for a function is refused, never approximated", () => {
    // Before, an expression it couldn't read (here `size()`) only bumped `version`, so the test
    // passed whatever the update said; DynamoDB refuses it, as measured on DynamoDB Local.
    expect(
      refusal(update(row({ a: { N: "1" } }), "SET #a = size(#b)", { "#a": "a", "#b": "b" })),
    ).toEqual({
      name: "ValidationException",
      message:
        "Invalid UpdateExpression: The function is not allowed in an update expression; function: size",
    })
  })
})

describe("applyUpdate refuses what DynamoDB refuses, and the item is left as it was", () => {
  const cases: ReadonlyArray<{
    readonly label: string
    readonly expression: string
    readonly names: Record<string, string>
    readonly values?: Record<string, AttributeValue>
    readonly message: string
  }> = [
    {
      label: "#a - :n, #a missing",
      expression: "SET #a = #a - :n",
      names: { "#a": "a" },
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: ":n - #a, #a missing",
      expression: "SET #a = :n - #a",
      names: { "#a": "a" },
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "list_append(#a, :l), #a missing",
      expression: "SET #a = list_append(#a, :l)",
      names: { "#a": "a" },
      values: { ":l": { L: [{ S: "x" }] } },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "list_append(:l, #a), #a missing",
      expression: "SET #a = list_append(:l, #a)",
      names: { "#a": "a" },
      values: { ":l": { L: [{ S: "x" }] } },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "#b = #a, #a missing",
      expression: "SET #b = #a",
      names: { "#a": "a", "#b": "b" },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "#m.#k2 = #m.#zz, the map key missing",
      expression: "SET #m.#k2 = #m.#zz",
      names: { "#m": "m", "#k2": "k2", "#zz": "zz" },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "#l[5] = #l[3], the list element missing",
      expression: "SET #l[5] = #l[3]",
      names: { "#l": "l" },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "one good clause and one reading a missing attribute",
      expression: "SET #x = :x, #a = #a - :n",
      names: { "#a": "a", "#x": "x" },
      values: { ":n": { N: "1" }, ":x": { S: "x" } },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "SET below a missing attribute",
      expression: "SET #z.#y = :v",
      names: { "#z": "z", "#y": "y" },
      values: { ":v": { S: "v" } },
      message: DDB_UPDATE_INVALID_PATH,
    },
    {
      label: "SET below a number",
      expression: "SET #n.#y = :v",
      names: { "#n": "n", "#y": "y" },
      values: { ":v": { S: "v" } },
      message: DDB_UPDATE_INVALID_PATH,
    },
    {
      label: "REMOVE below a missing attribute",
      expression: "REMOVE #z.#y",
      names: { "#z": "z", "#y": "y" },
      message: DDB_UPDATE_INVALID_PATH,
    },
    {
      label: "ADD below a missing attribute",
      expression: "ADD #z.#y :n",
      names: { "#z": "z", "#y": "y" },
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_INVALID_PATH,
    },
    {
      label: "#a = #s - :n, #s a string",
      expression: "SET #a = #s - :n",
      names: { "#a": "a", "#s": "s" },
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
    {
      label: "list_append(#s, :l), #s a string",
      expression: "SET #a = list_append(#s, :l)",
      names: { "#a": "a", "#s": "s" },
      values: { ":l": { L: [] } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
    {
      label: "ADD a number to a string",
      expression: "ADD #s :n",
      names: { "#s": "s" },
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
    {
      label: "ADD a set to a number",
      expression: "ADD #n :ss",
      names: { "#n": "n" },
      values: { ":ss": { SS: ["x"] } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
    {
      label: "ADD a number set to a string set",
      expression: "ADD #ss :ns",
      names: { "#ss": "ss" },
      values: { ":ns": { NS: ["2"] } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
    {
      label: "DELETE a set from a string",
      expression: "DELETE #s :ss",
      names: { "#s": "s" },
      values: { ":ss": { SS: ["x"] } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
    {
      label: "DELETE a number set from a string set",
      expression: "DELETE #ss :ns",
      names: { "#ss": "ss" },
      values: { ":ns": { NS: ["1"] } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
  ]
  const held = () =>
    row({
      n: { N: "1" },
      s: { S: "s" },
      m: { M: { k: { S: "v" } } },
      l: { L: [{ S: "0" }] },
      ss: { SS: ["a"] },
    })
  for (const each of cases) {
    it(each.label, () => {
      const item = held()
      expect(refusal(update(item, each.expression, each.names, each.values))).toEqual({
        name: "ValidationException",
        message: each.message,
      })
      expect(item).toEqual(held())
      expect(() =>
        applyUpdate(item, {
          UpdateExpression: each.expression,
          ExpressionAttributeNames: each.names,
          ExpressionAttributeValues: each.values,
        }),
      ).toThrow(each.message)
    })
  }

  it("on an item that isn't there, `#v + :one` is refused", () => {
    expect(
      refusal(
        update(
          { pk: { S: "p" }, sk: { S: "s" } },
          "SET #v = #v + :one",
          { "#v": "version" },
          { ":one": { N: "1" } },
        ),
      ),
    ).toEqual({ name: "ValidationException", message: DDB_UPDATE_MISSING_ATTRIBUTE })
  })

  it("what DynamoDB takes is taken: if_not_exists, ADD and DELETE on missing attributes", () => {
    const next = updated(
      update(
        row(),
        "SET #a = list_append(if_not_exists(#a, :e), :l), #v = if_not_exists(#v, :zero) + :one " +
          "ADD #c :one DELETE #s :ss REMOVE #r",
        { "#a": "a", "#v": "views", "#c": "c", "#s": "set", "#r": "r" },
        {
          ":e": { L: [] },
          ":l": { L: [{ S: "x" }] },
          ":zero": { N: "0" },
          ":one": { N: "1" },
          ":ss": { SS: ["a"] },
        },
      ),
    )
    expect(next).toEqual(row({ a: { L: [{ S: "x" }] }, views: { N: "1" }, c: { N: "1" } }))
  })
})

/**
 * Each case here is a row of `connected.helper-conformance.test.ts`, which sends it to DynamoDB
 * Local and to both tables: the answers below are DynamoDB Local's.
 */
describe("applyUpdate computes as DynamoDB Local does", () => {
  const bytes = (...values: Array<number>) => new Uint8Array(values)
  const held = () =>
    row({
      n: { N: "5" },
      big: { N: "9007199254740993" },
      dec: { N: "0.1" },
      s: { S: "x" },
      m: { M: { k: { N: "1" }, l: { L: [{ N: "1" }, { N: "2" }] }, inner: { M: {} } } },
      l: { L: [{ N: "1" }, { N: "2" }, { M: { a: { N: "1" } } }] },
      ss: { SS: ["a", "b"] },
      ns: { NS: ["1", "2"] },
      bs: { BS: [bytes(1), bytes(2)] },
    })
  const list = held().l!.L!
  const taken: ReadonlyArray<{
    readonly label: string
    readonly expression: string
    readonly values?: Record<string, AttributeValue>
    readonly changed: Item
  }> = [
    // Numbers are exact: Java's BigDecimal, never a double.
    {
      label: "SET: 9007199254740993 + 1",
      expression: "SET #big = #big + :n",
      values: { ":n": { N: "1" } },
      changed: { big: { N: "9007199254740994" } },
    },
    {
      label: "ADD: 9007199254740993 + 1",
      expression: "ADD #big :n",
      values: { ":n": { N: "1" } },
      changed: { big: { N: "9007199254740994" } },
    },
    {
      label: "SET: 0.1 + 0.2",
      expression: "SET #dec = #dec + :n",
      values: { ":n": { N: "0.2" } },
      changed: { dec: { N: "0.3" } },
    },
    {
      label: "ADD: 0.1 + 0.2",
      expression: "ADD #dec :n",
      values: { ":n": { N: "0.2" } },
      changed: { dec: { N: "0.3" } },
    },
    // A number set's members compare by value.
    {
      label: "ADD {1.0, 3} to {1, 2}",
      expression: "ADD #ns :v",
      values: { ":v": { NS: ["1.0", "3"] } },
      changed: { ns: { NS: ["1", "2", "3"] } },
    },
    {
      label: "DELETE {1.0} from {1, 2}",
      expression: "DELETE #ns :v",
      values: { ":v": { NS: ["1.0"] } },
      changed: { ns: { NS: ["2"] } },
    },
    {
      label: "ADD a binary set",
      expression: "ADD #bs :v",
      values: { ":v": { BS: [bytes(3)] } },
      changed: { bs: { BS: [bytes(1), bytes(2), bytes(3)] } },
    },
    // An index past a list's end appends, in index order; REMOVEs index the list as it was.
    {
      label: "SET l[5] on a list of three appends",
      expression: "SET #l[5] = :v",
      values: { ":v": { N: "9" } },
      changed: { l: { L: [...list, { N: "9" }] } },
    },
    {
      label: "SET l[5], l[3] on a list of three: l[3] first",
      expression: "SET #l[5] = :v, #l[3] = :w",
      values: { ":v": { N: "7" }, ":w": { N: "8" } },
      changed: { l: { L: [...list, { N: "8" }, { N: "7" }] } },
    },
    {
      label: "SET l[3], l[5] on a list of three",
      expression: "SET #l[3] = :v, #l[5] = :w",
      values: { ":v": { N: "7" }, ":w": { N: "8" } },
      changed: { l: { L: [...list, { N: "7" }, { N: "8" }] } },
    },
    {
      label: "REMOVE l[0], l[1] removes the first two",
      expression: "REMOVE #l[0], #l[1]",
      changed: { l: { L: [list[2]!] } },
    },
    // ADD below a map.
    {
      label: "ADD m.k",
      expression: "ADD #m.#k :n",
      values: { ":n": { N: "1" } },
      changed: { m: { M: { ...held().m!.M!, k: { N: "2" } } } },
    },
    {
      label: "ADD m.zz, a key the map doesn't hold",
      expression: "ADD #m.#zz :n",
      values: { ":n": { N: "1" } },
      changed: { m: { M: { ...held().m!.M!, zz: { N: "1" } } } },
    },
    // Whitespace is optional.
    {
      label: "SET #s=:v",
      expression: "SET #s=:v",
      values: { ":v": { S: "y" } },
      changed: { s: { S: "y" } },
    },
  ]
  for (const each of taken) {
    it(`${each.label}: taken`, () => {
      const names = Object.fromEntries(
        [...each.expression.matchAll(/#(\w+)/g)].map((match) => [`#${match[1]}`, match[1]!]),
      )
      expect(updated(update(held(), each.expression, names, each.values))).toEqual({
        ...held(),
        ...each.changed,
      })
    })
  }

  const refused: ReadonlyArray<{
    readonly label: string
    readonly expression: string
    readonly values?: Record<string, AttributeValue>
    readonly message: string
  }> = [
    // An operand of a type the action can't take, checked before the item is read.
    {
      label: "ADD a list",
      expression: "ADD #l :v",
      values: { ":v": { L: [{ N: "1" }] } },
      message:
        "Invalid UpdateExpression: Incorrect operand type for operator or function; operator: ADD, operand type: LIST, typeSet: ALLOWED_FOR_ADD_OPERAND",
    },
    {
      label: "ADD a string",
      expression: "ADD #n :v",
      values: { ":v": { S: "a" } },
      message:
        "Invalid UpdateExpression: Incorrect operand type for operator or function; operator: ADD, operand type: STRING, typeSet: ALLOWED_FOR_ADD_OPERAND",
    },
    {
      label: "DELETE a number",
      expression: "DELETE #ss :v",
      values: { ":v": { N: "1" } },
      message:
        "Invalid UpdateExpression: Incorrect operand type for operator or function; operator: DELETE, operand type: NUMBER, typeSet: ALLOWED_FOR_DELETE_OPERAND",
    },
    {
      label: "list_append of a string",
      expression: "SET #l = list_append(#l, :v)",
      values: { ":v": { S: "q" } },
      message:
        "Invalid UpdateExpression: Incorrect operand type for operator or function; operator or function: list_append, operand type: S",
    },
    {
      label: "ADD an empty string set",
      expression: "ADD #ss :x",
      values: { ":x": { SS: [] } },
      message:
        "ExpressionAttributeValues contains invalid value: One or more parameter values were invalid: An string set  may not be empty for key :x",
    },
    // Paths that overlap.
    {
      label: "SET a REMOVE a",
      expression: "SET #a = :v REMOVE #a",
      values: { ":v": { N: "1" } },
      message:
        "Invalid UpdateExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [a], path two: [a]",
    },
    {
      label: "SET m REMOVE m.k",
      expression: "SET #m = :v REMOVE #m.#k",
      values: { ":v": { N: "1" } },
      message:
        "Invalid UpdateExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [m], path two: [m, k]",
    },
    // if_not_exists reads its second operand too.
    {
      label: "if_not_exists(n, zz), n held, zz missing",
      expression: "SET #a = if_not_exists(#n, #zz)",
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    // Two problems in one update: which DynamoDB Local reports.
    { label: "s + zz", expression: "SET #a = #s + #zz", message: DDB_UPDATE_OPERAND_TYPE },
    { label: "zz + s", expression: "SET #a = #zz + #s", message: DDB_UPDATE_MISSING_ATTRIBUTE },
    {
      label: "s + 1, then zz + 1",
      expression: "SET #a = #s + :n, #c = #zz + :n",
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "REMOVE below a missing attribute, then zz + 1",
      expression: "REMOVE #qq.#y SET #a = #zz + :n",
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_MISSING_ATTRIBUTE,
    },
    {
      label: "REMOVE below a missing attribute, then s + 1",
      expression: "REMOVE #qq.#y SET #a = #s + :n",
      values: { ":n": { N: "1" } },
      message: DDB_UPDATE_OPERAND_TYPE,
    },
  ]
  for (const each of refused) {
    it(`${each.label}: refused`, () => {
      const names = Object.fromEntries(
        [...each.expression.matchAll(/#(\w+)/g)].map((match) => [`#${match[1]}`, match[1]!]),
      )
      const item = held()
      expect(refusal(update(item, each.expression, names, each.values))).toEqual({
        name: "ValidationException",
        message: each.message,
      })
      expect(item).toEqual(held())
    })
  }
})
