import { expect, test } from "@playwright/test"

const BASE = "/effect-dynamodb"

test.describe("Search", () => {
  test("search button is visible", async ({ page }) => {
    await page.goto(`${BASE}/getting-started/`)
    const searchButton = page.locator("button[aria-label='Search']").first()
    await expect(searchButton).toBeVisible()
  })
})
