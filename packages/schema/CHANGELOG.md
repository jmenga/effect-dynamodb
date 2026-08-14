# @effect-dynamodb/schema

## 1.10.0

### Minor Changes

- [`bfec5f2`](https://github.com/jmenga/effect-dynamodb/commit/bfec5f22ca03961b2bcc13dfa62b323a7bab6375) Thanks [@mixja](https://github.com/mixja)! - Upgrade to Effect 4.0.0-rc.109 (release candidate)

  The workspace moves from `effect@4.0.0-beta.85` to `effect@4.0.0-rc.109` (now published from the main Effect-TS/effect repo). The `effect` peer range is raised to `^4.0.0-rc.109` accordingly. Migrations applied:
  - **`Schema.DateValid` removed** — `Schema.Date` now rejects invalid dates itself; all `DateValid` usages (DynamoModel Unsafe date codecs, date-transform substitution) migrate to `Schema.Date` with identical validation semantics.
  - **AST introspection moved to `representation` identities** — the RC removed the `typeConstructor` / `meta` annotation payloads that date/Redacted detection sniffed via `SchemaAST.resolve`. Detection now reads the stable `representation.id` (`effect/schema/Date`, `effect/schema/DateTimeUtc`, `effect/schema/DateTimeZoned`, `effect/schema/Redacted`) through a shared `matchDateRepresentation` helper (deduplicating the former Aggregate.ts matchers).
  - **`Schema.Struct(...)` is now a function** — the `isSchemaClass` detection gains an AST-tag guard (`Declaration` vs `Objects`); without it, Struct-modeled entities were decoded through `new Struct(...)` and silently returned empty objects. A canary test locks the discriminator down.
  - **`SchemaIssue.InvalidType` signature** — the constructor takes the raw rejected input instead of an `Option`; all five custom-getter call sites updated.
  - **`DateTime.toEpochSeconds`** — replaces hand-rolled `Math.floor(toEpochMillis(...) / 1000)` TTL math in Entity and the DateEpochSeconds codec.

## 1.9.5

## 1.9.4

### Patch Changes

- Fix aggregate/ref hydration for pure entity definitions and transform-typed date fields ([#71](https://github.com/jmenga/effect-dynamodb/issues/71), [#72](https://github.com/jmenga/effect-dynamodb/issues/72)), and round-trip self-date fields nested inside refs/edges.
  - **[#71](https://github.com/jmenga/effect-dynamodb/issues/71)** — `BoundAggregate.get`/`create` no longer crash with `TypeError: runtimeEntity.get is not a function` when an aggregate edge is authored from a pure `@effect-dynamodb/schema` `EntityDefinition`. Hydration now promotes such pure edge targets to runtime entities (mirroring `DynamoClient.make`'s entity binding).
  - **[#72](https://github.com/jmenga/effect-dynamodb/issues/72)** — Transform-typed date fields (e.g. `Schema.DateTimeUtcFromString`) on an aggregate root, on a hydrated aggregate edge, and on a plain `Entity` ref target are now decoded exactly once instead of double-decoding (`SchemaError: Expected string, got DateTime.Utc`) — across aggregate `create`, `get`, and `update`. Plain-entity ref hydration re-encodes fetched refs to wire form before splicing; the aggregate reads/validates through a single tolerant decode schema (replacing the previous per-field pre-decode); and decomposed edge date fields are serialized to wire on write.
  - **Nested self-date round-trip (Option A)** — `Schema.DateTimeUtc` / `Schema.Date` (and `Schema.RedactedFromValue`) fields nested inside a `DynamoModel.ref` target or an aggregate edge model now round-trip through DynamoDB, with the nested class instance identity preserved. Covers **required and optional** nesting — `Schema.optional` / `Schema.optionalKey` classes (e.g. optional sub-aggregates), arrays of classes, and leaves.

## 1.9.3

### Patch Changes

- fix(client): bind pure `@effect-dynamodb/schema` definitions via `DynamoClient.make` (closes [#69](https://github.com/jmenga/effect-dynamodb/issues/69))

  A pure `EntityDefinition` produced by `@effect-dynamodb/schema`'s `Entity.make` — the AWS-free authoring surface introduced by the schema/runtime split ([#62](https://github.com/jmenga/effect-dynamodb/issues/62)) — was accepted by `DynamoClient.make` but bound to `never`: `db.entities.X` exposed no usable methods, and any call would also have crashed at runtime because pure definitions carry no operations or `_decodeRecord`. The single-source-of-truth goal of the split was unreachable — entities had to be re-authored with the runtime `Entity.make` to get a working client.

  This completes the split's end-to-end path:
  - **Type:** `TypedClient`'s entity mapping now matches a pure `EntityDefinition` (a second conditional branch) in addition to the runtime `Entity`, so `db.entities.X` resolves to the full bound entity (CRUD + index accessors + `scan`) for both authoring styles.
  - **Runtime:** `DynamoClient.make` transparently _promotes_ a pure definition to a full operational entity at bind time via `Entity.fromDefinition` — a thin op-attach over the definition's retained derivation data. This also fixes the silent `db.collections.*` decode crash for pure-authored members. CRUD, index queries, `scan`, collections, and table GSI derivation all work.
  - **Refs:** pure entities with refs are fully supported. Write-time ref hydration calls `.get()` on each ref target, so promotion now promotes ref targets too (one level — a `.get` does not itself hydrate, which also sidesteps cyclic refs). This package's `AnyRefValue` is unified onto the shared structural `RefEntity` carrier (also used by aggregate edges), so ref-derived id composites survive into the bound client and a ref target may be authored in either package.
  - **Derivation unified:** the runtime `Entity.make` now delegates to this package's shared `buildEntityDefinition` instead of re-implementing the EDD-90xx validation/derivation, eliminating drift between the two layers (the class of bug behind [#54](https://github.com/jmenga/effect-dynamodb/issues/54)). Promotion reuses the derived bundle, so there is no double derivation.
  - **Aggregates:** the runtime `Aggregate` now re-exports this package's `TypeId` instead of declaring a nominally-distinct `unique symbol`, closing a dual-package hazard. A pure `AggregateDefinition` remains schema-derivation-only (typed `inputSchema`/`updateSchema` for contracts) and is intentionally not bindable — the decompose/assemble engine is AWS-coupled; author aggregates with `effect-dynamodb`'s `Aggregate.make` to bind them. This is now documented on the type.

  Adds a `pure-authoring` example and type-level + runtime + connected regression tests (including pure entities with refs).

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
