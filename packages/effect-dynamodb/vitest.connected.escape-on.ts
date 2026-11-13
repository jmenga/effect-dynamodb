import { mergeConfig } from "vitest/config"
import { escapeKeysOnByDefault } from "../schema/test/helpers/escapeKeysOnByDefault.js"
import base from "./vitest.connected.js"

/** The connected suite with `escapeKeys` on unless a schema says otherwise. */
export default mergeConfig(base, {
  plugins: [escapeKeysOnByDefault()],
  // This pass runs against the tables the plain connected pass left behind, so
  // the larger matrix tests take several times longer than they do there.
  test: { include: ["test/escape-on.check.ts"], testTimeout: 120000 },
})
