/**
 * Extract TypeScript code blocks from MDX files.
 *
 * Parses code fences and extracts metadata (language, title, region, example).
 */

import { readFileSync } from "node:fs"

export interface CodeBlock {
  /** MDX file path */
  readonly source: string
  /** Code fence language (typescript, ts, etc.) */
  readonly language: string
  /** title="..." attribute, if present */
  readonly title: string | undefined
  /** region="..." attribute — maps to a #region in the backing example */
  readonly region: string | undefined
  /** example="..." attribute — path to the backing example file */
  readonly example: string | undefined
  /** Raw code content (no fence markers) */
  readonly content: string
  /** Line number in MDX where the opening fence appears */
  readonly lineNumber: number
}

export interface PageBlocks {
  /** MDX file path */
  readonly path: string
  /** Page slug (e.g., "tutorials/starter", "guides/modeling") */
  readonly slug: string
  /** All TypeScript code blocks on this page */
  readonly blocks: ReadonlyArray<CodeBlock>
}

/**
 * Extract all TypeScript code blocks from an MDX file.
 */
export function extractFromFile(filePath: string): PageBlocks {
  const content = readFileSync(filePath, "utf-8")
  return extractFromString(content, filePath)
}

/**
 * Extract all TypeScript code blocks from MDX content.
 */
export function extractFromString(content: string, filePath: string): PageBlocks {
  const lines = content.split("\n")
  const blocks: Array<CodeBlock> = []

  let inBlock = false
  let blockStart = 0
  let language = ""
  let title: string | undefined
  let region: string | undefined
  let example: string | undefined
  let blockLines: Array<string> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (!inBlock) {
      const match = line.match(/^```(typescript|ts)\b(.*)$/)
      if (match) {
        inBlock = true
        blockStart = i + 1
        language = match[1]!
        const meta = match[2]!
        title = extractAttr(meta, "title")
        region = extractAttr(meta, "region")
        example = extractAttr(meta, "example")
        blockLines = []
      }
    } else if (line.startsWith("```")) {
      blocks.push({
        source: filePath,
        language,
        title,
        region,
        example,
        content: blockLines.join("\n"),
        lineNumber: blockStart,
      })
      inBlock = false
    } else {
      blockLines.push(line)
    }
  }

  const slug = deriveSlug(filePath)
  return { path: filePath, slug, blocks }
}

/**
 * Extract a named attribute from a code fence meta string.
 * Handles both `attr="value"` and `attr='value'` forms.
 */
function extractAttr(meta: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}=["']([^"']+)["']`)
  const match = meta.match(pattern)
  return match?.[1]
}

/**
 * Derive a page slug from an MDX file path.
 */
function deriveSlug(filePath: string): string {
  const match = filePath.match(/content\/docs\/(.+)\.mdx$/)
  if (!match) return filePath
  const slug = match[1]!
  return slug === "index" ? "" : slug
}
