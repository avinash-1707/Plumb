import { describe, expect, it } from "vitest";
import { mergeLines, OrderTooLargeError, OutOfStockError, priceOrder, UnknownProductError } from "./pricing.ts";

const products = [
  { id: 1, priceCents: 1800, stock: 3 },
  { id: 2, priceCents: 5400, stock: 1 },
];

describe("mergeLines", () => {
  it("sums quantities for repeated products", () => {
    expect(mergeLines([{ productId: 1, quantity: 1 }, { productId: 2, quantity: 1 }, { productId: 1, quantity: 2 }])).toEqual([
      { productId: 1, quantity: 3 },
      { productId: 2, quantity: 1 },
    ]);
  });
});

describe("priceOrder", () => {
  it("totals lines at the current unit price", () => {
    const priced = priceOrder([{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }], products);
    expect(priced.totalCents).toBe(2 * 1800 + 5400);
    expect(priced.lines[0]).toEqual({ productId: 1, quantity: 2, unitPriceCents: 1800 });
  });

  it("rejects a quantity above stock", () => {
    expect(() => priceOrder([{ productId: 2, quantity: 2 }], products)).toThrow(OutOfStockError);
  });

  it("rejects an unknown product", () => {
    expect(() => priceOrder([{ productId: 9, quantity: 1 }], products)).toThrow(UnknownProductError);
  });
});

describe("order limits", () => {
  it("sorts merged lines by product id so row locks are taken in one order", () => {
    expect(mergeLines([{ productId: 2, quantity: 1 }, { productId: 1, quantity: 1 }]).map((l) => l.productId)).toEqual([1, 2]);
  });

  it("rejects a total beyond the 32-bit column", () => {
    const pricey = [{ id: 1, priceCents: 2_000_000_000, stock: 5 }];
    expect(() => priceOrder([{ productId: 1, quantity: 2 }], pricey)).toThrow(OrderTooLargeError);
  });
});
