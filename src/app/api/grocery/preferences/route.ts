import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";

const DEFAULT_PREFERENCES = {
  allergies: [],
  intolerances: [],
  dietaryRestrictions: ["halal"],
  dislikedFoods: [],
  defaultBudgetMode: "max",
};

function parseList(raw: string | null | undefined, fallback: unknown[] = []): unknown[] {
  try {
    const value = JSON.parse(raw || JSON.stringify(fallback));
    return Array.isArray(value) ? value.map(String).filter(Boolean) : fallback;
  } catch {
    return fallback;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;

  try {
    const pref = await db.userFoodPreference.findUnique({ where: { userId: auth.userId } });
    if (!pref) return NextResponse.json({ success: true, preferences: DEFAULT_PREFERENCES });

    return NextResponse.json({
      success: true,
      preferences: {
        allergies: parseList(pref.allergies),
        intolerances: parseList(pref.intolerances),
        dietaryRestrictions: parseList(pref.dietaryRestrictions, ["halal"]),
        dislikedFoods: parseList(pref.dislikedFoods),
        defaultBudgetMode: pref.defaultBudgetMode || "max",
      },
    });
  } catch (err) {
    console.error("[api/grocery/preferences GET] error:", err);
    return NextResponse.json({ success: false, error: "Failed to fetch preferences" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;

  try {
    const body = await req.json();
    // The user id comes from the session only. Any userId in the body is ignored.
    const allergies = Array.isArray(body.allergies) ? body.allergies.map(String) : [];
    const intolerances = Array.isArray(body.intolerances) ? body.intolerances.map(String) : [];
    const dietaryRestrictions = Array.isArray(body.dietaryRestrictions) ? body.dietaryRestrictions.map(String) : ["halal"];
    const dislikedFoods = Array.isArray(body.dislikedFoods) ? body.dislikedFoods.map(String) : [];
    const defaultBudgetMode = body.defaultBudgetMode === "cheapest" || body.defaultBudgetMode === "none" ? body.defaultBudgetMode : "max";
    const userId = auth.userId;

    const data = {
      allergies: JSON.stringify(allergies),
      intolerances: JSON.stringify(intolerances),
      dietaryRestrictions: JSON.stringify(dietaryRestrictions),
      dislikedFoods: JSON.stringify(dislikedFoods),
      defaultBudgetMode,
    };
    const upserted = await db.userFoodPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    return NextResponse.json({
      success: true,
      preferences: {
        allergies: parseList(upserted.allergies),
        intolerances: parseList(upserted.intolerances),
        dietaryRestrictions: parseList(upserted.dietaryRestrictions),
        dislikedFoods: parseList(upserted.dislikedFoods),
        defaultBudgetMode: upserted.defaultBudgetMode,
      },
    });
  } catch (err) {
    console.error("[api/grocery/preferences PUT] error:", err);
    return NextResponse.json({ success: false, error: "Failed to update preferences" }, { status: 500 });
  }
}
