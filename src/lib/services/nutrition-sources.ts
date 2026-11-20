/**
 * Live nutrition lookups from public food databases.
 *
 * Order of sources: Nutritics (only when configured; localized data), then USDA FoodData Central
 * (raw and generic foods), then Open Food Facts (packaged products), then Edamam (only when
 * credentials are configured). Every value keeps
 * its source and fetch time. Results are cached in memory, each request has a timeout, and a
 * source that fails or returns nothing relevant is skipped rather than guessed.
 */

import { mapNutriticsFoods } from "./data-parsers";

export type NutritionSourceName = "Nutritics" | "USDA FoodData Central" | "Open Food Facts" | "Edamam";

export interface Per100g {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodiumMg: number | null;
}

export interface SourcedFood {
  query: string;
  matchedName: string;
  source: NutritionSourceName;
  sourceRef: string;
  fetchedAt: string;
  per100g: Per100g;
  allergens: string[];
}

const REQUEST_TIMEOUT_MS = 4000;
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { value: SourcedFood | null; expiresAt: number }>();
const inflight = new Map<string, Promise<SourcedFood | null>>();

const STOPWORDS = new Set(["raw", "cooked", "fresh", "with", "and", "the", "of", "style", "plain", "boiled"]);

/** Turns a scanned label such as "Cooked rice (white), 200g" into a short search query. */
export function cleanIngredientQuery(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\d+(\.\d+)?\s*(g|gm|kg|ml|l|pcs|piece|pieces|cup|cups|tbsp|tsp|bowl|plate)\b/gi, " ")
    .replace(/[^a-zA-Z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** A database hit only counts if it shares a meaningful word with the query. */
export function isRelevantMatch(query: string, matchedName: string): boolean {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return false;
  const matched = new Set(tokens(matchedName));
  return queryTokens.some((t) => matched.has(t) || matched.has(t.replace(/s$/, "")));
}

function toNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Rejects values no real food can have, such as more than 900 kcal per 100 g of a whole food. */
function isPlausible(p: Per100g): boolean {
  return p.kcal <= 900 && p.protein + p.carbs + p.fat <= 105;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// USDA FoodData Central nutrient IDs.
const USDA_NUTRIENT = { kcal: 1008, protein: 1003, fat: 1004, carbs: 1005, fiber: 1079, sugar: 2000, sugarLegacy: 1063, sodium: 1093 };

async function lookupUsda(query: string): Promise<SourcedFood | null> {
  const key = process.env.USDA_API_KEY || "DEMO_KEY";
  const url =
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}` +
    `&query=${encodeURIComponent(query)}&pageSize=5&dataType=${encodeURIComponent("Foundation,SR Legacy")}`;
  const data = await fetchJson(url);
  const foods: any[] = Array.isArray(data?.foods) ? data.foods : [];

  for (const food of foods) {
    const name = String(food.description ?? "");
    if (!isRelevantMatch(query, name)) continue;

    const nutrients = new Map<number, number>();
    for (const n of food.foodNutrients ?? []) {
      const id = Number(n.nutrientId);
      const value = toNumber(n.value);
      if (value !== null) nutrients.set(id, value);
    }

    const per100g: Per100g = {
      kcal: nutrients.get(USDA_NUTRIENT.kcal) ?? NaN,
      protein: nutrients.get(USDA_NUTRIENT.protein) ?? NaN,
      carbs: nutrients.get(USDA_NUTRIENT.carbs) ?? NaN,
      fat: nutrients.get(USDA_NUTRIENT.fat) ?? NaN,
      fiber: nutrients.get(USDA_NUTRIENT.fiber) ?? 0,
      sugar: nutrients.get(USDA_NUTRIENT.sugar) ?? nutrients.get(USDA_NUTRIENT.sugarLegacy) ?? 0,
      sodiumMg: nutrients.get(USDA_NUTRIENT.sodium) ?? null,
    };
    if (![per100g.kcal, per100g.protein, per100g.carbs, per100g.fat].every(Number.isFinite)) continue;
    if (!isPlausible(per100g)) continue;

    return {
      query,
      matchedName: name,
      source: "USDA FoodData Central",
      sourceRef: `fdc:${food.fdcId}`,
      fetchedAt: new Date().toISOString(),
      per100g,
      allergens: [],
    };
  }
  return null;
}

async function lookupOpenFoodFacts(query: string): Promise<SourcedFood | null> {
  const url =
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=5`;
  const data = await fetchJson(url);
  const products: any[] = Array.isArray(data?.products) ? data.products : [];

  for (const p of products) {
    const name = String(p.product_name ?? "");
    if (!name || !isRelevantMatch(query, name)) continue;
    const n = p.nutriments ?? {};

    const kcal = toNumber(n["energy-kcal_100g"]);
    const protein = toNumber(n["proteins_100g"]);
    const carbs = toNumber(n["carbohydrates_100g"]);
    const fat = toNumber(n["fat_100g"]);
    if (kcal === null || protein === null || carbs === null || fat === null) continue;

    const sodiumG = toNumber(n["sodium_100g"]);
    const per100g: Per100g = {
      kcal,
      protein,
      carbs,
      fat,
      fiber: toNumber(n["fiber_100g"]) ?? 0,
      sugar: toNumber(n["sugars_100g"]) ?? 0,
      sodiumMg: sodiumG === null ? null : Math.round(sodiumG * 1000),
    };
    if (!isPlausible(per100g)) continue;

    return {
      query,
      matchedName: name,
      source: "Open Food Facts",
      sourceRef: `off:${p.code ?? "unknown"}`,
      fetchedAt: new Date().toISOString(),
      per100g,
      allergens: Array.isArray(p.allergens_tags) ? p.allergens_tags.map((t: string) => t.replace(/^en:/, "")) : [],
    };
  }
  return null;
}

async function lookupEdamam(query: string): Promise<SourcedFood | null> {
  const appId = process.env.EDAMAM_APP_ID;
  const appKey = process.env.EDAMAM_APP_KEY;
  if (!appId || !appKey) return null;

  // Asking for exactly 100 g makes the returned totals per-100g values.
  const url =
    `https://api.edamam.com/api/nutrition-data?app_id=${encodeURIComponent(appId)}` +
    `&app_key=${encodeURIComponent(appKey)}&ingr=${encodeURIComponent(`100 g ${query}`)}`;
  const data = await fetchJson(url);
  const totals = data?.totalNutrients;
  const weight = toNumber(data?.totalWeight);
  if (!totals || !weight || weight <= 0) return null;

  const scale = 100 / weight;
  const q = (key: string): number | null => {
    const v = toNumber(totals[key]?.quantity);
    return v === null ? null : v * scale;
  };
  const kcal = q("ENERC_KCAL");
  const protein = q("PROCNT");
  const carbs = q("CHOCDF");
  const fat = q("FAT");
  if (kcal === null || protein === null || carbs === null || fat === null) return null;

  const per100g: Per100g = {
    kcal,
    protein,
    carbs,
    fat,
    fiber: (q("FIBTG") ?? 0),
    sugar: (q("SUGAR") ?? 0),
    sodiumMg: q("NA"),
  };
  if (!isPlausible(per100g)) return null;

  return {
    query,
    matchedName: query,
    source: "Edamam",
    sourceRef: `edamam:${query}`,
    fetchedAt: new Date().toISOString(),
    per100g,
    allergens: [],
  };
}

/**
 * Nutritics, the localized database for Bangladesh-relevant foods. Enabled only when both
 * NUTRITICS_SEARCH_URL and NUTRITICS_API_KEY are set. The URL is a template with {query} and
 * {key} placeholders, because the account's endpoint and auth scheme come from its own
 * documentation and are not assumed here.
 */
async function lookupNutritics(query: string): Promise<SourcedFood | null> {
  const template = process.env.NUTRITICS_SEARCH_URL;
  const key = process.env.NUTRITICS_API_KEY;
  if (!template || !key) return null;
  const url = template
    .replace("{query}", encodeURIComponent(query))
    .replace("{key}", encodeURIComponent(key));
  const data = await fetchJson(url);
  for (const food of mapNutriticsFoods(data)) {
    if (!isRelevantMatch(query, food.name) || !isPlausible(food.per100g)) continue;
    return {
      query,
      matchedName: food.name,
      source: "Nutritics",
      sourceRef: `nutritics:${food.name}`,
      fetchedAt: new Date().toISOString(),
      per100g: food.per100g,
      allergens: food.allergens,
    };
  }
  return null;
}

/** Looks up one food. Tries each source in order and returns the first relevant, plausible hit. */
export async function lookupFood(rawQuery: string): Promise<SourcedFood | null> {
  if (process.env.NUTRITION_LOOKUP_ENABLED === "false") return null;
  const query = cleanIngredientQuery(rawQuery);
  if (!query) return null;

  const hit = cache.get(query);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const pending = inflight.get(query);
  if (pending) return pending;

  const work = (async () => {
    const value =
      (await lookupNutritics(query)) ??
      (await lookupUsda(query)) ??
      (await lookupOpenFoodFacts(query)) ??
      (await lookupEdamam(query));
    cache.set(query, { value, expiresAt: Date.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return value;
  })().finally(() => {
    inflight.delete(query);
  });

  inflight.set(query, work);
  return work;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise
      .then((v) => resolve(v))
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timer));
  });
}

/**
 * Looks up several ingredients in parallel with a per-item time budget. Items that do not
 * finish in time are left out, and their lookups still finish in the background for the cache.
 */
export async function enrichIngredients(names: string[], perItemMs = 4500, maxItems = 8): Promise<SourcedFood[]> {
  const unique = [...new Set(names.map(cleanIngredientQuery).filter(Boolean))].slice(0, maxItems);
  const results = await Promise.all(unique.map((n) => withTimeout(lookupFood(n), perItemMs)));
  return results.filter((r): r is SourcedFood => r !== null);
}

/** Clears the cache. Used by tests. */
export function clearNutritionCache(): void {
  cache.clear();
  inflight.clear();
}
