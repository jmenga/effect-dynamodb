// Checks packed tarballs, which is what actually gets published, not package.json.
//
// usage: node .github/scripts/check-lockstep-pins.mjs <tarball>...
//
// Fails if a manifest still holds a `workspace:` spec, which npm cannot install
// (issue #64), or allows a different version of another lockstep package. Keys are
// composed in `@effect-dynamodb/schema`, so a mixed install writes one version's key
// text with another version's runtime (issue #191).
import { execFileSync } from "node:child_process"

const LOCKSTEP = new Set([
  "effect-dynamodb",
  "@effect-dynamodb/schema",
  "@effect-dynamodb/geo",
  "@effect-dynamodb/language-service",
])
const FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"]

const problems = []
for (const tarball of process.argv.slice(2)) {
  const manifest = execFileSync("tar", ["-xzOf", tarball, "package/package.json"], {
    encoding: "utf8",
  })
  const pkg = JSON.parse(manifest)
  for (const field of FIELDS) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (String(spec).startsWith("workspace:")) {
        problems.push(`${pkg.name}: ${field}.${dep} = "${spec}" is an unresolved workspace spec`)
      } else if (LOCKSTEP.has(dep) && spec !== pkg.version) {
        problems.push(`${pkg.name}: ${field}.${dep} = "${spec}", expected exactly "${pkg.version}"`)
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  process.exit(1)
}
console.log(`Packed manifests are pinned: ${process.argv.length - 2} checked`)
