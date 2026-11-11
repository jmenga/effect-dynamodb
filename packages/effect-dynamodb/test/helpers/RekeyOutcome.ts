/**
 * What a `rekey` run decided, for comparing a dry run with the real one. A dry run
 * reads where the real run writes, so capacity differs by design, and `dryRun` by
 * definition. `repaired` counts index keys written, which a dry run never writes (#240):
 * it's left out here, and a dry run whose report counts one fails the comparison.
 */

import type * as Table from "../../src/Table.js"

const withoutRepaired = ({ repaired: _repaired, ...found }: Table.RekeyIndexKeys) => found

export const rekeyOutcome = (report: Table.RekeyReport) => {
  const { dryRun, capacity: _capacity, indexKeys, byMember, ...decided } = report
  if (
    dryRun &&
    (indexKeys.repaired !== 0 ||
      Object.values(byMember).some((member) => member.indexKeys.repaired !== 0))
  ) {
    throw new Error("A dry run's report counts index keys repaired: it writes none.")
  }
  return {
    ...decided,
    indexKeys: withoutRepaired(indexKeys),
    byMember: Object.fromEntries(
      Object.entries(byMember).map(([name, member]) => [
        name,
        { ...member, indexKeys: withoutRepaired(member.indexKeys) },
      ]),
    ),
  }
}
