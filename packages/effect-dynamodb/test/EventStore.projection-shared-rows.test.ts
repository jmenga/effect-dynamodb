/**
 * Projections sharing a read model's rows (#237).
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { Schema } from "effect"
import * as Entity from "../src/Entity.js"

describe("a sparse checkpoint map's entries beside another role's attribute", () => {
  // #237 §3: a checkpoint map stored as a sparse map with prefix `p`, beside a revision stored as
  // `p#rev`. `EDD-9133` compares the map by its container's name, but no projection can be defined
  // over such a read model: every role is a model field (`EDD-9081`), and `Entity.make` refuses a
  // model field stored where a row's reader takes an entry of a sparse map (`EDD-9140`), before any
  // projection exists. On 1.39.0 the row stored `p#rev = 90` from `initial`'s `{ rev: 90 }` and
  // reported revision 1; 1.40.0 refuses the entity, as this release does.
  const Model = Schema.Struct({
    id: Schema.String,
    total: Schema.Number,
    checkpoints: Schema.Record(Schema.String, Schema.Number),
    rev: Schema.optional(Schema.Number),
    version: Schema.optional(Schema.Number),
    owner: Schema.optional(Schema.String),
  })

  it.each([
    ["revision", "rev"],
    ["checkpoint", "version"],
    ["checkpoint owner", "owner"],
  ] as const)("a %s stored as an entry's attribute is refused at load", (_role, field) => {
    expect(() =>
      Entity.make({
        model: DynamoModel.configure(Model, {
          checkpoints: { storedAs: DynamoModel.SparseMap({ prefix: "p" }) },
          [field]: { field: `p#${field}` },
        }),
        entityType: "Row",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    ).toThrow(
      `[EDD-9140] Entity "Row": sparse map "checkpoints" stores each entry as "p#<key>", and a ` +
        `row's reader takes "p#${field}", the attribute the field "${field}" is stored in, as its ` +
        `entry "${field}".`,
    )
  })
})
