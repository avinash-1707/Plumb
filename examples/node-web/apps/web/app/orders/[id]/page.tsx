import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { apiUrl } from "@/lib/api.ts";
import { formatPrice } from "@/lib/format.ts";
import { OrderAgainButton } from "@/components/order-again-button.tsx";

interface OrderView {
  id: number;
  totalCents: number;
  items: Array<{ id: number; quantity: number; unitPriceCents: number; product: { name: string } }>;
}

export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const { id } = await params;
  const res = await fetch(`${apiUrl()}/api/orders/${encodeURIComponent(id)}`, {
    headers: { cookie: (await cookies()).toString() },
    cache: "no-store",
  });
  if (res.status === 401) redirect("/sign-in");
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`loading order ${id} failed (${res.status})`);
  const { order } = (await res.json()) as { order: OrderView };

  return (
    <>
      <h1>Order #{order.id}</h1>
      <ul aria-label="Order items">
        {order.items.map((item) => (
          <li key={item.id}>
            <span>
              {item.quantity} × {item.product.name}
            </span>
            <span>{formatPrice(item.unitPriceCents * item.quantity)}</span>
          </li>
        ))}
      </ul>
      <p data-testid="order-total">Total {formatPrice(order.totalCents)}</p>
      <OrderAgainButton orderId={order.id} />
    </>
  );
}
