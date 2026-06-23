# @effect-dynamodb/schema

## 1.9.3

### Patch Changes

- fix(client): bind pure `@effect-dynamodb/schema` definitions via `DynamoClient.make` (closes [#69](https://github.com/jmenga/effect-dynamodb/issues/69))

  A pure `EntityDefinition` produced by `@effect-dynamodb/schema`'s `Entity.make` — the AWS-free authoring surface introduced by the schema/runtime split ([#62](https://github.com/jmenga/effect-dynamodb/issues/62)) — was accepted by `DynamoClient.make` but bound to `never`: `db.entities.X` exposed no usable methods, and any call would also have crashed at runtime because pure definitions carry no operations or `_decodeRecord`. The single-source-of-truth goal of the split was unreachable — entities had to be re-authored with the runtime `Entity.make` to get a working client.

  This completes the split's end-to-end path:
  - **Type:** `TypedClient`'s entity mapping now matches a pure `EntityDefinition` (a second conditional branch) in addition to the runtime `Entity`, so `db.entities.X` resolves to the full bound entity (CRUD + index accessors + `scan`) for both authoring styles. The runtime branch is unchanged (no refs regression).
  - **Runtime:** `DynamoClient.make` transparently _promotes_ a pure definition to a full operational entity at bind time via `Entity.fromDefinition` — a thin op-attach over the definition's retained derivation data. This also fixes the silent `db.collections.*` decode crash for pure-authored members. CRUD, index queries, `scan`, collections, and table GSI derivation all work.
  - **Derivation unified:** the runtime `Entity.make` now delegates to the schema package's shared `buildEntityDefinition` instead of re-implementing the EDD-90xx validation/derivation, eliminating drift between the two layers (the class of bug behind [#54](https://github.com/jmenga/effect-dynamodb/issues/54)). Promotion reuses the derived bundle, so there is no double derivation.
  - **Aggregates:** the runtime `Aggregate` now re-exports the schema package's `TypeId` instead of declaring a nominally-distinct `unique symbol`, closing a dual-package hazard. A pure `AggregateDefinition` remains schema-derivation-only (typed `inputSchema`/`updateSchema` for contracts) and is intentionally not bindable — the decompose/assemble engine is AWS-coupled; author aggregates with `effect-dynamodb`'s `Aggregate.make` to bind them. This is now documented on the type.

  Adds a `pure-authoring` example and type-level + runtime + connected regression tests.

## 1.9.2

### Patch Changes

- fix(schema): make the AWS-free pure-authoring path actually usable (closes #66, closes #67).

  Two follow-ups to the #62 schema/runtime split, both blocking its headline use case
  (deriving a typed aggregate input/create payload from `@effect-dynamodb/schema` with
  no AWS SDK):
  - **#66** — the pure edge constructors (`Aggregate.ref` / `one` / `many`) required a
    `RefEntity` with a runtime `get` method, so aggregate edges could not be authored
    from pure `Entity.make` definitions (which have no `get`). `RefEntity` is now the
    minimal structural bound used only for derivation (`_tag`/`entityType`/`model`/
    `indexes`/`schemas`); the runtime ref-hydration narrows back to a `get`-bearing
    entity at its single call site.
  - **#67** — `deriveAggregateSchemas` (the table-free derivation entry point) returned
    `Schema.Top` members, so `typeof result.inputSchema.Type` collapsed to `unknown`.
    It is now generic and returns `Schema.Codec<AggregateInputType<…>>` (plus a
    `createSchema` alias), so the table-free path is as typed as the top-level
    `Aggregate.make` — no stub `table` tag or GSI key config needed.

  Type-checked regression tests for both land in the schema package's `tsconfig.test.json`
  gate (now wired into `pnpm check`).

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
