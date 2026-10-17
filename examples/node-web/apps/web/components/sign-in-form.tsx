"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { errorMessage, NETWORK_ERROR } from "@/lib/http.ts";

export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "sign-in failed"));
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <label>
        Email <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        Sign in
      </button>
    </form>
  );
}
