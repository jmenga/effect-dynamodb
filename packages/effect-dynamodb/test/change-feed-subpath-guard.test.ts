/**
 * `@aws-sdk/client-dynamodb-streams` is an optional peer dependency: only the
 * `effect-dynamodb/change-feed` subpath imports it, and the main entry's
 * import graph never reaches that subpath.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, "..")
const srcDir = join(pkgRoot, "src")

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : []
  })

/** Source without comments, so doc examples that mention the subpath do not count. */
const code = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

const SPECIFIER_RE = /(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g
const STREAMS_SDK = "@aws-sdk/client-dynamodb-streams"

describe("change-feed subpath guard", () => {
  it("only src/change-feed imports the DynamoDB Streams SDK", () => {
    const importers = walk(srcDir)
      .filter((file) => [...code(file).matchAll(SPECIFIER_RE)].some((m) => m[1] === STREAMS_SDK))
      .map((f) => relative(pkgRoot, f))
    expect(importers.length).toBeGreaterThan(0)
    for (const file of importers) expect(file.startsWith("src/change-feed/")).toBe(true)
  })

  it("the main entry's import graph never reaches the Streams SDK or the subpath", () => {
    const seen = new Set<string>()
    const queue = [join(srcDir, "index.ts")]
    const hits: Array<string> = []
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      for (const m of code(file).matchAll(SPECIFIER_RE)) {
        const spec = m[1]!
        if (spec === STREAMS_SDK || spec.includes("change-feed")) hits.push(`${file} -> ${spec}`)
        if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec).replace(/\.js$/, ".ts"))
      }
    }
    expect(seen.size).toBeGreaterThan(10)
    expect(hits).toEqual([])
  })

  it("package.json exports the subpath and declares the SDK an optional peer", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      readonly exports: Record<string, { readonly types: string; readonly import: string }>
      readonly dependencies: Record<string, string>
      readonly peerDependencies: Record<string, string>
      readonly peerDependenciesMeta: Record<string, { readonly optional?: boolean }>
    }
    expect(pkg.exports["./change-feed"]).toEqual({
      types: "./dist/change-feed/index.d.ts",
      import: "./dist/change-feed/index.js",
    })
    expect(pkg.dependencies[STREAMS_SDK]).toBeUndefined()
    expect(pkg.peerDependencies[STREAMS_SDK]).toBeDefined()
    expect(pkg.peerDependenciesMeta[STREAMS_SDK]).toEqual({ optional: true })
  })
})
