import { hashPassword, prisma } from "../src/index.ts";

// Fixed data so verification runs and the Playwright spec see the same catalog every time.
const DEMO_USER = { email: "demo@node-web.test", name: "Demo Shopper", password: "demo-password" };

const PRODUCTS = [
  { name: "Ceramic Mug", description: "Stoneware mug, 350 ml.", priceCents: 1800, stock: 25 },
  { name: "Pour-over Kettle", description: "Gooseneck kettle, 1 l.", priceCents: 5400, stock: 8 },
  { name: "Coffee Grinder", description: "Hand grinder with steel burrs.", priceCents: 7900, stock: 5 },
];

async function main(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { email: DEMO_USER.email },
    update: {},
    create: { email: DEMO_USER.email, name: DEMO_USER.name, passwordHash: await hashPassword(DEMO_USER.password) },
  });
  for (const product of PRODUCTS) {
    const existing = await prisma.product.findFirst({ where: { name: product.name } });
    if (existing === null) await prisma.product.create({ data: { ...product, sellerId: user.id } });
  }
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
