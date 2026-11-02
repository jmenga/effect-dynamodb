/**
 * Every definition-time position that names a model attribute is typed from
 * the model: a misspelled name is a compile error on that entry (and the
 * editor completes the names). Each position has a positive case and a typo
 * case (`@ts-expect-error`). The runtime checks stay, for untyped callers:
 * where `make` throws, the typo case asserts it too.
 *
 * Physical attribute names (`pk: { field: "gsi1pk" }`, `configure` `field`
 * renames, timestamp / version attribute names) are new attributes and are
 * not checked against the model.
 */
import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"

const AppSchema = DynamoSchema.make({ name: "fieldnames", version: 1 })

class Team extends Schema.Class<Team>("Team")({
  teamId: Schema.String,
  name: Schema.String,
}) {}

const Teams = Entity.make({
  model: DynamoModel.configure(Team, { teamId: { identifier: true } }),
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["teamId"] },
    sk: { field: "sk", composite: [] },
  },
})

class Listing extends Schema.Class<Listing>("Listing")({
  listingId: Schema.String,
  region: Schema.String,
  agencyId: Schema.String,
  price: Schema.Number,
  bedrooms: Schema.Number,
  listedAt: DynamoModel.DateString,
  status: Schema.Literals(["draft", "live", "sold"]),
  furnished: Schema.Boolean,
  title: Schema.String,
  email: Schema.String,
  description: Schema.String,
  seq: Schema.Number,
}) {}

const byListingId = {
  pk: { field: "pk", composite: ["listingId"] },
  sk: { field: "sk", composite: [] },
} as const

describe("definition attribute names are typed from the model", () => {
  describe("Entity.make keys", () => {
    it("primaryKey composites", () => {
      Entity.make({ model: Listing, entityType: "Listing", primaryKey: byListingId })
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: {
            // @ts-expect-error not a model field
            pk: { field: "pk", composite: ["listingIdd"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      ).toThrow(/EDD-9002/)
    })

    it("index composites, including a ref-derived id", () => {
      class Player extends Schema.Class<Player>("Player")({
        playerId: Schema.String,
        team: Team,
      }) {}
      const model = DynamoModel.configure(Player, {
        playerId: { identifier: true },
        team: { ref: true },
      })
      Entity.make({
        model,
        entityType: "Player",
        primaryKey: {
          pk: { field: "pk", composite: ["playerId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTeam: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["teamId"] },
            sk: { field: "gsi1sk", composite: ["playerId"] },
          },
        },
        refs: { team: { entity: Teams } },
      })
      expect(() =>
        Entity.make({
          model,
          entityType: "Player",
          primaryKey: {
            pk: { field: "pk", composite: ["playerId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byTeam: {
              name: "gsi1",
              // @ts-expect-error not a model field or ref id
              pk: { field: "gsi1pk", composite: ["teemId"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
          refs: { team: { entity: Teams } },
        }),
      ).toThrow(/EDD-9002/)
    })

    it("refs keys", () => {
      class Player extends Schema.Class<Player>("Player")({
        playerId: Schema.String,
        team: Team,
      }) {}
      const model = DynamoModel.configure(Player, {
        playerId: { identifier: true },
        team: { ref: true },
      })
      const primaryKey = {
        pk: { field: "pk", composite: ["playerId"] },
        sk: { field: "sk", composite: [] },
      } as const
      const Players = Entity.make({
        model,
        entityType: "Player",
        primaryKey,
        refs: { team: { entity: Teams } },
      })
      const Unreferenced = Entity.make({ model, entityType: "Player", primaryKey })
      type RefsOf<E> =
        E extends Entity.EntityDefinition<
          any,
          any,
          any,
          any,
          any,
          any,
          any,
          infer R,
          any,
          any,
          any,
          any,
          any
        >
          ? R
          : never
      expectTypeOf<RefsOf<typeof Players>>().toEqualTypeOf<{
        readonly team: { readonly entity: typeof Teams }
      }>()
      // Left out, refs resolve to none (not to the constraint the editor completes from).
      expectTypeOf<RefsOf<typeof Unreferenced>>().toEqualTypeOf<undefined>()
      expect(() =>
        Entity.make({
          model,
          entityType: "Player",
          primaryKey,
          // @ts-expect-error not a model field
          refs: { teem: { entity: Teams } },
        }),
      ).toThrow()
    })

    it("sk.prefix parts, bare and hashed", () => {
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: byListingId,
        indexes: {
          search: {
            name: "gsi2",
            pk: { field: "gsi2pk", composite: ["region"] },
            sk: {
              field: "gsi2sk",
              prefix: ["agencyId", { field: "title", hash: 4 }],
              zorder: [{ field: "price", min: 0, max: 100 }],
            },
          },
        },
      })
      const bad = () =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          indexes: {
            search: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["region"] },
              sk: {
                field: "gsi2sk",
                prefix: [
                  // @ts-expect-error not a model field
                  "agencyIdd",
                  // @ts-expect-error not a model field
                  { field: "titel", hash: 4 },
                ],
                zorder: [{ field: "price", min: 0, max: 100 }],
              },
            },
          },
        })
      expect(bad).toThrow(/EDD-9002/)
    })
  })

  describe("Entity.make sk.zorder entries", () => {
    const withZOrder = <const Z extends ReadonlyArray<unknown>>(zorder: Z) => zorder

    it("each field type takes its own kind of entry", () => {
      const Listings = Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: byListingId,
        indexes: {
          search: {
            name: "gsi2",
            pk: { field: "gsi2pk", composite: ["region"] },
            sk: {
              field: "gsi2sk",
              zorder: [
                { field: "price", min: 0, max: 5_000_000, step: 1_000 },
                { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 },
                "status",
                { field: "furnished", bits: 2 },
                { field: "title", bytes: 2 },
                { field: "region", values: ["north", "south"] },
              ],
            },
          },
        },
      })
      type Composite = typeof Listings.indexes.search.sk.composite
      expectTypeOf<Composite["length"]>().toEqualTypeOf<6>()
      expectTypeOf<Composite[2]>().toEqualTypeOf<"status">()
      expectTypeOf<Composite[5]>().toEqualTypeOf<"region">()
      expect(withZOrder([]).length).toBe(0)
    })

    it("a misspelled field, an option of another kind, or a bare name a field can't take", () => {
      const make = (zorder: unknown) => () =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          indexes: {
            search: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["region"] },
              sk: { field: "gsi2sk", zorder: zorder as never },
            },
          },
        })
      const typed = () =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          indexes: {
            search: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["region"] },
              sk: {
                field: "gsi2sk",
                zorder: [
                  // @ts-expect-error not a model field
                  { field: "pricee", min: 0, max: 9 },
                  // @ts-expect-error a date field takes from / unit / bits, not min / max
                  { field: "listedAt", min: 0, max: 9 },
                  // @ts-expect-error a plain string field has no members to take
                  "title",
                  // @ts-expect-error not a model field
                  "statuss",
                  // @ts-expect-error a literal union takes its members, not a range
                  { field: "status", from: "2024-01-01", unit: "days", bits: 4 },
                  // @ts-expect-error a plain number field takes a range, not a values list
                  { field: "price", values: [1, 2, 3] },
                ],
              },
            },
          },
        })
      expect(typed).toThrow()
      expect(make([{ field: "pricee", min: 0, max: 9 }])).toThrow(/EDD-9002/)
      expect(make([{ field: "listedAt", min: 0, max: 9 }])).toThrow(/EDD-9088/)
      expect(make(["title"])).toThrow(/EDD-9088/)
      expect(make([{ field: "price", values: [1, 2, 3] }])).toThrow(/EDD-9088/)
    })
  })

  describe("Entity.make other model-field positions", () => {
    it("unique fields, both forms", () => {
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: byListingId,
        unique: { email: ["email"], titled: { fields: ["title", "region"] } },
      })
      const bad = () =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          unique: {
            // @ts-expect-error not a model field
            email: ["emial"],
            // @ts-expect-error not a model field
            titled: { fields: ["titel"] },
          },
        })
      expect(bad).toThrow(
        /\[EDD-9002\] .*unique constraint "email" references unknown attribute "emial"/,
      )
    })

    it("timeSeries orderBy and appendInput", () => {
      const appendInput = Schema.Struct({
        listingId: Schema.String,
        seq: Schema.Number,
        price: Schema.Number,
      })
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: byListingId,
        timeSeries: { orderBy: "seq", appendInput },
      })
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          // @ts-expect-error not a model field
          timeSeries: { orderBy: "sequ", appendInput },
        }),
      ).toThrow()
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          timeSeries: {
            orderBy: "seq",
            // @ts-expect-error EDD-9013: appendInput field "cost" is not a model field
            appendInput: Schema.Struct({
              listingId: Schema.String,
              seq: Schema.Number,
              cost: Schema.Number,
            }),
          },
        }),
      ).toThrow(/EDD-9013/)
    })

    it("generatedId field", () => {
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: byListingId,
        generatedId: { field: "listingId" },
      })
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          // @ts-expect-error not a model field
          generatedId: { field: "listingIdd" },
        }),
      ).toThrow(/EDD-9008/)
    })

    it("vector index source, partition and filters", () => {
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: byListingId,
        vectorIndexes: {
          byDescription: {
            name: "vec1",
            dimensions: 8,
            source: { fields: ["description", "title"] },
            partition: ["region"],
            filters: ["status"],
          },
        },
      })
      const bad = () =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          vectorIndexes: {
            byDescription: {
              name: "vec1",
              dimensions: 8,
              // @ts-expect-error not a model field
              source: { fields: ["descripton"] },
              // @ts-expect-error not a model field
              partition: ["regon"],
              // @ts-expect-error not a model field
              filters: ["statsu"],
            },
          },
        })
      expect(bad).toThrow()
    })
  })

  describe("DynamoModel.configure", () => {
    it("attribute keys", () => {
      DynamoModel.configure(Listing, {
        email: { immutable: true },
        listingId: { identifier: true },
      })
      DynamoModel.configure(Listing, {
        email: { immutable: true },
        // @ts-expect-error emial is not a field of the model
        emial: { immutable: true },
      })
    })
  })

  describe("Aggregate.make (pure)", () => {
    class Official extends Schema.Class<Official>("Official")({
      officialId: Schema.String,
      name: Schema.String,
    }) {}
    const Officials = Entity.make({
      model: DynamoModel.configure(Official, { officialId: { identifier: true } }),
      entityType: "Official",
      primaryKey: {
        pk: { field: "pk", composite: ["officialId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    class Appointment extends Schema.Class<Appointment>("Appointment")({
      official: Official,
      role: Schema.Literals(["onfield", "third"]),
    }) {}
    class Match extends Schema.Class<Match>("Match")({
      matchId: Schema.String,
      season: Schema.String,
      venue: Schema.String,
      officials: Schema.Array(Appointment),
    }) {}
    const table = { Tag: {} }

    it("pk, collection, list and context composites, edge keys and many sk paths", () => {
      Aggregate.make(Match, {
        table,
        schema: AppSchema,
        pk: { field: "pk", composite: ["matchId"] },
        collection: {
          index: "lsi1",
          name: "match",
          sk: { field: "lsi1sk", composite: ["season"] },
        },
        list: {
          index: "gsi1",
          name: "matches",
          pk: { field: "gsi1pk", composite: ["season"] },
          sk: { field: "gsi1sk", composite: ["matchId"] },
        },
        context: ["venue"],
        root: { entityType: "MatchItem" },
        edges: {
          officials: Aggregate.many({
            entityType: "MatchOfficial",
            entity: Officials,
            sk: { composite: ["role", "official.officialId"] },
          }),
        },
      })
    })

    it("a misspelled name in each position", () => {
      const base = {
        table,
        schema: AppSchema,
        collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: [] } },
        root: { entityType: "MatchItem" },
      } as const
      const typeOnly = (_: () => unknown) => undefined
      typeOnly(() =>
        Aggregate.make(Match, {
          table,
          schema: AppSchema,
          // @ts-expect-error not a schema field
          pk: { field: "pk", composite: ["matchIdd"] },
          collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MatchItem" },
          edges: {},
        }),
      )
      typeOnly(() =>
        Aggregate.make(Match, {
          table,
          schema: AppSchema,
          pk: { field: "pk", composite: ["matchId"] },
          collection: { index: "lsi1", name: "match", sk: { field: "lsi1sk", composite: [] } },
          root: { entityType: "MatchItem" },
          // @ts-expect-error not a schema field
          context: ["venu"],
          edges: {},
        }),
      )
      typeOnly(() =>
        Aggregate.make(Match, {
          ...base,
          pk: { field: "pk", composite: ["matchId"] },
          edges: {
            // @ts-expect-error not a schema field
            oficials: Aggregate.many({
              entityType: "MatchOfficial",
              entity: Officials,
            }),
          },
        }),
      )
      typeOnly(() =>
        Aggregate.make(Appointment, {
          root: { entityType: "AppointmentItem" },
          edges: {
            // @ts-expect-error not a schema field (sub-aggregate form)
            oficial: Aggregate.one({ entityType: "Appointee", entity: Officials }),
          },
        }),
      )
      typeOnly(() =>
        Aggregate.make(Match, {
          ...base,
          pk: { field: "pk", composite: ["matchId"] },
          edges: {
            // @ts-expect-error not a scalar path of the element (the ref object itself)
            officials: Aggregate.many({
              entityType: "MatchOfficial",
              entity: Officials,
              sk: { composite: ["official"] },
            }),
          },
        }),
      )
    })
  })
})
