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

    // Each entry here is otherwise complete: only the guard on the entry's
    // keys refuses the extra option (the runtime refuses it too, EDD-9087).
    it("a misspelled option on an entry, or on a hashed prefix part", () => {
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
                prefix: [
                  "agencyId",
                  // @ts-expect-error `hsh` is not an option of a prefix part
                  { field: "title", hash: 4, hsh: 4 },
                ],
                zorder: [
                  // @ts-expect-error `stpe` is not an option of a range
                  { field: "price", min: 0, max: 100, stpe: 5 },
                  // @ts-expect-error `step` is a range's option, not a time window's
                  { field: "listedAt", from: "2024-01-01", unit: "days", bits: 8, step: 1 },
                  // @ts-expect-error `bitz` is not an option of a literals entry
                  { field: "status", bitz: 3 },
                ],
              },
            },
          },
        })
      expect(typed).toThrow(/EDD-9087/)
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

    it("a many sk over a record's values, as a custom decompose takes them", () => {
      const Line = Schema.Struct({ sku: Schema.String, qty: Schema.Number })
      const base = {
        table,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: { index: "lsi1", name: "keyed", sk: { field: "lsi1sk", composite: [] } },
        root: { entityType: "Keyed" },
      } as const
      const ByRecord = Schema.Struct({
        id: Schema.String,
        lines: Schema.Record(Schema.String, Line),
      })
      const ByStruct = Schema.Struct({
        id: Schema.String,
        lines: Schema.Struct({ first: Line, second: Line }),
      })
      const ByText = Schema.Struct({ id: Schema.String, lines: Schema.String })
      Aggregate.make(ByRecord, {
        ...base,
        edges: { lines: Aggregate.many({ entityType: "L", sk: { composite: ["sku"] } }) },
      })
      // Its rows are what its `decompose` makes: nothing here says what they hold.
      Aggregate.make(ByStruct, {
        ...base,
        edges: { lines: Aggregate.many({ entityType: "L", sk: { composite: ["anything"] } }) },
      })
      const typeOnly = (_: () => unknown) => undefined
      typeOnly(() =>
        Aggregate.make(ByRecord, {
          ...base,
          edges: {
            // @ts-expect-error a record's value has no `skuu`
            lines: Aggregate.many({ entityType: "L", sk: { composite: ["skuu"] } }),
          },
        }),
      )
      typeOnly(() =>
        Aggregate.make(ByText, {
          ...base,
          edges: {
            // @ts-expect-error a string has no rows
            lines: Aggregate.many({ entityType: "L", sk: { composite: ["sku"] } }),
          },
        }),
      )
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
  describe("shards.by (#183)", () => {
    const shardedOn = {
      name: "gsi7",
      pk: { field: "gsi7pk", composite: ["region"] },
      sk: { field: "gsi7sk", composite: ["agencyId", "status"] },
    } as const
    /** `shardedOn` in its own attributes: two key halves can't share one (`EDD-9106`). */
    const attributes = (n: number) =>
      ({
        name: `gsi${n}`,
        pk: { field: `gsi${n}pk`, composite: shardedOn.pk.composite },
        sk: { field: `gsi${n}sk`, composite: shardedOn.sk.composite },
      }) as const

    it("names sort key composites of its own index", () => {
      const made = Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: byListingId,
        indexes: {
          byRegion: { ...shardedOn, shards: { count: 8, by: ["agencyId"] } },
          byRegionAll: { ...attributes(8), shards: { count: 8, by: ["agencyId", "status"] } },
          shorthand: { ...attributes(9), shards: 8 },
          full: { ...attributes(10), shards: { count: 8, previous: 1 } },
        },
      })
      expect(made.indexes.byRegion.shards?.source).toEqual(["agencyId"])
    })

    it("refuses a name that is not a model field", () => {
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          indexes: {
            byRegion: {
              ...shardedOn,
              shards: {
                count: 8,
                // @ts-expect-error not a model field
                by: ["agency"],
              },
            },
          },
        }),
      ).toThrow("[EDD-9102]")
    })

    it("refuses a model field that is not a sort key composite of this index", () => {
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          indexes: {
            byRegion: {
              ...shardedOn,
              shards: {
                count: 8,
                // @ts-expect-error `title` is a model field, not a composite of this index
                by: ["title"],
              },
            },
          },
        }),
      ).toThrow("[EDD-9102]")
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          indexes: {
            byRegion: {
              ...shardedOn,
              shards: {
                count: 8,
                // @ts-expect-error a partition key composite can't be the source
                by: ["region"],
              },
            },
          },
        }),
      ).toThrow("[EDD-9102]")
    })

    it("refuses any `by` on a Z-order sort key", () => {
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: byListingId,
          indexes: {
            byFacets: {
              name: "gsi7",
              pk: { field: "gsi7pk", composite: ["region"] },
              sk: { field: "gsi7sk", zorder: [{ field: "bedrooms", min: 0, max: 15, step: 1 }] },
              shards: {
                count: 8,
                // @ts-expect-error a Z-order half's fields can't be pinned by an accessor
                by: ["bedrooms"],
              },
            },
          },
        }),
      ).toThrow("[EDD-9102]")
    })

    describe("a key over a value the library changes on every write (EDD-9121)", () => {
      class Revision extends Schema.Class<Revision>("Revision")({
        id: Schema.String,
        owner: Schema.String,
        price: Schema.Number,
        version: Schema.Number,
        rev: Schema.Number,
      }) {}
      const byId = {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      } as const

      it("`retain` knows the value, and without `versioned` it's any field", () => {
        Entity.make({
          model: Revision,
          entityType: "Revision",
          primaryKey: byId,
          versioned: { retain: true },
          indexes: {
            byVersion: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["owner"] },
              sk: { field: "gsi1sk", composite: ["version"] },
            },
          },
        })
        Entity.make({
          model: Revision,
          entityType: "Revision",
          primaryKey: byId,
          indexes: {
            byVersion: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["owner"] },
              sk: { field: "gsi1sk", composite: ["version"] },
            },
          },
        })
        // `versioned` keeps it elsewhere, so `version` is the model's.
        Entity.make({
          model: Revision,
          entityType: "Revision",
          primaryKey: byId,
          versioned: { field: "rev" },
          indexes: {
            byVersion: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["owner"] },
              sk: { field: "gsi1sk", composite: ["version"] },
            },
          },
        })
      })

      it("a half over it without `retain` is the error, on that half", () => {
        expect(() =>
          Entity.make({
            model: Revision,
            entityType: "Revision",
            primaryKey: byId,
            versioned: true,
            indexes: {
              byVersion: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["owner"] },
                // @ts-expect-error `versioned` adds one to it on every write, without reading it
                sk: { field: "gsi1sk", composite: ["version"] },
              },
            },
          }),
        ).toThrow(/EDD-9121/)
        expect(() =>
          Entity.make({
            model: Revision,
            entityType: "Revision",
            primaryKey: byId,
            versioned: { field: "rev" },
            indexes: {
              byRev: {
                name: "gsi1",
                // @ts-expect-error `versioned` keeps its version here
                pk: { field: "gsi1pk", composite: ["rev"] },
                sk: { field: "gsi1sk", composite: ["owner"] },
              },
            },
          }),
        ).toThrow(/EDD-9121/)
      })

      it("a Z-order entry over it, dimension or prefix", () => {
        expect(() =>
          Entity.make({
            model: Revision,
            entityType: "Revision",
            primaryKey: byId,
            versioned: true,
            indexes: {
              search: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["owner"] },
                sk: {
                  field: "gsi1sk",
                  zorder: [
                    { field: "price", min: 0, max: 9 },
                    // @ts-expect-error `versioned` adds one to it on every write, without reading it
                    { field: "version", min: 0, max: 9 },
                  ],
                },
              },
            },
          }),
        ).toThrow(/EDD-9121/)
        expect(() =>
          Entity.make({
            model: Revision,
            entityType: "Revision",
            primaryKey: byId,
            versioned: true,
            indexes: {
              search: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["owner"] },
                sk: {
                  field: "gsi1sk",
                  // @ts-expect-error `versioned` adds one to it on every write, without reading it
                  prefix: ["version"],
                  zorder: [{ field: "price", min: 0, max: 9 }],
                },
              },
            },
          }),
        ).toThrow(/EDD-9121/)
      })
    })

    it("refuses shards on the primary key", () => {
      expect(() =>
        Entity.make({
          model: Listing,
          entityType: "Listing",
          // @ts-expect-error shards is an option of a secondary index
          primaryKey: { ...byListingId, shards: 8 },
        }),
      ).toThrow("[EDD-9099]")
    })
  })
})

// Every such input compiles and loads, as on 1.39.0: an append that can't compose the index's key
// fails with EDD-9100 when it's made.
describe("timeSeries.appendInput against a sharded index", () => {
  class Series extends Schema.Class<Series>("FieldNamesSeries")({
    id: Schema.String,
    at: Schema.Number,
    tenant: Schema.String,
    region: Schema.optional(Schema.String),
    group: Schema.optional(Schema.String),
  }) {}
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const indexes = {
    byTenant: {
      name: "gsi",
      indexPolicy: { pk: "preserve", sk: "preserve" },
      pk: { field: "gpk", composite: ["tenant"] },
      sk: { field: "gsk", composite: ["region", "group"] },
      shards: { count: 4, by: ["group"] },
    },
  } as const

  it("the whole key compiles", () => {
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          tenant: Schema.String,
          region: Schema.String,
          group: Schema.String,
        }),
      },
    })
  })

  it("`by` without the composite before it compiles and loads", () => {
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          tenant: Schema.String,
          group: Schema.String,
        }),
      },
    })
  })

  it("an optional `by` compiles and loads: an append may leave it out", () => {
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          group: Schema.optional(Schema.String),
        }),
      },
    })
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          group: Schema.UndefinedOr(Schema.String),
        }),
      },
    })
  })

  it("an optional composite after a gap compiles and loads: an append may leave it out", () => {
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes: {
        byTenant: {
          name: "gsi",
          indexPolicy: { pk: "preserve", sk: "preserve" },
          pk: { field: "gpk", composite: ["tenant"] },
          sk: { field: "gsk", composite: ["group", "region"] },
          shards: { count: 4, by: ["group"] },
        },
      },
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          tenant: Schema.String,
          group: Schema.String,
        }),
      },
    })
  })

  it("a required `by` after a composite no append holds, beside optional ones, compiles and loads", () => {
    Entity.make({
      model: Series,
      entityType: "Series",
      primaryKey,
      indexes,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          id: Schema.String,
          at: Schema.optional(Schema.Number),
          tenant: Schema.String,
          group: Schema.String,
        }),
      },
    })
  })
})
