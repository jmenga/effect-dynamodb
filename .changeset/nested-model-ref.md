---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A ref whose target's model declares a ref of its own with `DynamoModel.ref` (`Selection` refs `Player`, whose model holds `team: DynamoModel.ref(Team)`) now works as it does when `Player` declares `team: Team` with `configure`'s `{ ref: true }`, at any depth. Up to 1.42.1 a `Selection` `put` stored its row and then failed with `Expected DateTime.Utc at player.team.founded`, as did every read of it, and a condition, filter or `pathSet` on `player.team.founded` sent the date as a map. Both forms now send the requests the `configure` form sent in 1.42.1, the date in the team entity's storage (`storedAs` included). The rows such a `put` left behind hold those bytes and now read, and a nested date a 1.42.1 `pathSet` stored as a map reads as the date it holds.

Two levels deep, a ref whose innermost target has a required `DynamoModel.Hidden` field (`League` refs `Club`, which refs `Team`) no longer fails `League`'s write, whichever way the refs are declared. In an aggregate, a ref held by an edge entity's model, and the refs below it, now store their transformed fields encoded (a date as ISO text) and read them back. Up to 1.42.1, under an edge entity made with `Entity.make`, a date there was stored as a map and read back as a plain object; rows holding such maps read as dates.
