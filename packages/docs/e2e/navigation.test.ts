import { expect, test } from "@playwright/test"

const BASE = "/effect-dynamodb"

test.describe("Navigation", () => {
  test("homepage renders introduction page", async ({ page }) => {
    await page.goto(`${BASE}/`)
    await expect(page.locator("h1")).toContainText("Introduction")
    const content = page.locator("main")
    await expect(content).toBeVisible()
    await expect(content.getByText("Core Concepts")).toBeVisible()
  })

  test("sidebar contains Introduction and Getting Started", async ({ page }) => {
    await page.goto(`${BASE}/`)
    const sidebar = page.locator("nav[aria-label='Main']")
    await expect(sidebar.getByText("Introduction")).toBeVisible()
    await expect(sidebar.getByText("Getting Started")).toBeVisible()
  })

  test("Getting Started link navigates from sidebar", async ({ page }) => {
    await page.goto(`${BASE}/`)
    const sidebar = page.locator("nav[aria-label='Main']")
    await sidebar.getByText("Getting Started").click()
    await expect(page).toHaveURL(/getting-started/)
    await expect(page.locator("h1")).toContainText("Getting Started")
  })

  test("sidebar contains all guide sections", async ({ page }) => {
    await page.goto(`${BASE}/getting-started/`)
    const sidebar = page.locator("nav[aria-label='Main']")
    await expect(sidebar.getByText("Modeling")).toBeVisible()
    await expect(sidebar.getByText("Indexes & Collections")).toBeVisible()
    await expect(sidebar.getByText("Queries")).toBeVisible()
    await expect(sidebar.getByText("Expressions")).toBeVisible()
    await expect(sidebar.getByText("Data Integrity")).toBeVisible()
    await expect(sidebar.getByText("Lifecycle")).toBeVisible()
    await expect(sidebar.getByText("Aggregates & Refs")).toBeVisible()
    await expect(sidebar.getByText("Geospatial")).toBeVisible()
    await expect(sidebar.getByText("Advanced")).toBeVisible()
  })

  test("sidebar navigation works between pages", async ({ page }) => {
    await page.goto(`${BASE}/getting-started/`)
    const sidebar = page.locator("nav[aria-label='Main']")
    await sidebar.getByText("Modeling").click()
    await expect(page).toHaveURL(/guides\/modeling/)
    await expect(page.locator("h1")).toContainText("Modeling")
  })

  test("guide pages render content", async ({ page }) => {
    const guides = [
      { path: "guides/modeling/", heading: "Modeling" },
      { path: "guides/indexes/", heading: "Indexes" },
      { path: "guides/queries/", heading: "Queries" },
      { path: "guides/data-integrity/", heading: "Data Integrity" },
      { path: "guides/lifecycle/", heading: "Lifecycle" },
      { path: "guides/aggregates/", heading: "Aggregates" },
      { path: "guides/geospatial/", heading: "Geospatial" },
      { path: "guides/advanced/", heading: "Advanced" },
    ]

    for (const guide of guides) {
      await page.goto(`${BASE}/${guide.path}`)
      await expect(page.locator("h1")).toContainText(guide.heading)
      const content = page.locator("main")
      await expect(content).toBeVisible()
    }
  })

  test("reference pages render", async ({ page }) => {
    await page.goto(`${BASE}/reference/api-reference/`)
    await expect(page.locator("h1")).toContainText("API Reference")

    await page.goto(`${BASE}/reference/faq/`)
    await expect(page.locator("h1")).toContainText("FAQ")
  })

  test("tutorial page renders", async ({ page }) => {
    await page.goto(`${BASE}/tutorials/gamemanager/`)
    await expect(page.locator("h1")).toContainText("Cricket Match Manager")
  })
})
