# node-web

A small shop used as Plumb's v1 integration target: a Next.js storefront (`apps/web`), an Express API (`apps/api`), and a Prisma/Postgres data package (`packages/db`), in one pnpm workspace.

## Run it

Requires Node 22.20+, pnpm, and Docker.

```sh
cp .env.example .env
pnpm install
pnpm db:setup     # start Postgres, apply migrations, seed demo data
pnpm dev          # api on :4000, web on :3000
```

Open http://localhost:3000 and sign in as `demo@node-web.test` / `demo-password`.

`pnpm teardown` stops Postgres and deletes its data. Ports come from `.env` (`API_PORT`, `PORT`, `POSTGRES_PORT`); values already set in the environment win, so `PORT=3100 API_PORT=4100 API_URL=http://localhost:4100 pnpm dev` runs an isolated second copy against the same database.

## Check it

```sh
pnpm typecheck
pnpm test         # Vitest unit tests, no database needed
pnpm exec playwright install chromium   # once
pnpm e2e          # Playwright; needs `pnpm db:setup` first, starts api and web itself
```

## Features

| Feature | User path | API |
|---|---|---|
| Sign in / out | `/sign-in`, "Sign out" in the header | `POST /api/sessions`, `DELETE /api/sessions` |
| List and search products | `/`, "Search products" box | `GET /api/products?q=` |
| Sell a product | `/products/new` (signed in) | `POST /api/products` |
| Place an order | "Buy <product>" on `/`, then `/orders/<id>` | `POST /api/orders`, `GET /api/orders/:id` |
| Order again | "Order again" on `/orders/<id>` | none: a server action writes the database directly |

## Structure Plumb's map should find

These exist on purpose so the golden map in `.plumb-golden/` covers each extractor:

- Cross-component imports: `apps/api` and `apps/web` both import `@node-web/db`.
- Web-to-API calls with literal URLs (`fetch("/api/sessions")`) and template URLs (`` fetch(`${apiUrl()}/api/orders/${id}`) ``).
- Two components writing the same tables: the API's `POST /api/orders` and the web's "Order again" server action both create `Order` rows and decrement `Product.stock`.
- A module-level mutable cache and a module-level `setInterval` in `apps/api/src/cache.ts`.
