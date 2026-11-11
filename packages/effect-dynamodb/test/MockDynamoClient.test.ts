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
