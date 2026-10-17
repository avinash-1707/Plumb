import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "@node-web/db";
import { readCookie } from "./cookies.ts";

export const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: number;
  email: string;
  name: string;
}

declare global {
  // Express declares res.locals typing in this global namespace.
  namespace Express {
    interface Locals {
      user?: AuthUser;
    }
  }
}

export async function createSession(res: Response, userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { token, userId, expiresAt } });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const session =
    token === undefined
      ? null
      : await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (session === null || session.expiresAt <= new Date()) {
    res.status(401).json({ error: "sign in required" });
    return;
  }
  const { id, email, name } = session.user;
  res.locals.user = { id, email, name };
  next();
}

export function currentUser(res: Response): AuthUser {
  const user = res.locals.user;
  if (user === undefined) throw new Error("currentUser called on a route without requireUser");
  return user;
}
