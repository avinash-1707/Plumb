import { Router } from "express";
import { prisma } from "@node-web/db";
import { currentUser, requireUser } from "../auth.ts";
import { mergeLines, OrderTooLargeError, OutOfStockError, priceOrder, UnknownProductError } from "../pricing.ts";
import { asPositiveInt, asRecord, parseId, ValidationError } from "../validate.ts";

const MAX_LINES = 50;
const MAX_QUANTITY = 100;

export const ordersRouter = Router();

ordersRouter.post("/api/orders", requireUser, async (req, res) => {
  const body = asRecord(req.body, "body");
  const rawItems = body["items"];
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_LINES) {
    throw new ValidationError(`items must be an array of 1 to ${MAX_LINES} lines`);
  }
  const lines = mergeLines(
    rawItems.map((raw, i) => {
      const item = asRecord(raw, `items[${i}]`);
      return {
        productId: asPositiveInt(item["productId"], `items[${i}].productId`),
        quantity: asPositiveInt(item["quantity"], `items[${i}].quantity`, { max: MAX_QUANTITY }),
      };
    }),
  );
  const userId = currentUser(res).id;

  try {
    const order = await prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } } });
      const priced = priceOrder(lines, products);
      for (const line of priced.lines) {
        // Conditional decrement: a concurrent order that drained stock makes count 0 instead of going negative.
        const { count } = await tx.product.updateMany({
          where: { id: line.productId, stock: { gte: line.quantity } },
          data: { stock: { decrement: line.quantity } },
        });
        if (count === 0) throw new OutOfStockError(line.productId);
      }
      return tx.order.create({
        data: { userId, totalCents: priced.totalCents, items: { create: priced.lines } },
        include: { items: true },
      });
    });
    res.status(201).json({ order });
  } catch (err) {
    if (err instanceof OutOfStockError || err instanceof UnknownProductError) {
      res.status(409).json({ error: err.message, productId: err.productId });
      return;
    }
    if (err instanceof OrderTooLargeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

ordersRouter.get("/api/orders/:id", requireUser, async (req, res) => {
  const id = parseId(req.params["id"]);
  const order = id !== null
    ? await prisma.order.findFirst({
        where: { id, userId: currentUser(res).id },
        include: { items: { include: { product: { select: { name: true } } } } },
      })
    : null;
  if (order === null) {
    res.status(404).json({ error: "order not found" });
    return;
  }
  res.json({ order });
});
