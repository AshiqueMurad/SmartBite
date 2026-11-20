/**
 * Deterministic personalization of a meal against the user's own data: saved targets (or
 * targets calculated from height, weight, age and goal), allergies, intolerances, dislikes and
 * dietary rules. Nothing here is random or model-generated, so the same inputs always give the
 * same warnings.
 */

import { calculateTargets } from "@/lib/nutrition";
import type { ProfilePayload } from "@/lib/profile-payload";
import type { SourcedFood } from "@/lib/services/nutrition-sources";

export interface UserPersonalContext {
  profile: ProfilePayload | null;
  allergies: string[];
  intolerances: string[];
  dietaryRestrictions: string[];
  dislikedFoods: string[];
}

export interface MealFitInput {
  totalCalories: number;
  protein: number;
  sugar: number;
  ingredientNames: string[];
  sourced: SourcedFood[];
}

export interface PersonalizedMealFit {
  targetBasis: "profile" | "no_profile";
  dailyTargets: { kcal: number; protein: number } | null;
  shareOfDailyKcalPct: number | null;
  shareOfDailyProteinPct: number | null;
  sugarSharePct: number | null;
  allergyAlerts: string[];
  intoleranceWarnings: string[];
  dislikeHits: string[];
  dietaryFlags: string[];
  notes: string[];
  dataSources: string[];
}

// Words that link a user's allergen or intolerance to the ingredient names a scan can return.
const ALLERGEN_TERMS: Record<string, string[]> = {
  milk: ["milk", "dairy", "cheese", "butter", "ghee", "curd", "yogurt", "yoghurt", "paneer", "cream", "lassi"],
  lactose: ["milk", "dairy", "cheese", "butter", "ghee", "curd", "yogurt", "yoghurt", "paneer", "cream", "lassi"],
  egg: ["egg", "eggs", "omelette", "omelet", "mayonnaise"],
  fish: ["fish", "rui", "hilsa", "ilish", "katla", "pangas", "tuna", "salmon"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "shellfish", "chingri"],
  peanut: ["peanut", "groundnut"],
  nuts: ["nut", "nuts", "almond", "cashew", "walnut", "pistachio", "hazelnut", "peanut", "badam", "kaju"],
  wheat: ["wheat", "atta", "maida", "gluten", "bread", "pasta", "noodle", "roti", "paratha"],
  gluten: ["wheat", "atta", "maida", "gluten", "bread", "pasta", "noodle", "roti", "paratha"],
  soy: ["soy", "soya", "soybean", "tofu"],
  sesame: ["sesame", "til"],
};

const MEAT_TERMS = ["chicken", "beef", "mutton", "lamb", "pork", "bacon", "ham", "fish", "rui", "hilsa", "shrimp", "prawn", "egg"];
const HALAL_CONCERN_TERMS = ["pork", "bacon", "ham", "lard", "gelatin", "alcohol", "wine", "beer", "rum"];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsWord = (haystack: string, term: string) =>
  new RegExp(`\\b${escapeRegExp(term.toLowerCase())}\\b`).test(haystack);

function pct(part: number, whole: number): number | null {
  if (!whole || whole <= 0 || !Number.isFinite(part)) return null;
  return Math.round((part / whole) * 100);
}

/**
 * Targets come from the user's current profile fields, using the same formula as the dashboard
 * (calculateTargets in lib/nutrition). A client-sent dailyCalories value is ignored: it can be
 * stale after the profile changes.
 */
function resolveTargets(profile: ProfilePayload | null): {
  basis: PersonalizedMealFit["targetBasis"];
  targets: { kcal: number; protein: number } | null;
} {
  if (!profile) return { basis: "no_profile", targets: null };
  const t = calculateTargets({
    gender: profile.gender,
    age: profile.age,
    height: profile.height,
    currentWeight: profile.currentWeight,
    goalWeight: profile.goalWeight,
    activityLevel: profile.activityLevel,
    goal: profile.goal,
  });
  return { basis: "profile", targets: { kcal: t.dailyCalories, protein: t.protein } };
}

export function personalizeMeal(meal: MealFitInput, ctx: UserPersonalContext): PersonalizedMealFit {
  const { basis, targets } = resolveTargets(ctx.profile);
  const notes: string[] = [];

  const shareKcal = targets ? pct(meal.totalCalories, targets.kcal) : null;
  const shareProtein = targets ? pct(meal.protein, targets.protein) : null;
  const sugarKcal = meal.sugar * 4;
  const sugarSharePct = meal.totalCalories > 0 ? pct(sugarKcal, meal.totalCalories) : null;

  if (targets && shareKcal !== null && shareProtein !== null) {
    const source = " (from your profile: height, weight, age, activity and goal)";
    notes.push(
      `This meal is about ${shareKcal}% of your ${targets.kcal} kcal daily target${source} and covers ${shareProtein}% of your ${targets.protein} g protein target.`
    );
    if (shareKcal >= 40) {
      notes.push("This meal is a large share of your day, so keep the rest of your meals lighter.");
    }
    if (shareKcal >= 20 && shareProtein < 15) {
      notes.push("Protein is low for this many calories. Adding dal, eggs, fish or chicken would balance the meal.");
    }
    if (shareProtein >= 25) {
      notes.push("Good protein for a single meal.");
    }
  }

  if (sugarSharePct !== null && sugarSharePct > 10) {
    notes.push(`About ${sugarSharePct}% of this meal's energy comes from sugar, above the WHO guideline of 10% of energy from free sugars.`);
  }

  // Allergy and intolerance checks search the scanned names and the sourced allergen tags.
  const haystacks = [
    ...meal.ingredientNames.map((name) => ({ label: name, text: name.toLowerCase() })),
    ...meal.sourced.map((s) => ({
      label: s.matchedName,
      text: `${s.matchedName} ${s.allergens.join(" ")}`.toLowerCase(),
    })),
  ];

  const findAllergen = (key: string) => {
    const terms = ALLERGEN_TERMS[key.toLowerCase()] ?? [key.toLowerCase()];
    for (const h of haystacks) {
      const term = terms.find((t) => containsWord(h.text, t));
      if (term) return { term, matched: h.label };
    }
    return null;
  };

  const allergyAlerts: string[] = [];
  for (const allergy of ctx.allergies) {
    const hit = findAllergen(allergy);
    if (hit) allergyAlerts.push(`Allergy alert: ${allergy} (matched "${hit.matched}" via "${hit.term}"). Do not eat this meal.`);
  }

  const intoleranceWarnings: string[] = [];
  for (const intolerance of ctx.intolerances) {
    const hit = findAllergen(intolerance);
    if (hit) intoleranceWarnings.push(`Avoid: ${intolerance} intolerance, matched "${hit.matched}" via "${hit.term}".`);
  }

  const dislikeHits: string[] = [];
  for (const dislike of ctx.dislikedFoods) {
    const hit = haystacks.find((h) => containsWord(h.text, dislike));
    if (hit) dislikeHits.push(`${dislike} (in "${hit.label}")`);
  }

  const dietaryFlags: string[] = [];
  const diets = ctx.dietaryRestrictions.map((d) => d.toLowerCase());
  if (diets.includes("halal")) {
    for (const h of haystacks) {
      const term = HALAL_CONCERN_TERMS.find((t) => containsWord(h.text, t));
      if (term) dietaryFlags.push(`Check halal status: "${h.label}" may contain ${term}.`);
    }
  }
  if (diets.includes("vegetarian") || diets.includes("vegan")) {
    for (const h of haystacks) {
      const term = MEAT_TERMS.find((t) => containsWord(h.text, t));
      if (term) dietaryFlags.push(`Not ${diets.includes("vegan") ? "vegan" : "vegetarian"}: "${h.label}" contains ${term}.`);
    }
  }

  const dataSources = [...new Set(meal.sourced.map((s) => s.source))];
  if (dataSources.length) {
    notes.push(`Nutrition for ingredients checked against ${dataSources.join(", ")}.`);
  }

  return {
    targetBasis: basis,
    dailyTargets: targets,
    shareOfDailyKcalPct: shareKcal,
    shareOfDailyProteinPct: shareProtein,
    sugarSharePct,
    allergyAlerts,
    intoleranceWarnings,
    dislikeHits,
    dietaryFlags,
    notes: [...allergyAlerts, ...intoleranceWarnings, ...notes],
    dataSources,
  };
}
