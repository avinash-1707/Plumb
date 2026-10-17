import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

describe("password hashing", () => {
  it("verifies the original password and rejects others", async () => {
    const stored = await hashPassword("demo-password");
    expect(await verifyPassword("demo-password", stored)).toBe(true);
    expect(await verifyPassword("demo-passwordX", stored)).toBe(false);
  });

  it.each(["ab12:", "ab12:zz", "no-separator"])("rejects malformed stored value %j", async (stored) => {
    expect(await verifyPassword("anything", stored)).toBe(false);
  });
});
