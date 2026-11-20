import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { readSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

export type RequireUserResult = { userId: string } | { error: NextResponse };

/**
 * Resolves the signed-in user from the session cookie. The user id is never taken from the
 * request body or query string. Returns an error response when there is no valid session or
 * the account no longer exists.
 */
export async function requireUser(req: NextRequest): Promise<RequireUserResult> {
  const userId = readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) {
    return { error: NextResponse.json({ success: false, error: "Sign in to continue." }, { status: 401 }) };
  }
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      return { error: NextResponse.json({ success: false, error: "Sign in to continue." }, { status: 401 }) };
    }
    return { userId: user.id };
  } catch (err) {
    console.error("[requireUser] lookup failed:", err);
    return { error: NextResponse.json({ success: false, error: "Could not verify your session." }, { status: 500 }) };
  }
}
