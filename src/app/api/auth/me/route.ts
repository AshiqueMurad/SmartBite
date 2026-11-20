import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { readSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { publicUser } from "@/lib/auth/user";

export const runtime = "nodejs";

/** Returns the signed-in user for the current session cookie, or 401. */
export async function GET(req: NextRequest) {
  const userId = readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  try {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    return NextResponse.json({ user: publicUser(user) });
  } catch (err) {
    console.error("[auth/me] error:", err);
    return NextResponse.json({ error: "Could not load your session." }, { status: 500 });
  }
}
