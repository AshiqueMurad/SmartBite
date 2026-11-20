import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveIngredient, SCANNER_FOOD_LABELS, aliasTargetIds, singularize } from "../src/lib/services/ingredient-matcher";
import { BANGLADESH_FOOD_CATALOG } from "../src/lib/services/bangladesh-food-db";
import { aiGroceryPlannerService, type GroceryPlannerInput } from "../src/lib/services/ai-grocery";

const CATALOG_IDS = new Set(BANGLADESH_FOOD_CATALOG.map((f) => f.id));
const base = (over: Partial<GroceryPlannerInput> = {}): GroceryPlannerInput => ({
  userContext: { age: 26, gender: "male", height: 172, currentWeight: 68, activityLevel: "moderate" },
  healthGoal: "weight loss",
  durationDays: 7,
  budgetMode: "none",
  foodInspirations: [],
  preferences: { allergies: [], intolerances: [], dietaryRestrictions: ["halal"], dislikedFoods: [] },
  ...over,
});

describe("scanner labels: coverage", () => {
  it("has exactly the 45 labels the vision model can return", () => {
    expect(SCANNER_FOOD_LABELS).toHaveLength(45);
    expect(new Set(SCANNER_FOOD_LABELS).size).toBe(45);
  });

  it("the vision script reads the same shared label file", () => {
    const script = readFileSync("scripts/prepare-vision.mjs", "utf8");
    expect(script).toContain("src/lib/services/scanner-labels.json");
  });

  it("every label either maps to a catalog food or is a named prepared dish", () => {
    for (const label of SCANNER_FOOD_LABELS) {
      const r = resolveIngredient(label);
      if (r.food) {
        expect(CATALOG_IDS.has(r.food.id), label).toBe(true);
      } else {
        expect(r.reason, label).toBe("prepared_dish");
      }
    }
  });

  it("every alias target points at a real catalog food", () => {
    for (const id of aliasTargetIds()) expect(CATALOG_IDS.has(id), id).toBe(true);
  });
});

describe("matching: exact words and plurals", () => {
  const id = (raw: string) => resolveIngredient(raw).food?.id ?? null;

  it("does not read eggplant as eggs", () => {
    expect(id("eggplant")).toBe("veg_begun_eggplant");
    expect(id("eggs")).toBe("eggs_farm_dozen");
  });

  it("does not turn fish into shrimp", () => {
    expect(id("fish")).toBe("fish_rui_medium");
    expect(id("shrimp")).toBe("fish_shrimp_galda");
  });

  it("normalizes plurals in both directions", () => {
    expect(id("tomatoes")).toBe("veg_tomato_ripe");
    expect(id("potatoes")).toBe("veg_alu_potato");
    expect(id("mushrooms")).toBe("mushroom_button");
    expect(id("carrots")).toBe("carrot_gajor");
    expect(id("beans")).toBe("beans_green_shim");
    expect(id("mangoes")).toBe("mango_local");
    expect(singularize("radishes")).toBe("radish");
  });

  it("matches romanized names whose singular form differs from the table key", () => {
    expect(id("pangas")).toBe("fish_pangas");
  });

  it("reports a prepared dish with its reason instead of guessing", () => {
    expect(resolveIngredient("pizza")).toEqual({ food: null, reason: "prepared_dish" });
  });

  it("reports an unknown item as not in catalog", () => {
    expect(resolveIngredient("dragonfruit")).toEqual({ food: null, reason: "not_in_catalog" });
  });
});

describe("planner: scanned items", () => {
  it("uses eggplant as eggplant when scanned, not as eggs", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(base({ foodInspirations: ["eggplant"] }));
    const eggplant = plan.items.find((i) => i.foodId === "veg_begun_eggplant");
    expect(eggplant?.quantity).toBeGreaterThan(0);
    expect(plan.unmatchedInspirations).toEqual([]);
  });

  it("reports a prepared dish as unmatched with its reason", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(base({ foodInspirations: ["pizza"] }));
    expect(plan.unmatchedInspirations).toEqual([{ name: "pizza", reason: "prepared_dish" }]);
  });

  it("reports an item excluded by an egg allergy instead of silently dropping it", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(
      base({
        foodInspirations: ["eggs"],
        preferences: { allergies: ["egg"], intolerances: [], dietaryRestrictions: ["halal"], dislikedFoods: [] },
      })
    );
    expect(plan.unmatchedInspirations).toEqual([{ name: "eggs", reason: "filtered_by_preferences" }]);
    expect(plan.items.some((i) => i.foodId === "eggs_farm_dozen")).toBe(false);
  });

  it("reports an out-of-stock scanned item", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(
      base({ foodInspirations: ["mango"], stockByFoodId: { mango_local: "Out of stock" } })
    );
    expect(plan.unmatchedInspirations).toEqual([{ name: "mango", reason: "out_of_stock" }]);
  });

  it("excludes soy and nut foods for users with those allergies", async () => {
    const soy = await aiGroceryPlannerService.generatePlan(
      base({ preferences: { allergies: ["soy"], intolerances: [], dietaryRestrictions: ["halal"], dislikedFoods: [] } })
    );
    expect(soy.items.some((i) => i.foodId === "tofu_soft" || i.foodId === "edamame_green_soy")).toBe(false);

    const nut = await aiGroceryPlannerService.generatePlan(
      base({ foodInspirations: ["nuts"], preferences: { allergies: ["nuts"], intolerances: [], dietaryRestrictions: ["halal"], dislikedFoods: [] } })
    );
    expect(nut.items.some((i) => i.foodId === "nuts_mixed")).toBe(false);
    expect(nut.unmatchedInspirations[0]?.reason).toBe("filtered_by_preferences");
  });
});
