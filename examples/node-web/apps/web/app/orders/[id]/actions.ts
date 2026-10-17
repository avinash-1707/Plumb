"use server";

import { redirect } from "next/navigation";
import { prisma } from "@node-web/db";
import { getCurrentUser } from "@/lib/session.ts";

export interface ReorderState {
  error: string | null;
}

class ReorderError extends Error {}

/** Places a copy of a past order at today's prices. Writes the database directly rather than through the API. */
export async function reorder(orderId: number, _previous: ReorderState): Promise<ReorderState> {
  // Bound arguments come back from the client, so they are untrusted at runtime.
  if (!Number.isSafeInteger(orderId) || orderId < 1) return { error: "This order cannot be repeated." };
  const user = await getCurrentUser();
  if (user === null) redirect("/sign-in");

  let newOrderId: number;
  try {
    newOrderId = await prisma.$transaction(async (tx) => {
      const previous = await tx.order.findFirst({
        where: { id: orderId, userId: user.id },
        // Lock rows in product id order, as the API does, so concurrent orders cannot deadlock.
        include: { items: { include: { product: true }, orderBy: { productId: "asc" } } },
      });
      if (previous === null) throw new ReorderError("This order no longer exists.");
      for (const item of previous.items) {
        const { count } = await tx.product.updateMany({
          where: { id: item.productId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (count === 0) throw new ReorderError(`${item.product.name} is out of stock.`);
      }
      const created = await tx.order.create({
        data: {
          userId: user.id,
          totalCents: previous.items.reduce((sum, i) => sum + i.product.priceCents * i.quantity, 0),
          items: {
            create: previous.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPriceCents: i.product.priceCents })),
          },
        },
      });
      return created.id;
    });
  } catch (err) {
    if (err instanceof ReorderError) return { error: err.message };
    throw err;
  }
  redirect(`/orders/${newOrderId}`);
}
