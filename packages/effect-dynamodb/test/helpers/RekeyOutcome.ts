/**
 * What a `rekey` run decided, for comparing a dry run with the real one. A dry run
 * reads where the real run writes, so capacity differs by design, and `dryRun` by
 * definition.
 */

import type * as Table from "../../src/Table.js"

export const rekeyOutcome = (report: Table.RekeyReport) => {
  const { dryRun: _dryRun, capacity: _capacity, ...decided } = report
  return decided
}
