/**
 * A ref to an entity that offloads fields (#179, decisions row 55). The ref's schema must leave the
 * offloaded fields out (EDD-9143), and the copy follows it: put-time hydration and a cascade both
 * store the target's other fields, never a pointer and never an offloaded value, and hydration
 * reads the target without fetching a single object.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

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

/** The referenced entity, plain or retaining versions (its cascade runs from another path). */
const define = (retain: boolean) => {
  const Owners = Entity.make({
    model: DynamoModel.configure(Owner, {
      ownerId: { identifier: true },
      avatar: { storedAs: DynamoModel.External({ contentType: "image/png" }) },
      profile: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 16 } }) },
    }),
    entityType: "Owner",
    primaryKey: {
      pk: { field: "pk", composite: ["ownerId"] },
      sk: { field: "sk", composite: [] },
    },
    ...(retain ? { versioned: { retain: true } } : {}),
  } as never) as any
  const Folder = Schema.Struct({
    folderId: Schema.String,
    owner: OwnerSummary.pipe(DynamoModel.ref),
  })
  const Folders = Entity.make({
    model: DynamoModel.configure(Folder, { folderId: { identifier: true } }),
    entityType: "Folder",
    primaryKey: {
      pk: { field: "pk", composite: ["folderId"] },
      sk: { field: "sk", composite: [] },
    },
    refs: {
      owner: {
        entity: Owners,
        cascade: { index: "gsi1", pk: { field: "gsi1pk" }, sk: { field: "gsi1sk" } },
      },
    },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "refs", version: 1, escapeKeys: true }),
    entities: { Owners, Folders },
  })
  return { Owners, Folders, Main }
}

const session = <A>(
  retain: boolean,
  body: (
    db: any,
    Folders: any,
    folders: () => ReadonlyArray<Row>,
    gets: () => number,
  ) => Effect.Effect<A, unknown, any>,
) => {
  const { Owners, Folders, Main } = define(retain)
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  const blobs = BlobStore.memory()
  const folders = () =>
    ([...table.items.values()] as ReadonlyArray<Row>).filter((row) => row.__edd_e__?.S === "Folder")
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { Owners, Folders }, tables: { Main } })
    return yield* body(db, Folders, folders, () => blobs.inspect().calls.get)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(table.layer, Main.layer({ name: "table" }), BlobStore.layer(blobs)),
    ),
  )
}

const AVATAR = new Uint8Array(64).fill(7)
const PROFILE = { bio: "b".repeat(200) }

describe("a ref to an entity that offloads fields (#179)", () => {
  for (const retain of [false, true]) {
    it.effect(
      `${retain ? "retained" : "plain"}: hydration and a cascade copy the target's other fields: no pointer, no offloaded value, no fetch`,
      () =>
        session(retain, (db, Folders, folders, gets) =>
          Effect.gen(function* () {
            yield* db.entities.Owners.put({
              ownerId: "o1",
              name: "Before",
              avatar: AVATAR,
              profile: PROFILE,
            }).asEffect()
            const put = yield* db.entities.Folders.put({ folderId: "f1", ownerId: "o1" }).asEffect()
            expect(JSON.parse(JSON.stringify(put))).toMatchObject({
              folderId: "f1",
              owner: { ownerId: "o1", name: "Before" },
            })
            expect(folders().map((row) => row.owner)).toEqual([
              { M: { ownerId: { S: "o1" }, name: { S: "Before" } } },
            ])
            // Hydration read the target lazily: nothing was fetched.
            expect(gets()).toBe(0)

            // The update's own result read lazily, so any fetch would be the cascade's.
            yield* db.entities.Owners.update({ ownerId: "o1" })
              .set({ name: "After" })
              .cascade({ targets: [Folders] })
              .offloaded("lazy")
              .asEffect()
            expect(folders().map((row) => row.owner)).toEqual([
              { M: { ownerId: { S: "o1" }, name: { S: "After" } } },
            ])
            expect(gets()).toBe(0)

            const got = yield* db.entities.Folders.get({ folderId: "f1" })
            expect(JSON.parse(JSON.stringify(got))).toMatchObject({
              folderId: "f1",
              owner: { ownerId: "o1", name: "After" },
            })
            expect(Object.keys((got as any).owner).sort()).toEqual(["name", "ownerId"])
            // Neither copy names the offloaded attributes, as a value or as a pointer.
            for (const row of folders()) {
              const owner = row.owner?.M ?? {}
              expect(Object.keys(owner).sort()).toEqual(["name", "ownerId"])
            }
          }),
        ),
    )
  }
})
