import type { FoodItemDefinition, GroceryCategory } from "./bangladesh-food-db";
import { matchIngredient, singularize } from "./ingredient-matcher";
import { quoteBestPrice } from "./pricing-engine";
import { aiGroceryPlannerService } from "./ai-grocery";

/**
 * RAG (Retrieval-Augmented Generation) Nutrition & Metabolic Intelligence Service
 * 
 * Provides:
 * 1. Curated vector knowledge base of regional dietary guidelines (BIRDEM, ICMR, FAO).
 * 2. Real-time Open Food Facts / USDA nutrient cross-referencing.
 * 3. Metabolic telemetry simulation (blood glucose / glycemic load, UPF/NOVA classifications, autoimmune triggers).
 * 4. Contextual Dietary Pivot engine mapping restaurant dishes or raw visual inputs to localized market baskets.
 */

export interface KnowledgeDocument {
  id: string;
  title: string;
  category: "guideline" | "metabolic_telemetry" | "culinary_pivot" | "additives_upf" | "seasonal_produce";
  keywords: string[];
  content: string;
  actionablePivot: string;
  source: string;
  /** Verified link to the guideline document, or null when no source was verified. */
  sourceUrl: string | null;
  /** "cited" only when sourceUrl backs the claim; everything else is general guidance. */
  evidence: "cited" | "general_guidance";
}

export interface RetrievedKnowledgeChunk {
  document: KnowledgeDocument;
  score: number;
}

export interface ExternalFoodFacts {
  productName: string;
  novaGroup?: number; // 1 = unprocessed, 4 = ultra-processed
  nutriscoreGrade?: string; // a, b, c, d, e
  allergens?: string[];
  additives?: string[];
  estimatedGlycemicIndex?: number;
  source: string;
}

export interface DietaryPivot {
  originalDetectedItem: string;
  detectedType: "cooked_meal" | "raw_ingredients" | "restaurant_menu";
  metabolicRiskProfile: {
    glycemicLoad: "low" | "medium" | "high";
    glycemicLoadScore: number; // 0-40+
    satietyIndex: "low" | "moderate" | "high";
    novaCategory: number; // 1-4
    novaLabel: string;
    flaggedAdditives: string[];
    metabolicObservation: string;
  };
  restaurantPivotRecommendation?: {
    orderSwapText: string;
    diningCustomizations: string[];
  };
  localizedMarketPivot: {
    title: string;
    description: string;
    suggestedIngredients: {
      foodId: string;
      genericName: string;
      genericNameBn: string;
      quantity: number;
      unit: string;
      estPriceBdt: number;
      metabolicRole: string;
    }[];
    /** Real cost of the basket built from this meal's ingredients, at benchmark prices. */
    totalEstCostBdt: number;
    /** Null unless a real restaurant price was supplied; never a constant. */
    estCostSavingsBdt: number | null;
    savingsBasis: "restaurant_price" | "unavailable";
    /** Ingredients removed by the user's allergy, intolerance, diet or dislike settings. */
    excludedIngredients: { name: string; foodId: string }[];
    /** Ingredients the catalog cannot match exactly, so no price is shown for them. */
    unmatchedIngredients: string[];
  };
  ragEvidence: {
    guidelineTitle: string;
    source: string;
    sourceUrl: string | null;
    evidence: "cited" | "general_guidance";
    summary: string;
  }[];
}

// Regional and dietary knowledge base. Only entries with a verified sourceUrl are "cited";
// the rest are labelled general guidance so the UI never presents them as guideline facts.
export const RAG_KNOWLEDGE_BASE: KnowledgeDocument[] = [
  {
    id: "who_free_sugars",
    title: "WHO Guideline on Free Sugars Intake",
    category: "guideline",
    keywords: ["sugar", "sugars", "sweet", "sweets", "sweetened", "drink", "soda", "dessert", "free", "added", "diabetes", "weight"],
    content:
      "WHO recommends that adults and children keep free sugars below 10% of total energy intake, and suggests below 5% for additional benefit. For a person on about 2000 kcal a day that is roughly 50 g and 25 g of sugar.",
    actionablePivot: "Replace sugary drinks and sweets with plain water, unsweetened tea or fresh fruit, and check labels for added sugar.",
    source: "WHO Guideline: sugars intake for adults and children (2015)",
    sourceUrl: "https://www.who.int/publications/i/item/9789241549028",
    evidence: "cited",
  },
  {
    id: "who_fruit_vegetables",
    title: "WHO Healthy Diet: Fruit, Vegetables and Fibre",
    category: "guideline",
    keywords: ["fruit", "fruits", "vegetable", "vegetables", "veg", "salad", "shak", "fibre", "fiber", "greens", "whole", "grain", "legume", "lentil", "dal"],
    content:
      "WHO recommends at least 400 g of fruit and vegetables a day, about five portions, excluding potatoes, sweet potatoes, cassava and other starchy roots. Legumes such as lentils and whole grains are also part of a healthy diet.",
    actionablePivot: "Add a vegetable or fruit portion to each main meal and use lentils or whole grains in place of some refined carbohydrate.",
    source: "WHO Healthy diet fact sheet",
    sourceUrl: "https://www.who.int/news-room/fact-sheets/detail/healthy-diet",
    evidence: "cited",
  },
  {
    id: "icmr_dgi_2024",
    title: "ICMR-NIN Dietary Guidelines for Indians (2024)",
    category: "guideline",
    keywords: ["guideline", "guidelines", "dietary", "icmr", "nin", "salt", "sugar", "oil", "fat", "activity", "indian", "bangladesh"],
    content:
      "The 2024 Dietary Guidelines for Indians recommend restricting salt, using oils and fats in moderation, minimising sugar and ultra-processed foods, and doing regular physical activity.",
    actionablePivot: "Follow the ICMR-NIN 2024 guidance: limit added salt, sugar and ultra-processed foods, and use oil in moderation.",
    source: "ICMR-NIN Dietary Guidelines for Indians 2024",
    sourceUrl: "https://www.nin.res.in/dietaryguidelines/pdfjs/locale/DGI24thJune2024fin.pdf",
    evidence: "cited",
  },
  {
    id: "upf_nova_additives",
    title: "NOVA Classification: Ultra-Processed Foods",
    category: "additives_upf",
    keywords: ["processed", "ultra", "fast food", "burger", "pizza", "packaged", "instant", "additive", "sugar", "nova", "restaurant"],
    content:
      "In the NOVA classification, ultra-processed foods are industrial formulations made mostly from ingredients rarely used in home cooking, such as additives and certain sugars and fats, and are designed to be very palatable.",
    actionablePivot: "Prefer freshly made home-cooked dishes over packaged or fast food.",
    source: "Monteiro et al. 2019, Public Health Nutrition (NOVA)",
    sourceUrl: "https://www.cambridge.org/core/product/E6D744D714B1FF09D5BCA3E74D53A185",
    evidence: "cited",
  },
  {
    id: "cardiovascular_sodium",
    title: "WHO Sodium and Salt Recommendation",
    category: "metabolic_telemetry",
    keywords: ["hypertension", "bp", "blood", "pressure", "heart", "sodium", "salt", "cardiovascular"],
    content:
      "WHO recommends adults eat less than 5 g of salt (under 2,000 mg sodium) per day, and the 2024 Dietary Guidelines for Indians also advise restricting salt.",
    actionablePivot: "Flavour dishes with garlic, ginger and lemon, and add salt sparingly.",
    source: "WHO Salt reduction fact sheet",
    sourceUrl: "https://www.who.int/en/news-room/fact-sheets/detail/salt-reduction",
    evidence: "cited",
  },
  {
    id: "birdem_diabetes_gl",
    title: "Glycemic Guidance for South Asian Diets",
    category: "metabolic_telemetry",
    keywords: ["diabetes", "glucose", "insulin", "rice", "blood sugar", "glycemic", "biryani", "roti", "paratha", "atta"],
    content:
      "Polished white rice and refined flour tend to raise blood glucose faster than whole-grain options such as red rice and atta. Eating leafy greens and lentils before carbohydrates is commonly advised to slow that rise.",
    actionablePivot: "Choose red rice or atta over polished white rice where you can, and start the meal with greens and dal.",
    source: "General dietary advice (no guideline document verified)",
    sourceUrl: null,
    evidence: "general_guidance",
  },
  {
    id: "icmr_protein_satiety",
    title: "Protein Complementation for Satiety",
    category: "guideline",
    keywords: ["protein", "muscle", "satiety", "chicken", "eggs", "egg", "rui", "fish", "dal", "lentil", "leucine"],
    content:
      "Lentils eaten together with eggs or fish provide a more complete mix of amino acids than either alone, which helps keep you full between meals.",
    actionablePivot: "Pair dal with eggs or fish in the same meal.",
    source: "General nutrition guidance",
    sourceUrl: null,
    evidence: "general_guidance",
  },
  {
    id: "seasonal_produce_dhaka",
    title: "Seasonal Local Produce",
    category: "seasonal_produce",
    keywords: ["seasonal", "market", "vegetables", "winter", "summer", "monsoon", "shak", "lau", "potol"],
    content:
      "Vegetables are usually cheapest and freshest in their local season, and what is in season changes through the year.",
    actionablePivot: "Buy seasonal local produce such as palong shak in winter and lau or potol in summer.",
    source: "General guidance (seasonal availability varies by year)",
    sourceUrl: null,
    evidence: "general_guidance",
  },
  {
    id: "nocturnal_eating_mitigation",
    title: "Evening Hunger and Snacking",
    category: "metabolic_telemetry",
    keywords: ["night", "craving", "late", "snack", "sleep", "hunger", "evening", "biscuit", "bread"],
    content:
      "Some people find a protein-rich snack such as plain curd or a boiled egg keeps evening hunger lower than a sugary snack.",
    actionablePivot: "If you get evening hunger, try plain curd or a boiled egg instead of biscuits or bread.",
    source: "General guidance",
    sourceUrl: null,
    evidence: "general_guidance",
  },
];

// ---------------------------------------------------------------------------
// BM25 retrieval with stopword removal. The index is built once when the module loads.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it",
  "its", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with", "you", "your", "i",
  "my", "me", "we", "our", "they", "their", "them", "not", "but", "if", "so", "do", "does", "can",
  "will", "than", "then", "into", "over", "about", "more", "most", "some", "any", "each", "also",
  "may", "such", "which", "who", "what", "when", "where", "how", "all", "no", "yes", "up", "down",
  "out", "off", "only", "very", "just", "per", "one", "two", "like", "get", "use",
]);

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export function tokenizeForRetrieval(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z\u0980-\u09FF]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(singularize);
}

interface IndexedDoc {
  doc: KnowledgeDocument;
  termFreq: Map<string, number>;
  length: number;
}

interface Bm25Index {
  docs: IndexedDoc[];
  docFreq: Map<string, number>;
  avgLength: number;
}

function buildBm25Index(docs: KnowledgeDocument[]): Bm25Index {
  const indexed: IndexedDoc[] = docs.map((doc) => {
    // Title is weighted twice and keywords three times; content counts once.
    const tokens = [
      ...tokenizeForRetrieval(doc.title),
      ...tokenizeForRetrieval(doc.title),
      ...doc.keywords.flatMap((k) => [...tokenizeForRetrieval(k), ...tokenizeForRetrieval(k), ...tokenizeForRetrieval(k)]),
      ...tokenizeForRetrieval(doc.content),
    ];
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    return { doc, termFreq, length: tokens.length };
  });
  const docFreq = new Map<string, number>();
  for (const d of indexed) for (const term of d.termFreq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  const avgLength = indexed.reduce((a, d) => a + d.length, 0) / Math.max(1, indexed.length);
  return { docs: indexed, docFreq, avgLength };
}

const BM25_INDEX = buildBm25Index(RAG_KNOWLEDGE_BASE);

export function scoreBm25(query: string, index: Bm25Index = BM25_INDEX): { doc: KnowledgeDocument; score: number }[] {
  const queryTerms = [...new Set(tokenizeForRetrieval(query))];
  const N = index.docs.length;
  return index.docs
    .map((d) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = d.termFreq.get(term);
        if (!tf) continue;
        const df = index.docFreq.get(term) ?? 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / index.avgLength);
        score += idf * ((tf * (BM25_K1 + 1)) / norm);
      }
      return { doc: d.doc, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** One serving of an ingredient, in the catalog's standard unit. */
function portionQuantity(food: FoodItemDefinition): number {
  if (food.id.startsWith("eggs_")) return 2;
  if (food.standardUnit === "pcs" || food.standardUnit === "bunch") return 1;
  if (food.standardUnit === "litre") return 0.1;
  if (food.category === "grains") return 0.15;
  if (food.category === "lentils_legumes") return 0.05;
  if (food.category === "protein_fish" || food.category === "protein_poultry_meat") return 0.25;
  return 0.2;
}

function metabolicRoleFor(category: GroceryCategory): string {
  switch (category) {
    case "protein_fish":
    case "protein_poultry_meat":
      return "Clean protein for tissue repair & satiety";
    case "eggs_dairy":
      return "Complete protein and micronutrients";
    case "grains":
      return "Complex carbohydrate; whole grains flatten glucose spikes";
    case "lentils_legumes":
      return "Plant protein and soluble fibre";
    case "vegetables":
      return "Fibre and micronutrients with few calories";
    case "fruits":
      return "Natural potassium and fibre";
    default:
      return "Cooking base and flavour";
  }
}

export class RAGNutritionService {
  /**
   * Retrieves the top guideline entries for a query using BM25 with stopword removal.
   * Allergies are not part of the query: they filter foods, not evidence.
   */
  retrieveGuidelines(query: string, condition?: string, topK = 3): RetrievedKnowledgeChunk[] {
    return scoreBm25(`${query} ${condition || ""}`)
      .slice(0, topK)
      .map((r) => ({ document: r.doc, score: r.score }));
  }

  /**
   * Cross-references Open Food Facts public API for verified food metadata.
   */
  async queryOpenFoodFacts(term: string): Promise<ExternalFoodFacts | null> {
    try {
      const cleanTerm = encodeURIComponent(term.trim().split(" ")[0]);
      const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${cleanTerm}&search_simple=1&action=process&json=1&page_size=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const data = await res.json();
      const product = data?.products?.[0];
      if (!product) return null;

      return {
        productName: product.product_name || term,
        novaGroup: product.nova_group ? Number(product.nova_group) : undefined,
        nutriscoreGrade: product.nutriscore_grade ? String(product.nutriscore_grade).toUpperCase() : undefined,
        allergens: Array.isArray(product.allergens_tags) ? product.allergens_tags : [],
        additives: Array.isArray(product.additives_tags) ? product.additives_tags : [],
        source: "Open Food Facts Global Collaborative Database",
      };
    } catch {
      return null;
    }
  }

  /**
   * Builds an intelligent, localized Dietary Pivot & Metabolic Report
   * from any visual scan (cooked meal, raw ingredients, or restaurant menu).
   */
  generateDietaryPivot(params: {
    mealName: string;
    ingredients: string[];
    userGoal?: string;
    metabolicCondition?: string;
    isMenuScan?: boolean;
    allergies?: string[];
    intolerances?: string[];
    dietaryRestrictions?: string[];
    dislikedFoods?: string[];
    /** Real menu price for the dish, if known. Savings are only computed when this is given. */
    restaurantPriceBdt?: number;
  }): DietaryPivot {
    const {
      mealName = "Meal",
      ingredients = [],
      userGoal = "",
      metabolicCondition = "",
      isMenuScan = false,
      allergies = [],
      intolerances = [],
      dietaryRestrictions = [],
      dislikedFoods = [],
      restaurantPriceBdt,
    } = params || {};
    const safeMealName = String(mealName || "Meal").trim();
    const safeIngredients = Array.isArray(ingredients) ? ingredients : [];
    const nameLower = safeMealName.toLowerCase();
    const allText = `${nameLower} ${safeIngredients.join(" ").toLowerCase()}`;
    // Whole-word tokens, so "eggplant" is not read as egg and "dal" is not read inside other words.
    const words = new Set(allText.split(/[^a-z\u0980-\u09FF]+/).filter(Boolean));
    const hasWord = (...terms: string[]) => terms.some((t) => words.has(t));

    // 1. Retrieve clinical RAG knowledge
    const retrieved = this.retrieveGuidelines(allText, `${userGoal} ${metabolicCondition}`);

    // 2. Assess Metabolic Impact (Glycemic Load, Satiety, NOVA group)
    const isHighCarbRefined =
      allText.includes("biryani") ||
      allText.includes("naan") ||
      allText.includes("paratha") ||
      allText.includes("burger") ||
      allText.includes("pizza") ||
      allText.includes("pasta") ||
      allText.includes("sugar") ||
      allText.includes("dessert");

    const isDeepFried =
      allText.includes("fried") ||
      allText.includes("fry") ||
      allText.includes("crispy") ||
      allText.includes("bhuna") ||
      allText.includes("samosa") ||
      allText.includes("chips");

    const hasLeanProtein = hasWord(
      "chicken", "fish", "rui", "tilapia", "egg", "eggs", "dal", "tofu", "murgi", "ডিম", "মাছ"
    );

    const hasGreens = hasWord(
      "shak", "spinach", "salad", "vegetable", "vegetables", "cucumber", "tomato", "tomatoes"
    );

    // NOVA Category. Only clear ultra-processed markers (fast food, packaged or instant
    // products) make a dish NOVA 4. A home-cooked bhuna or curry is classified by its ingredients.
    const isUltraProcessed =
      /(fast food|burger|pizza|nugget|sausage|hot dog|chips|instant|noodle|soft drink|packaged|frozen)/.test(allText);

    let novaCategory = 1;
    let novaLabel = "NOVA 1: Home-cooked whole-ingredient dish";
    const flaggedAdditives: string[] = [];

    if (isUltraProcessed) {
      novaCategory = 4;
      novaLabel = "NOVA 4: Ultra-Processed Food (UPF) Trap";
      flaggedAdditives.push("Industrial Emulsifiers & Reheated Seed Oils", "Elevated Sodium & MSG", "Refined High-GI Starches");
    } else if (isHighCarbRefined) {
      novaCategory = 3;
      novaLabel = "NOVA 3: Processed Culinary Formulation";
      flaggedAdditives.push("Refined Grain Flours", "Low Micronutrient Retention");
    }

    // Glycemic Load Calculation
    let glycemicLoad: "low" | "medium" | "high" = "low";
    let glycemicLoadScore = 12;
    if (isHighCarbRefined && !hasGreens) {
      glycemicLoad = "high";
      glycemicLoadScore = 28;
    } else if (isHighCarbRefined && hasGreens) {
      glycemicLoad = "medium";
      glycemicLoadScore = 18;
    }

    // Satiety Index
    const satietyIndex: "low" | "moderate" | "high" = hasLeanProtein && (hasGreens || !isHighCarbRefined)
      ? "high"
      : isHighCarbRefined && !hasLeanProtein
      ? "low"
      : "moderate";

    // Metabolic Observation
    const metabolicObservation =
      glycemicLoad === "high"
        ? "Rapid carbohydrate breakdown with high glycemic surge risk. Lacks sufficient soluble fiber matrix to buffer insulin response."
        : hasLeanProtein && hasGreens
        ? "Excellent metabolic balance. Bioavailable amino acids with natural dietary fiber promote stable satiety and sustained glucose control."
        : "Moderate macronutrient density. Can be significantly enhanced with local lean protein and leafy greens.";

    // 4. Localized market pivot: a basket built from the detected ingredients, filtered by the
    // user's allergies, intolerances, diet and dislikes, and priced from the catalog.
    const allowedIds = new Set(
      aiGroceryPlannerService
        .filterCatalog(allergies, intolerances, dietaryRestrictions, dislikedFoods)
        .map((f) => f.id)
    );
    const sourceNames = safeIngredients.length ? safeIngredients : [safeMealName];
    const seenIds = new Set<string>();
    const unmatchedIngredients: string[] = [];
    const excludedIngredients: { name: string; foodId: string }[] = [];
    const marketPivotIngredients: DietaryPivot["localizedMarketPivot"]["suggestedIngredients"] = [];

    for (const raw of sourceNames) {
      const food = matchIngredient(raw);
      if (!food) {
        unmatchedIngredients.push(raw);
        continue;
      }
      if (seenIds.has(food.id)) continue;
      seenIds.add(food.id);
      if (!allowedIds.has(food.id)) {
        excludedIngredients.push({ name: raw, foodId: food.id });
        continue;
      }
      const quantity = portionQuantity(food);
      const quote = quoteBestPrice(food, quantity);
      marketPivotIngredients.push({
        foodId: food.id,
        genericName: food.genericName,
        genericNameBn: food.genericNameBn,
        quantity,
        unit: food.standardUnit,
        estPriceBdt: quote.itemTotal,
        metabolicRole: metabolicRoleFor(food.category),
      });
    }

    // Real basket cost from the catalog. Savings need a real restaurant price to compare against.
    const totalEstCostBdt = marketPivotIngredients.reduce((acc, it) => acc + it.estPriceBdt, 0);
    const hasRestaurantPrice = typeof restaurantPriceBdt === "number" && restaurantPriceBdt > 0;
    const estCostSavingsBdt = hasRestaurantPrice ? restaurantPriceBdt - totalEstCostBdt : null;

    const restaurantPivotRecommendation = {
      orderSwapText:
        isHighCarbRefined || isDeepFried
          ? "Ask for Tandoori or Grilled protein with Cucumber Salad instead of fried bhuna/curry with heavy white naan."
          : "Keep the dish clean: request sauce on the side and substitute white rice with mixed salad or whole wheat roti.",
      diningCustomizations: [
        "Ask for minimal cooking oil / butter glaze",
        "Request double fresh lemon & cucumber slices to slow starch digestion",
        "Skip sweetened drinks / Borhani; choose mineral water or sugar-free tea",
      ],
    };

    return {
      originalDetectedItem: mealName,
      detectedType: isMenuScan ? "restaurant_menu" : ingredients.length > 2 ? "raw_ingredients" : "cooked_meal",
      metabolicRiskProfile: {
        glycemicLoad,
        glycemicLoadScore,
        satietyIndex,
        novaCategory,
        novaLabel,
        flaggedAdditives,
        metabolicObservation,
      },
      restaurantPivotRecommendation,
      localizedMarketPivot: {
        title: "Localized Home-Cooked Nutrient Pivot (Dhaka Market)",
        description: `Recreate this meal with unrefined Dhaka staples for an optimal metabolic curve at a fraction of commercial cost.`,
        suggestedIngredients: marketPivotIngredients,
        totalEstCostBdt,
        estCostSavingsBdt,
        savingsBasis: hasRestaurantPrice ? "restaurant_price" : "unavailable",
        excludedIngredients,
        unmatchedIngredients,
      },
      ragEvidence: retrieved.map((r) => ({
        guidelineTitle: r.document.title,
        source: r.document.source,
        sourceUrl: r.document.sourceUrl,
        evidence: r.document.evidence,
        summary: r.document.content,
      })),
    };
  }
}

export const ragNutritionService = new RAGNutritionService();
