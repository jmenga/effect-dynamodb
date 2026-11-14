---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A model field named `size`, `at` or `entry` is now reached in a condition, filter or select callback: `eq(t.size, 5)` and `t.box.size` name the field, and calling the name is still the accessor (`t.box.size()`, `t.roster.at(0)`, `t.zones.entry("k")`). Through 1.41.0 `t.size` was only the accessor, so `eq(t.size, 5)` was rejected by DynamoDB (an expression attribute value that is not defined) and `.select((t) => [t.size])` failed before sending.
