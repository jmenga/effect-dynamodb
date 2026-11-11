---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Keeps more of what 1.39.0 did that this release had taken away.

**`pathRemove` of a property below a union is sent again unless every member requires it.** On `Union([{ x, y }, { y }])`, or a tagged union whose other member has no `x`, removing `f.x` was refused because the member declaring `x` requires it. A value of the other member is left as it was, and the other member may read what's left of one with `x`, so whether the row reads afterwards depends on the stored value, which only a read says. 1.39.0 sent these, and so does this release again, standalone, in a transaction and on a retained entity. A property every member that holds properties requires is still refused, as is one under `NullOr`, since no stored value survives its removal.

**`pathRemove` of a list position is refused only when no list one shorter can be read.** The list closes up when an element is removed, so what's left is one position shorter: a stored `["first", "second"]` in a `[string, string?]` becomes `["second"]`, which reads. Such a removal is judged by length alone, over every list the path can reach through a union, a tuple in a union's struct members included, and refused only when no list one shorter than a list holding the position is a length one of them accepts: any position of a `[string, string]`, or of a `Union([[string, string], [number, number]])`. Otherwise it's sent as 1.39.0 sent it, standalone, in a transaction, on a retained entity and on one with a unique constraint: `f[0]` of a `[string, string?]`, either position of a `Union([[string, string], [string]])`, the position of a `Union([[string], []])`, an array's element. Length alone can't see that what's left puts a value where its position can't hold it (`f[0]` of a `[string, number?]`) or is a list only a member its tag rules out accepts, so such a removal is sent and leaves a row that can't be read, as on 1.39.0.
