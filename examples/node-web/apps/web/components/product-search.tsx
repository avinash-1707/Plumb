"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/format.ts";
import { errorMessage, NETWORK_ERROR } from "@/lib/http.ts";

interface Product {
  id: number;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
}

export function ProductSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/products?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`search failed (${res.status})`);
          const body = (await res.json()) as { products: Product[] };
          setProducts(body.products);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  async function buy(productId: number) {
    let res: Response;
    try {
      res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ productId, quantity: 1 }] }),
      });
    } catch {
      setError(NETWORK_ERROR);
      return;
    }
    if (res.status === 401) {
      router.push("/sign-in");
      return;
    }
    if (!res.ok) {
      setError(await errorMessage(res, "order failed"));
      return;
    }
    const { order } = (await res.json()) as { order: { id: number } };
    router.push(`/orders/${order.id}`);
  }

  return (
    <section>
      <input
        type="search"
        aria-label="Search products"
        placeholder="Search products"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error !== null && <p role="alert">{error}</p>}
      {products === null ? (
        <p>Loading…</p>
      ) : products.length === 0 ? (
        <p>No products match “{query}”.</p>
      ) : (
        <ul aria-label="Products">
          {products.map((p) => (
            <li key={p.id}>
              <span>
                <strong>{p.name}</strong> {formatPrice(p.priceCents)} ({p.stock} left)
              </span>
              <button type="button" disabled={p.stock === 0} onClick={() => void buy(p.id)}>
                Buy {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
