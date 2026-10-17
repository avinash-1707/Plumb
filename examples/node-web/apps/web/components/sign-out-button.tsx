"use client";

import { useRouter } from "next/navigation";

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    try {
      await fetch("/api/sessions", { method: "DELETE" });
    } finally {
      // Even if the API is unreachable, re-render so the header reflects the server's view of the session.
      router.push("/");
      router.refresh();
    }
  }

  return (
    <button type="button" onClick={() => void signOut()}>
      Sign out
    </button>
  );
}
