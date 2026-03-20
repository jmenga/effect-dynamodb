import { expect, test } from "@playwright/test"

const BASE = "/effect-dynamodb"

test.describe("Playground", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/playground/`)
  })

  test("playground page renders with all components", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Playground")

    // Scenario selector
    await expect(page.locator("#scenario-select")).toBeVisible()

    // Schema config inputs
    await expect(page.locator("#schema-name")).toBeVisible()
    await expect(page.locator("#schema-version")).toBeVisible()
    await expect(page.locator("#schema-casing")).toBeVisible()

    // Entity attribute inputs (default scenario = Task Manager)
    await expect(page.locator("#field-taskId")).toBeVisible()
    await expect(page.locator("#field-projectId")).toBeVisible()

    // Output tabs
    await expect(page.getByRole("button", { name: "Keys" })).toBeVisible()
    await expect(page.getByRole("button", { name: "PutItem" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Query" })).toBeVisible()
  })

  test("default scenario shows generated keys", async ({ page }) => {
    await expect(page.getByText("Generated Keys", { exact: true })).toBeVisible()

    // Key visualizer shows pk field with composed key
    await expect(page.getByText("$taskapp#v1").first()).toBeVisible()
  })

  test("changing scenario updates all fields", async ({ page }) => {
    await page.locator("#scenario-select").selectOption({ index: 1 })

    // HR System fields should appear
    await expect(page.locator("#field-employeeId")).toBeVisible()
    await expect(page.locator("#field-tenantId")).toBeVisible()
    await expect(page.locator("#field-department")).toBeVisible()

    // Task Manager fields should be gone
    await expect(page.locator("#field-taskId")).not.toBeVisible()

    // Schema name should update
    await expect(page.locator("#schema-name")).toHaveValue("hrapp")

    // Keys should reflect HR scenario
    await expect(page.getByText("$hrapp#v1").first()).toBeVisible()
  })

  test("editing schema name updates generated keys", async ({ page }) => {
    await expect(page.getByText("$taskapp#v1").first()).toBeVisible()

    await page.locator("#schema-name").fill("myapp")

    await expect(page.getByText("$myapp#v1").first()).toBeVisible()
  })

  test("editing schema version updates generated keys", async ({ page }) => {
    await expect(page.getByText("$taskapp#v1").first()).toBeVisible()

    await page.locator("#schema-version").fill("3")

    await expect(page.getByText("$taskapp#v3").first()).toBeVisible()
  })

  test("changing casing updates generated keys", async ({ page }) => {
    // Default is lowercase — key visualizer shows pk row
    const keyViz = page.locator("text=Generated Keys").locator("..")
    await expect(keyViz.getByText("$taskapp#v1#task").first()).toBeVisible()

    await page.locator("#schema-casing").selectOption("uppercase")

    await expect(keyViz.getByText("$TASKAPP#v1#TASK").first()).toBeVisible()
  })

  test("editing entity attribute values updates keys", async ({ page }) => {
    // Default taskId is "task-001" — visible in the key visualizer spans
    const keyViz = page.locator("text=Generated Keys").locator("..")
    await expect(keyViz.getByText("task-001", { exact: true })).toBeVisible()

    await page.locator("#field-taskId").fill("task-xyz")

    await expect(keyViz.getByText("task-xyz", { exact: true })).toBeVisible()
  })

  test("output tabs switch between views", async ({ page }) => {
    // Switch to PutItem tab
    await page.getByRole("button", { name: "PutItem" }).click()
    const pre = page.locator("pre").first()
    await expect(pre).toContainText("TableName")
    await expect(pre).toContainText("__edd_e__")

    // Switch to Query tab
    await page.getByRole("button", { name: "Query" }).click()
    await expect(page.locator("pre").first()).toContainText("KeyConditionExpression")
  })

  test("PutItem output contains expected structure", async ({ page }) => {
    await page.getByRole("button", { name: "PutItem" }).click()

    const text = await page.locator("pre").first().textContent()

    expect(text).toContain('"TableName"')
    expect(text).toContain('"Item"')
    expect(text).toContain('"__edd_e__"')
    expect(text).toContain('"createdAt"')
    expect(text).toContain('"version"')
  })

  test("Query output shows parameters for each index", async ({ page }) => {
    await page.getByRole("button", { name: "Query" }).click()

    // Task Manager has primary + byProject indexes — shown as section labels
    await expect(page.getByText("primary (table)")).toBeVisible()
    await expect(page.getByText("byProject (gsi1)")).toBeVisible()

    const preBlocks = page.locator("pre")
    const count = await preBlocks.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test("E-Commerce scenario with numeric field", async ({ page }) => {
    await page.locator("#scenario-select").selectOption({ index: 2 })

    const priceInput = page.locator("#field-price")
    await expect(priceInput).toBeVisible()
    await expect(priceInput).toHaveValue("299")

    await priceInput.fill("499")

    await page.getByRole("button", { name: "PutItem" }).click()
    const output = await page.locator("pre").first().textContent()
    expect(output).toContain("499")
  })
})
