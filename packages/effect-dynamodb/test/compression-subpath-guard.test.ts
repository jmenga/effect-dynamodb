/**
 * The main `effect-dynamodb` entry stays runtime-neutral: `node:zlib` is
 * imported only by the `effect-dynamodb/compression/zlib` subpath, which the
 * main entry's import graph never reaches.
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
const ZLIB = new Set(["node:zlib", "zlib"])

describe("compression subpath guard", () => {
  it("only src/compression/zlib.ts imports node:zlib", () => {
    const importers = walk(srcDir).filter((file) =>
      [...code(file).matchAll(SPECIFIER_RE)].some((m) => ZLIB.has(m[1]!)),
    )
    expect(importers.map((f) => relative(pkgRoot, f))).toEqual(["src/compression/zlib.ts"])
  })

  it("the main entry's import graph never reaches node:zlib or the node subpath", () => {
    const seen = new Set<string>()
    const queue = [join(srcDir, "index.ts")]
    const hits: Array<string> = []
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      for (const m of code(file).matchAll(SPECIFIER_RE)) {
        const spec = m[1]!
        if (ZLIB.has(spec) || spec.includes("compression/zlib")) hits.push(`${file} -> ${spec}`)
        if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec).replace(/\.js$/, ".ts"))
      }
    }
    expect(seen.size).toBeGreaterThan(10)
    expect(hits).toEqual([])
  })

  it("package.json exports the subpath at the path tsc emits", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      readonly exports: Record<string, { readonly types: string; readonly import: string }>
    }
    expect(pkg.exports["./compression/zlib"]).toEqual({
      types: "./dist/compression/zlib.d.ts",
      import: "./dist/compression/zlib.js",
    })
  })
})
