import { BANGLADESH_FOOD_CATALOG, type FoodItemDefinition } from "./bangladesh-food-db";
import preparedLabels from "./scanner-labels.json";

/** Lowercases, strips punctuation (Bengali letters are kept) and collapses whitespace. */
export function normalizeTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{M}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Reduces an English plural to its singular ("eggs" -> "egg", "tomatoes" -> "tomato").
 * Words that merely end in s ("hummus", "rice") are left alone.
 */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/[^\x00-\x7F]/.test(word)) return word; // non-English script
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Normalizes a phrase to singular tokens, so table keys and input compare on the same form. */
function canonical(raw: string): string {
  return normalizeTerm(raw)
    .split(" ")
    .filter(Boolean)
    .map(singularize)
    .join(" ");
}

/**
 * Raw ingredient names (English, Bangla or romanized Bangladeshi) to catalog ids. Keys are
 * canonicalized below, so "pangas" and "pangash" both reach "panga", and "eggs" reaches "egg".
 */
const ALIAS_ENTRIES: [string, string][] = [
  // Protein
  ["chicken", "chicken_broiler"],
  ["murgi", "chicken_broiler"],
  ["মুরগি", "chicken_broiler"],
  ["sonali chicken", "chicken_sonali"],
  ["fish", "fish_rui_medium"],
  ["rui", "fish_rui_medium"],
  ["katla", "fish_katla"],
  ["tilapia", "fish_tilapia"],
  ["pangas", "fish_pangas"],
  ["pangash", "fish_pangas"],
  ["shrimp", "fish_shrimp_galda"],
  ["prawn", "fish_shrimp_galda"],
  ["galda", "fish_shrimp_galda"],
  ["chingri", "fish_shrimp_galda"],
  ["মাছ", "fish_rui_medium"],
  ["beef", "beef_lean"],
  ["egg", "eggs_farm_dozen"],
  ["dim", "eggs_farm_dozen"],
  ["ডিম", "eggs_farm_dozen"],
  ["milk", "milk_cow_liquid"],
  ["curd", "curd_tok_doi"],
  ["yogurt", "curd_tok_doi"],
  ["yoghurt", "curd_tok_doi"],
  ["doi", "curd_tok_doi"],
  ["tofu", "tofu_soft"],
  ["edamame", "edamame_green_soy"],
  // Grains
  ["rice", "rice_miniket"],
  ["chal", "rice_miniket"],
  ["bhat", "rice_miniket"],
  ["miniket", "rice_miniket"],
  ["nazirshail", "rice_nazirshail"],
  ["red rice", "rice_red_coarse"],
  ["lal chal", "rice_red_coarse"],
  ["brown rice", "rice_red_coarse"],
  ["atta", "atta_whole_wheat"],
  ["wheat", "atta_whole_wheat"],
  ["flatbread", "atta_whole_wheat"],
  ["roti", "atta_whole_wheat"],
  ["chapati", "atta_whole_wheat"],
  ["oat", "oats_rolled"],
  ["oatmeal", "oats_rolled"],
  // Lentils and pulses
  ["dal", "dal_masoor"],
  ["lentil", "dal_masoor"],
  ["masoor", "dal_masoor"],
  ["moong", "dal_moong"],
  ["mung", "dal_moong"],
  ["chola", "chhola_chickpeas"],
  ["chickpea", "chhola_chickpeas"],
  ["chana", "chhola_chickpeas"],
  // Vegetables
  ["potato", "veg_alu_potato"],
  ["alu", "veg_alu_potato"],
  ["bottle gourd", "veg_lau_bottle_gourd"],
  ["lau", "veg_lau_bottle_gourd"],
  ["gourd", "veg_lau_bottle_gourd"],
  ["palong", "veg_palong_shak"],
  ["spinach", "veg_palong_shak"],
  ["red amaranth", "veg_lal_shak"],
  ["lal shak", "veg_lal_shak"],
  ["pointed gourd", "veg_potol_pointed_gourd"],
  ["potol", "veg_potol_pointed_gourd"],
  ["begun", "veg_begun_eggplant"],
  ["eggplant", "veg_begun_eggplant"],
  ["brinjal", "veg_begun_eggplant"],
  ["tomato", "veg_tomato_ripe"],
  ["okra", "veg_dherosh_okra"],
  ["dherosh", "veg_dherosh_okra"],
  ["cucumber", "veg_cucumber_shosha"],
  ["shosha", "veg_cucumber_shosha"],
  ["bean", "beans_green_shim"],
  ["shim", "beans_green_shim"],
  ["lettuce", "lettuce_leaf"],
  ["sweet corn", "sweet_corn_bhutta"],
  ["corn", "sweet_corn_bhutta"],
  ["bhutta", "sweet_corn_bhutta"],
  ["red cabbage", "red_cabbage"],
  ["carrot", "carrot_gajor"],
  ["gajor", "carrot_gajor"],
  ["broccoli", "broccoli_green"],
  ["cauliflower", "cauliflower_phool"],
  ["phool kopi", "cauliflower_phool"],
  ["mushroom", "mushroom_button"],
  ["pepper", "capsicum_bell"],
  ["capsicum", "capsicum_bell"],
  ["pumpkin", "pumpkin_kumra"],
  ["kumra", "pumpkin_kumra"],
  // Fruit
  ["banana", "fruit_banana_shobri"],
  ["kola", "fruit_banana_shobri"],
  ["guava", "fruit_guava_peara"],
  ["peara", "fruit_guava_peara"],
  ["papaya", "fruit_papaya_pepe"],
  ["pepe", "fruit_papaya_pepe"],
  ["apple", "apple_imported"],
  ["orange", "orange_local"],
  ["kamla", "orange_local"],
  ["mango", "mango_local"],
  ["aam", "mango_local"],
  ["watermelon", "watermelon_tormuj"],
  ["tormuj", "watermelon_tormuj"],
  ["grape", "grapes_green"],
  // Nuts
  ["nut", "nuts_mixed"],
  ["badam", "nuts_mixed"],
  // Pantry
  ["mustard oil", "oil_mustard"],
  ["oil", "oil_mustard"],
  ["sorisha", "oil_mustard"],
  ["onion", "pantry_onion_peyaj"],
  ["peyaj", "pantry_onion_peyaj"],
  ["garlic", "pantry_garlic_roshoon"],
  ["roshun", "pantry_garlic_roshoon"],
];

const ALIASES: ReadonlyMap<string, string> = new Map(
  ALIAS_ENTRIES.map(([key, id]) => [canonical(key), id])
);

/**
 * Dishes and processed foods with no single raw catalog ingredient. They are reported to the
 * user as unmatched instead of being guessed.
 */
const PREPARED_TERMS: ReadonlySet<string> = new Set(
  (preparedLabels.prepared as string[]).map((t) => canonical(t))
);

const CATALOG_BY_ID: ReadonlyMap<string, FoodItemDefinition> = new Map(
  BANGLADESH_FOOD_CATALOG.map((f) => [f.id, f])
);

export interface IngredientMatch {
  raw: string;
  food: FoodItemDefinition | null;
}

export type UnmatchedReason = "prepared_dish" | "not_in_catalog";

export type IngredientResolution =
  | { food: FoodItemDefinition; reason?: undefined }
  | { food: null; reason: UnmatchedReason };

/**
 * Resolves one free-text ingredient to a catalog food by whole words or phrases only. The longest
 * phrase wins, so "red rice" beats "rice". "eggplant" never matches "egg" and "fish" never matches
 * shrimp. Returns why the item could not be matched when it fails.
 */
export function resolveIngredient(raw: string): IngredientResolution {
  const tokens = canonical(raw).split(" ").filter(Boolean);
  for (let len = Math.min(3, tokens.length); len >= 1; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      const id = ALIASES.get(tokens.slice(i, i + len).join(" "));
      const food = id ? CATALOG_BY_ID.get(id) : undefined;
      if (food) return { food };
    }
  }
  const isPrepared = tokens.some((t) => PREPARED_TERMS.has(t));
  return { food: null, reason: isPrepared ? "prepared_dish" : "not_in_catalog" };
}

/** Matches one free-text ingredient to a catalog food, or null when nothing matches exactly. */
export function matchIngredient(raw: string): FoodItemDefinition | null {
  return resolveIngredient(raw).food;
}

export function matchIngredients(raws: string[]): IngredientMatch[] {
  return raws.map((raw) => ({ raw, food: matchIngredient(raw) }));
}

/** Ids of every alias target; used by tests to ensure the table points at real catalog foods. */
export function aliasTargetIds(): string[] {
  return [...new Set(ALIASES.values())];
}

/** Every scanner label the vision model can return, from the shared label file. */
export const SCANNER_FOOD_LABELS: readonly string[] = preparedLabels.foods;
