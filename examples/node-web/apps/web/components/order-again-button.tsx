"use client";

import { useActionState } from "react";
import { reorder, type ReorderState } from "@/app/orders/[id]/actions.ts";

export function OrderAgainButton({ orderId }: { orderId: number }) {
  const [state, action, pending] = useActionState<ReorderState>(reorder.bind(null, orderId), { error: null });
  return (
    <form action={action}>
      {state.error !== null && <p role="alert">{state.error}</p>}
      <button type="submit" disabled={pending}>
        Order again
      </button>
    </form>
  );
}
