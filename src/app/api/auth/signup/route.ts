import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { normalizeEmail, publicUser, validateSignup } from "@/lib/auth/user";
import { clientKey, rateLimited } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (rateLimited(`signup:${clientKey(req)}`)) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  const email = normalizeEmail(String(body.email ?? ""));
  const password = String(body.password ?? "");

  const problem = validateSignup(name, email, password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please sign in instead." },
        { status: 409 }
      );
    }

    const user = await db.user.create({
      data: { name, email, passwordHash: await hashPassword(password) },
    });

    const res = NextResponse.json({ user: publicUser(user) }, { status: 201 });
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("[auth/signup] error:", err);
    return NextResponse.json({ error: "Could not create your account. Please try again." }, { status: 500 });
  }
}
