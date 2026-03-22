/**
 * Sync verification — compare doc snippets against example regions.
 *
 * For each code block with a `region` attribute, verify its content matches
 * the corresponding #region in the backing example file.
 */

import { resolve } from "node:path"
import type { CodeBlock } from "./extract.js"
import { extractFromFile } from "./extract.js"
import { extractRegions, regionMap } from "./regions.js"

export interface SyncResult {
  /** MDX file path */
  readonly source: string
  /** Page slug */
  readonly slug: string
  /** Results per region-attributed code block */
  readonly checks: ReadonlyArray<SyncCheck>
}

export interface SyncCheck {
  /** Region name */
  readonly region: string
  /** Example file path */
  readonly example: string
  /** Whether the doc snippet matches the example region */
  readonly matches: boolean
  /** Doc snippet content (normalized) */
  readonly docContent: string
  /** Example region content (normalized) */
  readonly exampleContent: string
  /** Line number in MDX */
  readonly lineNumber: number
}

/**
 * Verify all region-attributed code blocks in an MDX file match their example.
 */
export function verifySyncForPage(
  mdxPath: string,
  examplesDir: string,
): SyncResult {
  const page = extractFromFile(mdxPath)
  const regionBlocks = page.blocks.filter(
    (b): b is CodeBlock & { region: string; example: string } =>
      b.region !== undefined && b.example !== undefined,
  )

  const checks: Array<SyncCheck> = []

  // Group by example file to avoid re-parsing
  const byExample = new Map<string, Array<CodeBlock & { region: string; example: string }>>()
  for (const block of regionBlocks) {
    const examplePath = resolve(examplesDir, block.example)
    const existing = byExample.get(examplePath)
    if (existing) {
      existing.push(block)
    } else {
      byExample.set(examplePath, [block])
    }
  }

  for (const [examplePath, blocks] of byExample) {
    const regions = regionMap(extractRegions(examplePath))

    for (const block of blocks) {
      const region = regions.get(block.region)
      const docNorm = normalize(block.content)
      const exampleNorm = region ? normalize(region.content) : ""

      checks.push({
        region: block.region,
        example: examplePath,
        matches: region !== undefined && docNorm === exampleNorm,
        docContent: docNorm,
        exampleContent: exampleNorm,
        lineNumber: block.lineNumber,
      })
    }
  }

  return { source: mdxPath, slug: page.slug, checks }
}

/**
 * Normalize code for comparison:
 * - Trim leading/trailing whitespace
 * - Normalize line endings
 * - Remove Console.log lines (examples have them, docs may omit them)
 * - Remove empty for/for-of loops left after Console.log removal
 * - Collapse multiple blank lines to single blank line
 * - Normalize import paths (example relative → package name)
 */
function normalize(content: string): string {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    // Remove Console.log lines
    .filter((line) => !line.trim().startsWith("yield* Console.log"))
    // Remove empty for loops left after Console.log removal
    .join("\n")
    .replace(/\s*for\s*\([^)]*\)\s*\{\s*\}/g, "")
    .split("\n")
    // Remove blank lines for comparison (whitespace is not semantic)
    .filter((line) => line.trim().length > 0)

  return lines
    // Remove assert/assertEq lines (test infrastructure, not doc content)
    .filter((line) => !line.trim().startsWith("assertEq(") && !line.trim().startsWith("assert("))
    // Remove nested #region/#endregion markers
    .filter((line) => !line.trim().match(/^\/\/\s*#(end)?region/))
    // Normalize indentation: trim all leading whitespace per line
    .map((line) => line.trimStart())
    .join("\n")
    .trim()
    // Remove inline output comments (e.g., "// → name: ...", "// State: ...", "// Current version: ...")
    .replace(/\n\/\/\s*(?:→|State:|Current|Error:|Latest:|Reconstructed:|v\d+:)[^\n]*/g, "")
    // Remove inline result annotations (e.g., "// coffee.category -> ...")
    .replace(/\n\/\/\s*\w+\.\w+\s*→[^\n]*/g, "")
    // Normalize import paths
    .replace(/from\s+["']\.\.\/src\/[^"']+["']/g, 'from "effect-dynamodb"')
}
