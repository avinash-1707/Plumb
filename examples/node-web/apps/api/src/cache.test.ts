import { describe, expect, it } from "vitest";
import { evictExpired, getCachedSearch, invalidateSearchCache, setCachedSearch } from "./cache.ts";

describe("product search cache", () => {
  it("treats queries case- and whitespace-insensitively", () => {
    invalidateSearchCache();
    setCachedSearch(" Mug ", [1], 0);
    expect(getCachedSearch("mug", 1)).toEqual([1]);
  });

  it("misses after the TTL and evicts expired entries", () => {
    invalidateSearchCache();
    setCachedSearch("mug", [1], 0);
    expect(getCachedSearch("mug", 30_000)).toBeUndefined();
    evictExpired(30_000);
    expect(getCachedSearch("mug", 0)).toBeUndefined();
  });

  it("drops the oldest query once full", () => {
    invalidateSearchCache();
    for (let i = 0; i < 500; i++) setCachedSearch(`q${i}`, [i], 0);
    setCachedSearch("newest", [1], 0);
    expect(getCachedSearch("q0", 1)).toBeUndefined();
    expect(getCachedSearch("q1", 1)).toEqual([1]);
    expect(getCachedSearch("newest", 1)).toEqual([1]);
  });
});
