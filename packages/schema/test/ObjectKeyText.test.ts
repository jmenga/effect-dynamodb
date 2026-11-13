/**
 * The object key decision (#242, `EDD-9162`), made where a key is composed: under a write's own
 * schema (`objectKeys`) an object composing `[object Object]` throws the refusal from the composer;
 * a key the composer doesn't compose (a sparse index missing a value) never reaches it; a schema
 * without `objectKeys` composes the text as it always did.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import { defaultObjectText, judgeObjectKeyText } from "../src/internal/ObjectKeyText.js"
import * as KeyComposer from "../src/KeyComposer.js"

const schema = DynamoSchema.make({ name: "ok", version: 1, escapeKeys: false })
const sites: Array<DynamoSchema.ObjectKeySite> = []
const own: DynamoSchema.DynamoSchema = {
  ...schema,
  objectKeys: (site) => {
    sites.push(site)
    return `Field "${site.attr}" is composed into a key`
  },
}

const primary: KeyComposer.IndexDefinition = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}
const byU: KeyComposer.IndexDefinition = {
  index: "gsi1",
  pk: { field: "gsi1pk", composite: ["missing", "u"] },
  sk: { field: "gsi1sk", composite: [] },
}

describe("the object key decision", () => {
  it("defaultObjectText: an object composing its tag", () => {
    expect(defaultObjectText({}, "[object Object]")).toBe("[object Object]")
    expect(defaultObjectText("[object Object]", "[object Object]")).toBeUndefined()
  })

  it("judges only under a write's own schema", () => {
    expect(() =>
      judgeObjectKeyText(schema, {}, "[object Object]", () => undefined as never),
    ).not.toThrow()
    expect(() =>
      judgeObjectKeyText(own, { a: 1 }, "[object Object]", () => ({
        attr: "u",
        value: { a: 1 },
        key: byU,
        half: "pk",
      })),
    ).toThrow(/Field "u" is composed into a key.*\[EDD-9162\]/)
  })

  it("the composer refuses where it composes, naming the definition and the half", () => {
    sites.length = 0
    expect(() =>
      KeyComposer.composeAllKeys(own, "E", 1, { primary, byU }, { id: "a", missing: "m", u: {} }),
    ).toThrow(/\[EDD-9162\]/)
    expect(sites).toEqual([{ attr: "u", value: {}, key: byU, half: "pk" }])
  })

  it("a sparse index missing a value composes nothing, so refuses nothing", () => {
    expect(KeyComposer.composeAllKeys(own, "E", 1, { primary, byU }, { id: "a", u: {} })).toEqual({
      pk: "$ok#v1#e#id_a",
      sk: "$ok#v1#e",
    })
  })

  it("a key a read composes keeps the text", () => {
    expect(KeyComposer.composePk(schema, "E", byU, { missing: "m", u: {} })).toBe(
      "$ok#v1#e#missing_m#u_[object object]",
    )
  })

  it("a value composing other text isn't refused", () => {
    expect(KeyComposer.siteCompositeText(own, ["x", "y"], "u", byU, "pk")).toBe("x,y")
  })
})
