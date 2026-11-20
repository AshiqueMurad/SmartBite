import type { FoodItemDefinition } from "./bangladesh-food-db";
import type { StockStatus } from "./stock-check";
import { getCachedLivePrice } from "./stock-check";
import { getHistoricalPrice } from "./historical-prices";

/** Where a unit price came from. Only "live_retailer" reflects a price read today. */
export type PriceSource = "live_retailer" | "historical_median" | "static_benchmark";

export interface CleanGroceryItem {
  id: string; // unique item uuid in basket
  foodId: string;
  genericName: string;
  genericNameBn: string;
  category: string;
  quantity: number; // e.g. 2
  unit: string; // "kg", "litre", "pcs", "bunch"
  unitPrice: number; // in BDT
  itemTotal: number; // quantity * unitPrice
  isPriceEditable: boolean;
  selectionReason: string;
  selectionReasonBn: string;
  expandedExplanation: string;
  expandedExplanationBn: string;
  purchased: boolean;
  /** Live retailer stock status when the item has a retailer URL. Prices are never live. */
  stockStatus?: StockStatus;
}

export interface RetailerPriceQuote {
  foodId: string;
  matchedQuantity: number;
  unitPrice: number;
  totalPrice: number;
  isAvailable: boolean;
}

export interface RetailerProvider {
  name: string;
  getPriceQuote(food: FoodItemDefinition, requiredQuantity: number): Promise<RetailerPriceQuote>;
}

export interface BestPriceQuote {
  unitPrice: number;
  itemTotal: number;
  isPriceEditable: boolean;
  priceSource?: PriceSource;
}

/**
 * Benchmark estimate: packaged prices from the static Dhaka benchmark table.
 * Picks the pack combination that covers the required quantity at lowest cost.
 */
export function benchmarkQuote(food: FoodItemDefinition, requiredQuantity: number): RetailerPriceQuote {
  if (!food.packSizes || food.packSizes.length === 0) {
    return {
      foodId: food.id,
      matchedQuantity: requiredQuantity,
      unitPrice: food.defaultUnitPriceBdt,
      totalPrice: Math.round(requiredQuantity * food.defaultUnitPriceBdt),
      isAvailable: true,
    };
  }

  let bestTotal = Infinity;
  let effectiveUnitPrice = food.defaultUnitPriceBdt;
  for (const pack of [...food.packSizes].sort((a, b) => a.size - b.size)) {
    const packsNeeded = Math.ceil(requiredQuantity / pack.size);
    const cost = packsNeeded * pack.priceBdt;
    if (cost < bestTotal) {
      bestTotal = cost;
      effectiveUnitPrice = Math.round((cost / (packsNeeded * pack.size)) * 10) / 10;
    }
  }

  return {
    foodId: food.id,
    matchedQuantity: requiredQuantity,
    unitPrice: effectiveUnitPrice,
    totalPrice: Math.round(requiredQuantity * effectiveUnitPrice),
    isAvailable: true,
  };
}

/**
 * Benchmark estimate: the static default unit price from the Dhaka table, with no live
 * retailer data behind it.
 */
export function staticListQuote(food: FoodItemDefinition, requiredQuantity: number): RetailerPriceQuote {
  return {
    foodId: food.id,
    matchedQuantity: requiredQuantity,
    unitPrice: food.defaultUnitPriceBdt,
    totalPrice: Math.round(requiredQuantity * food.defaultUnitPriceBdt),
    isAvailable: true,
  };
}

/**
 * Synchronous best-price resolution. The basket optimizer calls this many times
 * while searching, so it must stay pure and cheap. Returns the cheapest
 * available quote; price is marked editable when no quote is available.
 */
export function quoteBestPrice(food: FoodItemDefinition, requiredQuantity: number): BestPriceQuote {
  const live = getCachedLivePrice(food.id);
  if (live) {
    return {
      unitPrice: live.unitPriceBdt,
      itemTotal: Math.round(requiredQuantity * live.unitPriceBdt),
      isPriceEditable: false,
      priceSource: "live_retailer",
    };
  }
  const historical = getHistoricalPrice(food.id);
  if (historical) {
    return {
      unitPrice: historical.unitPriceBdt,
      itemTotal: Math.round(requiredQuantity * historical.unitPriceBdt),
      isPriceEditable: false,
      priceSource: "historical_median",
    };
  }
  const quotes = [benchmarkQuote(food, requiredQuantity), staticListQuote(food, requiredQuantity)].filter(
    (q) => q.isAvailable && q.totalPrice > 0
  );
  if (quotes.length === 0) {
    return { unitPrice: 0, itemTotal: 0, isPriceEditable: true };
  }
  const best = quotes.reduce((a, b) => (b.totalPrice < a.totalPrice ? b : a));
  return {
    unitPrice: best.unitPrice,
    itemTotal: Math.round(requiredQuantity * best.unitPrice),
    isPriceEditable: false,
    priceSource: "static_benchmark",
  };
}

export class BenchmarkEstimateProvider implements RetailerProvider {
  name = "Benchmark estimate";
  async getPriceQuote(food: FoodItemDefinition, requiredQuantity: number): Promise<RetailerPriceQuote> {
    return benchmarkQuote(food, requiredQuantity);
  }
}

export class StaticListPriceProvider implements RetailerProvider {
  name = "Benchmark estimate (static list price)";
  async getPriceQuote(food: FoodItemDefinition, requiredQuantity: number): Promise<RetailerPriceQuote> {
    return staticListQuote(food, requiredQuantity);
  }
}

/**
 * Price engine facade. Strips retailer names, brands and links before returning
 * clean generic data for the UI.
 */
export class PriceComparisonEngine {
  async resolveBestPrice(food: FoodItemDefinition, requiredQuantity: number): Promise<BestPriceQuote> {
    return quoteBestPrice(food, requiredQuantity);
  }
}

export const pricingEngine = new PriceComparisonEngine();
