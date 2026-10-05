/**
 * @internal Parse the extended ISO strings `DateTime.formatIsoZoned` writes.
 *
 * ONE parser for every place a zoned date is read back from storage — the
 * `DynamoModel.DateTimeZoned` transform and the substituted date transform —
 * so the two cannot drift apart again (#133: the transform rebuilt an offset
 * zone as UTC after the substitute had learned not to).
 *
 * - a NAMED zone is written with a bracketed suffix,
 *   `2000-01-01T00:00:00.000+00:00[Europe/London]`, and rebuilt in that zone;
 * - an OFFSET zone is written as a bare offset, `2000-01-01T05:00:00.000+05:00`,
 *   and rebuilt with that offset;
 * - anything else that parses as an instant (`…Z`) is rebuilt in `UTC`.
 *
 * Throws when the string is not a date; callers turn that into a schema issue.
 *
 * Not part of the public API.
 */

import { DateTime } from "effect"

export const parseZonedIso = (value: string): DateTime.Zoned => {
  const named = value.match(/^(.+)\[(.+)\]$/)
  if (named) {
    const utc = DateTime.makeUnsafe(named[1]!)
    return DateTime.makeZonedUnsafe(utc, { timeZone: named[2]! })
  }
  const utc = DateTime.makeUnsafe(value)
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/)
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1
    const ms = sign * (Number(offset[2]) * 3_600_000 + Number(offset[3]) * 60_000)
    return DateTime.makeZonedUnsafe(utc, { timeZone: DateTime.zoneMakeOffset(ms) })
  }
  return DateTime.makeZonedUnsafe(utc, { timeZone: "UTC" })
}
