import { describe, it, expect } from "vitest";
import {
  aiGroceryPlannerService,
  GroceryPlannerInput,
  TARGET_TOLERANCE,
} from "../src/lib/services/ai-grocery";

type Prefs = GroceryPlannerInput["preferences"];

const prefs = (over: Partial<Prefs> = {}): Prefs => ({
  allergies: [],
  intolerances: [],
  dietaryRestrictions: ["halal"],
  dislikedFoods: [],
  ...over,
});

const input = (over: Partial<GroceryPlannerInput> = {}): GroceryPlannerInput => ({
  userId: "test",
  userContext: { age: 26, gender: "male", height: 172, currentWeight: 68, activityLevel: "moderate" },
  healthGoal: "weight loss",
  durationDays: 7,
  budgetMode: "max",
  budgetLimitBdt: 600,
  foodInspirations: [],
  preferences: prefs(),
  ...over,
});

const within = (actual: number, target: number) => Math.abs(actual - target) / target <= TARGET_TOLERANCE;

describe("planner: targets", () => {
  it("weight loss at 600 BDT meets kcal and protein within ±10% and stays under budget", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(input());
    expect(plan.targetsUnmet).toBeNull();
    expect(within(plan.nutrition.dailyCalories, plan.targetComparison.targetDailyCalories)).toBe(true);
    expect(within(plan.nutrition.dailyProtein, plan.targetComparison.targetDailyProtein)).toBe(true);
    expect(plan.budgetAnalysis.totalActualCostBdt).toBeLessThanOrEqual(600);
    expect(plan.budgetAnalysis.isBudgetExceeded).toBe(false);
  });

  it("returns targetsUnmet with a budget reason when the budget cannot cover the targets", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(input({ budgetLimitBdt: 150 }));
    expect(plan.targetsUnmet).not.toBeNull();
    expect(plan.targetsUnmet!.reason).toMatch(/budget/i);
    expect(plan.budgetAnalysis.totalActualCostBdt).toBeLessThanOrEqual(150);
  });

  it("is deterministic for identical input", async () => {
    const a = await aiGroceryPlannerService.generatePlan(input());
    const b = await aiGroceryPlannerService.generatePlan(input());
    const summary = (r: typeof a) => r.items.map((i) => `${i.foodId}:${i.quantity}`);
    expect(summary(a)).toEqual(summary(b));
  });
});

describe("planner: allergies and diet", () => {
  it("vegan plan contains no animal foods", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(
      input({ preferences: prefs({ dietaryRestrictions: ["vegan"] }) })
    );
    for (const item of plan.items) {
      expect(["protein_fish", "protein_poultry_meat", "eggs_dairy"]).not.toContain(item.category);
    }
  });

  it("fish and egg allergy excludes every fish and egg food from the plan", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(
      input({ preferences: prefs({ allergies: ["fish", "egg"] }) })
    );
    for (const item of plan.items) {
      expect(item.foodId.startsWith("fish_")).toBe(false);
      expect(item.foodId.startsWith("eggs_")).toBe(false);
    }
  });

  it("allergy synonyms such as 'Eggs' and 'Fish' are treated like the canonical tags", () => {
    const foods = aiGroceryPlannerService.filterCatalog(["Eggs", "Fish"], [], ["halal"], []);
    for (const f of foods) {
      expect((f.allergyTags ?? []).includes("egg")).toBe(false);
      expect((f.allergyTags ?? []).includes("fish")).toBe(false);
    }
  });

  it("a 'seafood' allergy excludes both fish and shellfish", () => {
    const foods = aiGroceryPlannerService.filterCatalog(["seafood"], [], ["halal"], []);
    expect(foods.some((f) => f.allergyTags?.includes("fish") || f.allergyTags?.includes("shellfish"))).toBe(false);
  });

  it("pescatarian keeps fish but drops poultry", () => {
    const foods = aiGroceryPlannerService.filterCatalog([], [], ["pescatarian"], []);
    expect(foods.some((f) => f.category === "protein_fish")).toBe(true);
    expect(foods.some((f) => f.category === "protein_poultry_meat")).toBe(false);
  });

  it("disliked foods are never added", () => {
    const foods = aiGroceryPlannerService.filterCatalog([], [], [], ["masoor"]);
    expect(foods.some((f) => f.id === "dal_masoor")).toBe(false);
  });
});

describe("planner: budget and user picks", () => {
  it("keeps a user-selected ingredient at a practical quantity", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(
      input({ budgetLimitBdt: 900, foodInspirations: ["Rui fish curry"] })
    );
    const rui = plan.items.find((i) => i.foodId === "fish_rui_medium");
    expect(rui).toBeDefined();
    expect(rui!.quantity).toBeGreaterThanOrEqual(0.5);
  });

  it("without a budget ceiling the plan still meets targets", async () => {
    const plan = await aiGroceryPlannerService.generatePlan(input({ budgetMode: "none", budgetLimitBdt: undefined }));
    expect(plan.targetsUnmet).toBeNull();
    expect(plan.budgetAnalysis.isBudgetExceeded).toBe(false);
  });
});
