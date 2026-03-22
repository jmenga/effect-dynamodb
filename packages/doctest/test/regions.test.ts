import { describe, expect, it } from "vitest"
import { extractRegionsFromString, regionMap } from "../src/regions.js"

describe("extractRegionsFromString", () => {
  it("extracts a single region", () => {
    const content = `
import { Schema } from "effect"

// #region model
class User extends Schema.Class<User>("User")({
  userId: Schema.String,
}) {}
// #endregion

const other = 42
`
    const regions = extractRegionsFromString(content, "test.ts")
    expect(regions).toHaveLength(1)
    expect(regions[0]!.name).toBe("model")
    expect(regions[0]!.content).toContain("class User")
    expect(regions[0]!.content).not.toContain("import")
    expect(regions[0]!.content).not.toContain("other")
  })

  it("extracts multiple regions", () => {
    const content = `
// #region model
class User {}
// #endregion

// #region entity
const Users = Entity.make({})
// #endregion
`
    const regions = extractRegionsFromString(content, "test.ts")
    expect(regions).toHaveLength(2)
    expect(regions[0]!.name).toBe("model")
    expect(regions[1]!.name).toBe("entity")
  })

  it("handles nested regions", () => {
    const content = `
// #region setup
const schema = DynamoSchema.make({ name: "app", version: 1 })

// #region entity
const Users = Entity.make({})
// #endregion

const table = Table.make({ schema })
// #endregion
`
    const regions = extractRegionsFromString(content, "test.ts")
    expect(regions).toHaveLength(2)

    const entityRegion = regions.find((r) => r.name === "entity")
    expect(entityRegion!.content).toContain("Entity.make")
    expect(entityRegion!.content).not.toContain("DynamoSchema")

    const setupRegion = regions.find((r) => r.name === "setup")
    expect(setupRegion!.content).toContain("DynamoSchema")
    expect(setupRegion!.content).toContain("Entity.make")
    expect(setupRegion!.content).toContain("Table.make")
  })

  it("trims content whitespace", () => {
    const content = `
// #region model

class User {}

// #endregion
`
    const regions = extractRegionsFromString(content, "test.ts")
    expect(regions[0]!.content).toBe("class User {}")
  })

  it("returns empty array for no regions", () => {
    const content = `const x = 42`
    const regions = extractRegionsFromString(content, "test.ts")
    expect(regions).toHaveLength(0)
  })
})

describe("regionMap", () => {
  it("builds name → region map", () => {
    const content = `
// #region model
class User {}
// #endregion
// #region entity
const Users = Entity.make({})
// #endregion
`
    const regions = extractRegionsFromString(content, "test.ts")
    const map = regionMap(regions)
    expect(map.get("model")!.content).toContain("class User")
    expect(map.get("entity")!.content).toContain("Entity.make")
    expect(map.has("nonexistent")).toBe(false)
  })
})
