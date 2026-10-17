import { describe, expect, it } from "vitest";
import { formatPrice, parsePriceInput } from "./format.ts";

describe("formatPrice", () => {
  it("formats cents as US dollars", () => {
    expect(formatPrice(1800)).toBe("$18.00");
  });
});

describe("parsePriceInput", () => {
  it.each([
    ["18", 1800],
    ["18.5", 1850],
    [" 18.05 ", 1805],
  ])("parses %j", (input, cents) => {
    expect(parsePriceInput(input)).toBe(cents);
  });

  it.each(["", "abc", "18.555", "-1", "0"])("rejects %j", (input) => {
    expect(parsePriceInput(input)).toBeNull();
  });
});
