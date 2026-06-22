# @effect-dynamodb/schema

## 1.9.1

### Patch Changes

- fix(release): resolve `workspace:` protocol at publish time (closes #64).

  `1.9.0` shipped with an unresolved `workspace:` spec (`effect-dynamodb`'s
  `dependencies."@effect-dynamodb/schema": "workspace:^"`, and `@effect-dynamodb/geo`'s
  `peerDependencies.effect-dynamodb`), making `effect-dynamodb@1.9.0` uninstallable for
  consumers. Root cause: `release.yml` published via `npm publish`, which does not
  rewrite the `workspace:` protocol.

  The publish step now packs each package with `pnpm pack` (which rewrites `workspace:`
  in `dependencies` and `peerDependencies` to concrete ranges) and publishes the
  resulting tarball via `npm publish` (preserving OIDC Trusted Publishing + provenance),
  with a guard that refuses to publish if any `workspace:` spec remains in the packed
  manifest. No runtime/API changes — 1.9.1 republishes 1.9.0 with correctly resolved
  dependency ranges.

## 1.9.0

### Minor Changes

- 0e56c83: feat: split pure schema/relationship-derivation layer into the new @effect-dynamodb/schema package (importable without @aws-sdk); effect-dynamodb re-exports it, non-breaking (closes #62).
  - New `@effect-dynamodb/schema` package owns the AWS-free core: `DynamoModel`, `DynamoSchema`, `KeyComposer`, the tagged `Errors`, `Projection`, the entity/aggregate derivation internals, and pure `Entity.make` / `Aggregate.make` definition builders carrying the derived `inputSchema` / `updateSchema` / `createSchema`. It has ZERO `@aws-sdk` dependency in both its runtime import graph and its emitted `.d.ts` surface — guarded by an automated test.
  - `effect-dynamodb` depends on and re-exports the entire public surface of `@effect-dynamodb/schema`, then adds the AWS runtime (DynamoClient, CRUD/query operations, Batch/Transaction/Collection, Marshaller). Existing consumers (and `@effect-dynamodb/geo`) are unaffected — every import keeps working unchanged.
  - Consumers who only need an entity/aggregate's derived schemas (e.g. HttpApi payloads, validation) can now `import { Entity, Aggregate, DynamoModel, DynamoSchema } from "@effect-dynamodb/schema"` without pulling `@aws-sdk/*` into their dependency graph or type surface.
