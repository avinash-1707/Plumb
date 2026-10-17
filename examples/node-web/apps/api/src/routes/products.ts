import { Router } from "express";
import { prisma } from "@node-web/db";
import { currentUser, requireUser } from "../auth.ts";
import { getCachedSearch, invalidateSearchCache, setCachedSearch } from "../cache.ts";
import { asPositiveInt, asRecord, asString } from "../validate.ts";

// Keeps any order (100 units per line, 50 lines) within the 32-bit order total.
const MAX_PRICE_CENTS = 10_000_00;
const MAX_STOCK = 1_000_000;

export const productsRouter = Router();

productsRouter.get("/api/products", async (req, res) => {
  const query = typeof req.query["q"] === "string" ? req.query["q"].slice(0, 100) : "";
  let ids = getCachedSearch(query);
  if (ids === undefined) {
    const matches = await prisma.product.findMany({
      where: query.trim() === "" ? {} : { name: { contains: query.trim(), mode: "insensitive" } },
      select: { id: true },
    });
    ids = matches.map((m) => m.id);
    setCachedSearch(query, ids);
  }
  // Rows are always read fresh: stock changes from any writer show up immediately.
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, orderBy: { name: "asc" } });
  res.json({ products });
});

productsRouter.post("/api/products", requireUser, async (req, res) => {
  const body = asRecord(req.body, "body");
  const product = await prisma.product.create({
    data: {
      name: asString(body["name"], "name", { maxLength: 120 }),
      description: asString(body["description"], "description", { maxLength: 2000 }),
      priceCents: asPositiveInt(body["priceCents"], "priceCents", { max: MAX_PRICE_CENTS }),
      stock: asPositiveInt(body["stock"], "stock", { allowZero: true, max: MAX_STOCK }),
      sellerId: currentUser(res).id,
    },
  });
  invalidateSearchCache();
  res.status(201).json({ product });
});
