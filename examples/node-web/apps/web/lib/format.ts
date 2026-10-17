const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatPrice(cents: number): string {
  return usd.format(cents / 100);
}

/** Parses a dollar amount typed by a user ("18", "18.5", "18.50") into cents; null if invalid. */
export function parsePriceInput(input: string): number | null {
  const match = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (match === null) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}
