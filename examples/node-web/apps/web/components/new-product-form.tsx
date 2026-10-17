"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { parsePriceInput } from "@/lib/format.ts";
import { errorMessage, NETWORK_ERROR } from "@/lib/http.ts";

export function NewProductForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const priceCents = parsePriceInput(String(form.get("price")));
    const stock = Number(form.get("stock"));
    if (priceCents === null) {
      setError("Price must be a positive amount like 18 or 18.50");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.get("name"), description: form.get("description"), priceCents, stock }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "could not create product"));
        return;
      }
      router.push("/");
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <label>
        Name <input name="name" required maxLength={120} />
      </label>
      <label>
        Description <textarea name="description" required maxLength={2000} />
      </label>
      <label>
        Price (USD) <input name="price" inputMode="decimal" required />
      </label>
      <label>
        Stock <input name="stock" type="number" min={0} step={1} defaultValue={1} required />
      </label>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Create product
      </button>
    </form>
  );
}
