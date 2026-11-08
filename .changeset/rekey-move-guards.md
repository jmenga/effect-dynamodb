---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`rekey` keeps a write that lands on an aggregate row between its read and its move.

An aggregate row's move was guarded on the attributes the row was read with, so a write adding an attribute it didn't have yet, such as an optional field set for the first time, didn't cancel it, and the move put the row back without it. The guard now also requires each attribute the row's entity type can hold, and the row didn't, to be still absent: the write cancels the move, and `rekey` reads the row again and moves it with the write. An event stream's rows and a projection's row tombstones and outbox items are guarded on the whole row as read too.

A write that only adds an attribute none of the member's declarations name is still not seen. Neither is a write to a row too wide to guard whole (DynamoDB's limits on one expression) that changes only an attribute left out of its guard and not its version or `updatedAt`.
