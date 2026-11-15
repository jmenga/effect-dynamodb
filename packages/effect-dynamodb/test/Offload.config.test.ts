/**
 * Offloaded storage (#179) — the config surface of the runtime members:
 * `Entity.make` (`entity.offload`, index composites), `fromDefinition`, the
 * aggregate guards (EDD-9111 / EDD-9142 on edge items, EDD-9143 on ref edges
 * and wrapped `many` refs at any depth), and `EventStore.makeStream`
 * (`Packed({ external })` data / state, `stream.offload`, `offload` options,
 * an `External` config refused as a stream storage config). Nothing here
 * reads or writes.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as SchemaEntity from "@effect-dynamodb/schema/Entity.js"
import { BlobStoreError as SchemaBlobStoreError } from "@effect-dynamodb/schema/Errors.js"
import { Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Barrel from "../src/index.js"
import * as Table from "../src/Table.js"

// Offloading requires escaped key text (design §11.10).
const AppSchema = DynamoSchema.make({ name: "offload", version: 1, escapeKeys: true })

class Scan extends Schema.Class<Scan>("Scan")({
  scanId: Schema.String,
  label: Schema.String,
  image: Schema.Uint8Array,
  notes: Schema.Struct({ text: Schema.String }),
}) {}

const binary = DynamoModel.External({ contentType: "image/png" })
const overflow = DynamoModel.Packed({ format: "json", external: { threshold: 1_024 } })

const scanConfig = {
  model: DynamoModel.configure(Scan, {
    scanId: { identifier: true },
    image: { storedAs: binary },
    notes: { storedAs: overflow },
  }),
  entityType: "Scan",
  primaryKey: {
    pk: { field: "pk", composite: ["scanId"] },
    sk: { field: "sk", composite: [] },
  },
} as const

describe("Entity.make (runtime) — offloaded storage", () => {
  it("defines an entity that offloads, with the default offload options", () => {
    const Scans = Entity.make(scanConfig)
    expect(Scans.offload).toEqual({
      itemBudget: undefined,
      prefix: undefined,
      overflow: ["notes"],
      binary: ["image"],
    })
  })

  it("resolves entity.offload", () => {
    const Scans = Entity.make({ ...scanConfig, offload: { itemBudget: 200_000, prefix: "scans" } })
    expect(Scans.offload).toEqual({
      itemBudget: 200_000,
      prefix: "scans",
      overflow: ["notes"],
      binary: ["image"],
    })
    // Operational: the CRUD surface is there.
    expect(typeof Scans.put).toBe("function")
  })

  it("offload is undefined for an entity that offloads nothing", () => {
    const Plain = Entity.make({ ...scanConfig, model: Scan })
    expect(Plain.offload).toBeUndefined()
  })

  it("refuses the offload options with EDD-9114", () => {
    expect(() => Entity.make({ ...scanConfig, offload: { prefix: "/abs" } })).toThrow(
      /\[EDD-9114\] Entity "Scan": offload\.prefix/,
    )
    expect(() => Entity.make({ ...scanConfig, model: Scan, offload: {} })).toThrow(
      /\[EDD-9114\].*nothing is offloaded/,
    )
  })

  it("refuses an index over an External field (EDD-9142)", () => {
    const withIndex = (composite: ReadonlyArray<string>) =>
      ({
        ...scanConfig,
        indexes: {
          byX: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["label"] },
            sk: { field: "gsi1sk", composite },
          },
        },
      }) as never
    expect(() => Entity.make(withIndex(["image"]))).toThrow(
      /\[EDD-9142\] Entity "Scan": External field "image" cannot be a composite of index "byX"/,
    )
    // An overflow field keeps its Packed refusal.
    expect(() => Entity.make(withIndex(["notes"]))).toThrow(/\[EDD-9072\]/)
  })

  it("fromDefinition carries a pure definition's offload settings", () => {
    const pure = SchemaEntity.make({
      ...scanConfig,
      model: DynamoModel.configure(Scan, {
        scanId: { identifier: true },
        image: { storedAs: DynamoModel.External() },
      }),
      offload: { prefix: "pure" },
    })
    const runtime = Entity.fromDefinition(pure as never)
    expect(runtime.offload).toEqual({
      itemBudget: undefined,
      prefix: "pure",
      overflow: [],
      binary: ["image"],
    })
  })

  it("exports BlobStoreError from the package entry point (the schema package's class)", () => {
    expect(Barrel.BlobStoreError).toBe(SchemaBlobStoreError)
  })
})

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

describe("Aggregate.make — offloaded edge fields", () => {
  const Scans = Entity.make(scanConfig)
  const MainTable = Table.make({ schema: AppSchema, entities: { Scans } })

  class Album extends Schema.Class<Album>("Album")({
    albumId: Schema.String,
    cover: Scan,
    scans: Schema.Array(Scan),
  }) {}

  const albumConfig = (edges: Record<string, unknown>) =>
    ({
      table: MainTable,
      schema: AppSchema,
      pk: { field: "pk", composite: ["albumId"] },
      collection: { name: "album" },
      root: { entityType: "AlbumItem" },
      edges,
    }) as never

  it("accepts one and many edges over an offloading entity", () => {
    expect(() =>
      Aggregate.make(
        Album,
        albumConfig({
          cover: Aggregate.one("cover", { entityType: "AlbumCover", entity: Scans }),
          scans: Aggregate.many("scans", {
            entityType: "AlbumScan",
            entity: Scans,
            sk: { composite: ["scanId"] },
          }),
        }),
      ),
    ).not.toThrow()
  })

  it("refuses a many element that redeclares an External field as non-binary (EDD-9111)", () => {
    class ScanSheet extends Schema.Class<ScanSheet>("ScanSheet")({
      scanId: Schema.String,
      label: Schema.String,
      image: Schema.String,
    }) {}
    class Sheets extends Schema.Class<Sheets>("Sheets")({
      albumId: Schema.String,
      scans: Schema.Array(ScanSheet),
    }) {}
    expect(() =>
      Aggregate.make(
        Sheets,
        albumConfig({
          scans: Aggregate.many("scans", {
            entityType: "AlbumScan",
            entity: Scans,
            sk: { composite: ["scanId"] },
          }),
        }),
      ),
    ).toThrow(
      /\[EDD-9111\] Aggregate edge "scans": "image" is an External field of entity "Scan".*non-binary/,
    )
  })

  it("refuses an External field as a one edge's discriminator (EDD-9142)", () => {
    expect(() =>
      Aggregate.make(
        Album,
        albumConfig({
          cover: Aggregate.one("cover", {
            entityType: "AlbumCover",
            entity: Scans,
            discriminator: { image: "x" },
          }),
        }),
      ),
    ).toThrow(/\[EDD-9142\] Aggregate edge "cover": discriminator "image" is an External field/)
  })

  it("refuses an External field as a many edge's sort-key composite (EDD-9142)", () => {
    expect(() =>
      Aggregate.make(
        Album,
        albumConfig({
          scans: Aggregate.many("scans", {
            entityType: "AlbumScan",
            entity: Scans,
            sk: { composite: ["image"] },
          }),
        }),
      ),
    ).toThrow(/\[EDD-9142\] Aggregate edge "scans": sort-key composite "image" is an External/)
  })

  describe("ref edges (EDD-9143)", () => {
    class ScanRef extends Schema.Class<ScanRef>("ScanRef")({
      scanId: Schema.String,
      label: Schema.String,
    }) {}

    it("refuses a ref edge whose schema includes an offloaded field", () => {
      class Pinned extends Schema.Class<Pinned>("Pinned")({
        albumId: Schema.String,
        pinned: Scan,
      }) {}
      expect(() => Aggregate.make(Pinned, albumConfig({ pinned: Aggregate.ref(Scans) }))).toThrow(
        /\[EDD-9143\] Aggregate "AlbumItem": ref "pinned" copies entity "Scan", and its schema includes "notes", "image"/,
      )
    })

    it("refuses one inside a sub-aggregate", () => {
      class Page extends Schema.Class<Page>("Page")({ title: Schema.String, pinned: Scan }) {}
      class Book extends Schema.Class<Book>("Book")({ albumId: Schema.String, page: Page }) {}
      const PageAggregate = Aggregate.make(Page, {
        root: { entityType: "BookPage" },
        edges: { pinned: Aggregate.ref(Scans) },
      })
      expect(() =>
        Aggregate.make(
          Book,
          albumConfig({ page: PageAggregate.with({ discriminator: { pageNumber: 1 } }) }),
        ),
      ).toThrow(/\[EDD-9143\].*ref "pinned" copies entity "Scan"/)
    })

    it("accepts a ref edge to a subset model without the offloaded fields", () => {
      class Pinned extends Schema.Class<Pinned>("PinnedSubset")({
        albumId: Schema.String,
        pinned: ScanRef,
      }) {}
      expect(() =>
        Aggregate.make(Pinned, albumConfig({ pinned: Aggregate.ref(Scans) })),
      ).not.toThrow()
    })

    // A `many` element that WRAPS the ref (`PlayerSheet { player }`): hydration
    // fills the element field named after the entity (`scan`) from `scanId`,
    // and the edge item stores it as a nested map — a denormalised copy.
    describe("a many element wrapping the ref", () => {
      class ScanWithImage extends Schema.Class<ScanWithImage>("ScanWithImage")({
        scanId: Schema.String,
        label: Schema.String,
        image: Schema.Uint8Array,
      }) {}
      class ScanWithNotes extends Schema.Class<ScanWithNotes>("ScanWithNotes")({
        scanId: Schema.String,
        label: Schema.String,
        notes: Schema.Struct({ text: Schema.String }),
      }) {}
      const sheets = (scan: Schema.Top) => {
        const Sheet = Schema.Struct({ scan, position: Schema.Number })
        class Sheets extends Schema.Class<Sheets>("Sheets")({
          albumId: Schema.String,
          scans: Schema.Array(Sheet),
        }) {}
        return { Sheet, Sheets }
      }
      const scansEdge = () =>
        Aggregate.many("scans", { entityType: "AlbumScanSheet", entity: Scans })

      it("refuses one whose ref includes a binary field", () => {
        const { Sheets } = sheets(ScanWithImage.pipe(DynamoModel.ref))
        expect(() => Aggregate.make(Sheets, albumConfig({ scans: scansEdge() }))).toThrow(
          /\[EDD-9143\] Aggregate "AlbumItem": ref "scans\.scan" copies entity "Scan", and its schema includes "image",/,
        )
      })

      it("refuses one whose ref includes an overflow field", () => {
        const { Sheets } = sheets(ScanWithNotes.pipe(DynamoModel.ref))
        expect(() => Aggregate.make(Sheets, albumConfig({ scans: scansEdge() }))).toThrow(
          /\[EDD-9143\].*ref "scans\.scan" copies entity "Scan", and its schema includes "notes",/,
        )
      })

      it("refuses one whose wrapped field is not ref-annotated (hydrated by name)", () => {
        const { Sheets } = sheets(Scan)
        expect(() => Aggregate.make(Sheets, albumConfig({ scans: scansEdge() }))).toThrow(
          /\[EDD-9143\].*ref "scans\.scan".*includes "notes", "image"/,
        )
      })

      it("refuses one inside a sub-aggregate", () => {
        const { Sheet } = sheets(ScanWithImage.pipe(DynamoModel.ref))
        class Shelf extends Schema.Class<Shelf>("Shelf")({
          title: Schema.String,
          scans: Schema.Array(Sheet),
        }) {}
        class Library extends Schema.Class<Library>("Library")({
          albumId: Schema.String,
          shelf: Shelf,
        }) {}
        const ShelfAggregate = Aggregate.make(Shelf, {
          root: { entityType: "LibraryShelf" },
          edges: { scans: scansEdge() },
        })
        expect(() =>
          Aggregate.make(
            Library,
            albumConfig({ shelf: ShelfAggregate.with({ discriminator: { shelfNo: 1 } }) }),
          ),
        ).toThrow(/\[EDD-9143\].*ref "scans\.scan" copies entity "Scan"/)
      })

      it("accepts one whose ref is a subset model without the offloaded fields", () => {
        const { Sheets } = sheets(ScanRef.pipe(DynamoModel.ref))
        expect(() => Aggregate.make(Sheets, albumConfig({ scans: scansEdge() }))).not.toThrow()
      })
    })
  })
})

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

describe("EventStore.makeStream — offloaded storage", () => {
  const LedgerTable = Table.make({ schema: AppSchema, entities: {} })
  class Recorded extends Schema.TaggedClass<Recorded>()("Recorded", {
    amount: Schema.Number,
    note: Schema.String,
  }) {}
  const State = Schema.Struct({ total: Schema.Number })
  const streamConfig = {
    table: LedgerTable,
    streamName: "Ledger",
    events: [Recorded],
    streamId: { composite: ["ledgerId"] },
  } as const
  const plain = DynamoModel.Packed({ format: "json" })

  it("defines a stream that offloads data, state or both, reporting stream.offload", () => {
    const none = { itemBudget: undefined, prefix: undefined }
    expect(
      EventStore.makeStream({ ...streamConfig, storedAs: { data: overflow } }).offload,
    ).toEqual({ ...none, overflow: ["data"] })
    expect(
      EventStore.makeStream({
        ...streamConfig,
        storedAs: { data: overflow },
        snapshot: { schema: State, storedAs: overflow },
      }).offload,
    ).toEqual({ ...none, overflow: ["data", "state"] })
    expect(
      EventStore.makeStream({ ...streamConfig, snapshot: { schema: State, storedAs: overflow } })
        .offload,
    ).toEqual({ ...none, overflow: ["state"] })
  })

  it("defines an offloading stream, reporting its storage and offload options", () => {
    const Ledger = EventStore.makeStream({
      ...streamConfig,
      storedAs: { data: overflow },
      snapshot: { schema: State, storedAs: plain },
      offload: { itemBudget: 350_000, prefix: "ledger" },
    })
    expect(Ledger.storedAs.data).toBe(overflow)
    expect(Ledger.storedAs.data?.external).toEqual({ threshold: 1_024 })
    expect(Ledger.storedAs.state?.external).toBeUndefined()
    expect(Ledger.offload).toEqual({ itemBudget: 350_000, prefix: "ledger", overflow: ["data"] })
  })

  it("stream.offload is undefined for a stream that offloads nothing", () => {
    const Ledger = EventStore.makeStream({ ...streamConfig, storedAs: { data: plain } })
    expect(Ledger.storedAs.data?.external).toBeUndefined()
    expect(Ledger.offload).toBeUndefined()
  })

  it("refuses the offload options with EDD-9114", () => {
    expect(() =>
      EventStore.makeStream({ ...streamConfig, storedAs: { data: plain }, offload: {} }),
    ).toThrow(/\[EDD-9114\] EventStream "Ledger": offload is set, but nothing is offloaded/)
    expect(() =>
      EventStore.makeStream({
        ...streamConfig,
        storedAs: { data: overflow },
        offload: { itemBudget: 0 },
      }),
    ).toThrow(/\[EDD-9114\] EventStream "Ledger": offload\.itemBudget/)
    expect(() =>
      EventStore.makeStream({
        ...streamConfig,
        storedAs: { data: overflow },
        offload: { prefix: "a b" } as never,
      }),
    ).toThrow(/\[EDD-9114\].*offload\.prefix/)
    expect(() =>
      EventStore.makeStream({
        ...streamConfig,
        storedAs: { data: overflow },
        offload: { budget: 1 } as never,
      }),
    ).toThrow(/\[EDD-9114\].*unknown offload option "budget"/)
  })

  it("refuses an External config as event data or snapshot state (EDD-9079)", () => {
    expect(() =>
      EventStore.makeStream({ ...streamConfig, storedAs: { data: binary as never } }),
    ).toThrow(
      /\[EDD-9079\].*storedAs\.data must be .*a DynamoModel\.External\(\.\.\.\) config.*DynamoModel\.Packed\(\{ external \}\)/,
    )
    expect(() =>
      EventStore.makeStream({
        ...streamConfig,
        snapshot: { schema: State, storedAs: binary as never },
      }),
    ).toThrow(/\[EDD-9079\].*snapshot\.storedAs must be .*DynamoModel\.External/)
  })

  it("runs the Packed guards on an overflow state (EDD-9073)", () => {
    expect(() =>
      EventStore.makeStream({
        ...streamConfig,
        snapshot: { schema: Schema.Number, storedAs: overflow },
      }),
    ).toThrow(/\[EDD-9073\]/)
  })
})
