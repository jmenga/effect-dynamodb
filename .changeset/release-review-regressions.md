---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Keeps more of what 1.39.0 did that this release had taken away.

**`pathRemove` of a property below a union is sent again unless every member requires it.** On `Union([{ x, y }, { y }])`, or a tagged union whose other member has no `x`, removing `f.x` was refused because the member declaring `x` requires it. A value of the other member is left as it was, and the other member may read what's left of one with `x`, so whether the row reads afterwards depends on the stored value, which only a read says. 1.39.0 sent these, and so does this release again, standalone, in a transaction and on a retained entity. A property every member that holds properties requires is still refused, as is one under `NullOr`, since no stored value survives its removal.
