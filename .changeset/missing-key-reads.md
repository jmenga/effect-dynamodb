---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An aggregate, a stream or a projection reading a stored row that lacks a field fails on the missing key again, as 1.39.0 did, where the field's transformation throws on `undefined`.

A read now takes an absent attribute as the value it stands for, through the field's own steps, so a step that throws on `undefined` made the read die where 1.39.0 failed with a `ValidationError` on the missing key. Entity rows were already kept as they were; the same is now done for an aggregate's `get`, `list` and the read inside `update` (a root field or an edge's), a stream's events, metadata and snapshot state on `read`, `readFrom`, `readLatest`, `readSnapshot` and `decodeStreamImage`, and a projection's outbox effects on `drain`. Each fails with 1.39.0's error, its operation and message included. The issue is only looked for once the read has died, so a read that succeeds does no more than before, and a step that throws on a value the row holds is still a defect.
