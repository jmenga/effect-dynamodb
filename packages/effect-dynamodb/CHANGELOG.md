# effect-dynamodb

## 1.1.0

### Minor Changes

- feat(Entity): `timeSeries` primitive for event-driven workloads

  Adds a new `timeSeries` configuration primitive on `Entity.make()` for IoT-style workloads that need the split-item pattern: one "current" item per partition (latest state, index-visible) plus N immutable "event" items (TTL-bounded, time-queryable).

  - **New API:** `Entity.make({ timeSeries: { orderBy, ttl?, appendInput } })`
  - **`.append(input, condition?)`** — atomic `TransactWriteItems` (UpdateItem current + Put event) with CAS `attribute_not_exists(pk) OR #orderBy < :newOb`. Returns a discriminated union `{ applied: true | false, current }` — stale writes are a success value, not an error.
  - **`.history(key)`** — `BoundQuery` auto-scoped via `begins_with(<currentSk>#e#)`, with `.where()` restricted to the configured `orderBy` attribute.
  - **Enrichment preservation** — `.append()`'s `SET` clause covers only fields declared in `appendInput`. Model fields outside `appendInput` (e.g. background-assigned `accountId`) are never touched.
  - **Mutually exclusive** with `versioned` (`EDD-9012`) and `softDelete` (`EDD-9015`).
  - **`appendInput` is required** (`EDD-9016`) — forces the enrichment-preservation choice to be visible at the entity definition.

  Not source-breaking: the `Entity<...>` generic signature gains a new optional type parameter at the end (`TTimeSeries`, defaults to `undefined`). Existing code compiles unchanged. The semantic change is additive.

## 1.0.0

### Minor Changes

- [#4](https://github.com/jmenga/effect-dynamodb/pull/4) [`76654b7`](https://github.com/jmenga/effect-dynamodb/commit/76654b7a6d35a361fe74a2733bdfb1ce837504bf) Thanks [@jmenga](https://github.com/jmenga)! - Add `.primary()` query accessor on the bound client

  Every entity now exposes a `.primary(...)` accessor on `db.entities.*` alongside the existing GSI accessors. The primary index is treated symmetrically with GSIs: pass required PK composites (and optionally one or more SK composites) to get back a `BoundQuery` with the full combinator surface (`.where()`, `.filter()`, `.select()`, `.limit()`, `.reverse()`, `.startFrom()`, `.consistentRead()`, `.collect()`, `.fetch()`, `.paginate()`, `.count()`).

  Previously the primary index was deliberately excluded from accessor generation, so the shared-PK join-table pattern (many items under one partition key, distinguished by SK) had no first-class typed query path — only `.get(fullKey)` or a raw `Query.make` escape hatch.

  ```ts
  // List every membership in an organization — PK only, SK composites omitted
  const allMembers =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
    }).collect();

  // Narrow by partial SK composite (begins_with prefix match)
  const bobs =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
      userId: "u-bob",
    }).collect();
  ```

  `.get(fullKey)` remains the dedicated `GetItem` path for single-item strongly-consistent reads. Resolves [#2](https://github.com/jmenga/effect-dynamodb/issues/2).
