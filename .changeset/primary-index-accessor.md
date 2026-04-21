---
"effect-dynamodb": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Add `.primary()` query accessor on the bound client

Every entity now exposes a `.primary(...)` accessor on `db.entities.*` alongside the existing GSI accessors. The primary index is treated symmetrically with GSIs: pass required PK composites (and optionally one or more SK composites) to get back a `BoundQuery` with the full combinator surface (`.where()`, `.filter()`, `.select()`, `.limit()`, `.reverse()`, `.startFrom()`, `.consistentRead()`, `.collect()`, `.fetch()`, `.paginate()`, `.count()`).

Previously the primary index was deliberately excluded from accessor generation, so the shared-PK join-table pattern (many items under one partition key, distinguished by SK) had no first-class typed query path — only `.get(fullKey)` or a raw `Query.make` escape hatch.

```ts
// List every membership in an organization — PK only, SK composites omitted
const allMembers = yield* db.entities.Memberships.primary({
  orgId: "org-acme",
}).collect()

// Narrow by partial SK composite (begins_with prefix match)
const bobs = yield* db.entities.Memberships.primary({
  orgId: "org-acme",
  userId: "u-bob",
}).collect()
```

`.get(fullKey)` remains the dedicated `GetItem` path for single-item strongly-consistent reads. Resolves #2.
