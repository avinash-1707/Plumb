import express, { type ErrorRequestHandler } from "express";
import { ordersRouter } from "./routes/orders.ts";
import { productsRouter } from "./routes/products.ts";
import { sessionsRouter } from "./routes/sessions.ts";
import { ValidationError } from "./validate.ts";

function isClientHttpError(err: unknown): err is Error & { status: number } {
  return (
    err instanceof Error &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status < 500 &&
    "expose" in err &&
    err.expose === true
  );
}

// Express 5 forwards rejected async handlers here.
const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // express.json() raises http-errors for malformed or oversized bodies; those are the client's fault.
  if (isClientHttpError(err)) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal error" });
};

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(sessionsRouter);
  app.use(productsRouter);
  app.use(ordersRouter);
  app.use(errorHandler);
  return app;
}
