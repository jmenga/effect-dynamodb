import { mergeConfig } from "vitest/config"
import { escapeKeysOnByDefault } from "../schema/test/helpers/escapeKeysOnByDefault.js"
import base from "./vitest.connected.js"

/** The connected suite with `escapeKeys` on unless a schema says otherwise. */
export default mergeConfig(base, { plugins: [escapeKeysOnByDefault()] })
