import { describe, it, expect } from "vitest";
import { personalizeMeal } from "@/lib/services/personalization";
import { cleanIngredientQuery, isRelevantMatch } from "@/lib/services/nutrition-sources";

const profile = {
  gender: "male", age: 30, height: 170, currentWeight: 80, goalWeight: 75,
  activityLevel: "moderate", goal: "lose", dailyCalories: 2000, protein: 120, carbs: 200, fat: 60,
} as const;

const baseCtx = {
  profile: profile as any,
  allergies: [] as string[],
  intolerances: [] as string[],
  dietaryRestrictions: [] as string[],
  dislikedFoods: [] as string[],
};

describe("ingredient query cleaning", () => {
  it("strips quantities and parentheses", () => {
    expect(cleanIngredientQuery("Cooked rice (white), 200g")).toBe("cooked rice");
  });
  it("does not match eggplant to egg", () => {
    expect(isRelevantMatch("eggplant", "Egg, whole, raw")).toBe(false);
    expect(isRelevantMatch("egg", "Egg, whole, raw")).toBe(true);
  });
});

describe("personalizeMeal", () => {
  it("derives targets from the profile, ignoring any stale client value", () => {
    const fit = personalizeMeal(
      { totalCalories: 500, protein: 30, sugar: 2, ingredientNames: ["Dal"], sourced: [] },
      baseCtx
    );
    expect(fit.targetBasis).toBe("profile");
    // Same numbers the dashboard shows: male 30y, 170cm, 80kg, moderate, lose (-500 kcal).
    expect(fit.dailyTargets!.kcal).toBe(2162);
    expect(fit.dailyTargets!.protein).toBe(216);
    expect(fit.shareOfDailyKcalPct).toBe(23);
  });

  it("changes the target when the user's inputs change", () => {
    const meal = { totalCalories: 500, protein: 30, sugar: 0, ingredientNames: ["Dal"], sourced: [] };
    const heavier = personalizeMeal(meal, { ...baseCtx, profile: { ...profile, currentWeight: 100 } as any });
    const lighter = personalizeMeal(meal, { ...baseCtx, profile: { ...profile, currentWeight: 60 } as any });
    expect(heavier.dailyTargets!.kcal).not.toBe(lighter.dailyTargets!.kcal);
  });

  it("raises an allergy alert for a scanned ingredient", () => {
    const fit = personalizeMeal(
      { totalCalories: 400, protein: 20, sugar: 0, ingredientNames: ["Fried egg"], sourced: [] },
      { ...baseCtx, allergies: ["egg"] }
    );
    expect(fit.allergyAlerts[0]).toMatch(/^Allergy alert: egg/);
  });

  it("catches allergens from sourced allergen tags", () => {
    const fit = personalizeMeal(
      {
        totalCalories: 300, protein: 10, sugar: 0, ingredientNames: ["Snack"],
        sourced: [{
          query: "snack", matchedName: "Snack bar", source: "Open Food Facts", sourceRef: "off:1", fetchedAt: "",
          per100g: { kcal: 300, protein: 10, carbs: 40, fat: 10, fiber: 2, sugar: 5, sodiumMg: null },
          allergens: ["nuts"],
        }],
      },
      { ...baseCtx, allergies: ["nuts"] }
    );
    expect(fit.allergyAlerts.length).toBe(1);
  });

  it("flags sugar above 10% of energy", () => {
    const fit = personalizeMeal(
      { totalCalories: 200, protein: 5, sugar: 30, ingredientNames: ["Sweet"], sourced: [] },
      baseCtx
    );
    expect(fit.sugarSharePct).toBe(60);
    expect(fit.notes.some((n) => n.includes("WHO"))).toBe(true);
  });



  it("returns no targets without a profile", () => {
    const fit = personalizeMeal(
      { totalCalories: 500, protein: 30, sugar: 0, ingredientNames: ["Dal"], sourced: [] },
      { ...baseCtx, profile: null }
    );
    expect(fit.targetBasis).toBe("no_profile");
    expect(fit.shareOfDailyKcalPct).toBeNull();
  });
});
