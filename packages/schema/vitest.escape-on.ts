import { mergeConfig } from "vitest/config"
import { escapeKeysOnByDefault } from "./test/helpers/escapeKeysOnByDefault.js"
import base from "./vitest.config.js"

/** The suite with `escapeKeys` on unless a schema says otherwise. The file named pins the default. */
export default mergeConfig(base, {
  plugins: [escapeKeysOnByDefault()],
  test: {
    include: ["test/escape-on.check.ts"],
    exclude: ["test/KeyText136.test.ts"],
  },
})
