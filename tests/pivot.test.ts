import { describe, it, expect } from "vitest";
import { ragNutritionService } from "../src/lib/services/rag-nutrition";

const pivot = (over: Parameters<typeof ragNutritionService.generateDietaryPivot>[0]) =>
  ragNutritionService.generateDietaryPivot(over);

describe("pivot: classification", () => {
  it("does not read eggplant as egg protein", () => {
    const p = pivot({ mealName: "Eggplant bhaji", ingredients: ["eggplant", "onion", "oil"] });
    expect(p.metabolicRiskProfile.satietyIndex).not.toBe("high");
  });

  it("keeps a home-cooked chicken bhuna out of NOVA 4", () => {
    const p = pivot({ mealName: "Chicken bhuna", ingredients: ["chicken", "onion", "oil"] });
    expect(p.metabolicRiskProfile.novaCategory).toBeLessThan(4);
  });

  it("classes a burger as NOVA 4", () => {
    const p = pivot({ mealName: "Chicken burger", ingredients: ["chicken", "bun"] });
    expect(p.metabolicRiskProfile.novaCategory).toBe(4);
  });
});

describe("pivot: market basket and savings", () => {
  it("omits savings when no restaurant price is supplied", () => {
    const p = pivot({ mealName: "Dal", ingredients: ["dal", "rice"] });
    expect(p.localizedMarketPivot.estCostSavingsBdt).toBeNull();
    expect(p.localizedMarketPivot.savingsBasis).toBe("unavailable");
  });

  it("computes savings from the real basket cost when a restaurant price is given", () => {
    const p = pivot({ mealName: "Dal", ingredients: ["dal", "rice"], restaurantPriceBdt: 300 });
    const m = p.localizedMarketPivot;
    expect(m.savingsBasis).toBe("restaurant_price");
    expect(m.estCostSavingsBdt).toBe(300 - m.totalEstCostBdt);
  });

  it("filters out ingredients the user is allergic to and lists them as excluded", () => {
    const p = pivot({ mealName: "Egg curry", ingredients: ["egg", "rice"], allergies: ["egg"] });
    expect(p.localizedMarketPivot.suggestedIngredients.map((i) => i.foodId)).not.toContain("eggs_farm_dozen");
    expect(p.localizedMarketPivot.excludedIngredients.map((e) => e.foodId)).toContain("eggs_farm_dozen");
  });
});

describe("pivot: diet and dislike filtering", () => {
  it("does not suggest animal protein for a vegan user", () => {
    const p = pivot({
      mealName: "Chicken and dal",
      ingredients: ["chicken", "dal", "rice"],
      dietaryRestrictions: ["vegan"],
    });
    const ids = p.localizedMarketPivot.suggestedIngredients.map((i) => i.foodId);
    expect(ids).not.toContain("chicken_broiler");
    expect(ids).toContain("dal_masoor");
    expect(p.localizedMarketPivot.excludedIngredients.map((e) => e.foodId)).toContain("chicken_broiler");
  });

  it("excludes disliked foods and reports them", () => {
    const p = pivot({
      mealName: "Okra fry",
      ingredients: ["okra", "onion"],
      dislikedFoods: ["okra"],
    });
    expect(p.localizedMarketPivot.suggestedIngredients.map((i) => i.foodId)).not.toContain("veg_dherosh_okra");
    expect(p.localizedMarketPivot.excludedIngredients.map((e) => e.foodId)).toContain("veg_dherosh_okra");
  });

  it("lists ingredients the catalog cannot match, with no price", () => {
    const p = pivot({ mealName: "Mystery", ingredients: ["dragonfruit"] });
    expect(p.localizedMarketPivot.unmatchedIngredients).toContain("dragonfruit");
    expect(p.localizedMarketPivot.totalEstCostBdt).toBe(0);
  });
});
