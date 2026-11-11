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
  stamped: new Set(["createdAt", "updatedAt", "version"]),
  lagTolerated: "updatedAt",
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

describe.each(POLICIES)("a composite the library stamps (shapes 16 to 18), %s", (policy) => {
  const values = { tenant: "t", id: "1", status: "open", createdAt: "c9", updatedAt: "u9" }
  const judged = (
    pk: ReadonlyArray<string>,
    sk: ReadonlyArray<string>,
    stored: string | undefined,
    record: Record<string, unknown> = values,
    half: "pk" | "sk" = "sk",
  ) => KeyComposer.judgeIndexHalf(judging, index(pk, sk, policy), half, stored, record)
  const FINE = { kind: "fine" }

  it("no key on a row a put would index: missing, whichever stamp", () => {
    expect(judged(["tenant"], ["updatedAt"], undefined)).toEqual({
      kind: "set",
      drift: "missing",
      value: key("updatedat_u9"),
    })
    expect(judged(["tenant"], ["createdAt"], undefined)).toEqual({
      kind: "set",
      drift: "missing",
      value: key("createdat_c9"),
    })
    expect(judged(["tenant"], ["status", "updatedAt"], undefined)).toEqual({
      kind: "set",
      drift: "missing",
      value: key("status_open", "updatedat_u9"),
    })
    expect(judged(["createdAt"], ["id"], undefined, values, "pk")).toEqual({
      kind: "set",
      drift: "missing",
      value: "$j#v1#row#createdat_c9",
    })
  })

  it("the other half of a whole index is missing with it", () => {
    expect(judged(["tenant"], ["updatedAt"], undefined, values, "pk")).toEqual({
      kind: "set",
      drift: "missing",
      value: PK,
    })
  })

  it("no key and another composite absent: a put wouldn't index it", () => {
    const noStatus = { tenant: "t", id: "1", createdAt: "c9", updatedAt: "u9" }
    expect(judged(["tenant"], ["status", "updatedAt"], undefined, noStatus)).toEqual(FINE)
    expect(judged(["tenant"], ["status", "createdAt"], undefined, noStatus)).toEqual(FINE)
  })

  it("no stamped value on the row: nothing to compose", () => {
    const unstamped = { tenant: "t", id: "1", status: "open" }
    expect(judged(["tenant"], ["updatedAt"], undefined, unstamped)).toEqual(FINE)
    expect(judged(["tenant"], ["createdAt"], undefined, unstamped)).toEqual(FINE)
  })

  it("a key holding `updatedAt` that lags: nothing, so a run after any write rewrites nothing", () => {
    expect(judged(["tenant"], ["updatedAt"], key("updatedat_u1"))).toEqual(FINE)
    expect(judged(["tenant"], ["status", "updatedAt"], key("status_open", "updatedat_u1"))).toEqual(
      FINE,
    )
    // A composite after it has to match too.
    expect(judged(["tenant"], ["updatedAt", "id"], key("updatedat_u1", "id_1"))).toEqual(FINE)
    expect(judged(["updatedAt"], ["id"], "$j#v1#row#updatedat_u1", values, "pk")).toEqual(FINE)
    // And it's no different when equal.
    expect(judged(["tenant"], ["status", "updatedAt"], key("status_open", "updatedat_u9"))).toEqual(
      FINE,
    )
  })

  it("a key differing in anything else is rewritten, once, from the row's `updatedAt`", () => {
    const whole = key("status_open", "updatedat_u9")
    expect(judged(["tenant"], ["status", "updatedAt"], key("status_shut", "updatedat_u1"))).toEqual(
      {
        kind: "set",
        drift: "lagging",
        value: whole,
      },
    )
    // What that wrote is the row's own, so the next run has nothing, whatever `updatedAt` does next.
    expect(
      judged(["tenant"], ["status", "updatedAt"], whole, { ...values, updatedAt: "u10" }),
    ).toEqual(FINE)
    // After it too.
    expect(judged(["tenant"], ["updatedAt", "id"], key("updatedat_u1", "id_2"))).toEqual({
      kind: "set",
      drift: "lagging",
      value: key("updatedat_u9", "id_1"),
    })
  })

  it("one lagging segment means one: no empty text, no extra segment", () => {
    for (const stored of [
      key("status_open", "updatedat_"),
      key("status_open", "updatedat_u1", "extra"),
      key("status_open", "updatedat_u1#extra"),
    ]) {
      expect(judged(["tenant"], ["status", "updatedAt"], stored)).toEqual({
        kind: "set",
        drift: "lagging",
        value: key("status_open", "updatedat_u9"),
      })
    }
  })

  it("a key cut short is truncated, and not a lag", () => {
    expect(judged(["tenant"], ["status", "updatedAt"], key("status_open"))).toEqual({
      kind: "set",
      drift: "truncated",
      value: key("status_open", "updatedat_u9"),
    })
    expect(judged(["tenant"], ["status", "createdAt"], key("status_open"))).toEqual({
      kind: "set",
      drift: "truncated",
      value: key("status_open", "createdat_c9"),
    })
  })

  it("`createdAt` never moves, so a key that differs in it is rewritten", () => {
    expect(judged(["tenant"], ["createdAt"], key("createdat_c1"))).toEqual({
      kind: "set",
      drift: "lagging",
      value: key("createdat_c9"),
    })
    expect(judged(["tenant"], ["createdAt"], key("createdat_c9"))).toEqual(FINE)
  })

  it("a retain `version` is judged whole: every write of that path composes it", () => {
    const versioned = { ...values, version: 3 }
    const text = "version_0000000000000003"
    expect(judged(["tenant"], ["version"], key("version_0000000000000002"), versioned)).toEqual({
      kind: "set",
      drift: "lagging",
      value: key(text),
    })
    expect(judged(["tenant"], ["version"], key(text), versioned)).toEqual(FINE)
    expect(judged(["tenant"], ["version"], undefined, versioned)).toEqual({
      kind: "set",
      drift: "missing",
      value: key(text),
    })
  })

  it("no writer leaves a stamp out, so only the other composites can be ambiguous", () => {
    const placed = { ...values, region: "r" }
    const verdict = judged(["tenant"], ["status", "region", "updatedAt"], undefined, placed)
    expect(verdict).toEqual(
      policy === "sparse"
        ? { kind: "ambiguous" }
        : {
            kind: "set",
            drift: "missing",
            value: key("status_open", "region_r", "updatedat_u9"),
          },
    )
    expect(judged(["tenant"], ["status", "createdAt"], undefined)).toEqual({
      kind: "set",
      drift: "missing",
      value: key("status_open", "createdat_c9"),
    })
  })

  it("without a `timestamps.updated`, an `updatedAt` composite is any other", () => {
    const plain = { ...judging, stamped: new Set<string>(), lagTolerated: null }
    expect(
      KeyComposer.judgeIndexHalf(
        plain,
        index(["tenant"], ["updatedAt"], policy),
        "sk",
        key("updatedat_u1"),
        values,
      ),
    ).toEqual({ kind: "set", drift: "lagging", value: key("updatedat_u9") })
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
