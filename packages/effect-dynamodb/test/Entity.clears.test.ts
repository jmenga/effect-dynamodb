/**
 * Clearing a field (#177, #178), on a recording table: everything sent is seen, and a
 * refusal must have sent nothing. `connected.clears.test.ts` runs the same scenarios on
 * DynamoDB Local. The canonical GSI shapes are in `IndexPolicyV3.test.ts` and
 * `connected.test.ts`, and at the composer in the schema package's `KeyComposer.test.ts`.
 */

import { it } from "@effect/vitest"
import { describe } from "vitest"
import * as Clears from "./helpers/ClearScenarios.js"
import * as NoStoredForm from "./helpers/NoStoredFormScenarios.js"

for (const [group, scenarios] of Object.entries({
  ...Clears.allScenarios,
  ...NoStoredForm.allScenarios,
})) {
  describe(group, () => {
    for (const scenario of scenarios) {
      it.effect(scenario.name, () => scenario.run(Clears.recordingHarness))
    }
  })
}
