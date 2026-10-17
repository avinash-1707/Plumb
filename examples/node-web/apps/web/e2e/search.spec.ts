import { expect, test } from "@playwright/test";

test("searching narrows the product list", async ({ page }) => {
  await page.goto("/");
  const products = page.getByRole("list", { name: "Products" });
  await expect(products.getByText("Pour-over Kettle", { exact: true })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search products" }).fill("mug");

  await expect(products.getByText("Ceramic Mug", { exact: true })).toBeVisible();
  await expect(products.getByText("Pour-over Kettle", { exact: true })).toBeHidden();
});
