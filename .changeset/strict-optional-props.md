---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
---

Make optional properties on definition-time config surfaces strict under `exactOptionalPropertyTypes`.

`?: T | undefined` and `?: T` mean different things when `exactOptionalPropertyTypes` is on:
the first permits an explicit `{ field: undefined }`, which is precisely what the flag exists
to forbid. Declaring `| undefined` on every optional property quietly opts back out of it.

48 optional properties across the declarative config surfaces — entity config, index
definitions (`GsiConfig` / `IndexDefinition`), vector index config, aggregate config and edge
descriptors, and geo index config — are now `?: T`. "Not set" is expressed by omitting the key.

Construction sites that previously assigned an explicit `undefined` now omit the key instead,
so absent optionals stay absent rather than becoming present-but-undefined. `VectorIndexDefinition.casing`
changes from a required `Casing | undefined` to an optional `?: Casing` for the same reason.

**Possible breaking change for TypeScript consumers.** Code that passes a possibly-undefined
value into one of these fields — `{ collection: maybeUndefined }` — no longer compiles. Omit the
key conditionally instead: `...(x !== undefined && { collection: x })`. Runtime behaviour is
unchanged.

Types that mirror AWS SDK command inputs (`Query`, `DynamoClient`, vector search emulation),
runtime plumbing such as `TableConfig.ttlAttributeName`, tagged-error payloads, and the
incremental builder-state types keep `?: T | undefined` deliberately — those legitimately receive
computed optional values, and forcing conditional spreads on callers there would cost ergonomics
for no safety.
