import { describe, expect, it } from "vitest";
import { readCookie } from "./cookies.ts";

describe("readCookie", () => {
  it("finds a cookie among several and decodes it", () => {
    expect(readCookie("theme=dark; session=abc%3D1; other=x", "session")).toBe("abc=1");
  });

  it("returns undefined when absent", () => {
    expect(readCookie("theme=dark", "session")).toBeUndefined();
    expect(readCookie(undefined, "session")).toBeUndefined();
  });
});

describe("readCookie with malformed encoding", () => {
  it("returns undefined instead of throwing", () => {
    expect(readCookie("session=%E0%A4", "session")).toBeUndefined();
  });
});
