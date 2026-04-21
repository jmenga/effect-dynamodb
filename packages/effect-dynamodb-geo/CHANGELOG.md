# @effect-dynamodb/geo

## 2.0.0

### Patch Changes

- Updated dependencies []:
  - effect-dynamodb@2.0.0

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

### Patch Changes

- Updated dependencies [[`76654b7`](https://github.com/jmenga/effect-dynamodb/commit/76654b7a6d35a361fe74a2733bdfb1ce837504bf)]:
  - effect-dynamodb@1.0.0
