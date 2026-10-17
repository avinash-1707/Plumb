import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "@/components/sign-out-button.tsx";
import { getCurrentUser } from "@/lib/session.ts";
import "./globals.css";

export const metadata: Metadata = { title: "Node Web Shop" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  return (
    <html lang="en">
      <body>
        <header>
          <nav aria-label="Main">
            <Link href="/">Node Web Shop</Link>
            {user === null ? (
              <Link href="/sign-in">Sign in</Link>
            ) : (
              <>
                <Link href="/products/new">Sell a product</Link>
                <span data-testid="current-user">{user.name}</span>
                <SignOutButton />
              </>
            )}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
