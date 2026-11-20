import {
  BANGLADESH_FOOD_CATALOG,
  FoodItemDefinition,
  GroceryCategory,
} from "./bangladesh-food-db";
import { CleanGroceryItem, quoteBestPrice } from "./pricing-engine";
import { calculateBasketNutrition, calculateUserProfileTargets, BasketMacroSummary } from "./nutrition-calc";
import { BasketLine, OptimizerConstraints, optimizeBasketMultiStart } from "./basket-optimizer";
import type { StockStatus } from "./stock-check";
import { resolveIngredient } from "./ingredient-matcher";

/** Daily kcal and protein must land within this relative band of the target. */
export const TARGET_TOLERANCE = 0.1;

export interface TargetsUnmet {
  reason: string;
  reasonBn: string;
  achievedDailyCalories: number;
  achievedDailyProtein: number;
  targetDailyCalories: number;
  targetDailyProtein: number;
}

export interface GroceryPlannerInput {
  userId?: string;
  userContext: {
    age?: number;
    gender?: string;
    height?: number; // cm
    currentWeight?: number; // kg
    activityLevel?: string;
  };
  healthGoal: string;
  durationDays: number;
  budgetMode: "max" | "cheapest" | "none";
  budgetLimitBdt?: number;
  foodInspirations?: string[]; // e.g. ["Grilled chicken", "Rui fish curry", "Lentil soup"]
  /** Live stock status by food id. Out-of-stock foods are never chosen; unknown foods stay allowed. */
  stockByFoodId?: Record<string, StockStatus>;
  preferences: {
    allergies: string[]; // ["shellfish", "fish", "egg", "dairy", "gluten"]
    intolerances: string[]; // ["lactose"]
    dietaryRestrictions: string[]; // ["halal", "vegetarian", "vegan"]
    dislikedFoods: string[]; // ["begun", "eggplant", "okra"]
  };
}

/** Why a scanned or typed item could not be used in the plan. */
export type InspirationIssue = "prepared_dish" | "not_in_catalog" | "filtered_by_preferences" | "out_of_stock";

export interface UnmatchedInspiration {
  name: string;
  reason: InspirationIssue;
}

export interface GroceryPlanResult {
  context?: { tip: string; offers: {name: string; url: string; stock: StockStatus; checkedAt: string}[] };
  items: CleanGroceryItem[];
  nutrition: BasketMacroSummary;
  targetComparison: {
    targetDailyCalories: number;
    targetDailyProtein: number;
    targetDailyCarbs: number;
    targetDailyFat: number;
  };
  budgetAnalysis: {
    budgetMode: "max" | "cheapest" | "none";
    budgetLimitBdt?: number;
    totalActualCostBdt: number;
    remainingBudgetBdt?: number;
    isBudgetExceeded: boolean;
    compromisesMade?: string;
    suggestedRealisticBudgetBdt?: number;
  };
  /** Null when both daily targets are within tolerance and the budget is respected. */
  targetsUnmet: TargetsUnmet | null;
  /** Scanned or typed items the plan could not use, each with its reason. Never guessed. */
  unmatchedInspirations: UnmatchedInspiration[];
  /** Catalog foods left out of the plan because the retailer reports them out of stock. */
  stockExcluded: { foodId: string; genericName: string }[];
  disclaimer: string;
  disclaimerBn: string;
  generatedAt: string;
}

const MEDICAL_DISCLAIMER_EN =
  "Medical & Nutritional Disclaimer: This grocery plan is generated for educational and nutritional planning purposes only. It does not constitute medical diagnosis, clinical prescription, or dietary treatment. Individuals with chronic medical conditions (such as diabetes, renal disease, hypertension, or food allergies) should consult a licensed physician or registered dietitian before making drastic dietary changes.";

const MEDICAL_DISCLAIMER_BN =
  "চিকিৎসা ও পুষ্টি বিষয়ক সতর্কবার্তা: এই বাজার তালিকাটি শুধুমাত্র পুষ্টি সচেতনতা এবং খাদ্য পরিকল্পনার উদ্দেশ্যে তৈরি করা হয়েছে। এটি কোন চিকিৎসা পরামর্শ বা প্রেসক্রিপশন নয়। দীর্ঘস্থায়ী শারীরিক সমস্যা (যেমন ডায়াবেটিস, কিডনির রোগ, উচ্চ রক্তচাপ বা অ্যালার্জি) থাকলে খাদ্যাভ্যাস পরিবর্তনের পূর্বে অবশ্যই নিবন্ধিত চিকিৎসকের পরামর্শ নিন।";

/** Common allergen, intolerance and synonym terms mapped to catalog allergyTags. */
const ALLERGEN_ALIASES: Record<string, string[]> = {
  egg: ["egg"],
  eggs: ["egg"],
  fish: ["fish"],
  shellfish: ["shellfish"],
  shrimp: ["shellfish"],
  prawn: ["shellfish"],
  prawns: ["shellfish"],
  crab: ["shellfish"],
  seafood: ["fish", "shellfish"],
  dairy: ["dairy"],
  milk: ["dairy"],
  lactose: ["dairy"],
  gluten: ["gluten"],
  wheat: ["gluten"],
  soy: ["soy"],
  soya: ["soy"],
  nut: ["nuts"],
  nuts: ["nuts"],
};

function expandAllergenTags(raw: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of raw) {
    const key = value.toLowerCase().trim();
    if (!key) continue;
    out.add(key);
    for (const tag of ALLERGEN_ALIASES[key] ?? []) out.add(tag);
  }
  return out;
}

function normalizeDiet(raw: string[]) {
  const values = raw.map((v) => v.toLowerCase().trim());
  const vegan = values.some((v) => v === "vegan" || v === "plant-based" || v === "plant based");
  const vegetarian = vegan || values.some((v) => v === "vegetarian" || v === "veg");
  const pescatarian = values.some((v) => v === "pescatarian" || v === "pescetarian");
  return { vegan, vegetarian, pescatarian };
}

const VEGAN_EXCLUDED_CATEGORIES = new Set<GroceryCategory>(["protein_fish", "protein_poultry_meat", "eggs_dairy"]);
const VEGETARIAN_EXCLUDED_CATEGORIES = new Set<GroceryCategory>(["protein_fish", "protein_poultry_meat"]);
const PESCATARIAN_EXCLUDED_CATEGORIES = new Set<GroceryCategory>(["protein_poultry_meat"]);

/** Groups a sensible basket should cover; only groups the filtered pool can supply are enforced. */
function buildCoreGroups(pool: FoodItemDefinition[]): Set<string>[] {
  const idsWhere = (pred: (f: FoodItemDefinition) => boolean) =>
    new Set(pool.filter(pred).map((f) => f.id));
  const groups = [
    idsWhere((f) => f.category === "grains"),
    idsWhere(
      (f) =>
        f.category === "protein_fish" ||
        f.category === "protein_poultry_meat" ||
        f.category === "lentils_legumes" ||
        f.id.startsWith("eggs_")
    ),
    idsWhere((f) => f.category === "vegetables"),
    idsWhere((f) => f.category === "fruits"),
  ];
  return groups.filter((g) => g.size > 0);
}

function withinTolerance(actual: number, target: number): boolean {
  return Math.abs(actual - target) / target <= TARGET_TOLERANCE;
}

export interface TargetsEvaluationInput {
  dailyCalories: number;
  dailyProtein: number;
  totalCostBdt: number;
  targetCalories: number;
  targetProtein: number;
  /** Undefined when no budget ceiling applies. */
  budgetLimitBdt?: number;
  /** Protein-rich foods left after filtering; used only to explain a protein shortfall. */
  proteinFoodCount?: number;
}

/**
 * Explains which daily targets a basket misses and why. Returns null when kcal and
 * protein are within tolerance and the budget holds. Pure, so the UI can re-check a
 * basket after the user edits it.
 */
export function evaluateTargetsUnmet(input: TargetsEvaluationInput): TargetsUnmet | null {
  const kcalOk = withinTolerance(input.dailyCalories, input.targetCalories);
  const proteinOk = withinTolerance(input.dailyProtein, input.targetProtein);
  const overBudget = input.budgetLimitBdt !== undefined && input.totalCostBdt > input.budgetLimitBdt;
  if (kcalOk && proteinOk && !overBudget) return null;

  const en: string[] = [];
  const bn: string[] = [];
  const kcal = Math.round(input.dailyCalories);
  const protein = Math.round(input.dailyProtein);

  if (overBudget && input.budgetLimitBdt !== undefined) {
    const cost = Math.round(input.totalCostBdt);
    en.push(`The cheapest basket that respects your allergy, diet and dislike rules costs ৳${cost}, above your ৳${input.budgetLimitBdt} budget.`);
    bn.push(`আপনার অ্যালার্জি, খাদ্যাভ্যাস ও অপছন্দের শর্ত মেনে সবচেয়ে সস্তা তালিকার দাম ৳${cost}, যা আপনার ৳${input.budgetLimitBdt} বাজেটের বেশি।`);
  }
  if (!kcalOk) {
    en.push(`Daily energy is ${kcal} kcal, outside ±10% of your ${input.targetCalories} kcal target.`);
    bn.push(`দৈনিক শক্তি ${kcal} kcal, যা আপনার ${input.targetCalories} kcal লক্ষ্যের ±১০% সীমার বাইরে।`);
  }
  if (!proteinOk) {
    en.push(`Daily protein is ${protein} g, outside ±10% of your ${input.targetProtein} g target.`);
    bn.push(`দৈনিক প্রোটিন ${protein} g, যা আপনার ${input.targetProtein} g লক্ষ্যের ±১০% সীমার বাইরে।`);
    if (input.proteinFoodCount !== undefined && input.proteinFoodCount <= 4) {
      en.push(`Only ${input.proteinFoodCount} protein-rich foods remain after your allergy, diet and dislike filters.`);
      bn.push(`আপনার অ্যালার্জি, খাদ্যাভ্যাস ও অপছন্দের ফিল্টারের পর মাত্র ${input.proteinFoodCount}টি প্রোটিন-সমৃদ্ধ খাবার অবশিষ্ট আছে।`);
    }
  }
  if (input.budgetLimitBdt !== undefined && !overBudget && input.totalCostBdt >= input.budgetLimitBdt * 0.95) {
    en.push("Your budget is the limiting factor.");
    bn.push("আপনার বাজেটই এখানে সীমাবদ্ধতা।");
  }

  return {
    reason: en.join(" "),
    reasonBn: bn.join(" "),
    achievedDailyCalories: kcal,
    achievedDailyProtein: protein,
    targetDailyCalories: input.targetCalories,
    targetDailyProtein: input.targetProtein,
  };
}

export class AIGroceryPlannerService {
  /**
   * Filters the food catalog based on strict allergy hard exclusions,
   * dietary restrictions, and disliked foods.
   */
  filterCatalog(
    allergies: string[] = [],
    intolerances: string[] = [],
    dietaryRestrictions: string[] = [],
    dislikedFoods: string[] = []
  ): FoodItemDefinition[] {
    const excludedTags = expandAllergenTags([...allergies, ...intolerances]);
    const diet = normalizeDiet(dietaryRestrictions);
    const normDislikes = dislikedFoods.map((f) => f.toLowerCase().trim()).filter(Boolean);

    return BANGLADESH_FOOD_CATALOG.filter((food) => {
      // 1. Allergen and intolerance exclusions (aliases such as "eggs" or "shrimp" are expanded)
      if (food.allergyTags?.some((tag) => excludedTags.has(tag.toLowerCase()))) return false;

      // 2. Dietary restrictions
      if (diet.vegan && VEGAN_EXCLUDED_CATEGORIES.has(food.category)) return false;
      if (diet.vegetarian && VEGETARIAN_EXCLUDED_CATEGORIES.has(food.category)) return false;
      if (diet.pescatarian && PESCATARIAN_EXCLUDED_CATEGORIES.has(food.category)) return false;

      // 3. Disliked foods
      for (const dislike of normDislikes) {
        if (
          food.id.toLowerCase().includes(dislike) ||
          food.genericName.toLowerCase().includes(dislike) ||
          food.genericNameBn.toLowerCase().includes(dislike)
        ) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Generates a fully reasoned, personalized Bangladeshi grocery plan.
   */
  async generatePlan(input: GroceryPlannerInput): Promise<GroceryPlanResult> {
    const days = Math.max(1, input.durationDays || 7);
    const catalogFoods = this.filterCatalog(
      input.preferences.allergies,
      input.preferences.intolerances,
      input.preferences.dietaryRestrictions,
      input.preferences.dislikedFoods
    );
    const stockMap = input.stockByFoodId ?? {};
    const stockExcluded = catalogFoods
      .filter((f) => stockMap[f.id] === "Out of stock")
      .map((f) => ({ foodId: f.id, genericName: f.genericName }));
    const outOfStockIds = new Set(stockExcluded.map((s) => s.foodId));
    const availableFoods = catalogFoods.filter((f) => !outOfStockIds.has(f.id));

    const goal = (input.healthGoal || "").toLowerCase();
    const isWeightLoss =
      goal.includes("loss") || goal.includes("fat") || goal.includes("cut") || goal.includes("slim");
    const isMuscleGain =
      goal.includes("muscle") || goal.includes("gain") || goal.includes("bulk") || goal.includes("bodybuilding");
    const isDiabetes =
      goal.includes("diabet") || goal.includes("sugar") || goal.includes("glucose");
    const isHypertension =
      goal.includes("bp") || goal.includes("pressure") || goal.includes("heart") || goal.includes("sodium");

    const targets = calculateUserProfileTargets({
      ...input.userContext,
      goalType: input.healthGoal,
    });

    // Determine basket staples based on health goal, inspiration, and available catalog
    const plannedItems: {
      food: FoodItemDefinition;
      quantity: number;
      locked: boolean; // true when the user chose this food explicitly
      reasonEn: string;
      reasonBn: string;
      explanationEn: string;
      explanationBn: string;
    }[] = [];

    const getFood = (id: string) => availableFoods.find((f) => f.id === id);

    // Track food IDs already included
    const includedFoodIds = new Set<string>();

    const hasUserInspirations = Array.isArray(input.foodInspirations) && input.foodInspirations.length > 0;

    // 0. Scanned or typed inspirations. Each must resolve to a catalog food by whole word.
    //    Anything that cannot be used is reported in unmatchedInspirations, never guessed.
    const unmatchedInspirations: UnmatchedInspiration[] = [];
    if (hasUserInspirations) {
      for (const rawInspiration of input.foodInspirations!) {
        if (!rawInspiration || typeof rawInspiration !== "string") continue;
        const resolution = resolveIngredient(rawInspiration);
        if (!resolution.food) {
          unmatchedInspirations.push({ name: rawInspiration, reason: resolution.reason });
          continue;
        }
        const food = resolution.food;
        if (outOfStockIds.has(food.id)) {
          unmatchedInspirations.push({ name: rawInspiration, reason: "out_of_stock" });
          continue;
        }
        const match = availableFoods.find((f) => f.id === food.id);
        if (!match) {
          unmatchedInspirations.push({ name: rawInspiration, reason: "filtered_by_preferences" });
          continue;
        }
        if (includedFoodIds.has(match.id)) continue;

        includedFoodIds.add(match.id);
        const defaultQty =
          match.standardUnit === "pcs"
            ? Math.max(2, Math.round(days * 0.8))
            : match.standardUnit === "bunch"
            ? Math.max(1, Math.round(days * 0.3))
            : Math.max(0.5, Math.round(days * 0.15 * 10) / 10);

        plannedItems.push({
          food: match,
          quantity: defaultQty,
          locked: true,
          reasonEn: "From your selected ingredients: " + rawInspiration,
          reasonBn: "আপনার নির্বাচিত উপকরণ: " + match.genericNameBn,
          explanationEn: "Selected using an estimated local price.",
          explanationBn: "আনুমানিক স্থানীয় দামের ভিত্তিতে নির্বাচিত।",
        });
      }
    }

    const addStapleIfNotPresent = (
      food: FoodItemDefinition | undefined,
      quantity: number,
      reasonEn: string,
      reasonBn: string,
      explanationEn: string,
      explanationBn: string
    ) => {
      if (!food || includedFoodIds.has(food.id)) return;
      includedFoodIds.add(food.id);
      plannedItems.push({
        food,
        quantity,
        locked: false,
        reasonEn,
        reasonBn,
        explanationEn,
        explanationBn,
      });
    };

      // 1. Grains & Carbs
      if (isDiabetes) {
      const redRice = getFood("rice_red_coarse") || getFood("atta_whole_wheat");
      if (redRice) {
        const qty = Math.max(1, Math.round(days * 0.2)); // ~200g/day
        addStapleIfNotPresent(
          redRice,
          qty,
          "Low-glycemic complex carbohydrates for glycemic control",
          "রক্তের শর্করার মাত্রা নিয়ন্ত্রণে লো-গ্লাইসেমিক শস্য",
          `Whole grain rice/wheat prevents rapid insulin spikes while meeting your daily ${days}-day energy baseline.`,
          `লাল চাল বা আটা রক্তে শর্করার দ্রুত বৃদ্ধি রোধ করে এবং দীর্ঘস্থায়ী শক্তি যোগায়।`
        );
      }
    } else {
      const rice = getFood("rice_miniket") || getFood("rice_nazirshail") || availableFoods.find((f) => f.category === "grains");
      if (rice) {
        const qty = Math.max(1, Math.round(days * (isWeightLoss ? 0.2 : 0.3)));
        addStapleIfNotPresent(
          rice,
          qty,
          "Primary staple clean carbohydrate source",
          "দৈনন্দিন শক্তির প্রধান শর্করা উপাদান",
          `Provides essential complex carbohydrates sized to fuel your metabolic rate without excess fat storage.`,
          `আপনার দৈনিক ক্যালরি চাহিদা অনুযায়ী পরিমিত ভাত যা অতিরিক্ত চর্বি তৈরি না করে শক্তি দেয়।`
        );
      }
      if (isMuscleGain) {
        const oats = getFood("oats_rolled");
        if (oats) {
          addStapleIfNotPresent(
            oats,
            Math.max(1, Math.round(days * 0.08)),
            "Slow-digesting carbohydrate and soluble fiber",
            "ধীরে হজম হওয়া শর্করা ও ফাইবার",
            "Supports muscle glycogen synthesis and prolonged energy during workouts.",
            "ব্যায়ামের সময় টেকসই শক্তি ও পেশি বৃদ্ধিতে সহায়তা করে।"
          );
        }
      }
    }

    // 2. High-Protein Core (Fish, Poultry, Eggs, Lentils)
    const eggs = getFood("eggs_farm_dozen");
    if (eggs) {
      const eggsCount = isMuscleGain ? Math.round(days * 3) : Math.round(days * 1.5);
      addStapleIfNotPresent(
        eggs,
        Math.max(4, eggsCount),
        "Complete bioavailable protein and essential choline",
        "সম্পূর্ণ প্রোটিন ও কোলিনের আদর্শ উৎস",
        `Eggs supply high biological value protein to meet your target of ${targets.targetProtein}g daily.`,
        `ডিম সহজে হজমযোগ্য প্রোটিন সরবরাহ করে যা কোষ মেরামত ও পেশি গঠনে ভূমিকা রাখে।`
      );
    }

    // Lean poultry or fish
    const chicken = getFood("chicken_broiler") || getFood("chicken_sonali");
    if (chicken && !isHypertension) {
      const qty = Math.max(1, Math.round(days * (isMuscleGain ? 0.35 : 0.2)));
      addStapleIfNotPresent(
        chicken,
        qty,
        "Lean animal protein for muscle repair and satiety",
        "পেশি গঠন এবং দীর্ঘক্ষণ পেট ভরা রাখার জন্য লিন প্রোটিন",
        `Provides dense essential amino acids with low saturated fat to support tissue synthesis.`,
        `অল্প চর্বিযুক্ত মুরগির মাংস শরীরের প্রয়োজনীয় অ্যামিনো এসিডের ঘাটতি পূরণ করে।`
      );
    }

    const fish = getFood("fish_rui_medium") || getFood("fish_tilapia") || getFood("fish_pangas");
    if (fish) {
      const qty = Math.max(1, Math.round(days * 0.25));
      addStapleIfNotPresent(
        fish,
        qty,
        "Freshwater fish providing omega-3 fatty acids",
        "ওমেগা-৩ ফ্যাটি এসিড সমৃদ্ধ তাজা মাছ",
        "Heart-healthy unsaturated fats and lean protein support cardiovascular vitality.",
        "হৃদযন্ত্র সুস্থ রাখতে এবং প্রোটিন সরবরাহ করতে তাজা রুই বা দেশি মাছ অপরিহার্য।"
      );
    }

    // Lentils (Dal)
    const dal = getFood("dal_masoor") || getFood("dal_moong");
    if (dal) {
      const qty = Math.max(0.5, Math.round(days * 0.08 * 10) / 10);
      addStapleIfNotPresent(
        dal,
        qty,
        "Plant-based protein, iron, and prebiotic fiber",
        "উদ্ভিজ্জ প্রোটিন, আয়রন ও প্রিবায়োটিক ফাইবার",
        "Classic South Asian staple that pairs with rice for a complete amino acid profile.",
        "মসুর ডাল উদ্ভিজ্জ প্রোটিন ও আয়রনের সহজলভ্য উৎস যা পাচনতন্ত্র ভালো রাখে।"
      );
    }

    // 3. Vegetables (Produce & Greens)
    const shak = getFood("veg_palong_shak") || getFood("veg_lal_shak");
    if (shak) {
      const bunches = Math.max(1, Math.round(days * 0.5));
      addStapleIfNotPresent(
        shak,
        bunches,
        "Local leafy greens rich in folate and antioxidants",
        "ফোলেট ও অ্যান্টিঅক্সিডেন্টে ভরপুর তাজা শাক",
        "Delivers essential micronutrients, vitamin A, and fiber with negligible calories.",
        "রোগ প্রতিরোধ ক্ষমতা বাড়াতে ও খাদ্য হজমে শাকসবজি অত্যন্ত গুরুত্বপূর্ণ।"
      );
    }

    const vegLau = getFood("veg_lau_bottle_gourd") || getFood("veg_potol_pointed_gourd");
    if (vegLau) {
      const qty = Math.max(1, Math.round(days * 0.2));
      addStapleIfNotPresent(
        vegLau,
        qty,
        "Hydrating, low-calorie seasonal vegetable",
        "কম ক্যালরিযুক্ত পানীয়সমৃদ্ধ পুষ্টিকর সবজি",
        "Promotes healthy gut motility and provides electrolytes.",
        "শরীরে পানির ভারসাম্য বজায় রাখে এবং রক্তচাপ নিয়ন্ত্রণে সাহায্য করে।"
      );
    }

    const tomato = getFood("veg_tomato_ripe");
    if (tomato) {
      addStapleIfNotPresent(
        tomato,
        Math.max(0.5, Math.round(days * 0.15 * 10) / 10),
        "Lycopene-rich vegetable for cellular protection",
        "লাইকোপেন ও ভিটামিন সি সমৃদ্ধ অ্যান্টিঅক্সিডেন্ট",
        "Enhances non-heme iron absorption from lentils and protects cardiovascular health.",
        "ডালের আয়রন শোষণ বাড়াতে ও ত্বক-হৃদপিণ্ড ভালো রাখতে টমেটো সহায়ক।"
      );
    }

    // 4. Local Fruits
    const fruit = getFood("fruit_banana_shobri") || getFood("fruit_guava_peara");
    if (fruit) {
      const qty = fruit.standardUnit === "pcs" ? Math.max(4, Math.round(days * 1.2)) : Math.max(1, Math.round(days * 0.2));
      addStapleIfNotPresent(
        fruit,
        qty,
        "Natural potassium, pectin, and micronutrients",
        "পটাশিয়াম ও পেকটিন সমৃদ্ধ পুষ্টিকর ফল",
        "Supports muscle electrolyte balance and healthy natural energy.",
        "পটাশিয়ামের ঘাটতি পূরণ এবং ক্লান্তি দূর করতে তাজা দেশি ফল।"
      );
    }

    // 5. Healthy Cooking Medium (Mustard Oil / Onion)
    const oil = getFood("oil_mustard");
    if (oil) {
      const qty = Math.max(0.5, Math.round(days * 0.04 * 10) / 10);
      addStapleIfNotPresent(
        oil,
        qty,
        "Monounsaturated fats and natural pungent antioxidants",
        "মনো-আনস্যাচুরেটেড ভালো ফ্যাট ও অ্যান্টিঅক্সিডেন্ট",
        "Essential fatty acid vehicle supporting fat-soluble vitamin (A, D, E) absorption.",
        "ভিটামিন শোষণে ও পরিমিত স্বাস্থ্যকর ফ্যাটের জোগান দিতে সরিষার তেল।"
      );
    }

    // Iterate: adjust quantities, add and swap catalog items until kcal and protein sit
    // within tolerance of target, with the budget ceiling as a hard constraint.
    const budgetLimit =
      input.budgetMode === "max" && input.budgetLimitBdt && input.budgetLimitBdt > 0
        ? input.budgetLimitBdt
        : undefined;
    const constraints: OptimizerConstraints = {
      days,
      targetDailyCalories: targets.targetCalories,
      targetDailyProtein: targets.targetProtein,
      budgetLimitBdt: budgetLimit,
      tolerance: TARGET_TOLERANCE,
      pool: availableFoods,
      coreGroups: buildCoreGroups(availableFoods),
    };
    const initialLines: BasketLine[] = plannedItems.map((p) => ({
      food: p.food,
      quantity: p.quantity,
      locked: p.locked,
    }));
    // Two starts: the heuristic basket, and only the user's picks (a different search basin).
    const optimized = optimizeBasketMultiStart(
      [initialLines, initialLines.filter((l) => l.locked)],
      constraints
    );

    const plannedById = new Map(plannedItems.map((p) => [p.food.id, p]));
    const cleanItems: CleanGroceryItem[] = optimized.lines.map((line) => {
      const meta = plannedById.get(line.food.id);
      const pricing = quoteBestPrice(line.food, line.quantity);
      return {
        id: `item_${Math.random().toString(36).slice(2, 9)}`,
        foodId: line.food.id,
        genericName: line.food.genericName,
        genericNameBn: line.food.genericNameBn,
        category: line.food.category,
        quantity: line.quantity,
        unit: line.food.standardUnit,
        unitPrice: pricing.unitPrice,
        itemTotal: pricing.itemTotal,
        isPriceEditable: pricing.isPriceEditable,
        stockStatus: stockMap[line.food.id],
        selectionReason: meta?.reasonEn ?? "Added to close the gap to your calorie and protein targets",
        selectionReasonBn: meta?.reasonBn ?? "ক্যালরি ও প্রোটিনের লক্ষ্য পূরণে যুক্ত",
        expandedExplanation:
          meta?.explanationEn ?? "Chosen by the planner to meet your targets within your constraints.",
        expandedExplanationBn:
          meta?.explanationBn ?? "আপনার লক্ষ্য ও সীমার মধ্যে পরিকল্পনাকারী কর্তৃক নির্বাচিত।",
        purchased: false,
      };
    });

    const totalCost = optimized.score.totalCostBdt;
    const compromisesList: string[] = [];
    for (const move of optimized.moves) {
      if (move.kind === "swap") {
        compromisesList.push(`Replaced ${move.replacedName} with ${move.foodName}.`);
      } else if (move.kind === "add") {
        compromisesList.push(`Added ${move.foodName}${move.replacedName ? ` (reduced ${move.replacedName})` : ""}.`);
      } else {
        compromisesList.push(`Dropped ${move.foodName}.`);
      }
    }
    if (input.budgetMode === "cheapest") {
      compromisesList.push("Prioritized Dhaka market staples with highest nutrient density per Taka spent.");
    }
    const compromises = compromisesList.join(" ");

    // Compute nutrition based on final items
    const nutritionSummary = calculateBasketNutrition(
      cleanItems.map((it) => ({ foodId: it.foodId, quantity: it.quantity })),
      days
    );

    const targetsUnmet = evaluateTargetsUnmet({
      dailyCalories: optimized.score.dailyCalories,
      dailyProtein: optimized.score.dailyProtein,
      totalCostBdt: optimized.score.totalCostBdt,
      targetCalories: targets.targetCalories,
      targetProtein: targets.targetProtein,
      budgetLimitBdt: budgetLimit,
      proteinFoodCount: availableFoods.filter((f) => f.proteinPer100g >= 10).length,
    });

    return {
      items: cleanItems,
      nutrition: nutritionSummary,
      targetComparison: {
        targetDailyCalories: targets.targetCalories,
        targetDailyProtein: targets.targetProtein,
        targetDailyCarbs: targets.targetCarbs,
        targetDailyFat: targets.targetFat,
      },
      budgetAnalysis: {
        budgetMode: input.budgetMode,
        budgetLimitBdt: input.budgetLimitBdt,
        totalActualCostBdt: totalCost,
        remainingBudgetBdt:
          input.budgetLimitBdt && input.budgetMode === "max"
            ? Math.max(0, input.budgetLimitBdt - totalCost)
            : undefined,
        isBudgetExceeded: optimized.score.budgetOverBdt > 0,
        compromisesMade: compromises || undefined,
        suggestedRealisticBudgetBdt: totalCost,
      },
      targetsUnmet,
      stockExcluded,
      unmatchedInspirations,
      disclaimer: MEDICAL_DISCLAIMER_EN,
      disclaimerBn: MEDICAL_DISCLAIMER_BN,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const aiGroceryPlannerService = new AIGroceryPlannerService();
