/**
 * Offloaded entity fields (#179) — the definition-time surface of the pure
 * `Entity.make` (shared with the runtime one through `buildEntityDefinition`):
 * the resolved `entity.offload`, and the guards EDD-9111 (missing / non-binary
 * External field), EDD-9142 (External key / index / unique / ref / identifier
 * / vector source), EDD-9143 (a ref copying an offloaded field) and EDD-9114
 * (`offload` options).
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as Entity from "../src/Entity.js"

class Document extends Schema.Class<Document>("Document")({
  docId: Schema.String,
  title: Schema.String,
  status: Schema.String,
  body: Schema.Struct({ text: Schema.String }),
  scan: Schema.Uint8Array,
  thumbnail: Schema.optional(Schema.Uint8Array),
  preview: Schema.NullOr(Schema.Uint8Array),
  sketch: Schema.optionalKey(Schema.Uint8Array),
  encoded: Schema.Uint8ArrayFromBase64,
  mixed: Schema.Union([Schema.Uint8Array, Schema.String]),
}) {}

const overflow = DynamoModel.Packed({ format: "json", external: {} })
const binary = DynamoModel.External({ contentType: "application/pdf" })

const primaryKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const make = (
  attrs: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  model: Schema.Top = Document,
): Entity.EntityDefinition =>
  Entity.make({
    // The guards are what is under test: the attribute map is built
    // dynamically, including shapes the configure() types would refuse.
    model: DynamoModel.configure(model as typeof Document, attrs as never),
    entityType: "Document",
    primaryKey,
    ...extra,
  } as never) as unknown as Entity.EntityDefinition

describe("Entity.make — offloading members", () => {
  it("defines an entity that offloads", () => {
    expect(make({ body: { storedAs: overflow }, scan: { storedAs: binary } }).offload).toEqual({
      itemBudget: undefined,
      prefix: undefined,
      overflow: ["body"],
      binary: ["scan"],
    })
    expect(make({ scan: { storedAs: binary } }).offload?.binary).toEqual(["scan"])
    expect(make({ body: { storedAs: overflow } }).offload?.overflow).toEqual(["body"])
  })

  it("leaves entity.offload undefined for an entity that offloads nothing", () => {
    const def = make({ body: { storedAs: DynamoModel.Packed({ format: "json" }) } })
    expect(def.offload).toBeUndefined()
    expect(def._data.externalFields).toEqual({})
    expect(def._data.overflowFields).toEqual({})
    expect(make({}).offload).toBeUndefined()
  })

  it("runs every guard on an offloading entity", () => {
    expect(() => make({ scan: { storedAs: binary } }, { unique: { byScan: ["scan"] } })).toThrow(
      /\[EDD-9142\]/,
    )
    expect(() => make({ scan: { storedAs: binary } }, { offload: { nope: 1 } })).toThrow(
      /\[EDD-9114\]/,
    )
  })
})

describe("Entity.make — resolved offload settings", () => {
  it("resolves entity.offload with the offloaded field names by kind", () => {
    const def = make(
      {
        body: { storedAs: overflow },
        scan: { field: "s", storedAs: binary },
        thumbnail: { storedAs: DynamoModel.External() },
      },
      { offload: { itemBudget: 300_000, prefix: "prod/docs" } },
    )
    expect(def.offload).toEqual({
      itemBudget: 300_000,
      prefix: "prod/docs",
      overflow: ["body"],
      binary: ["scan", "thumbnail"],
    })
    expect(Object.isFrozen(def.offload)).toBe(true)
    expect(def._data.overflowFields).toEqual({ body: overflow })
    expect(def._data.externalFields).toEqual({ scan: binary, thumbnail: DynamoModel.External() })
    // An overflow field is a packed field; External fields are as opaque to
    // expressions, so the expression guards cover them too (EDD-9076).
    expect(def._data.packedFields.body).toBe(overflow)
    expect(def._packedFields).toEqual(["body", "scan", "thumbnail"])
  })

  it("leaves itemBudget and prefix undefined when offload is not given", () => {
    const def = make({ scan: { storedAs: binary } })
    expect(def.offload).toEqual({
      itemBudget: undefined,
      prefix: undefined,
      overflow: [],
      binary: ["scan"],
    })
  })

  it("accepts optional, optionalKey and NullOr binary fields", () => {
    const def = make({
      thumbnail: { storedAs: binary },
      preview: { storedAs: binary },
      sketch: { storedAs: binary },
    })
    expect(def.offload?.binary).toEqual(["thumbnail", "preview", "sketch"])
  })

  it("combines External with field and immutable", () => {
    const def = make({ scan: { field: "s", immutable: true, storedAs: binary } })
    expect(def.offload?.binary).toEqual(["scan"])
  })
})

describe("EDD-9111 — External field shape", () => {
  it("refuses an External field that is not on the model", () => {
    expect(() =>
      Entity.make({
        model: {
          ...DynamoModel.configure(Document, {}),
          attributes: { nope: { external: binary } },
        } as never,
        entityType: "Document",
        primaryKey,
      }),
    ).toThrow(/\[EDD-9111\] Entity "Document": External field "nope" does not exist on the model/)
  })

  it.each([
    ["encoded", /its encoded side is a string/],
    ["title", /its encoded side is a string/],
    ["body", /must be binary/],
    ["mixed", /must be binary/],
  ])("refuses %s", (field, reason) => {
    const thunk = () => make({ [field]: { storedAs: binary } })
    expect(thunk).toThrow(`[EDD-9111] Entity "Document": External field "${field}" must be binary`)
    expect(thunk).toThrow(reason)
  })
})

describe("EDD-9142 — External key, index and constraint sources", () => {
  it("refuses a primary-key composite", () => {
    expect(() =>
      Entity.make({
        model: DynamoModel.configure(Document, { scan: { storedAs: binary } }),
        entityType: "Document",
        primaryKey: {
          pk: { field: "pk", composite: ["docId"] },
          sk: { field: "sk", composite: ["scan"] },
        },
      }),
    ).toThrow(/\[EDD-9142\].*External field "scan" cannot be a composite of the primary key/)
  })

  it("refuses a GSI pk or sk composite", () => {
    const index = (pk: string, sk: string) => ({
      byX: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: [pk] },
        sk: { field: "gsi1sk", composite: [sk] },
      },
    })
    expect(() =>
      make({ scan: { storedAs: binary } }, { indexes: index("scan", "status") }),
    ).toThrow(/\[EDD-9142\].*"scan" cannot be a composite of index "byX"/)
    expect(() =>
      make({ scan: { storedAs: binary } }, { indexes: index("status", "scan") }),
    ).toThrow(/\[EDD-9142\]/)
  })

  it("refuses a shards.by source, which the shard hash would read as a pointer (#183)", () => {
    const sharded = (by: ReadonlyArray<string>) => ({
      byStatus: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["status"] },
        sk: { field: "gsi1sk", composite: ["title", "scan"] },
        shards: { count: 4, by },
      },
    })
    const bySource =
      /\[EDD-9142\] Entity "Document": External field "scan" cannot be a shards\.by source of index "byStatus"/
    expect(() => make({ scan: { storedAs: binary } }, { indexes: sharded(["scan"]) })).toThrow(
      bySource,
    )
    expect(() =>
      make({ scan: { storedAs: binary } }, { indexes: sharded(["title", "scan"]) }),
    ).toThrow(bySource)
    // Named before its composite, and on an injected (collection-owned) index too.
    const def = make({ scan: { storedAs: binary } })
    expect(() =>
      def._injectIndex("coll", {
        index: "gsi9",
        pk: { field: "gsi9pk", composite: ["status"] },
        sk: { field: "gsi9sk", composite: ["scan"] },
        shards: { count: 4, by: ["scan"], previous: undefined, source: ["scan"] },
      }),
    ).toThrow(/\[EDD-9142\].*"scan" cannot be a shards\.by source of index "coll"/)
    // A scalar source beside an External field elsewhere is accepted.
    const accepted = make(
      { scan: { storedAs: binary } },
      {
        indexes: {
          byStatus: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["status"] },
            sk: { field: "gsi1sk", composite: ["title"] },
            shards: { count: 4, by: ["title"] },
          },
        },
      },
    )
    expect(accepted.indexes.byStatus?.shards?.source).toEqual(["title"])
  })

  it("refuses an index injected later (collection-owned) whose composite is External", () => {
    const def = make({ scan: { storedAs: binary } })
    expect(() =>
      def._injectIndex("coll", {
        index: "gsi9",
        pk: { field: "gsi9pk", composite: ["status"] },
        sk: { field: "gsi9sk", composite: ["scan"] },
      }),
    ).toThrow(/\[EDD-9142\].*External field "scan" cannot be a composite of index "coll"/)
    // A clean injection still works.
    def._injectIndex("ok", {
      index: "gsi8",
      pk: { field: "gsi8pk", composite: ["status"] },
      sk: { field: "gsi8sk", composite: [] },
    })
    expect(def.indexes.ok).toBeDefined()
  })

  it("names the External composite, matching own keys only", () => {
    // `"valueOf" in {}` is true, so an `in` lookup named a field inherited
    // from Object.prototype as the External composite.
    const Odd = Schema.Struct({
      docId: Schema.String,
      valueOf: Schema.String,
      scan: Schema.Uint8Array,
    })
    expect(() =>
      make(
        { scan: { storedAs: binary } },
        {
          indexes: {
            byX: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["valueOf"] },
              sk: { field: "gsi1sk", composite: ["scan"] },
            },
          },
        },
        Odd,
      ),
    ).toThrow(/\[EDD-9142\] Entity "Document": External field "scan" cannot be a composite/)
    // A composite with such a name is not External.
    expect(() =>
      make(
        { scan: { storedAs: binary } },
        {
          indexes: {
            byX: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["valueOf"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        },
        Odd,
      ),
    ).not.toThrow()
  })

  it("refuses timeSeries.orderBy", () => {
    expect(() =>
      make(
        { scan: { storedAs: binary } },
        {
          timeSeries: {
            orderBy: "scan",
            appendInput: Schema.Struct({ docId: Schema.String, scan: Schema.Uint8Array }),
          },
        },
      ),
    ).toThrow(/\[EDD-9142\].*"scan" cannot be timeSeries\.orderBy/)
  })

  it("refuses a unique-constraint field", () => {
    expect(() => make({ scan: { storedAs: binary } }, { unique: { byScan: ["scan"] } })).toThrow(
      /\[EDD-9142\].*"scan" cannot be named by unique constraint "byScan"/,
    )
    expect(() =>
      make({ scan: { storedAs: binary } }, { unique: { byBoth: { fields: ["title", "scan"] } } }),
    ).toThrow(/\[EDD-9142\].*unique constraint "byBoth"/)
  })

  it("refuses a DynamoModel.ref field", () => {
    expect(() => make({ scan: { storedAs: binary, ref: true } })).toThrow(
      /\[EDD-9142\].*"scan" is a DynamoModel\.ref field/,
    )
  })

  it("refuses the entity's identifier", () => {
    expect(() => make({ scan: { storedAs: binary, identifier: true } })).toThrow(
      /\[EDD-9142\].*"scan" is the entity's identifier/,
    )
  })

  it.each([
    ["source", { source: { fields: ["scan"] } }, /source field of vector index "similar"/],
    [
      "partition",
      { source: { fields: ["title"] }, partition: ["scan"] },
      /partition composite of vector index "similar"/,
    ],
    [
      "filters",
      { source: { fields: ["title"] }, filters: ["scan"] },
      /filter field of vector index "similar"/,
    ],
  ])("refuses a vector index %s field", (_, vector, reason) => {
    const thunk = () =>
      make(
        { scan: { storedAs: binary } },
        { vectorIndexes: { similar: { index: "vec", dimensions: 3, ...vector } } },
      )
    expect(thunk).toThrow(/\[EDD-9142\]/)
    expect(thunk).toThrow(reason)
  })

  it("an overflow field keeps the Packed guards (EDD-9072 on a key composite)", () => {
    expect(() =>
      Entity.make({
        model: DynamoModel.configure(Document, { body: { storedAs: overflow } }),
        entityType: "Document",
        primaryKey: {
          pk: { field: "pk", composite: ["docId"] },
          sk: { field: "sk", composite: ["body"] },
        },
      }),
    ).toThrow(/\[EDD-9072\]/)
    expect(() => make({ body: { storedAs: overflow } }, { unique: { byBody: ["body"] } })).toThrow(
      /\[EDD-9074\]/,
    )
  })
})

describe("EDD-9143 — a ref copying an offloaded field", () => {
  class Owner extends Schema.Class<Owner>("Owner")({
    ownerId: Schema.String,
    name: Schema.String,
    avatar: Schema.Uint8Array,
    profile: Schema.Struct({ bio: Schema.String }),
  }) {}
  class OwnerSummary extends Schema.Class<OwnerSummary>("OwnerSummary")({
    ownerId: Schema.String,
    name: Schema.String,
  }) {}

  const Owners = (attrs: Record<string, unknown>) =>
    Entity.make({
      model: DynamoModel.configure(Owner, {
        ownerId: { identifier: true },
        ...attrs,
      } as never),
      entityType: "Owner",
      primaryKey: {
        pk: { field: "pk", composite: ["ownerId"] },
        sk: { field: "sk", composite: [] },
      },
    } as never)

  const Folder = (owner: Schema.Top) =>
    Schema.Struct({ folderId: Schema.String, owner: owner.pipe(DynamoModel.ref) })

  const makeFolders = (owner: Schema.Top, target: unknown) =>
    Entity.make({
      model: DynamoModel.configure(Folder(owner), { folderId: { identifier: true } }),
      entityType: "Folder",
      primaryKey: {
        pk: { field: "pk", composite: ["folderId"] },
        sk: { field: "sk", composite: [] },
      },
      refs: { owner: { entity: target } },
    } as never)

  it("refuses a ref whose schema includes a binary field the target offloads", () => {
    const target = Owners({ avatar: { storedAs: DynamoModel.External() } })
    expect(() => makeFolders(Owner, target)).toThrow(
      /\[EDD-9143\] Entity "Folder": ref "owner" copies entity "Owner", and its schema includes "avatar"/,
    )
  })

  it("refuses a ref whose schema includes an overflow field the target offloads", () => {
    const target = Owners({ profile: { storedAs: overflow } })
    expect(() => makeFolders(Owner, target)).toThrow(/\[EDD-9143\].*includes "profile"/)
    const both = Owners({ profile: { storedAs: overflow }, avatar: { storedAs: binary } })
    expect(() => makeFolders(Owner, both)).toThrow(/includes "profile", "avatar".*those fields\./)
  })

  it("accepts a ref to a subset model without the offloaded fields", () => {
    const target = Owners({ avatar: { storedAs: DynamoModel.External() } })
    const def = makeFolders(OwnerSummary, target) as unknown as Entity.EntityDefinition
    expect(def.offload).toBeUndefined()
  })

  it("accepts a ref to an entity that offloads nothing", () => {
    const target = Entity.make({
      model: DynamoModel.configure(Owner, { ownerId: { identifier: true } }),
      entityType: "Owner",
      primaryKey: {
        pk: { field: "pk", composite: ["ownerId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    expect(() => makeFolders(Owner, target)).not.toThrow()
  })
})

describe("EDD-9114 — offload options", () => {
  const expect9114 = (
    attrs: Record<string, unknown>,
    offload: unknown,
    fragment: string | RegExp,
  ) => {
    const thunk = () => make(attrs, { offload })
    expect(thunk).toThrow(/\[EDD-9114\] Entity "Document":/)
    expect(thunk).toThrow(fragment)
  }
  const both = { body: { storedAs: overflow }, scan: { storedAs: binary } }

  it("refuses offload that is not an object", () => {
    expect9114(both, null, "received null")
    expect9114(both, 5, "received number")
    expect9114(both, [], "received an array")
  })

  it("refuses an unknown option", () => {
    expect9114(both, { threshold: 1 }, 'unknown offload option "threshold"')
  })

  it("refuses offload on an entity that offloads nothing", () => {
    expect9114({}, {}, "offload is set, but nothing is offloaded")
    expect9114(
      { body: { storedAs: DynamoModel.Packed({ format: "json" }) } },
      { prefix: "x" },
      "nothing is offloaded",
    )
  })

  it("refuses an itemBudget out of range", () => {
    for (const itemBudget of [0, -1, 1.5, 409_601, Number.NaN, "300000"]) {
      expect9114(both, { itemBudget }, "offload.itemBudget must be a safe integer in 1 … 409600")
    }
  })

  it("accepts itemBudget at both ends of the range", () => {
    expect(make(both, { offload: { itemBudget: 1 } }).offload?.itemBudget).toBe(1)
    expect(make(both, { offload: { itemBudget: 409_600 } }).offload?.itemBudget).toBe(409_600)
  })

  it("refuses itemBudget on a binary-only entity", () => {
    expect9114(
      { scan: { storedAs: binary } },
      { itemBudget: 300_000 },
      "offload.itemBudget is set, but nothing can be offloaded to meet it",
    )
  })

  it("refuses a malformed prefix", () => {
    for (const prefix of ["", "/prod", "prod docs", "prod#docs", "naïve", "x".repeat(257), 5]) {
      expect9114(both, { prefix }, "offload.prefix must be a non-empty string")
    }
  })

  it("accepts a prefix of unreserved characters and slashes", () => {
    const prefix = "prod/docs-1_x.~/"
    expect(make(both, { offload: { prefix } }).offload?.prefix).toBe(prefix)
    const longest = "p".repeat(256)
    expect(make(both, { offload: { prefix: longest } }).offload?.prefix).toBe(longest)
  })

  it("accepts an empty offload object", () => {
    expect(make(both, { offload: {} }).offload).toEqual({
      itemBudget: undefined,
      prefix: undefined,
      overflow: ["body"],
      binary: ["scan"],
    })
  })
})
