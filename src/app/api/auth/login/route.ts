import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { normalizeEmail, publicUser } from "@/lib/auth/user";
import { clientKey, rateLimited } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

const INVALID = "Invalid email or password.";

export async function POST(req: NextRequest) {
  if (rateLimited(`login:${clientKey(req)}`)) {
    return NextResponse.json({ error: "Too many sign-in attempts. Try again in 15 minutes." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const email = normalizeEmail(String(body.email ?? ""));
  const password = String(body.password ?? "");
  if (!email || !password || password.length > 128) {
    return NextResponse.json({ error: INVALID }, { status: 401 });
  }

  try {
    const user = await db.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      // Spend the same time as a real check so response timing does not reveal which emails exist.
      await hashPassword(password);
      return NextResponse.json({ error: INVALID }, { status: 401 });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return NextResponse.json({ error: INVALID }, { status: 401 });

    const res = NextResponse.json({ user: publicUser(user) });
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("[auth/login] error:", err);
    return NextResponse.json({ error: "Could not sign you in. Please try again." }, { status: 500 });
  }
}
