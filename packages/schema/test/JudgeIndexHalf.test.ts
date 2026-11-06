/**
 * What `KeyComposer.judgeIndexHalf` says of a half of a stored row (#185, `rekey-repair.md`): the
 * rule table, under each policy, and the canonical shapes (CLAUDE.md, `DESIGN.md §7`).
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { schema136, schema137, schemaEscaped } from "../src/internal/KeyText136.js"
import * as KeyComposer from "../src/KeyComposer.js"

const schema = DynamoSchema.make({ name: "j", version: 1, escapeKeys: true })

const judging: KeyComposer.IndexKeyJudging = {
  schema,
  entityType: "Row",
  entityVersion: 1,
  forms: [
    { pk: schema136(schema), sk: schema136(schema) },
    { pk: schema137(schema), sk: schemaEscaped(schema) },
    { pk: schemaEscaped(schema), sk: schemaEscaped(schema) },
  ],
  primaryComposites: new Set(["tenant", "id"]),
  stamped: new Set(["updatedAt"]),
}

const index = (
  pk: ReadonlyArray<string>,
  sk: ReadonlyArray<string>,
  policy?: "sparse" | "preserve",
): KeyComposer.IndexDefinition => ({
  index: "gsi",
  pk: { field: "gpk", composite: [...pk] },
  sk: { field: "gsk", composite: [...sk] },
  ...(policy === undefined ? {} : { indexPolicy: { pk: policy, sk: policy } }),
})

const POLICIES = ["sparse", "preserve"] as const
const PK = "$j#v1#row#tenant_t"
const key = (...parts: ReadonlyArray<string>) => ["$j#v1#row", ...parts].join("#")

describe.each(POLICIES)("the rule table, %s", (policy) => {
  const mixed = index(["tenant"], ["zone", "id"], policy)
  const two = index(["tenant"], ["a", "b"], policy)
  const whole = { tenant: "t", id: "1", zone: "z", a: "A", b: "B" }

  it("every composite there, the key equal: nothing", () => {
    expect(KeyComposer.judgeIndexHalf(judging, mixed, "sk", key("zone_z", "id_1"), whole)).toEqual({
      kind: "fine",
    })
  })

  it("every composite there, the key other values: set, lagging", () => {
    expect(
      KeyComposer.judgeIndexHalf(judging, mixed, "sk", key("zone_old", "id_1"), whole),
    ).toEqual({ kind: "set", drift: "lagging", value: key("zone_z", "id_1") })
  })

  it("every composite there, the key a leading run: set, truncated", () => {
    expect(KeyComposer.judgeIndexHalf(judging, mixed, "sk", key("zone_z"), whole)).toEqual({
      kind: "set",
      drift: "truncated",
      value: key("zone_z", "id_1"),
    })
    // Even the bare prefix: the whole of a run of none.
    expect(KeyComposer.judgeIndexHalf(judging, mixed, "sk", key(), whole)).toEqual({
      kind: "set",
      drift: "truncated",
      value: key("zone_z", "id_1"),
    })
  })

  it("a leading run under another form is still truncated", () => {
    const special = { tenant: "t", id: "1", zone: "a b", a: "A", b: "B" }
    expect(
      KeyComposer.judgeIndexHalf(judging, mixed, "sk", key("zone_a b"), special),
    ).toMatchObject({ kind: "set", drift: "truncated", value: key("zone_a%20b", "id_1") })
  })

  it("no key, at most one composite outside the primary key: set, missing", () => {
    expect(KeyComposer.judgeIndexHalf(judging, mixed, "sk", undefined, whole)).toEqual({
      kind: "set",
      drift: "missing",
      value: key("zone_z", "id_1"),
    })
  })

  it("no key, two or more outside it: ambiguous under sparse, set under preserve", () => {
    expect(KeyComposer.judgeIndexHalf(judging, two, "sk", undefined, whole)).toEqual(
      policy === "sparse"
        ? { kind: "ambiguous" }
        : { kind: "set", drift: "missing", value: key("a_a", "b_b") },
    )
  })

  it("no key, the other half can't compose: put wrote no entry, so nothing", () => {
    expect(
      KeyComposer.judgeIndexHalf(judging, index(["zone"], ["id"], policy), "sk", undefined, {
        tenant: "t",
        id: "1",
      }),
    ).toEqual({ kind: "fine" })
    expect(
      KeyComposer.judgeIndexHalf(judging, index(["tenant"], ["zone"], policy), "pk", undefined, {
        tenant: "t",
        id: "1",
      }),
    ).toEqual({ kind: "fine" })
  })

  it("trailing composite missing, no key or the truncated text: nothing (shape 3)", () => {
    const values = { tenant: "t", id: "1", a: "A" }
    expect(KeyComposer.judgeIndexHalf(judging, two, "sk", undefined, values)).toEqual({
      kind: "fine",
    })
    expect(KeyComposer.judgeIndexHalf(judging, two, "sk", key("a_a"), values)).toEqual({
      kind: "fine",
    })
  })

  it("trailing composite missing, anything else: truncated under sparse, left under preserve", () => {
    const values = { tenant: "t", id: "1", a: "A" }
    expect(KeyComposer.judgeIndexHalf(judging, two, "sk", key("a_a", "b_old"), values)).toEqual(
      policy === "sparse" ? { kind: "set", drift: "lagging", value: key("a_a") } : { kind: "fine" },
    )
  })

  it("a hole, or none leading, no key: nothing (shape 4)", () => {
    for (const values of [
      { tenant: "t", id: "1", b: "B" },
      { tenant: "t", id: "1" },
    ]) {
      expect(KeyComposer.judgeIndexHalf(judging, two, "sk", undefined, values)).toEqual({
        kind: "fine",
      })
    }
  })

  it("a hole, or none leading, a key: removed under sparse, left under preserve", () => {
    for (const values of [
      { tenant: "t", id: "1", b: "B" },
      { tenant: "t", id: "1" },
    ]) {
      expect(KeyComposer.judgeIndexHalf(judging, two, "sk", key("a_a"), values)).toEqual(
        policy === "sparse" ? { kind: "remove" } : { kind: "fine" },
      )
    }
  })

  it("a partition key half is judged the same way: the issue's third row", () => {
    const partition = index(["tenant", "zone"], ["id"], policy)
    expect(KeyComposer.judgeIndexHalf(judging, partition, "pk", PK, whole)).toEqual({
      kind: "set",
      drift: "truncated",
      value: `${PK}#zone_z`,
    })
  })

  it("a composite the library stamps: never judged", () => {
    const values = { tenant: "t", id: "1", updatedAt: "2026" }
    const stamped = index(["tenant"], ["updatedAt"], policy)
    for (const stored of [undefined, key("updatedat_old")]) {
      expect(KeyComposer.judgeIndexHalf(judging, stamped, "sk", stored, values)).toEqual({
        kind: "fine",
      })
    }
    // Nor does it make a whole index of the other half.
    expect(KeyComposer.judgeIndexHalf(judging, stamped, "pk", undefined, values)).toEqual({
      kind: "fine",
    })
  })

  it("values composing no key: nothing, as a put would refuse", () => {
    const number = index(["tenant"], ["n"], policy)
    expect(
      KeyComposer.judgeIndexHalf(judging, number, "sk", undefined, {
        tenant: "t",
        id: "1",
        n: Number.NaN,
      }),
    ).toEqual({ kind: "fine" })
  })

  it("shape 2: composites all in the primary key, no key: set", () => {
    expect(
      KeyComposer.judgeIndexHalf(
        judging,
        index(["tenant"], ["id"], policy),
        "sk",
        undefined,
        whole,
      ),
    ).toEqual({ kind: "set", drift: "missing", value: key("id_1") })
  })

  it("shape 6: an empty half is a constant, set only when its index is whole", () => {
    const empty = index(["zone"], [], policy)
    expect(KeyComposer.judgeIndexHalf(judging, empty, "sk", undefined, whole)).toEqual({
      kind: "set",
      drift: "missing",
      value: key(),
    })
    expect(
      KeyComposer.judgeIndexHalf(judging, empty, "sk", undefined, { tenant: "t", id: "1" }),
    ).toEqual({ kind: "fine" })
    expect(KeyComposer.judgeIndexHalf(judging, empty, "sk", key(), whole)).toEqual({ kind: "fine" })
  })
})

describe("Z-order halves", () => {
  class Home extends Schema.Class<Home>("Home")({
    tenant: Schema.String,
    id: Schema.String,
    price: Schema.optional(Schema.Number),
    beds: Schema.optional(Schema.Number),
    kind: Schema.optional(Schema.Literals(["a", "b"])),
    count: Schema.optional(Schema.Number),
    agency: Schema.optional(Schema.String),
    office: Schema.optional(Schema.String),
  }) {}
  const dimensions = [
    { field: "price", min: 0, max: 1000, step: 10 },
    { field: "beds", min: 0, max: 15 },
  ]
  const zorderIndexes = (policy: "sparse" | "preserve") =>
    (
      Entity.make({
        model: Home,
        entityType: "Row",
        primaryKey: {
          pk: { field: "pk", composite: ["tenant"] },
          sk: { field: "sk", composite: ["id"] },
        },
        indexes: {
          facets: {
            name: "gsi1",
            pk: { field: "gpk", composite: ["tenant"] },
            sk: { field: "gsk", zorder: dimensions },
            indexPolicy: { sk: policy },
          },
          emptyPk: {
            name: "gsi2",
            pk: { field: "gpk2", composite: [] },
            sk: { field: "gsk2", zorder: dimensions },
            indexPolicy: { sk: policy },
          },
          oneBit: {
            name: "gsi3",
            pk: { field: "gpk3", composite: ["tenant"] },
            sk: { field: "gsk3", zorder: ["kind"] },
            indexPolicy: { sk: policy },
          },
          mixedWidths: {
            name: "gsi4",
            pk: { field: "gpk4", composite: ["tenant"] },
            sk: { field: "gsk4", zorder: ["kind", { field: "count", min: 0, max: 8191 }] },
            indexPolicy: { sk: policy },
          },
          offices: {
            name: "gsi5",
            pk: { field: "gpk5", composite: ["tenant"] },
            sk: {
              field: "gsk5",
              prefix: ["agency", "office"],
              zorder: [{ field: "beds", min: 0, max: 15 }],
            },
            indexPolicy: { sk: policy },
          },
        },
      } as never) as any
    ).indexes as Record<string, KeyComposer.IndexDefinition>
  const addressOf = (index: KeyComposer.IndexDefinition, values: Record<string, unknown>) =>
    KeyComposer.composeZOrderSk(schema, index, values)

  describe.each(POLICIES)("%s", (policy) => {
    const indexes = zorderIndexes(policy)
    const facets = indexes.facets!
    const whole = { tenant: "t", id: "1", price: 100, beds: 2 }

    it("shape 7: within one quantization level, the same bytes: nothing", () => {
      const stored = addressOf(facets, whole)
      const within = { ...whole, price: 104 }
      expect(KeyComposer.judgeIndexHalf(judging, facets, "sk", stored, within)).toEqual({
        kind: "fine",
      })
    })

    it("shape 7: another level: set whole, never truncated", () => {
      const moved = { ...whole, price: 500 }
      const verdict = KeyComposer.judgeIndexHalf(
        judging,
        facets,
        "sk",
        addressOf(facets, whole),
        moved,
      )
      expect(verdict).toMatchObject({ kind: "set", drift: "lagging" })
      expect((verdict as { readonly value: Uint8Array }).value).toEqual(addressOf(facets, moved))
    })

    it("shape 7: a dimension gone, an address held: removed under sparse, left under preserve", () => {
      expect(
        KeyComposer.judgeIndexHalf(judging, facets, "sk", addressOf(facets, whole), {
          tenant: "t",
          id: "1",
          price: 100,
        }),
      ).toEqual(policy === "sparse" ? { kind: "remove" } : { kind: "fine" })
    })

    it("shape 7: no address, every dimension there: ambiguous under sparse, set under preserve", () => {
      expect(KeyComposer.judgeIndexHalf(judging, facets, "sk", undefined, whole)).toMatchObject(
        policy === "sparse" ? { kind: "ambiguous" } : { kind: "set", drift: "missing" },
      )
    })

    it("shape 7: a value a dimension can't place: nothing, as a put would refuse", () => {
      expect(
        KeyComposer.judgeIndexHalf(judging, indexes.oneBit!, "sk", undefined, {
          tenant: "t",
          id: "1",
          kind: "other",
        }),
      ).toEqual({ kind: "fine" })
    })

    it("7a: a single-bit dimension", () => {
      const verdict = KeyComposer.judgeIndexHalf(judging, indexes.oneBit!, "sk", undefined, {
        tenant: "t",
        id: "1",
        kind: "b",
      })
      expect(verdict).toMatchObject({ kind: "set", drift: "missing" })
      expect((verdict as { readonly value: Uint8Array }).value).toEqual(new Uint8Array([1]))
    })

    it("7a': mixed widths compose right-aligned", () => {
      const values = { tenant: "t", id: "1", kind: "b", count: 1 }
      const verdict = KeyComposer.judgeIndexHalf(
        judging,
        indexes.mixedWidths!,
        "sk",
        undefined,
        values,
      )
      expect(verdict).toMatchObject(
        policy === "sparse" ? { kind: "ambiguous" } : { kind: "set", drift: "missing" },
      )
      if (policy === "preserve") {
        const address = (verdict as { readonly value: Uint8Array }).value
        expect(address.length).toBe(2)
        expect(address[0]! & 0b1100_0000).toBe(0)
      }
    })

    it("7b: an empty partition half is evaluated whatever the sort key does", () => {
      const emptyPk = indexes.emptyPk!
      expect(KeyComposer.judgeIndexHalf(judging, emptyPk, "pk", undefined, whole)).toEqual({
        kind: "set",
        drift: "missing",
        value: "$j#v1#row",
      })
      // The index isn't whole with a dimension gone: no key for the empty half to add.
      expect(
        KeyComposer.judgeIndexHalf(judging, emptyPk, "pk", undefined, {
          tenant: "t",
          id: "1",
          price: 100,
        }),
      ).toEqual({ kind: "fine" })
    })

    it("8c: a hierarchical prefix with a level gone: no truncated address", () => {
      const offices = indexes.offices!
      const stored = addressOf(offices, {
        tenant: "t",
        id: "1",
        agency: "x",
        office: "y",
        beds: 2,
      })
      expect(
        KeyComposer.judgeIndexHalf(judging, offices, "sk", stored, {
          tenant: "t",
          id: "1",
          agency: "x",
          beds: 2,
        }),
      ).toEqual(policy === "sparse" ? { kind: "remove" } : { kind: "fine" })
    })
  })
})

describe("a sharded partition key", () => {
  const sharded = (policy: "sparse" | "preserve"): KeyComposer.IndexDefinition => ({
    ...index(["tenant"], ["group", "id"], policy),
    shards: { count: 8, by: ["group"], previous: undefined, source: ["group"] } as never,
  })
  const whole = { tenant: "t", id: "1", group: "g" }

  it.each(POLICIES)("%s: missing, with its source: set with the marker", (policy) => {
    const verdict = KeyComposer.judgeIndexHalf(judging, sharded(policy), "pk", undefined, whole)
    expect(verdict).toMatchObject({ kind: "set", drift: "missing" })
    expect((verdict as { readonly value: string }).value).toContain("!8.")
  })

  it.each(POLICIES)("%s: its source gone: nothing is said", (policy) => {
    for (const stored of [undefined, "anything"]) {
      expect(
        KeyComposer.judgeIndexHalf(judging, sharded(policy), "pk", stored, {
          tenant: "t",
          id: "1",
        }),
      ).toEqual({ kind: "fine" })
    }
  })

  it.each(POLICIES)("%s: a key stored: `rekey` already rewrites or reports it", (policy) => {
    expect(KeyComposer.judgeIndexHalf(judging, sharded(policy), "pk", "anything", whole)).toEqual({
      kind: "fine",
    })
  })

  it.each(POLICIES)("%s: its sort key isn't whole without the source", (policy) => {
    const index_: KeyComposer.IndexDefinition = {
      ...index(["tenant"], ["id"], policy),
      shards: { count: 8, by: ["group"], previous: undefined, source: ["group"] } as never,
    }
    expect(
      KeyComposer.judgeIndexHalf(judging, index_, "sk", undefined, { tenant: "t", id: "1" }),
    ).toEqual({ kind: "fine" })
  })
})
