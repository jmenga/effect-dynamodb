---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
---

Upgrade Effect v4 from `4.0.0-rc.109` to `4.0.0-rc.112` (and `@effect/vitest` to match).

No source changes were required — rc.110, rc.111 and rc.112 contain no breaking changes
affecting APIs this library uses. The interface changes in those releases (`Pool.State`,
`Pool.PoolItem`, `Scope.State.Open`, and the `Matcher` / `ValueMatcher` flavor type
arguments) touch modules the library does not consume.

Consumers pick up upstream improvements for free:

- Faster synchronous `Schema` decode/encode (completed parser exits plus a direct loop for
  common struct parsers) — this library decodes every item it reads.
- Faster `SchemaError` construction (stack frame capture is now skipped) — validation
  failures are cheaper on hot paths.
- `Optic` gained dual standalone `get` / `set` / `replace` / `modify` functions, usable
  alongside the cursor API exposed by `Aggregate.update`.
