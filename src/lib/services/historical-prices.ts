/**
 * Browser-safe store for historical unit prices. This module has no filesystem access, so it can
 * be bundled into client components through ai-grocery and pricing-engine. The server fills the
 * store from a CSV via price-history.ts before any planning runs.
 */
import type { BaseUnit, CommodityPrice } from "./data-parsers";

export interface HistoricalPrice {
  foodId: string;
  commodity: string;
  unitPriceBdt: number;
  sampleSize: number;
  windowStart: string;
  windowEnd: string;
}

export interface CommodityMapEntry {
  foodId: string;
  patterns: string[];
}

let store: Map<string, HistoricalPrice> = new Map();

/** Pure: matches summarized commodities to catalog foods. */
export function matchCommodities(
  summaries: CommodityPrice[],
  mapping: CommodityMapEntry[],
  foodBase: (foodId: string) => BaseUnit | undefined
): Map<string, HistoricalPrice> {
  const out = new Map<string, HistoricalPrice>();
  for (const entry of mapping) {
    const base = foodBase(entry.foodId);
    if (!base) continue;
    const regexes = entry.patterns.map((p) => new RegExp(p, "i"));
    // When several commodities match one food, the one with the most samples wins.
    const best = summaries
      .filter((s) => s.base === base && regexes.some((re) => re.test(s.commodity)))
      .sort((a, b) => b.sampleSize - a.sampleSize)[0];
    if (!best) continue;
    out.set(entry.foodId, {
      foodId: entry.foodId,
      commodity: best.commodity,
      unitPriceBdt: best.unitPriceBdt,
      sampleSize: best.sampleSize,
      windowStart: best.windowStart,
      windowEnd: best.windowEnd,
    });
  }
  return out;
}

/** Replaces the whole store. Called by the server loader. */
export function setHistoricalPrices(prices: Map<string, HistoricalPrice>): void {
  store = prices;
}

/** The historical benchmark for a catalog food, or null when none is loaded. */
export function getHistoricalPrice(foodId: string): HistoricalPrice | null {
  return store.get(foodId) ?? null;
}

export function clearHistoricalPrices(): void {
  store = new Map();
}
