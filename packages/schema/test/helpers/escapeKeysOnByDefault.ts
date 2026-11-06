/**
 * A Vite plugin for the `test:escape-on` runs: `DynamoSchema.make` turns `escapeKeys` on unless a
 * schema says `false`, so a suite whose schemas don't set it runs with key text escaped. The library
 * stays off by default for 1.x; this is how its suites also cover the other setting. A file that
 * doesn't hold the line it replaces stops the run, so a refactor can't quietly turn the runs off.
 */

const FROM = "config.escapeKeys === true"
const TO = "config.escapeKeys !== false"

export const escapeKeysOnByDefault = () => ({
  name: "escape-keys-on-by-default",
  enforce: "pre" as const,
  transform: (code: string, id: string) => {
    if (!/\/packages\/schema\/(dist|src)\/DynamoSchema\.(js|ts)$/.test(id.split("?")[0] ?? "")) {
      return undefined
    }
    if (!code.includes(FROM)) throw new Error(`${id} no longer holds \`${FROM}\``)
    return { code: code.replace(FROM, TO), map: null }
  },
})
