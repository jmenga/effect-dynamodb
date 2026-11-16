/**
 * Completions for a shard table's `match` keys (#287, design §2.2, §10.3): the editor offers
 * exactly the index's partition key composites, in `Entity.make` and in `ShardLayouts.of`.
 * They come from the types (the guard sits on the parameter, with no default), so this asks
 * TypeScript's own language service, over a file beside the schema package's sources.
 */

import ts from "typescript"
import { describe, expect, it } from "vitest"

// Vitest defines it; the package's types have no Node globals.
declare const __dirname: string
const schemaSrc = ts.sys.resolvePath(`${__dirname}/../../schema/src`)
const probeFile = `${schemaSrc}/__shard_match_completions__.ts`

const source = (cursor: string) => `
import { Schema } from "effect"
import * as Entity from "./Entity.js"
import * as ShardLayouts from "./ShardLayouts.js"

class Device extends Schema.Class<Device>("Device")({
  tenantId: Schema.String,
  regionId: Schema.String,
  deviceId: Schema.String,
}) {}

const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId", "regionId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      shards: ${cursor === "make" ? "{ layouts: { default: 1, values: [{ match: { /*|*/ }, layout: 20 }] } }" : '{ layouts: "provided" }'},
    },
  },
})

${cursor === "of" ? "ShardLayouts.of(Devices, { byTenant: { default: 1, values: [{ match: { /*|*/ }, layout: 20 }] } })" : ""}
`

const completionsAt = (cursor: "make" | "of"): ReadonlyArray<string> => {
  const text = source(cursor)
  const position = text.indexOf("/*|*/")
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
  }
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [probeFile],
    getScriptVersion: () => "1",
    getScriptSnapshot: (file) => {
      if (file === probeFile) return ts.ScriptSnapshot.fromString(text)
      const content = ts.sys.readFile(file)
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getCurrentDirectory: () => schemaSrc,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (file) => file === probeFile || ts.sys.fileExists(file),
    readFile: (file) => (file === probeFile ? text : ts.sys.readFile(file)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  const completions = service.getCompletionsAtPosition(probeFile, position, {})
  return (completions?.entries ?? []).map((entry) => entry.name).sort()
}

describe("shard table match completions (#287)", () => {
  it("Entity.make completes the partition key composites", { timeout: 120_000 }, () => {
    expect(completionsAt("make")).toEqual(["regionId", "tenantId"])
  })

  it("ShardLayouts.of completes the provided index's composites", { timeout: 120_000 }, () => {
    expect(completionsAt("of")).toEqual(["regionId", "tenantId"])
  })
})
