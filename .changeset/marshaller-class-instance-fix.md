---
---

Chore: no version change. Fix `Marshaller.toAttributeValue` to pass `convertClassInstanceToMap: true` and `removeUndefinedValues: true`, matching `toAttributeMap`. Without this, `update()`/`append()` SET clauses and condition/filter values threw at runtime when the value was a `Schema.Class` instance (or contained one). Fixes #12.
