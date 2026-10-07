import { expect, test } from "@playwright/test";
import { PRODUCT_NAME } from "@rakazo/contracts/brand";
import { captureScreenshot } from "./helpers";

const ssoOnly = {
  passwordAuth: false,
  passwordReset: false,
  resetUrl: null,
  sso: { providerId: "oidc", name: "Company SSO" },
};

test("SSO-only sign-in offers the identity provider and no password form", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) => route.fulfill({ json: ssoOnly }));
  let socialRequest: unknown;
  await page.route("**/api/auth/sign-in/social", async (route) => {
    socialRequest = route.request().postDataJSON();
    await route.fulfill({ json: { url: "/sign-in?sso=started", redirect: true } });
  });
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: `Sign in to ${PRODUCT_NAME}` })).toBeVisible();
  const sso = page.getByRole("button", { name: "Continue with Company SSO" });
  await expect(sso).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign up" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sso-only-sign-in");
  await sso.click();
  await expect(page).toHaveURL(/sso=started/);
  expect(socialRequest).toMatchObject({ provider: "oidc" });
});

test("a failed capabilities request offers a retry that restores SSO", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  let available = false;
  await page.route("**/api/auth/capabilities", (route) =>
    available
      ? route.fulfill({ json: ssoOnly })
      : route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.goto("/sign-in");
  const alert = page.getByRole("alert").filter({ hasText: "Could not load sign-in options" });
  await expect(alert).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-options-retry");
  available = true;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Continue with Company SSO" })).toBeVisible();
  await expect(alert).toHaveCount(0);
});
