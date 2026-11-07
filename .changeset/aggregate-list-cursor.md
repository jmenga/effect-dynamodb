---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`Aggregate.list` can page past a key holding text above U+00FF. Such a page used to die with an `InvalidCharacterError` defect, so the caller couldn't get past it. `list` now uses the same cursor codec as `Query`: a key `btoa` can carry keeps the bytes it always had, and any other key gets a `v2.` cursor. A cursor handed out by an earlier release still resumes.

A cursor `list` can't decode is a `ValidationError` (`[EDD-9094]`, `operation: "list"`) with nothing sent, where it used to be a defect. So is a `.within()` or sharded query's cursor, and so is an empty string, which used to read from the start. A sharded list still refuses every cursor with `EDD-9051`.
