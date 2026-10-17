import { Router } from "express";
import { prisma, verifyPassword } from "@node-web/db";
import { createSession, SESSION_COOKIE } from "../auth.ts";
import { readCookie } from "../cookies.ts";
import { asPassword, asRecord, asString } from "../validate.ts";

export const sessionsRouter = Router();

sessionsRouter.post("/api/sessions", async (req, res) => {
  const body = asRecord(req.body, "body");
  const email = asString(body["email"], "email").toLowerCase();
  const password = asPassword(body["password"]);

  const user = await prisma.user.findUnique({ where: { email } });
  if (user === null || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: "email or password is incorrect" });
    return;
  }
  await createSession(res, user.id);
  res.status(201).json({ user: { id: user.id, email: user.email, name: user.name } });
});

sessionsRouter.delete("/api/sessions", async (req, res) => {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (token !== undefined) await prisma.session.deleteMany({ where: { token } });
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.status(204).end();
});
