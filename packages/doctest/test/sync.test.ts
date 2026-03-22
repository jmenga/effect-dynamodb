import { readdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { describe, expect, it } from "vitest"
import { extractFromFile } from "../src/extract.js"
import { verifySyncForPage } from "../src/sync.js"

const DOCS_DIR = resolve(import.meta.dirname, "../../docs/src/content/docs")
const EXAMPLES_DIR = resolve(import.meta.dirname, "../../effect-dynamodb/examples")

/**
 * Discover all MDX files that have region-attributed code blocks.
 */
function findSyncablePages(): Array<{ mdxPath: string; slug: string }> {
  const pages: Array<{ mdxPath: string; slug: string }> = []

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.name.endsWith(".mdx")) {
        const page = extractFromFile(fullPath)
        const hasRegions = page.blocks.some((b) => b.region !== undefined && b.example !== undefined)
        if (hasRegions) {
          pages.push({ mdxPath: fullPath, slug: page.slug })
        }
      }
    }
  }

  if (existsSync(DOCS_DIR)) walk(DOCS_DIR)
  return pages
}

describe("Doc snippet sync", () => {
  const pages = findSyncablePages()

  if (pages.length === 0) {
    it("no syncable pages found yet (add region attributes to MDX code blocks)", () => {
      // Placeholder — will be replaced as pages get region attributes
    })
    return
  }

  for (const { mdxPath, slug } of pages) {
    it(`${slug} — snippets match example regions`, () => {
      const result = verifySyncForPage(mdxPath, EXAMPLES_DIR)

      for (const check of result.checks) {
        if (!check.matches) {
          expect.fail(
            `Region "${check.region}" at line ${check.lineNumber} does not match ` +
              `example ${check.example}.\n\n` +
              `--- Doc snippet ---\n${check.docContent}\n\n` +
              `--- Example region ---\n${check.exampleContent}`,
          )
        }
      }
    })
  }
})
