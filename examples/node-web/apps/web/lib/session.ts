import "server-only";
import { cookies } from "next/headers";
import { prisma } from "@node-web/db";

// Must match the cookie the API sets on sign-in.
const SESSION_COOKIE = "session";

export interface SessionUser {
  id: number;
  name: string;
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: { select: { id: true, name: true } } },
  });
  return session !== null && session.expiresAt > new Date() ? session.user : null;
}
