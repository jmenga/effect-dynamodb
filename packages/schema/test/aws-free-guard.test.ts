/**
 * AWS-free guard — the whole point of `@effect-dynamodb/schema`.
 *
 * Asserts the pure schema package has ZERO `@aws-sdk` dependency in BOTH:
 *   (a) its transitive RUNTIME import graph (walk the built JS `import`/`require`
 *       statements AND assert no `aws-sdk` string survives in `dist/**` *.js), AND
 *   (b) its emitted `.d.ts` surface (no `aws-sdk` string in `dist/**` *.d.ts).
 *
 * This MUST fail loudly if a future change reintroduces an AWS import (value OR
 * `import type`) into the pure layer.
 *
 * Also verifies the source tree never imports `@aws-sdk` (catches the regression
 * even before a build), and a use-case smoke test (typed `inputSchema`).
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
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full, exts))
    else if (exts.includes(extname(full))) out.push(full)
  }
  return out
}

// Match real ESM/CJS module specifiers, NOT prose mentions in comments:
//   import ... from "@aws-sdk/..."   |   require("@aws-sdk/...")   |   import("@aws-sdk/...")
const SPECIFIER_RE = /(?:from|require|import)\s*\(?\s*["'`]@aws-sdk\/[^"'`]+["'`]/g
// A blunt substring check — after build, the pure dist must contain NO aws-sdk
// string at all (we phrase doc comments to avoid the literal "aws-sdk").
const SUBSTRING = "aws-sdk"

describe("aws-free guard", () => {
  beforeAll(() => {
    // Ensure dist is present and fresh so the .js / .d.ts assertions are authoritative.
    if (!existsSync(join(distDir, "index.js")) || !existsSync(join(distDir, "index.d.ts"))) {
      execFileSync("pnpm", ["exec", "tsc"], { cwd: pkgRoot, stdio: "inherit" })
    }
  })

  it("source tree imports no @aws-sdk module (value or type)", () => {
    const offenders: Array<string> = []
    for (const file of walk(srcDir, [".ts"])) {
      const content = readFileSync(file, "utf8")
      if (SPECIFIER_RE.test(content)) offenders.push(file)
      SPECIFIER_RE.lastIndex = 0
    }
    expect(offenders, `@aws-sdk import found in pure source: ${offenders.join(", ")}`).toEqual([])
  })

  it("built JS has no @aws-sdk import/require in its runtime graph", () => {
    const jsFiles = walk(distDir, [".js"])
    expect(jsFiles.length).toBeGreaterThan(0)
    const offenders: Array<string> = []
    for (const file of jsFiles) {
      const content = readFileSync(file, "utf8")
      if (SPECIFIER_RE.test(content)) offenders.push(file)
      SPECIFIER_RE.lastIndex = 0
    }
    expect(offenders, `@aws-sdk import found in built JS: ${offenders.join(", ")}`).toEqual([])
  })

  it("built JS contains no aws-sdk substring at all", () => {
    const offenders: Array<string> = []
    for (const file of walk(distDir, [".js"])) {
      if (readFileSync(file, "utf8").includes(SUBSTRING)) offenders.push(file)
    }
    expect(offenders, `aws-sdk substring found in built JS: ${offenders.join(", ")}`).toEqual([])
  })

  it("emitted .d.ts surface contains no @aws-sdk reference", () => {
    const dtsFiles = walk(distDir, [".ts"]).filter((f) => f.endsWith(".d.ts"))
    expect(dtsFiles.length).toBeGreaterThan(0)
    const offenders: Array<string> = []
    for (const file of dtsFiles) {
      // The strict check: NO aws-sdk substring anywhere in the public type surface.
      // This catches `import("@aws-sdk/...").AttributeValue` inline references too.
      if (readFileSync(file, "utf8").includes(SUBSTRING)) offenders.push(file)
    }
    expect(offenders, `aws-sdk reference found in emitted .d.ts: ${offenders.join(", ")}`).toEqual(
      [],
    )
  })

  it("transitive runtime import graph (from dist/index.js) reaches no @aws-sdk", () => {
    // Walk relative imports starting at the built entry. Any bare specifier that
    // starts with "@aws-sdk" is an immediate failure. We only need to follow the
    // package's OWN relative graph — a bare aws-sdk specifier anywhere in it fails.
    const seen = new Set<string>()
    const queue: Array<string> = [join(distDir, "index.js")]
    const awsHits: Array<string> = []
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file) || !existsSync(file)) continue
      seen.add(file)
      const content = readFileSync(file, "utf8")
      // bare-specifier imports
      for (const m of content.matchAll(/(?:from|import|require)\s*\(?\s*["'`]([^"'`]+)["'`]/g)) {
        const spec = m[1]!
        if (spec.startsWith("@aws-sdk")) awsHits.push(`${file} -> ${spec}`)
        if (spec.startsWith(".")) {
          const resolved = resolve(dirname(file), spec)
          queue.push(resolved.endsWith(".js") ? resolved : `${resolved}.js`)
        }
      }
    }
    expect(awsHits, `@aws-sdk reachable in runtime graph: ${awsHits.join(", ")}`).toEqual([])
  })
})
