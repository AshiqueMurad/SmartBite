import type { FoodItemDefinition } from "./bangladesh-food-db";
import { calculateRawEdibleGrams } from "./nutrition-calc";
import { quoteBestPrice } from "./pricing-engine";

/**
 * One line of the basket. Locked lines were chosen by the user (scan or
 * inspiration): the optimizer may change their quantity, and removes them
 * only when nothing else satisfies the constraints.
 */
export interface BasketLine {
  food: FoodItemDefinition;
  quantity: number;
  locked: boolean;
}

export interface OptimizerConstraints {
  days: number;
  targetDailyCalories: number;
  targetDailyProtein: number;
  /** Hard ceiling on total basket cost in BDT. Undefined = no budget constraint. */
  budgetLimitBdt?: number;
  /** Allowed relative deviation from the kcal and protein targets (0.10 = ±10%). */
  tolerance: number;
  /** Foods (already filtered for allergies, diet and dislikes) that may be added or swapped in. */
  pool: FoodItemDefinition[];
  /** Food-id groups a sensible basket should cover when the pool allows it. */
  coreGroups: Set<string>[];
}

export interface BasketScore {
  dailyCalories: number;
  dailyProtein: number;
  totalCostBdt: number;
  /** BDT above the budget ceiling (0 when within budget or no ceiling). */
  budgetOverBdt: number;
  /** Sum of relative deviations beyond the tolerance band (0 = both targets met). */
  targetViolation: number;
  /** Number of locked (user-chosen) foods removed from the original basket. */
  lockedRemoved: number;
  /** Number of core groups with no representative in the basket. */
  missingCoreGroups: number;
  /** Number of lines too small to be a practical purchase (see isTokenQuantity). */
  tokenLines: number;
}

export interface OptimizerMove {
  kind: "add" | "remove" | "swap";
  foodName: string;
  replacedName?: string;
}

export interface OptimizerResult {
  lines: BasketLine[];
  score: BasketScore;
  moves: OptimizerMove[];
  iterations: number;
}

const MAX_ITERATIONS = 1000;
const EPS = 1e-9;

export function quantityStep(food: FoodItemDefinition): number {
  if (food.standardUnit === "kg") return 0.1;
  if (food.standardUnit === "litre") return 0.25;
  return 1; // pcs and bunch are whole units
}

/** Upper bound on quantity for the whole period, based on a per-person-per-day limit. */
function maxQuantity(food: FoodItemDefinition, days: number): number {
  const step = quantityStep(food);
  let perDay: number;
  if (food.standardUnit === "pcs") perDay = food.id.startsWith("eggs_") ? 3 : 2;
  else if (food.standardUnit === "kg") perDay = 1;
  else if (food.standardUnit === "litre") perDay = 0.5;
  else perDay = 1.5;
  return Math.max(step, Math.floor((perDay * days) / step) * step);
}

/**
 * A "token" line is a purchase too small to matter in a meal plan, e.g. 0.1 kg of rice
 * for a week. Weight-based foods need at least about 70 g per person per day.
 */
export function isTokenQuantity(food: FoodItemDefinition, quantity: number, days: number): boolean {
  if (food.standardUnit !== "kg") return false;
  return quantity < Math.max(0.2, 0.07 * days) - EPS;
}

/** Lower bound for a line. User-chosen weight-based foods keep a practical amount rather than a token. */
function minQuantity(line: BasketLine, days: number): number {
  const step = quantityStep(line.food);
  if (line.locked && line.food.standardUnit === "kg") {
    return Math.max(step, Math.ceil((0.07 * days) / step) * step);
  }
  return step;
}

function snap(food: FoodItemDefinition, quantity: number): number {
  const step = quantityStep(food);
  return Math.round(Math.round(quantity / step) * step * 1000) / 1000;
}

interface LineContribution {
  calories: number;
  protein: number;
  cost: number;
}

type ContributionCache = Map<string, LineContribution>;

function contributionOf(line: BasketLine, cache: ContributionCache): LineContribution {
  const key = `${line.food.id}|${line.quantity}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const factor = calculateRawEdibleGrams(line.food, line.quantity) / 100;
  const value = {
    calories: line.food.caloriesPer100g * factor,
    protein: line.food.proteinPer100g * factor,
    cost: quoteBestPrice(line.food, line.quantity).itemTotal,
  };
  cache.set(key, value);
  return value;
}

export function evaluateBasket(
  lines: BasketLine[],
  c: OptimizerConstraints,
  originalLockedIds: Set<string> = new Set(),
  cache: ContributionCache = new Map()
): BasketScore {
  let calories = 0;
  let protein = 0;
  let cost = 0;
  const presentIds = new Set<string>();

  for (const line of lines) {
    const part = contributionOf(line, cache);
    calories += part.calories;
    protein += part.protein;
    cost += part.cost;
    presentIds.add(line.food.id);
  }

  const dailyCalories = calories / c.days;
  const dailyProtein = protein / c.days;
  const kcalDeviation = Math.abs(dailyCalories - c.targetDailyCalories) / c.targetDailyCalories;
  const proteinDeviation = Math.abs(dailyProtein - c.targetDailyProtein) / c.targetDailyProtein;

  return {
    dailyCalories,
    dailyProtein,
    totalCostBdt: cost,
    budgetOverBdt: c.budgetLimitBdt !== undefined && cost > c.budgetLimitBdt ? cost - c.budgetLimitBdt : 0,
    targetViolation:
      Math.max(0, kcalDeviation - c.tolerance) + Math.max(0, proteinDeviation - c.tolerance),
    lockedRemoved: [...originalLockedIds].filter((id) => !presentIds.has(id)).length,
    missingCoreGroups: c.coreGroups.filter((group) => ![...group].some((id) => presentIds.has(id))).length,
    tokenLines: lines.filter((l) => isTokenQuantity(l.food, l.quantity, c.days)).length,
  };
}

/** Lexicographic priority: budget, targets, user picks, variety, practical quantities, then cost. */
function priorityKey(s: BasketScore): number[] {
  return [s.budgetOverBdt, s.targetViolation, s.lockedRemoved, s.missingCoreGroups, s.tokenLines, s.totalCostBdt];
}

export function isBetter(a: BasketScore, b: BasketScore): boolean {
  const ka = priorityKey(a);
  const kb = priorityKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i] - EPS) return true;
    if (ka[i] > kb[i] + EPS) return false;
  }
  return false;
}

interface Candidate {
  lines: BasketLine[];
  move: OptimizerMove | null; // null for quantity adjustments, which are not logged
}

function neighbours(lines: BasketLine[], c: OptimizerConstraints): Candidate[] {
  const out: Candidate[] = [];
  const inBasket = new Set(lines.map((l) => l.food.id));

  lines.forEach((line, i) => {
    const step = quantityStep(line.food);
    const up = snap(line.food, line.quantity + step);
    const down = snap(line.food, line.quantity - step);

    if (up <= maxQuantity(line.food, c.days)) {
      const next = lines.slice();
      next[i] = { ...line, quantity: up };
      out.push({ lines: next, move: null });
    }
    if (down >= minQuantity(line, c.days)) {
      const next = lines.slice();
      next[i] = { ...line, quantity: down };
      out.push({ lines: next, move: null });
    }

    out.push({
      lines: lines.filter((_, j) => j !== i),
      move: { kind: "remove", foodName: line.food.genericName },
    });

    for (const alt of c.pool) {
      if (inBasket.has(alt.id)) continue;
      if (alt.category !== line.food.category || alt.standardUnit !== line.food.standardUnit) continue;
      const next = lines.slice();
      next[i] = { food: alt, quantity: snap(alt, line.quantity), locked: line.locked };
      out.push({
        lines: next,
        move: { kind: "swap", foodName: alt.genericName, replacedName: line.food.genericName },
      });
    }
  });

  for (const food of c.pool) {
    if (inBasket.has(food.id)) continue;
    out.push({
      lines: [...lines, { food, quantity: quantityStep(food), locked: false }],
      move: { kind: "add", foodName: food.genericName },
    });
  }

  return out;
}

/** One step out of a line and one step into another line or a new pool food. */
function transfers(lines: BasketLine[], c: OptimizerConstraints): Candidate[] {
  const out: Candidate[] = [];
  const inBasket = new Set(lines.map((l) => l.food.id));

  lines.forEach((from, i) => {
    const fromStep = quantityStep(from.food);
    const fromQty = snap(from.food, from.quantity - fromStep);
    if (fromQty < minQuantity(from, c.days)) return; // dropping the line is covered by the remove move
    const fromName = from.food.genericName;

    lines.forEach((to, j) => {
      if (i === j) return;
      const toQty = snap(to.food, to.quantity + quantityStep(to.food));
      if (toQty > maxQuantity(to.food, c.days)) return;
      const next = lines.slice();
      next[i] = { ...from, quantity: fromQty };
      next[j] = { ...to, quantity: toQty };
      out.push({ lines: next, move: null });
    });

    for (const food of c.pool) {
      if (inBasket.has(food.id)) continue;
      const next = lines.slice();
      next[i] = { ...from, quantity: fromQty };
      next.push({ food, quantity: quantityStep(food), locked: false });
      out.push({
        lines: next,
        move: { kind: "add", foodName: food.genericName, replacedName: fromName },
      });
    }
  });

  return out;
}

/**
 * Steepest-descent local search. Each iteration evaluates every single-step change
 * (quantity up or down, add, remove, same-category swap) and applies the best one
 * that improves the priority key. Deterministic: the same input gives the same basket.
 */
export function optimizeBasket(initial: BasketLine[], c: OptimizerConstraints): OptimizerResult {
  const originalLockedIds = new Set(initial.filter((l) => l.locked).map((l) => l.food.id));

  const cache: ContributionCache = new Map();
  let current = initial.map((l) => ({ ...l, quantity: snap(l.food, l.quantity) }));
  let currentScore = evaluateBasket(current, c, originalLockedIds, cache);
  const moves: OptimizerMove[] = [];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    let best: Candidate | null = null;
    let bestScore = currentScore;

    for (const cand of [...neighbours(current, c), ...transfers(current, c)]) {
      const score = evaluateBasket(cand.lines, c, originalLockedIds, cache);
      if (isBetter(score, bestScore)) {
        best = cand;
        bestScore = score;
      }
    }
    if (!best) break;

    current = best.lines;
    currentScore = bestScore;
    if (best.move) moves.push(best.move);
  }

  return { lines: current, score: currentScore, moves, iterations };
}

/**
 * Runs the search from several starting baskets and keeps the best result. A single
 * start can get trapped where a swap only pays off after a second adjustment.
 */
export function optimizeBasketMultiStart(starts: BasketLine[][], c: OptimizerConstraints): OptimizerResult {
  let best: OptimizerResult | null = null;
  for (const start of starts) {
    const result = optimizeBasket(start, c);
    if (!best || isBetter(result.score, best.score)) best = result;
  }
  if (!best) throw new Error("optimizeBasketMultiStart requires at least one start");
  return best;
}
