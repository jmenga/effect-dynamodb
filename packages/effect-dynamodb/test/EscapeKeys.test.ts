/**
 * `escapeKeys` (#183) through the entity, the aggregate and the stream, on a table that stores
 * what it is sent. The scenarios are in `helpers/EscapeKeyScenarios.ts`;
 * `connected.escape-keys.test.ts` runs them on DynamoDB Local.
 */

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { fromAttributeMap } from "../src/Marshaller.js"
import {
  cursorScenarios,
  everyKeyScenarios,
  findsEveryKeyScenarios,
  flipScenarios,
  type Harness,
  historyScenarios,
  sentinelScenarios,
  shapeScenarios,
} from "./helpers/EscapeKeyScenarios.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const harness: Harness = {
  on: (MainTable, body) => {
    const indexes: Record<string, { pk: string; sk: string }> = {
      lsi1: { pk: "pk", sk: "lsi1sk" },
      gsi4: { pk: "sk", sk: "pk" },
    }
    for (const n of [1, 2, 3, 5, 6, 7]) indexes[`gsi${n}`] = { pk: `gsi${n}pk`, sk: `gsi${n}sk` }
    // The shapes' `gsi4` is an ordinary one.
    if (MainTable.schema.name === "shapes") indexes.gsi4 = { pk: "gsi4pk", sk: "gsi4sk" }
    const table = makeRecordingTable({ indexes })
    return body(
      () => Effect.sync(() => [...table.items.values()].map((row) => fromAttributeMap(row))),
      (other, effect) => effect.pipe(Effect.provide(other.layer({ name: "t" }))) as never,
    ).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "t" })))) as never
  },
}

describe("escapeKeys", () => {
  describe("every key against the published 1.36.0", () => {
    for (const scenario of everyKeyScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("every key path finds what it wrote", () => {
    for (const scenario of findsEveryKeyScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("turning it on or off over stored rows", () => {
    for (const scenario of flipScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a unique sentinel in transition", () => {
    for (const scenario of sentinelScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("a time series' bounds", () => {
    for (const scenario of historyScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("cursors", () => {
    for (const scenario of cursorScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
  describe("the canonical GSI shapes", () => {
    for (const scenario of shapeScenarios) {
      it.effect(scenario.name, () => scenario.run(harness))
    }
  })
})
