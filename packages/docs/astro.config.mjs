import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import { pluginLineNumbers } from "@expressive-code/plugin-line-numbers"
import react from "@astrojs/react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  site: "https://example.github.io",
  base: "/effect-dynamodb",
  integrations: [
    starlight({
      title: "effect-dynamodb",
      description:
        "An Effect TS ORM for DynamoDB — Schema-driven entities, single-table design, composite keys, type-safe queries",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      expressiveCode: {
        themes: ["github-light", "github-dark"],
        plugins: [pluginLineNumbers()],
        defaultProps: {
          showLineNumbers: true,
          overridesByStyle: {
            terminal: { showLineNumbers: false },
          },
        },
        styleOverrides: {
          frames: {
            frameBoxShadowCssValue: "none",
          },
        },
      },
      sidebar: [
        { label: "Introduction", slug: "" },
        { label: "Getting Started", slug: "getting-started" },
        {
          label: "Guides",
          items: [
            { label: "Modeling", slug: "guides/modeling" },
            { label: "Indexes & Collections", slug: "guides/indexes" },
            { label: "Queries", slug: "guides/queries" },
            { label: "Expressions", slug: "guides/expressions" },
            { label: "Data Integrity", slug: "guides/data-integrity" },
            { label: "Lifecycle", slug: "guides/lifecycle" },
            { label: "Aggregates & Refs", slug: "guides/aggregates" },
            { label: "Geospatial", slug: "guides/geospatial" },
            { label: "DynamoDB Streams", slug: "guides/streams" },
            { label: "Testing", slug: "guides/testing" },
            { label: "Advanced", slug: "guides/advanced" },
          ],
        },
        {
          label: "Tutorials",
          items: [
            { label: "Getting Started", slug: "tutorials/starter" },
            { label: "CRUD Operations", slug: "tutorials/crud" },
            { label: "Rich Updates", slug: "tutorials/updates" },
            { label: "Batch Operations", slug: "tutorials/batch" },
            { label: "Conditional Writes & Filters", slug: "tutorials/expressions" },
            { label: "Scan Operations", slug: "tutorials/scan" },
            { label: "Projections", slug: "tutorials/projections" },
            { label: "Unique Constraints", slug: "tutorials/unique-constraints" },
            { label: "Blog Platform", slug: "tutorials/blog" },
            { label: "Shopping Mall", slug: "tutorials/shopping-mall" },
            { label: "Human Resources", slug: "tutorials/human-resources" },
            { label: "Task Manager", slug: "tutorials/task-manager" },
            { label: "Library System", slug: "tutorials/library-system" },
            { label: "Version Control", slug: "tutorials/version-control" },
            { label: "Cricket Match Manager", slug: "tutorials/gamemanager" },
            { label: "Event Sourcing", slug: "tutorials/event-sourcing" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "API Reference", slug: "reference/api-reference" },
            { label: "FAQ & Troubleshooting", slug: "reference/faq" },
            {
              label: "Migration from ElectroDB",
              slug: "reference/migration-from-electrodb",
            },
            {
              label: "ElectroDB Comparison",
              slug: "reference/electrodb-comparison",
            },
          ],
        },
        { label: "Playground", slug: "playground" },
      ],
    }),
    react(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
})
