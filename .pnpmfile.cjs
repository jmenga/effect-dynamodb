// Pins the peer dependency between lockstep packages in the manifest that gets
// published, so `@effect-dynamodb/geo@X` requires `effect-dynamodb@X` (issue #191).
//
// `workspace:*` does this for regular dependencies, but not for a peer: Changesets
// major-bumps a package whose peer falls out of range, an exact peer falls out of
// range on every minor, and the fixed group then takes all four packages to the next
// major. So the peer stays `workspace:^` in package.json, and is pinned only here.
//
// The hook runs after pnpm resolves `workspace:`, so it sees a concrete range.
const LOCKSTEP = [
  "effect-dynamodb",
  "@effect-dynamodb/schema",
  "@effect-dynamodb/geo",
  "@effect-dynamodb/language-service",
]

module.exports = {
  hooks: {
    beforePacking(pkg) {
      for (const name of LOCKSTEP) {
        if (pkg.peerDependencies?.[name] !== undefined) {
          pkg.peerDependencies[name] = pkg.version
        }
      }
      return pkg
    },
  },
}
