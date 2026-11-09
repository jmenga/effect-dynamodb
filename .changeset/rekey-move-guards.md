---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`rekey` keeps a write that lands on a row between its read and its move, and leaves a row it can't prove unchanged.

An aggregate row's move was guarded on the attributes the row was read with, so a write adding an attribute it didn't have yet, such as an optional field set for the first time, didn't cancel it, and the move put the row back without it. The guard now also requires each attribute the row's entity type can hold, and the row didn't, to be still absent: the write cancels the move, and `rekey` reads the row again and moves it with the write. An event stream's rows and a projection's row tombstones and outbox items are guarded on the whole row as read too.

A row too wide to guard whole (DynamoDB's limits on one expression) is guarded on its `updatedAt` when its member stamps one, held or still absent. With no version or `updatedAt`, nothing proves it unchanged, and 1.39.0 moved it under a partial guard, losing a write to an attribute left out of it. `rekey` now leaves such a row where it is and reports it as a conflict with the new reason `"unguarded"` (`RekeyConflict.reason` gains the member), in a dry run too. An aggregate or event stream holding one is left whole; a projection's row tombstone or outbox item is judged alone. The new option `writesStopped: true` says nothing else writes to the table, and moves such rows under the strongest guard that fits, as 1.39.0 did.

A write that only adds an attribute none of the member's declarations name is still not seen. Neither is a write from outside the library to a wide row that changes only an attribute left out of its guard and not its version or `updatedAt`. A soft, retain or unique delete of a wide row with no version or `updatedAt` still sends the strongest guard that fits, as 1.39.0 did.
