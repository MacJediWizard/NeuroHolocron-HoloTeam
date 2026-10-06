import { readFileSync } from "node:fs";
import path from "node:path";
import { PRODUCT_NAME } from "@rakazo/contracts/brand";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  productName?: string;
  build?: { productName?: string };
};

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe(PRODUCT_NAME);
    expect(packageJson.build?.productName).toBeUndefined();
  });
});
