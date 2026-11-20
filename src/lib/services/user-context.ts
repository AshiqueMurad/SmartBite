import { db } from "@/lib/db";
import { GOAL_LABELS, type ProfilePayload } from "@/lib/profile-payload";

export interface UserContext {
  profile: ProfilePayload | null;
  allergies: string[];
  intolerances: string[];
  dietaryRestrictions: string[];
  dislikedFoods: string[];
}

function parseList(raw?: string | null): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Loads the user's saved food preferences from the database and combines them with the client profile. */
export async function loadUserContext(
  userId?: string,
  profile?: ProfilePayload | null
): Promise<UserContext> {
  let prefs: {
    allergies: string;
    intolerances: string;
    dietaryRestrictions: string;
    dislikedFoods: string;
  } | null = null;

  if (userId) {
    try {
      prefs = await db.userFoodPreference.findUnique({ where: { userId } });
    } catch (err) {
      console.warn("[user-context] could not load preferences:", err);
    }
  }

  return {
    profile: profile ?? null,
    allergies: parseList(prefs?.allergies),
    intolerances: parseList(prefs?.intolerances),
    dietaryRestrictions: parseList(prefs?.dietaryRestrictions),
    dislikedFoods: parseList(prefs?.dislikedFoods),
  };
}

/** Plain-text summary of the user for inclusion in an AI prompt. Empty string if nothing is known. */
export function describeUserContext(ctx: UserContext): string {
  const lines: string[] = [];
  const p = ctx.profile;
  if (p) {
    lines.push(`Goal: ${GOAL_LABELS[p.goal] ?? p.goal}`);
    lines.push(
      `Body: ${p.gender}, age ${p.age}, ${p.height} cm, ${p.currentWeight} kg now, goal weight ${p.goalWeight} kg, activity level ${p.activityLevel}`
    );
    if (p.dailyCalories) {
      lines.push(
        `Daily targets: ${p.dailyCalories} kcal, protein ${p.protein ?? "?"} g, carbs ${p.carbs ?? "?"} g, fat ${p.fat ?? "?"} g`
      );
    }
  }
  if (ctx.allergies.length) lines.push(`Allergies (must never be recommended): ${ctx.allergies.join(", ")}`);
  if (ctx.intolerances.length) lines.push(`Intolerances (avoid): ${ctx.intolerances.join(", ")}`);
  if (ctx.dislikedFoods.length) lines.push(`Disliked foods (avoid): ${ctx.dislikedFoods.join(", ")}`);
  if (ctx.dietaryRestrictions.length) lines.push(`Dietary restrictions: ${ctx.dietaryRestrictions.join(", ")}`);
  return lines.join("\n");
}
