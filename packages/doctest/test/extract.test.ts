import { describe, expect, it } from "vitest"
import { extractFromString } from "../src/extract.js"

describe("extractFromString", () => {
  it("extracts basic typescript code blocks", () => {
    const mdx = `
# Hello

\`\`\`typescript
const x = 1
\`\`\`

Some text.
`
    const result = extractFromString(mdx, "test.mdx")
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.content).toBe("const x = 1")
    expect(result.blocks[0]!.language).toBe("typescript")
  })

  it("extracts title attribute", () => {
    const mdx = `
\`\`\`typescript title="models.ts"
class User {}
\`\`\`
`
    const result = extractFromString(mdx, "test.mdx")
    expect(result.blocks[0]!.title).toBe("models.ts")
  })

  it("extracts region and example attributes", () => {
    const mdx = `
\`\`\`typescript region="model" example="starter.ts"
class Todo {}
\`\`\`
`
    const result = extractFromString(mdx, "test.mdx")
    expect(result.blocks[0]!.region).toBe("model")
    expect(result.blocks[0]!.example).toBe("starter.ts")
  })

  it("extracts multiple attributes", () => {
    const mdx = `
\`\`\`typescript title="models.ts" region="user-model" example="crud.ts"
class User {}
\`\`\`
`
    const result = extractFromString(mdx, "test.mdx")
    const block = result.blocks[0]!
    expect(block.title).toBe("models.ts")
    expect(block.region).toBe("user-model")
    expect(block.example).toBe("crud.ts")
  })

  it("ignores non-typescript code blocks", () => {
    const mdx = `
\`\`\`bash
echo hello
\`\`\`

\`\`\`typescript
const x = 1
\`\`\`

\`\`\`json
{ "key": "value" }
\`\`\`
`
    const result = extractFromString(mdx, "test.mdx")
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.language).toBe("typescript")
  })

  it("handles ts language tag", () => {
    const mdx = `
\`\`\`ts
const x = 1
\`\`\`
`
    const result = extractFromString(mdx, "test.mdx")
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.language).toBe("ts")
  })

  it("derives slug from docs file path", () => {
    const result = extractFromString("", "packages/docs/src/content/docs/tutorials/starter.mdx")
    expect(result.slug).toBe("tutorials/starter")
  })

  it("derives empty slug for index", () => {
    const result = extractFromString("", "packages/docs/src/content/docs/index.mdx")
    expect(result.slug).toBe("")
  })

  it("preserves multi-line content", () => {
    const mdx = `
\`\`\`typescript
const a = 1
const b = 2
const c = a + b
\`\`\`
`
    const result = extractFromString(mdx, "test.mdx")
    expect(result.blocks[0]!.content).toBe("const a = 1\nconst b = 2\nconst c = a + b")
  })

  it("returns undefined for missing attributes", () => {
    const mdx = `
\`\`\`typescript
const x = 1
\`\`\`
`
    const result = extractFromString(mdx, "test.mdx")
    expect(result.blocks[0]!.title).toBeUndefined()
    expect(result.blocks[0]!.region).toBeUndefined()
    expect(result.blocks[0]!.example).toBeUndefined()
  })
})
