import { describe, expect, it } from "vitest";
import { asPassword, asPositiveInt, parseId, ValidationError } from "./validate.ts";

describe("parseId", () => {
  it.each([["42", 42], ["2147483647", 2_147_483_647]])("accepts %j", (raw, id) => {
    expect(parseId(raw)).toBe(id);
  });

  it.each(["0", "0x10", "1e3", "-1", "2147483648", "99999999999", "", undefined])("rejects %j", (raw) => {
    expect(parseId(raw)).toBeNull();
  });
});

describe("asPositiveInt", () => {
  it("rejects values above the 32-bit column", () => {
    expect(() => asPositiveInt(3_000_000_000, "priceCents")).toThrow(ValidationError);
  });
});

describe("asPassword", () => {
  it("keeps surrounding spaces", () => {
    expect(asPassword(" secret ")).toBe(" secret ");
  });
});
