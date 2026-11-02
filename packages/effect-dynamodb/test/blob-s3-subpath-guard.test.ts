/**
 * `@aws-sdk/client-s3` is an optional peer dependency (#179, design §12.2):
 * only the `effect-dynamodb/blob/s3` subpath (`src/blob/`) imports it, the
 * main entry's import graph never reaches it or the subpath, and the library
 * never imports `@aws-sdk/s3-request-presigner` (a caller passes its
 * `getSignedUrl`).
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
const S3_SDK = "@aws-sdk/client-s3"
const PRESIGNER = "@aws-sdk/s3-request-presigner"
const SUBPATH_RE = /(^|\/)blob\//

const importersOf = (matches: (specifier: string) => boolean): Array<string> =>
  walk(srcDir)
    .filter((file) => [...code(file).matchAll(SPECIFIER_RE)].some((m) => matches(m[1]!)))
    .map((file) => relative(pkgRoot, file))

describe("blob/s3 subpath guard", () => {
  it("only src/blob imports the S3 SDK; nothing imports the presigner", () => {
    const importers = importersOf((specifier) => specifier === S3_SDK)
    expect(importers.length).toBeGreaterThan(0)
    for (const file of importers) expect(file.startsWith("src/blob/")).toBe(true)
    expect(importersOf((specifier) => specifier === PRESIGNER)).toEqual([])
  })

  it("only src/blob imports src/blob", () => {
    for (const file of importersOf((specifier) => SUBPATH_RE.test(specifier))) {
      expect(file.startsWith("src/blob/")).toBe(true)
    }
  })

  it("the main entry's import graph never reaches the S3 SDK or the subpath", () => {
    const seen = new Set<string>()
    const queue = [join(srcDir, "index.ts")]
    const hits: Array<string> = []
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      for (const m of code(file).matchAll(SPECIFIER_RE)) {
        const spec = m[1]!
        if (spec === S3_SDK || spec === PRESIGNER || SUBPATH_RE.test(spec)) {
          hits.push(`${file} -> ${spec}`)
        }
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
    expect(pkg.exports["./blob/s3"]).toEqual({
      types: "./dist/blob/s3.d.ts",
      import: "./dist/blob/s3.js",
    })
    expect(pkg.dependencies[S3_SDK]).toBeUndefined()
    expect(pkg.dependencies[PRESIGNER]).toBeUndefined()
    expect(pkg.peerDependencies[S3_SDK]).toBeDefined()
    expect(pkg.peerDependenciesMeta[S3_SDK]).toEqual({ optional: true })
    expect(pkg.peerDependencies[PRESIGNER]).toBeUndefined()
  })
})
