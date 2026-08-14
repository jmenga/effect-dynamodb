---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Upgrade to Effect 4.0.0-rc.109 (release candidate)

The workspace moves from `effect@4.0.0-beta.85` to `effect@4.0.0-rc.109` (now published from the main Effect-TS/effect repo). The `effect` peer range is raised to `^4.0.0-rc.109` accordingly. Migrations applied:

- **`Schema.DateValid` removed** — `Schema.Date` now rejects invalid dates itself; all `DateValid` usages (DynamoModel Unsafe date codecs, date-transform substitution) migrate to `Schema.Date` with identical validation semantics.
- **AST introspection moved to `representation` identities** — the RC removed the `typeConstructor` / `meta` annotation payloads that date/Redacted detection sniffed via `SchemaAST.resolve`. Detection now reads the stable `representation.id` (`effect/schema/Date`, `effect/schema/DateTimeUtc`, `effect/schema/DateTimeZoned`, `effect/schema/Redacted`) through a shared `matchDateRepresentation` helper (deduplicating the former Aggregate.ts matchers).
- **`Schema.Struct(...)` is now a function** — the `isSchemaClass` detection gains an AST-tag guard (`Declaration` vs `Objects`); without it, Struct-modeled entities were decoded through `new Struct(...)` and silently returned empty objects. A canary test locks the discriminator down.
- **`SchemaIssue.InvalidType` signature** — the constructor takes the raw rejected input instead of an `Option`; all five custom-getter call sites updated.
- **`DateTime.toEpochSeconds`** — replaces hand-rolled `Math.floor(toEpochMillis(...) / 1000)` TTL math in Entity and the DateEpochSeconds codec.
