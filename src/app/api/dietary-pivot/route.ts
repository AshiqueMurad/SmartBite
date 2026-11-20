import { NextRequest, NextResponse } from "next/server";
import { ragNutritionService } from "@/lib/services/rag-nutrition";
import { ensureHistoricalPrices } from "@/lib/services/price-history";
import { loadUserContext, describeUserContext } from "@/lib/services/user-context";
import { GOAL_LABELS, type ProfilePayload } from "@/lib/profile-payload";
import { requireUser } from "@/lib/auth/require-user";
import { aiRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

interface LlmPivotText {
  metabolicObservation?: string;
  orderSwapText?: string;
  diningCustomizations?: string[];
  personalNote?: string;
}

async function personalizeWithGemini(prompt: string, apiKey: string): Promise<LlmPivotText | null> {
  const model = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? (JSON.parse(text) as LlmPivotText) : null;
  } catch (err) {
    console.warn("[dietary-pivot] Gemini personalization failed:", err);
    return null;
  }
}

function buildPrompt(args: {
  mealName: string;
  ingredients: string[];
  isMenu: boolean;
  userContext: string;
  evidence: { guidelineTitle: string; source: string; sourceUrl: string | null; evidence: "cited" | "general_guidance"; summary: string }[];
}): string {
  const evidence = args.evidence.length
    ? args.evidence
          .map((e) => `- ${e.guidelineTitle} (${e.evidence === "cited" ? e.source : "general guidance"}): ${e.summary}`)
          .join("\n")
    : "- No matching guideline found; keep advice general and conservative.";
  return `You are SmartBite's nutrition coach for users in Bangladesh. Write a personalized dietary pivot for this meal.

USER PROFILE:
${args.userContext || "No profile saved. Give general advice."}

MEAL: ${args.mealName}
INGREDIENTS DETECTED: ${args.ingredients.join(", ") || "not listed"}
RESTAURANT MENU: ${args.isMenu ? "yes" : "no"}

GUIDELINE EVIDENCE (the only clinical sources you may use; name the guideline title when you rely on one):
${evidence}

RULES:
- Tailor every suggestion to the user's goal and daily targets.
- Never suggest a food the user is allergic or intolerant to, or dislikes.
- Prefer foods that are easy to find in Dhaka markets.
- No diagnosis or treatment claims. Frame everything as nutritional observations.

Return ONLY a JSON object:
{"metabolicObservation": "two sentences on how this meal affects blood sugar and satiety for this user", "orderSwapText": "one concrete order or cooking change", "diningCustomizations": ["up to three short items"], "personalNote": "one sentence tied to the user's goal and targets"}`;
}

export async function POST(req: NextRequest) {
  ensureHistoricalPrices();
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;
  const limited = aiRateLimit(req, auth.userId, "dietary-pivot", { perUser: 30, perIp: 90 });
  if (limited) return limited;

  try {
    const body = await req.json();
    const mealName = String(body.mealName || "Scanned Meal");
    const ingredients: string[] = Array.isArray(body.ingredients) ? body.ingredients.map(String) : [];
    const isMenuScan = Boolean(body.isMenuScan);
    const profile: ProfilePayload | null = body.profile ?? null;

    // Identity comes from the session. Any userId in the body is ignored.
    const ctx = await loadUserContext(auth.userId, profile);
    const userContext = describeUserContext(ctx);
    const goalText = profile ? GOAL_LABELS[profile.goal] ?? "overall metabolic health" : "overall metabolic health";

    const externalFacts = await ragNutritionService.queryOpenFoodFacts(mealName);

    // Deterministic retrieval (RAG) over the guideline knowledge base, filtered by the user's allergies.
    const pivot: any = ragNutritionService.generateDietaryPivot({
      mealName,
      ingredients,
      userGoal: goalText,
      metabolicCondition: profile?.goal ?? "",
      isMenuScan,
      allergies: ctx.allergies,
      intolerances: ctx.intolerances,
      dietaryRestrictions: ctx.dietaryRestrictions,
      dislikedFoods: ctx.dislikedFoods,
      restaurantPriceBdt: Number(body.restaurantPriceBdt) > 0 ? Number(body.restaurantPriceBdt) : undefined,
    });

    // Generation step: the LLM writes a personalized answer grounded in the retrieved guideline evidence.
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    let aiText: LlmPivotText | null = null;
    if (geminiKey) {
      aiText = await personalizeWithGemini(
        buildPrompt({
          mealName,
          ingredients,
          isMenu: isMenuScan,
          userContext,
          evidence: pivot.ragEvidence ?? [],
        }),
        geminiKey
      );
    }

    if (aiText) {
      if (aiText.metabolicObservation && pivot.metabolicRiskProfile) {
        pivot.metabolicRiskProfile.metabolicObservation = aiText.metabolicObservation;
      }
      if (pivot.restaurantPivotRecommendation) {
        if (aiText.orderSwapText) pivot.restaurantPivotRecommendation.orderSwapText = aiText.orderSwapText;
        if (aiText.diningCustomizations?.length) {
          pivot.restaurantPivotRecommendation.diningCustomizations = aiText.diningCustomizations.map(String).slice(0, 3);
        }
      }
    }

    return NextResponse.json({
      success: true,
      pivot,
      externalFacts,
      personalized: Boolean(aiText),
      personalNote: aiText?.personalNote ?? null,
    });
  } catch (err) {
    console.error("[api/dietary-pivot] error:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Failed to generate dietary pivot" },
      { status: 500 }
    );
  }
}
