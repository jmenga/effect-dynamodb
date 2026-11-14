import { defineConfig } from "vitest/config"
import { escapeKeysOnByDefault } from "../schema/test/helpers/escapeKeysOnByDefault.js"
import { unitProjects } from "./vitest.config.js"

/** The suite with `escapeKeys` on unless a schema says otherwise. */
export default defineConfig({
  plugins: [escapeKeysOnByDefault()],
  test: {
    projects: unitProjects({
      include: ["test/escape-on.check.ts"],
      // It pins the library's default, which this run turns over.
      exclude: ["test/EscapeKeysDefault.test.ts"],
    }),
  },
})
