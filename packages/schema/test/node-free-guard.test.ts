/**
 * Node-free guard — `@effect-dynamodb/schema` is runtime-neutral: compression
 * goes through the pluggable `Compression` registry, and the package never
 * imports `node:zlib` (or any other Node builtin) in its source or built JS.
 * zlib compressors live in `effect-dynamodb/compression/zlib`.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, "..")
const srcDir = join(pkgRoot, "src")
const distDir = join(pkgRoot, "dist")

const walk = (dir: string, exts: ReadonlyArray<string>): Array<string> => {
  const out: Array<string> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, exts))
    else if (exts.includes(extname(full))) out.push(full)
  }
  return out
}

// A module specifier naming zlib (`node:zlib` or bare `zlib`), or any `node:` builtin.
const SPECIFIER_RE = /(?:from|require|import)\s*\(?\s*["'`](node:[^"'`]+|zlib)["'`]/g

const offendersIn = (files: ReadonlyArray<string>): Array<string> => {
  const offenders: Array<string> = []
  for (const file of files) {
    const content = readFileSync(file, "utf8")
    for (const match of content.matchAll(SPECIFIER_RE)) offenders.push(`${file} -> ${match[1]}`)
  }
  return offenders
}

describe("node-free guard", () => {
  beforeAll(() => {
    if (!existsSync(join(distDir, "index.js"))) {
      execFileSync("pnpm", ["exec", "tsc"], { cwd: pkgRoot, stdio: "inherit" })
    }
  })

  it("source tree imports no node:zlib / Node builtin", () => {
    expect(offendersIn(walk(srcDir, [".ts"]))).toEqual([])
  })

  it("built JS and .d.ts import no node:zlib / Node builtin", () => {
    const files = walk(distDir, [".js", ".ts"])
    expect(files.length).toBeGreaterThan(0)
    expect(offendersIn(files)).toEqual([])
  })

  it("the built Compression and PackedCodec modules are present (so the dist check covers them)", () => {
    for (const file of ["Compression.js", "internal/PackedCodec.js"]) {
      expect(existsSync(join(distDir, file)), `${file} missing from dist — rebuild`).toBe(true)
    }
  })
})
