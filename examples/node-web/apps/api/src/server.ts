import { prisma } from "@node-web/db";
import { createApp } from "./app.ts";

const port = Number(process.env["API_PORT"] ?? 4000);
const server = createApp().listen(port, () => {
  console.log(`api listening on http://localhost:${port}`);
});

function shutdown(): void {
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
