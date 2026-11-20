import { buildBasketContext } from "@/lib/services/basket-context";
import { NextRequest, NextResponse } from "next/server";
import { aiGroceryPlannerService, GroceryPlannerInput } from "@/lib/services/ai-grocery";
import { BANGLADESH_FOOD_CATALOG } from "@/lib/services/bangladesh-food-db";
import { getStockForCatalog } from "@/lib/services/stock-check";
import { ensureHistoricalPrices } from "@/lib/services/price-history";
import { requireUser } from "@/lib/auth/require-user";
import { aiRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  ensureHistoricalPrices();
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;
  const limited = aiRateLimit(req, auth.userId, "grocery-generate", { perUser: 30, perIp: 90 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as Partial<GroceryPlannerInput>;

    if (!body.healthGoal || typeof body.healthGoal !== "string" || !body.healthGoal.trim()) {
      return NextResponse.json({ success: false, error: "Health goal is required." }, { status: 400 });
    }

    const durationDays = Math.max(1, Math.min(60, Number(body.durationDays) || 7));
    const budgetMode = body.budgetMode === "cheapest" || body.budgetMode === "none" ? body.budgetMode : "max";
    const budgetLimitBdt = body.budgetLimitBdt ? Number(body.budgetLimitBdt) : undefined;

    const input: GroceryPlannerInput = {
      // Identity comes from the session. Any userId the client sends is ignored.
      userId: auth.userId,
      userContext: {
        age: Number(body.userContext?.age) || 26,
        gender: body.userContext?.gender || "male",
        height: Number(body.userContext?.height) || 172,
        currentWeight: Number(body.userContext?.currentWeight) || 68,
        activityLevel: body.userContext?.activityLevel || "moderate",
      },
      healthGoal: body.healthGoal.trim(),
      durationDays,
      budgetMode,
      budgetLimitBdt,
      foodInspirations: Array.isArray(body.foodInspirations) ? body.foodInspirations : [],
      preferences: {
        allergies: Array.isArray(body.preferences?.allergies) ? body.preferences.allergies : [],
        intolerances: Array.isArray(body.preferences?.intolerances) ? body.preferences.intolerances : [],
        dietaryRestrictions: Array.isArray(body.preferences?.dietaryRestrictions)
          ? body.preferences.dietaryRestrictions
          : ["halal"],
        dislikedFoods: Array.isArray(body.preferences?.dislikedFoods) ? body.preferences.dislikedFoods : [],
      },
    };

    // Live stock for every catalog item with a retailer URL (cached). Out-of-stock items are not planned.
    const stock = await getStockForCatalog(BANGLADESH_FOOD_CATALOG);
    input.stockByFoodId = Object.fromEntries(Object.entries(stock).map(([id, info]) => [id, info.status]));

    const result = await aiGroceryPlannerService.generatePlan(input);

    return NextResponse.json({
      success: true,
      data: { ...result, context: await buildBasketContext(result.items, input.healthGoal, stock) },
    });
  } catch (err) {
    console.error("[api/grocery/generate] error:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal grocery planner error" },
      { status: 500 }
    );
  }
}
