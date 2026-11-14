---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

`Aggregate.list` takes `prefix: true` to match the last list sort key value it's given as a prefix of its composite's value, as every list key was matched up to 1.36. Since 1.37.0 each value is matched whole (`{ league: "big" }` no longer finds `Big Bash`), and that stays the default: a list without the option sends the requests it sent before. The prefix is composed as the key is, so it follows the schema's casing and `escapeKeys`, and the list pages with its own cursor, sharded lists included. A numeric composite has no text prefix and is still matched whole. `KeyComposer.matchesTextPrefix` is the one rule every `beginsWith` on a composite now follows.
