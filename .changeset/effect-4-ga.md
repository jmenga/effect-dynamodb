---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Require Effect 4.0.0 (stable). The `effect` peer dependency moves from `^4.0.0-rc.112` to `^4.0.0`, so pre-release builds of Effect no longer satisfy it. Consumers on an Effect 4 release candidate should upgrade to `effect@4.0.0` and apply the GA renames that affect application code: `Config.string`/`Config.int` → `Config.String`/`Config.Int`, `SchemaGetter.transformOrFail` → `SchemaGetter.transformEffect`, and `effect/unstable/http` / `effect/unstable/httpapi` → `effect/http` / `effect/http-api`. Tests built on `@effect/vitest@4.0.0` need vitest 5. The language-service plugin now compiles with TypeScript 6 and its emitted output is unchanged.
