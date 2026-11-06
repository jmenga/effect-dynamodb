import { mergeConfig } from "vitest/config"
import { escapeKeysOnByDefault } from "../schema/test/helpers/escapeKeysOnByDefault.js"
import base from "./vitest.config.js"

/** The suite with `escapeKeys` on unless a schema says otherwise. */
export default mergeConfig(base, { plugins: [escapeKeysOnByDefault()] })
