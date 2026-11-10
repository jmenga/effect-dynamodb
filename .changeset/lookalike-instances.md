---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Effect's own value types read back as the instances written, on rows already stored too.

`Schema.Duration`, `Schema.BigDecimal`, the time zones, `Schema.Cookie` and `Schema.Cookies`, `Schema.UrlParams`, `Schema.SemVer` and `Schema.SemVerRange`, the IP, MAC, socket, host and DNS record types, and a `Schema.DateTimeUtc` or `Schema.DateTimeZoned` inside a `Schema.Option` or a `Schema.Result` are stored as maps. Each type's guard takes that map, so a read handed it back: a plain object that passed for the value and wasn't one. `Equal.equals` with the value written was `false`, `.pipe` was `undefined`, and `BigDecimal.sum` threw below 2^53. Reads on an entity, an aggregate and a stream now return the real instance. What's stored doesn't change, except a cookie's expiry.

- **Your own code that inspects one of these values on a read now sees the instance, where it saw the map.** That's a `.check()` on it or on what holds it, a transformation from it, and a class or a declaration of your own holding it. A check that passed on the map and fails on the instance now fails the read, and one that failed on the map can now pass. A row is still decoded once, and each check, transformation, constructor and default runs as often as it did.
- **A transformation of your own onto one of these types reads the instance too**, when its step hands the stored map on as it is. Effect's own codecs (`Schema.DurationFromMillis`, `Schema.BigDecimalFromString`, `Schema.DateTimeUtcFromString`, ...) made the instance already and aren't touched.
- **A value stored with properties of its own keeps them.** `Object.assign(Duration.millis(5), { source: "invoice" })` is stored with `source`, read back as a `Duration` holding `source`, and written again with it.
- **A `BigDecimal` that's been compared, hashed or normalised can be written.** Each of those caches a normalized decimal that holds itself, and marshalling it ran out of stack, so every write of one died. It's now stored as a fresh decimal of the same value and scale is.
- **A real `Cookie`'s expiry is now stored as ISO text wherever it's written, untyped fields included.** Its `expires` is a `Date`, which was stored as an empty map, so the expiry was lost. A field typed as a cookie reads it back as the `Date`; a row 1.39.0 wrote reads back as a cookie with no expiry.
- **A condition on a cookie no longer matches a row written by 1.39.0, since that row's expiry was lost.** 1.39.0's condition matched such a row whatever the cookie's date had been.
