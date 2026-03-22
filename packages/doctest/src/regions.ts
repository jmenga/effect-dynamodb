/**
 * Parse #region / #endregion markers from example files.
 *
 * Example files use:
 *   // #region model
 *   class Product extends Schema.Class<Product>("Product")({ ... })
 *   // #endregion
 */

import { readFileSync } from "node:fs"

export interface Region {
  /** Region name (from `// #region <name>`) */
  readonly name: string
  /** Source file path */
  readonly source: string
  /** Content between #region and #endregion (trimmed) */
  readonly content: string
  /** Line number of the #region marker */
  readonly lineNumber: number
}

/**
 * Extract all named regions from a source file.
 */
export function extractRegions(filePath: string): ReadonlyArray<Region> {
  const content = readFileSync(filePath, "utf-8")
  return extractRegionsFromString(content, filePath)
}

/**
 * Extract all named regions from source content.
 */
export function extractRegionsFromString(content: string, filePath: string): ReadonlyArray<Region> {
  const lines = content.split("\n")
  const regions: Array<Region> = []
  const stack: Array<{ name: string; startLine: number; lines: Array<string> }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()

    const regionStart = trimmed.match(/^\/\/\s*#region\s+(\S+)/)
    if (regionStart) {
      stack.push({ name: regionStart[1]!, startLine: i + 1, lines: [] })
      continue
    }

    if (trimmed.match(/^\/\/\s*#endregion/)) {
      const current = stack.pop()
      if (current) {
        regions.push({
          name: current.name,
          source: filePath,
          content: current.lines.join("\n").trim(),
          lineNumber: current.startLine,
        })
      }
      continue
    }

    // Add line to all open regions (supports nesting)
    for (const open of stack) {
      open.lines.push(line)
    }
  }

  return regions
}

/**
 * Build a map of region name → content for quick lookup.
 */
export function regionMap(regions: ReadonlyArray<Region>): Map<string, Region> {
  const map = new Map<string, Region>()
  for (const region of regions) {
    map.set(region.name, region)
  }
  return map
}
