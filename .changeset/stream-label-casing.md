---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

`EventStore.makeStream` accepts `labelCasing: "lowercase" | "schema"`. The default, `"lowercase"`, keeps today's key layout: the stream name is lower-cased in its keys whatever the schema's `casing`. `"schema"` makes the stream name follow the schema's casing like an entity type does. The two only write different keys under `casing: "preserve"` when `streamName` has upper-case letters; switching an existing stream there moves its keys, so its history is no longer read. The `__edd_e__` discriminators stay lower-cased either way. The default becomes `"schema"` in the next major.

The language-service hover tooltips now show the keys the library actually writes — attribute-name prefixes, cased composite values, padded numbers, the `"isolated"` collection default and the `begins_with` delimiter rule — and a parity test pins them to `@effect-dynamodb/schema`. The docs playground now composes keys with `@effect-dynamodb/schema` directly.

Docs: the `casing` option is described as casing composite values too (it always has), with a warning that ids differing only by case share a key, that `casing` is part of the storage format, and which fixed key markers (`v1`, `#v#`, `#deleted#`, `_1`) are never cased. Tests pin those markers.
