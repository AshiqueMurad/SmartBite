import { normalizeTerm, singularize } from "./ingredient-matcher";
import { calculateUserProfileTargets } from "./nutrition-calc";
import type { UserContext } from "./user-context";

/** Nutrition estimate returned by the CLIP fallback. */
export interface NutritionEstimate {
  mealName: string;
  portionSize: string;
  confidence: number;
  totalCalories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  ingredients: { name: string; quantity: string; calories: number }[];
  insights: string[];
  provider?: string;
}

export interface FoodCatalogEntry {
  keywords: string[];
  name: string;
  quantity: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  /** Allergen or diet tags the dish may contain (e.g. "fish", "egg", "meat", "dairy"). */
  tags?: string[];
}

/**
 * Nutrition reference per typical serving for the CLIP fallback. Keywords are compared after
 * singularization, so "eggs", "potatoes" and "tomatoes" match their singular entries.
 */
export const NUTRITION_DB: FoodCatalogEntry[] = [
  { keywords: ["chicken breast", "roasted chicken", "grilled chicken", "chicken"], name: "Roasted / Grilled Chicken", quantity: "150g", calories: 245, protein: 38, carbs: 0, fat: 10, fiber: 0, sugar: 0, tags: ["meat"] },
  { keywords: ["beef", "steak", "meat"], name: "Cooked Beef / Steak", quantity: "150g", calories: 310, protein: 34, carbs: 0, fat: 19, fiber: 0, sugar: 0, tags: ["meat"] },
  { keywords: ["fish", "salmon", "tuna", "rui", "rohu"], name: "Fish Fillet / Curry", quantity: "150g", calories: 220, protein: 32, carbs: 2, fat: 9, fiber: 0, sugar: 0, tags: ["fish", "meat"] },
  { keywords: ["shrimp", "prawn"], name: "Cooked Prawns / Shrimp", quantity: "120g", calories: 140, protein: 26, carbs: 1, fat: 3, fiber: 0, sugar: 0, tags: ["shellfish", "meat"] },
  { keywords: ["egg", "boiled egg"], name: "Hard-Boiled / Cooked Eggs", quantity: "2 large (100g)", calories: 145, protein: 13, carbs: 1, fat: 10, fiber: 0, sugar: 1, tags: ["egg"] },
  { keywords: ["tofu", "paneer"], name: "Grilled Tofu / Paneer", quantity: "100g", calories: 120, protein: 12, carbs: 3, fat: 7, fiber: 1, sugar: 1, tags: ["soy", "dairy"] },
  { keywords: ["yogurt", "curd", "yoghurt"], name: "Plain Yogurt / Curd", quantity: "150g", calories: 90, protein: 9, carbs: 6, fat: 4, fiber: 0, sugar: 6, tags: ["dairy"] },
  { keywords: ["cheese"], name: "Cheese", quantity: "30g", calories: 110, protein: 7, carbs: 0, fat: 9, fiber: 0, sugar: 0, tags: ["dairy"] },
  { keywords: ["soup", "creamy orange soup", "pumpkin soup"], name: "Creamy Pumpkin / Vegetable Soup", quantity: "1 bowl (240ml)", calories: 165, protein: 4, carbs: 22, fat: 7, fiber: 4, sugar: 6 },
  { keywords: ["potato", "roasted potato", "sweet potato"], name: "Roasted Potatoes", quantity: "150g", calories: 160, protein: 3, carbs: 32, fat: 3, fiber: 4, sugar: 2 },
  { keywords: ["roasted vegetable", "mixed vegetable", "vegetable"], name: "Roasted Mixed Vegetables", quantity: "1 cup (140g)", calories: 95, protein: 3, carbs: 14, fat: 3, fiber: 5, sugar: 4 },
  { keywords: ["rice", "basmati", "biryani", "pulao"], name: "Steamed Rice", quantity: "1.5 cups (220g)", calories: 280, protein: 6, carbs: 62, fat: 1, fiber: 1, sugar: 0 },
  { keywords: ["paratha", "roti", "chapati", "naan", "bread", "toast", "flatbread"], name: "Artisan Bread / Flatbread", quantity: "2 slices (80g)", calories: 190, protein: 6, carbs: 36, fat: 2, fiber: 3, sugar: 2, tags: ["gluten"] },
  { keywords: ["dal", "daal", "lentil"], name: "Spiced Lentil Dal", quantity: "1 cup (180g)", calories: 150, protein: 10, carbs: 24, fat: 2, fiber: 6, sugar: 2 },
  { keywords: ["chickpea", "chana", "chhola"], name: "Chickpeas", quantity: "1 cup (165g)", calories: 270, protein: 15, carbs: 45, fat: 4, fiber: 13, sugar: 8 },
  { keywords: ["lettuce", "greens", "spinach", "kale"], name: "Fresh Leafy Greens", quantity: "60g", calories: 15, protein: 1, carbs: 3, fat: 0, fiber: 2, sugar: 1 },
  { keywords: ["cherry tomato", "tomato"], name: "Fresh Tomatoes", quantity: "75g", calories: 18, protein: 1, carbs: 4, fat: 0, fiber: 1, sugar: 3 },
  { keywords: ["cabbage", "red cabbage"], name: "Shredded Red Cabbage", quantity: "50g", calories: 16, protein: 1, carbs: 4, fat: 0, fiber: 1, sugar: 2 },
  { keywords: ["corn", "sweet corn", "corn kernel"], name: "Sweet Corn Kernels", quantity: "60g", calories: 65, protein: 2, carbs: 14, fat: 1, fiber: 2, sugar: 3 },
  { keywords: ["cucumber"], name: "Sliced Cucumber", quantity: "80g", calories: 14, protein: 1, carbs: 3, fat: 0, fiber: 1, sugar: 1 },
  { keywords: ["carrot"], name: "Sliced Carrots", quantity: "1 cup (128g)", calories: 52, protein: 1, carbs: 12, fat: 0, fiber: 4, sugar: 6 },
  { keywords: ["broccoli", "cauliflower"], name: "Broccoli / Cauliflower", quantity: "1 cup (150g)", calories: 40, protein: 3, carbs: 8, fat: 0, fiber: 3, sugar: 2 },
  { keywords: ["mushroom"], name: "Mushrooms", quantity: "1 cup (70g)", calories: 15, protein: 2, carbs: 2, fat: 0, fiber: 1, sugar: 1 },
  { keywords: ["bean", "edamame"], name: "Green Beans / Edamame", quantity: "1 cup (130g)", calories: 120, protein: 9, carbs: 12, fat: 4, fiber: 6, sugar: 2 },
  { keywords: ["pepper", "capsicum", "bell pepper"], name: "Bell Pepper", quantity: "1 medium (120g)", calories: 31, protein: 1, carbs: 6, fat: 0, fiber: 2, sugar: 4 },
  { keywords: ["gourd", "bottle gourd", "lau"], name: "Bottle Gourd (Lau)", quantity: "1 cup (120g)", calories: 18, protein: 1, carbs: 4, fat: 0, fiber: 1, sugar: 2 },
  { keywords: ["pumpkin seed", "seed"], name: "Toasted Pumpkin Seeds", quantity: "15g", calories: 85, protein: 4, carbs: 2, fat: 7, fiber: 1, sugar: 0, tags: ["nuts"] },
  { keywords: ["tomato sauce", "sauce", "gravy"], name: "Herb Tomato Sauce", quantity: "50g", calories: 35, protein: 1, carbs: 6, fat: 1, fiber: 1, sugar: 4 },
  { keywords: ["wine", "red wine"], name: "Red Wine", quantity: "1 glass (150ml)", calories: 125, protein: 0, carbs: 4, fat: 0, fiber: 0, sugar: 1 },
  { keywords: ["pasta", "noodle", "spaghetti"], name: "Cooked Pasta", quantity: "180g", calories: 280, protein: 10, carbs: 54, fat: 2, fiber: 3, sugar: 2, tags: ["gluten"] },
  { keywords: ["pizza"], name: "Pizza Slices", quantity: "2 slices (200g)", calories: 540, protein: 22, carbs: 60, fat: 24, fiber: 4, sugar: 6, tags: ["gluten", "dairy"] },
  { keywords: ["burger", "sandwich"], name: "Burger / Sandwich", quantity: "1 serving (220g)", calories: 480, protein: 24, carbs: 44, fat: 22, fiber: 3, sugar: 6, tags: ["gluten", "meat"] },
  { keywords: ["banana"], name: "Ripe Banana", quantity: "1 medium (118g)", calories: 105, protein: 1, carbs: 27, fat: 0, fiber: 3, sugar: 14 },
  { keywords: ["apple"], name: "Fresh Apple", quantity: "1 medium (180g)", calories: 95, protein: 0, carbs: 25, fat: 0, fiber: 4, sugar: 19 },
  { keywords: ["orange"], name: "Orange", quantity: "1 medium (131g)", calories: 62, protein: 1, carbs: 15, fat: 0, fiber: 3, sugar: 12 },
  { keywords: ["mango"], name: "Mango", quantity: "1 cup (165g)", calories: 99, protein: 1, carbs: 25, fat: 1, fiber: 3, sugar: 23 },
  { keywords: ["watermelon"], name: "Watermelon", quantity: "1 cup (152g)", calories: 46, protein: 1, carbs: 12, fat: 0, fiber: 1, sugar: 9 },
  { keywords: ["grape"], name: "Grapes", quantity: "1 cup (151g)", calories: 104, protein: 1, carbs: 27, fat: 0, fiber: 1, sugar: 23 },
  { keywords: ["avocado"], name: "Sliced Avocado", quantity: "80g", calories: 130, protein: 2, carbs: 7, fat: 12, fiber: 5, sugar: 1 },
  { keywords: ["nut", "almond", "cashew", "walnut", "peanut"], name: "Mixed Nuts", quantity: "30g", calories: 185, protein: 5, carbs: 6, fat: 16, fiber: 2, sugar: 1, tags: ["nuts"] },
  { keywords: ["oatmeal", "oat", "porridge"], name: "Cooked Oatmeal", quantity: "1 cup (234g)", calories: 166, protein: 6, carbs: 28, fat: 4, fiber: 4, sugar: 1 },
  { keywords: ["onion", "garlic"], name: "Onion / Garlic (cooking base)", quantity: "1 medium onion (110g)", calories: 44, protein: 1, carbs: 10, fat: 0, fiber: 2, sugar: 5 },
];

/** Allergy and intolerance names mapped to the tags used above. */
const TAG_ALIASES: Record<string, string> = {
  eggs: "egg", shrimp: "shellfish", prawn: "shellfish", prawns: "shellfish", crab: "shellfish",
  milk: "dairy", lactose: "dairy", wheat: "gluten", soya: "soy", nut: "nuts", peanut: "nuts",
};

/** Foods each diet rules out, by tag. */
const DIET_EXCLUDES: Record<string, string[]> = {
  vegan: ["meat", "fish", "shellfish", "egg", "dairy"],
  vegetarian: ["meat", "fish", "shellfish"],
  pescatarian: ["meat"],
  pescetarian: ["meat"],
};

export function tagOf(raw: string): string {
  const key = normalizeTerm(raw).split(" ").map(singularize).join(" ");
  return TAG_ALIASES[key] ?? key;
}

/** Caption or label text reduced to singular whole words, padded so phrase checks match whole words. */
export function canonicalText(text: string): string {
  return ` ${normalizeTerm(text).split(" ").filter(Boolean).map(singularize).join(" ")} `;
}

export function entriesFor(text: string): FoodCatalogEntry[] {
  const canon = canonicalText(text);
  return NUTRITION_DB.filter((entry) =>
    entry.keywords.some((kw) => canon.includes(canonicalText(kw)))
  );
}

/**
 * Confidence for the CLIP fallback. Built from the similarity of each detected label and the
 * share of labels that have a nutrition entry. This is a heuristic, not a calibrated probability.
 * Returns a low value when nothing matched.
 */
export function clipConfidence(detected: DetectedLabel[], matchedLabels: number): number {
  if (!detected.length || matchedLabels === 0) return 0.2;
  // Caption-only input has no CLIP scores, so confidence then rests on label coverage alone.
  const scored = detected.filter((d): d is DetectedLabel & { score: number } => typeof d.score === "number");
  const meanScore = scored.length ? scored.reduce((sum, d) => sum + d.score, 0) / scored.length : 0.3;
  const visual = Math.min(1, Math.max(0, (meanScore - 0.2) / 0.1));
  const coverage = matchedLabels / detected.length;
  const value = 0.1 + 0.8 * visual * coverage;
  return Math.round(Math.min(0.9, Math.max(0.1, value)) * 100) / 100;
}

/**
 * Step 2B (deterministic fallback on the CLIP labels): builds the nutrition breakdown from the
 * detected foods, with confidence from the match strength and the user's own allergies, diet
 * and calorie or protein target applied.
 */
/** A detected food label. `score` is the CLIP similarity, absent when the input is a text caption. */
export interface DetectedLabel {
  label: string;
  score?: number;
}

/** Splits a free-text caption into food phrases for the same nutrition lookup used for CLIP labels. */
export function captionToLabels(caption: string): DetectedLabel[] {
  return caption
    .split(/,|;| and | with /i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((label) => ({ label }));
}

export function buildNutritionFromCaption(detected: DetectedLabel[], ctx: UserContext): NutritionEstimate {
  const matchedEntries: FoodCatalogEntry[] = [];
  let matchedLabels = 0;
  for (const d of detected) {
    const found = entriesFor(d.label);
    if (found.length) matchedLabels++;
    for (const entry of found) if (!matchedEntries.includes(entry)) matchedEntries.push(entry);
  }
  // Labels with no nutrition entry are still listed, so the user sees what the photo showed.
  const unmatchedLabels = detected.filter((d) => entriesFor(d.label).length === 0).map((d) => d.label);

  if (matchedEntries.length === 0) {
    matchedEntries.push({
      keywords: ["meal"],
      name: "Detected Dish",
      quantity: "1 serving (300g)",
      calories: 380,
      protein: 18,
      carbs: 42,
      fat: 14,
      fiber: 5,
      sugar: 5,
    });
  }

  const totalCalories = matchedEntries.reduce((s, e) => s + e.calories, 0);
  const protein = matchedEntries.reduce((s, e) => s + e.protein, 0);
  const carbs = matchedEntries.reduce((s, e) => s + e.carbs, 0);
  const fat = matchedEntries.reduce((s, e) => s + e.fat, 0);
  const fiber = matchedEntries.reduce((s, e) => s + e.fiber, 0);
  const sugar = matchedEntries.reduce((s, e) => s + e.sugar, 0);

  const topNames = matchedEntries.slice(0, 3).map((e) => e.name.replace(/^(Roasted \/ Grilled |Cooked |Fresh |Hard-Boiled \/ )/, ""));
  const mealName =
    topNames.length === 1
      ? topNames[0]
      : topNames.length === 2
      ? `${topNames[0]} & ${topNames[1]}`
      : `${topNames[0]}, ${topNames[1]} & ${topNames[2]}`;

  const insights: string[] = [];
  insights.push(`Suggested ingredients: ${detected.map((d) => d.label).join(", ") || "none"}`);
  if (unmatchedLabels.length) {
    insights.push(`No nutrition reference for: ${unmatchedLabels.join(", ")}. Those items are not included in the totals.`);
  }

  // Allergy, intolerance and diet conflicts with the detected foods.
  const userTags = new Set([...ctx.allergies, ...ctx.intolerances].map(tagOf));
  const dietRules = ctx.dietaryRestrictions.map((d) => d.toLowerCase().trim());
  const dietExcluded = new Set<string>();
  for (const diet of dietRules) for (const tag of DIET_EXCLUDES[diet] ?? []) dietExcluded.add(tag);
  for (const entry of matchedEntries) {
    for (const tag of entry.tags ?? []) {
      if (userTags.has(tag)) insights.push(`Warning: ${entry.name} may contain ${tag}, which is on your allergy or intolerance list.`);
      else if (dietExcluded.has(tag)) insights.push(`Warning: ${entry.name} may contain ${tag}, which does not fit your diet (${dietRules.join(", ")}).`);
    }
  }

  // Goal check against the user's daily calorie and protein targets.
  const p = ctx.profile;
  if (p) {
    const dailyKcal = p.dailyCalories ?? calculateUserProfileTargets({
      gender: p.gender, age: p.age, height: p.height, currentWeight: p.currentWeight,
      activityLevel: p.activityLevel, goalType: p.goal,
    }).targetCalories;
    const perMeal = dailyKcal / 3;
    if ((p.goal === "lose" || p.goal === "maintain") && totalCalories > perMeal * 1.25) {
      insights.push(`About ${Math.round(totalCalories)} kcal, above a third of your ${Math.round(dailyKcal)} kcal daily target.`);
    }
    if ((p.goal === "muscle" || p.goal === "gain") && protein < 20) {
      insights.push(`About ${Math.round(protein)} g protein, which is low for your goal. Add eggs, fish, chicken or dal.`);
    }
  }
  if (protein >= 25) insights.push(`High in protein (${Math.round(protein)}g), supporting muscle maintenance and satiety.`);
  if (fiber >= 5) insights.push(`Good dietary fiber content (${Math.round(fiber)}g) from the detected vegetables and plant ingredients.`);
  if (matchedEntries.length === 1 && matchedEntries[0].name === "Detected Dish") {
    insights.push("No nutrition reference matched the photo, so the values below are a generic estimate.");
  } else if (insights.length < 3) {
    insights.push("Nutrition is an estimate based on reference portions.");
  }

  return {
    mealName,
    portionSize: matchedEntries.length > 3 ? "Multi-dish spread (~550g)" : "1 serving (~350g)",
    confidence: clipConfidence(detected, matchedLabels),
    totalCalories,
    protein,
    carbs,
    fat,
    fiber,
    sugar,
    ingredients: matchedEntries.map((e) => ({
      name: e.name,
      quantity: e.quantity,
      calories: e.calories,
    })),
    insights,
    provider: "florence2-vision",
  };
}
