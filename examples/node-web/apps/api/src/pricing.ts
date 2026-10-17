export interface OrderLine {
  productId: number;
  quantity: number;
}

export interface PricedProduct {
  id: number;
  priceCents: number;
  stock: number;
}

export class OutOfStockError extends Error {
  constructor(readonly productId: number) {
    super(`product ${productId} does not have enough stock`);
  }
}

export class UnknownProductError extends Error {
  constructor(readonly productId: number) {
    super(`product ${productId} does not exist`);
  }
}

export class OrderTooLargeError extends Error {
  constructor() {
    super("order total is too large");
  }
}

// Order.totalCents is a 32-bit Postgres INTEGER.
const MAX_TOTAL_CENTS = 2_147_483_647;

/**
 * Merges duplicate lines so one product is checked against its stock once, sorted by product id so
 * concurrent orders lock product rows in the same order and cannot deadlock.
 */
export function mergeLines(lines: readonly OrderLine[]): OrderLine[] {
  const quantities = new Map<number, number>();
  for (const line of lines) quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
  return [...quantities].map(([productId, quantity]) => ({ productId, quantity })).sort((a, b) => a.productId - b.productId);
}

/** Prices merged lines against current products; throws when a product is missing or short on stock. */
export function priceOrder(lines: readonly OrderLine[], products: readonly PricedProduct[]) {
  const byId = new Map(products.map((p) => [p.id, p]));
  let totalCents = 0;
  const priced = lines.map((line) => {
    const product = byId.get(line.productId);
    if (product === undefined) throw new UnknownProductError(line.productId);
    if (product.stock < line.quantity) throw new OutOfStockError(line.productId);
    totalCents += product.priceCents * line.quantity;
    if (totalCents > MAX_TOTAL_CENTS) throw new OrderTooLargeError();
    return { ...line, unitPriceCents: product.priceCents };
  });
  return { lines: priced, totalCents };
}
