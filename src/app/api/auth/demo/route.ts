import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { publicUser } from "@/lib/auth/user";
import { clientKey, rateLimited } from "@/lib/auth/rate-limit";
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_PROFILE } from "@/lib/sample-data";

export const runtime = "nodejs";

// The demo account looks like it has been used for two weeks, so the Food Diary has history.
const DEMO_HISTORY_DAYS = 14;

/**
 * Starts a real session for the shared demo account, creating the account on first use. No
 * password is needed. Set DEMO_ACCOUNT_ENABLED=false to turn this off (for example, in production).
 */
export async function POST(req: NextRequest) {
  if (process.env.DEMO_ACCOUNT_ENABLED === "false") {
    return NextResponse.json({ error: "The demo account is not available." }, { status: 404 });
  }
  if (rateLimited(`demo:${clientKey(req)}`, 60)) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }

  try {
    let user = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
    if (!user) {
      user = await db.user.create({
        data: {
          email: DEMO_EMAIL,
          name: DEMO_PROFILE.fullName,
          passwordHash: await hashPassword(DEMO_PASSWORD),
          createdAt: new Date(Date.now() - DEMO_HISTORY_DAYS * 24 * 60 * 60 * 1000),
        },
      });
    }

    const res = NextResponse.json({ user: publicUser(user) });
    res.cookies.set(SESSION_COOKIE, createSessionToken(user.id), sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("[auth/demo] error:", err);
    return NextResponse.json({ error: "Could not open the demo. Please try again." }, { status: 500 });
  }
}
