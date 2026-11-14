---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A model field named `size`, `at`, `entry` or `_tag` is now reached in a condition, filter or select callback: `eq(t.size, 5)`, `t.box.size` and a tagged struct's `t.box._tag` name the field, and calling `size`, `at` or `entry` is still the accessor (`t.box.size()`, `t.roster.at(0)`, `t.zones.entry("k")`). Through 1.41.0 `t.size` was only the accessor, so `eq(t.size, 5)` was rejected by DynamoDB (an expression attribute value that is not defined) and `.select((t) => [t.size])` failed before sending, and `t.box._tag` was the text `"Path"`, so `eq(t.box._tag, "Box")` never matched.
