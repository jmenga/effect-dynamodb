import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config"

/**
 * Files whose cases read state a module keeps for the whole process, which another file's cases
 * change: `ProxyTraps` (what the marshaller reads once a getter has been met) and the zlib file that
 * mocks `node:zlib`. Each runs in a fresh worker.
 */
const ISOLATED = ["test/ProxyTraps.test.ts", "test/compression-zlib-without-zstd.test.ts"]

/**
 * The unit suite as two projects: every other file shares its worker's modules with the files run
 * before it (`isolate: false`), which spares loading the library once a file, about a quarter of the run.
 * `include` and `exclude` add to the shared project's files.
 */
export const unitProjects = (
  options: { readonly include?: Array<string>; readonly exclude?: Array<string> } = {},
): Array<TestProjectInlineConfiguration> => [
  {
    extends: true,
    test: {
      name: "unit",
      isolate: false,
      include: ["test/**/*.test.ts", ...(options.include ?? [])],
      exclude: ["test/connected*.test.ts", ...ISOLATED, ...(options.exclude ?? [])],
    },
  },
  { extends: true, test: { name: "unit-isolated", include: ISOLATED } },
]

export default defineConfig({ test: { projects: unitProjects() } })
