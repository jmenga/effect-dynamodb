/**
 * What `Aggregate.make` derives for dates the library stamps (`DESIGN.md` §7, "Composites the
 * library stamps"): a date a row's value declares is optional on the input, at the root and at each
 * node below it, and a field of that name of another type stays the caller's. The writes themselves
 * are `helpers/StampedComposites.ts` in `effect-dynamodb`.
 */

import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoSchema from "../src/DynamoSchema.js"

const schema = DynamoSchema.make({ name: "app", version: 1 })
/** A date as this input takes it: the derived schemas decode what's sent over the wire. */
const at = "2020-02-03T04:05:06.000Z"
const Dates = { createdAt: Schema.DateTimeUtc, updatedAt: Schema.DateTimeUtc }

const config = {
  table: { Tag: Symbol.for("test/table") },
  schema,
  pk: { field: "pk", composite: ["id"] as const },
  collection: { index: "gsi1", name: "c", sk: { field: "gsi1sk", composite: [] as const } },
  root: { entityType: "Root" },
  edges: {},
}

const definition = (model: Schema.Top, extra: Record<string, unknown>) =>
  Aggregate.make(model, { ...config, ...extra } as never) as unknown as {
    readonly inputSchema: Schema.Codec<any>
  }

const accepts = (model: Schema.Top, extra: Record<string, unknown>, input: unknown) =>
  Schema.decodeUnknownExit(definition(model, extra).inputSchema)(input)._tag === "Success"

describe("the input of an aggregate with `timestamps`", () => {
  const Root = Schema.Struct({ id: Schema.String, ...Dates })

  it("doesn't need a date the root declares", () => {
    expect(accepts(Root, { timestamps: true }, {})).toBe(true)
  })

  it("takes one, and refuses what isn't one", () => {
    const given = { createdAt: at, updatedAt: at }
    expect(accepts(Root, { timestamps: true }, given)).toBe(true)
    expect(accepts(Root, { timestamps: true }, { createdAt: "yesterday" })).toBe(false)
  })

  it("still needs it without `timestamps`", () => {
    expect(accepts(Root, {}, {})).toBe(false)
    expect(accepts(Root, {}, { createdAt: at, updatedAt: at })).toBe(true)
  })

  it("under its configured name: another field of the default name is the caller's", () => {
    const Named = Schema.Struct({ id: Schema.String, made: Schema.DateTimeUtc, ...Dates })
    const stamps = { timestamps: { created: { field: "made" } } }
    expect(accepts(Named, stamps, { createdAt: at })).toBe(true)
    expect(accepts(Named, stamps, {})).toBe(false)
  })

  it("still needs a field of that name of another type: it's the caller's", () => {
    const Owned = Schema.Struct({ id: Schema.String, createdAt: Schema.String })
    expect(accepts(Owned, { timestamps: true }, {})).toBe(false)
    expect(accepts(Owned, { timestamps: true }, { createdAt: "mine" })).toBe(true)
  })

  it("doesn't need an optional one either", () => {
    const Optional = Schema.Struct({
      id: Schema.String,
      createdAt: Schema.optional(Schema.DateTimeUtc),
    })
    expect(accepts(Optional, { timestamps: true }, {})).toBe(true)
    expect(accepts(Optional, { timestamps: true }, { createdAt: at })).toBe(true)
  })

  describe("below the root", () => {
    const Child = Schema.Struct({ name: Schema.String, ...Dates })
    const stamps = { timestamps: true }

    it("a one edge with an entity takes its id, whatever the row declares", () => {
      const Model = Schema.Struct({ id: Schema.String, venue: Child })
      const entity = {
        model: Child,
        entityType: "Venue",
        indexes: { primary: { pk: { field: "pk", composite: ["name"] } } },
      }
      const edges = { edges: { venue: Aggregate.one({ entityType: "Venue", entity } as never) } }
      expect(accepts(Model, { ...edges, ...stamps }, { venueId: "v" })).toBe(true)
      expect(accepts(Model, { ...edges, ...stamps }, {})).toBe(false)
    })

    it("a one edge with no entity takes the value, as create does", () => {
      const Model = Schema.Struct({ id: Schema.String, venue: Child })
      const edges = { edges: { venue: Aggregate.one({ entityType: "Venue" }) } }
      const input = { venue: { name: "n" } }
      expect(accepts(Model, { ...edges, ...stamps }, input)).toBe(true)
      expect(accepts(Model, edges, input)).toBe(false)
      expect(accepts(Model, edges, { venue: { name: "n", createdAt: at, updatedAt: at } })).toBe(
        true,
      )
      expect(accepts(Model, { ...edges, ...stamps }, { venueId: "v" })).toBe(false)
      expect(accepts(Model, { ...edges, ...stamps }, { venue: {} })).toBe(false)
    })

    it("an optional one edge with no entity", () => {
      const Model = Schema.Struct({ id: Schema.String, venue: Schema.optional(Child) })
      const edges = { edges: { venue: Aggregate.one({ entityType: "Venue" }) } }
      expect(accepts(Model, { ...edges, ...stamps }, {})).toBe(true)
      expect(accepts(Model, { ...edges, ...stamps }, { venue: { name: "n" } })).toBe(true)
    })

    it("a keyed many edge's values (a custom decompose)", () => {
      const Model = Schema.Struct({
        id: Schema.String,
        lines: Schema.Record(Schema.String, Child),
      })
      const edges = {
        edges: {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["name"] },
            decompose: (value) => Object.values(value as object),
            assemble: (items) => items,
          }),
        },
      }
      const input = { lines: { a: { name: "n" } } }
      expect(accepts(Model, { ...edges, ...stamps }, input)).toBe(true)
      expect(accepts(Model, edges, input)).toBe(false)
      const Optional = Schema.Struct({
        id: Schema.String,
        lines: Schema.optional(Schema.Record(Schema.String, Child)),
      })
      expect(accepts(Optional, { ...edges, ...stamps }, {})).toBe(true)
      expect(accepts(Optional, { ...edges, ...stamps }, input)).toBe(true)
    })

    it("a keyed many edge of plain values is as the model has it", () => {
      const edges = {
        edges: {
          lines: Aggregate.many({ entityType: "Line", decompose: () => [], assemble: () => ({}) }),
        },
      }
      const Plain = Schema.Struct({
        id: Schema.String,
        lines: Schema.Record(Schema.String, Schema.String),
      })
      expect(accepts(Plain, { ...edges, ...stamps }, { lines: { a: "x" } })).toBe(true)
    })

    it("a many element", () => {
      const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Child) })
      const edges = {
        edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["name"] } }) },
      }
      const input = { lines: [{ name: "n" }] }
      expect(accepts(Model, { ...edges, ...stamps }, input)).toBe(true)
      expect(accepts(Model, edges, input)).toBe(false)
    })

    it("a sub-aggregate root", () => {
      const Sub = Aggregate.make(Child, { root: { entityType: "Sub" }, edges: {} } as never) as any
      const Model = Schema.Struct({ id: Schema.String, sub: Child })
      const edges = { edges: { sub: Sub.with({ discriminator: { slot: "a" } }) } }
      expect(accepts(Model, { ...edges, ...stamps }, { sub: { name: "n" } })).toBe(true)
      expect(accepts(Model, edges, { sub: { name: "n" } })).toBe(false)
    })

    it("a root field of that name of another type turns the stamp off below it too", () => {
      const Sub = Aggregate.make(Child, { root: { entityType: "Sub" }, edges: {} } as never) as any
      const Model = Schema.Struct({ id: Schema.String, createdAt: Schema.String, sub: Child })
      const edges = { edges: { sub: Sub.with({ discriminator: { slot: "a" } }) } }
      const at = "2024-01-01T00:00:00.000Z"
      expect(
        accepts(Model, { ...edges, ...stamps }, { createdAt: "mine", sub: { name: "n" } }),
      ).toBe(false)
      expect(
        accepts(
          Model,
          { ...edges, ...stamps },
          { createdAt: "mine", sub: { name: "n", createdAt: at } },
        ),
      ).toBe(true)
    })

    it("another type there is the caller's, and the rest of the node is unchanged", () => {
      const Owned = Schema.Struct({ name: Schema.String, createdAt: Schema.String })
      const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Owned) })
      const edges = {
        edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["name"] } }) },
      }
      expect(accepts(Model, { ...edges, ...stamps }, { lines: [{ name: "n" }] })).toBe(false)
      expect(accepts(Model, { ...edges, ...stamps }, { lines: [{ createdAt: "x" }] })).toBe(false)
      expect(
        accepts(Model, { ...edges, ...stamps }, { lines: [{ name: "n", createdAt: "x" }] }),
      ).toBe(true)
    })
  })
})

describe("the input's type", () => {
  const Root = Schema.Struct({ id: Schema.String, title: Schema.String, ...Dates })
  const Stamped = Aggregate.make(Root, { ...config, timestamps: true })
  const Bare = Aggregate.make(Root, config)

  it("follows `timestamps`", () => {
    type StampedInput = Aggregate.Input<typeof Stamped>
    type BareInput = Aggregate.Input<typeof Bare>
    expectTypeOf<{ title: string }>().toExtend<StampedInput>()
    expectTypeOf<{ title: string }>().not.toExtend<BareInput>()
    expectTypeOf<StampedInput["title"]>().toEqualTypeOf<string>()
    // @ts-expect-error `title` isn't stamped
    const _missing: StampedInput = {}
  })
})

describe("EDD-9121, a many edge's sort key over `updatedAt`", () => {
  const Line = Schema.Struct({ sku: Schema.String, updatedAt: Schema.DateTimeUtc })
  const lines = (composite: ReadonlyArray<string>, extra: Record<string, unknown> = {}) =>
    Aggregate.many({ entityType: "Line", sk: { composite }, ...extra })
  const edges = (composite: ReadonlyArray<string>) => ({ edges: { lines: lines(composite) } })
  const Model = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })

  it("is refused where the library stamps it, as the operational make does", () => {
    expect(() => definition(Model, { ...edges(["updatedAt"]), timestamps: true })).toThrow(
      /\[EDD-9121\] Aggregate "Root": edge "lines"/,
    )
    expect(() => definition(Model, { ...edges(["sku", "updatedAt"]), timestamps: true })).toThrow(
      /EDD-9121/,
    )
  })

  it("isn't where it doesn't, or over another field", () => {
    expect(() => definition(Model, edges(["updatedAt"]))).not.toThrow()
    expect(() => definition(Model, { ...edges(["sku"]), timestamps: true })).not.toThrow()
    expect(() =>
      definition(Model, {
        ...edges(["updatedAt"]),
        timestamps: { updated: { field: "changed" } },
      }),
    ).not.toThrow()
  })

  it("a row's field of that name of another type is its own", () => {
    const Own = Schema.Struct({
      id: Schema.String,
      lines: Schema.Array(Schema.Struct({ sku: Schema.String, updatedAt: Schema.String })),
    })
    expect(() => definition(Own, { ...edges(["updatedAt"]), timestamps: true })).not.toThrow()
  })

  it("a root's field of that name of another type turns the stamp off on every row", () => {
    const Root = Schema.Struct({
      id: Schema.String,
      updatedAt: Schema.String,
      lines: Schema.Array(Line),
    })
    expect(() => definition(Root, { ...edges(["updatedAt"]), timestamps: true })).not.toThrow()
  })

  it("under a sub-aggregate, and over an entity's model or a keyed value", () => {
    const Sub = Aggregate.make(Schema.Struct({ name: Schema.String, lines: Schema.Array(Line) }), {
      root: { entityType: "Sub" },
      edges: { lines: lines(["updatedAt"]) },
    } as never) as any
    const Nested = Schema.Struct({
      id: Schema.String,
      sub: Schema.Struct({ name: Schema.String, lines: Schema.Array(Line) }),
    })
    expect(() =>
      definition(Nested, {
        edges: { sub: Sub.with({ discriminator: { slot: "a" } }) },
        timestamps: true,
      }),
    ).toThrow(/EDD-9121/)
    const Opaque = Schema.Struct({ id: Schema.String, lines: Schema.Unknown })
    const entity = { model: Line, entityType: "Line" }
    expect(() =>
      definition(Opaque, {
        edges: { lines: lines(["updatedAt"], { entity }) },
        timestamps: true,
      }),
    ).toThrow(/EDD-9121/)
    // An entity's model says the same about its rows as the aggregate's would.
    const OwnLine = Schema.Struct({ sku: Schema.String, updatedAt: Schema.String })
    expect(() =>
      definition(Opaque, {
        edges: { lines: lines(["updatedAt"], { entity: { model: OwnLine, entityType: "Line" } }) },
        timestamps: true,
      }),
    ).not.toThrow()
    const Keyed = Schema.Struct({ id: Schema.String, lines: Schema.Record(Schema.String, Line) })
    expect(() => definition(Keyed, { ...edges(["updatedAt"]), timestamps: true })).toThrow(
      /EDD-9121/,
    )
    // Nothing says what an opaque value's rows hold: they're stamped, not declared, and read back
    // from nothing, so the key isn't over a value of the row's.
    expect(() => definition(Opaque, { ...edges(["sku"]), timestamps: true })).not.toThrow()
  })
})

describe("EDD-9121, a partition key over `updatedAt`", () => {
  const Keyed = Schema.Struct({ updatedAt: Schema.DateTimeUtc, name: Schema.String })
  const keyed = { pk: { field: "pk", composite: ["updatedAt"] } }

  it("is refused where the library stamps it", () => {
    expect(() => definition(Keyed, { ...keyed, timestamps: true })).toThrow(/EDD-9121/)
  })

  it("isn't where it doesn't", () => {
    expect(() => definition(Keyed, keyed)).not.toThrow()
    expect(() =>
      definition(Keyed, { ...keyed, timestamps: { updated: { field: "changed" } } }),
    ).not.toThrow()
  })
})
