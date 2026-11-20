import fs from "node:fs";
import { BANGLADESH_FOOD_CATALOG } from "./bangladesh-food-db";
import { summarizeCommodityPrices, type BaseUnit } from "./data-parsers";
import { matchCommodities, setHistoricalPrices, clearHistoricalPrices, type CommodityMapEntry } from "./historical-prices";
import commodityMapRaw from "../data/commodity-map.json";

/**
 * Server-only loader for historical prices from a local CSV export of the Kaggle "Global Food
 * Prices" dataset. Call ensureHistoricalPrices() at the start of any server route that plans a
 * basket. It reads the file once per process and does nothing on later calls.
 *
 * Environment:
 *   PRICE_HISTORY_CSV      path to the CSV. Unset means no historical prices are used.
 *   PRICE_HISTORY_COUNTRY  defaults to "Bangladesh".
 *   USD_TO_BDT             used only for rows priced in USD.
 */

const commodityMap = commodityMapRaw as CommodityMapEntry[];
let loadedFor: string | null | undefined;

function baseOf(foodId: string): BaseUnit | undefined {
  const unit = BANGLADESH_FOOD_CATALOG.find((f) => f.id === foodId)?.standardUnit;
  return unit === "kg" ? "kg" : unit === "litre" ? "litre" : undefined;
}

export function ensureHistoricalPrices(): void {
  const file = process.env.PRICE_HISTORY_CSV || null;
  if (loadedFor === file) return;
  loadedFor = file;

  if (!file || !fs.existsSync(file)) {
    clearHistoricalPrices();
    return;
  }
  try {
    const summaries = summarizeCommodityPrices(fs.readFileSync(file, "utf8"), {
      country: process.env.PRICE_HISTORY_COUNTRY || "Bangladesh",
      usdToBdt: Number(process.env.USD_TO_BDT) || undefined,
    });
    setHistoricalPrices(matchCommodities(summaries, commodityMap, baseOf));
  } catch (err) {
    // A malformed file must not break planning. Historical prices are simply unavailable.
    console.error("Historical price file could not be read:", err);
    clearHistoricalPrices();
  }
}

/** Test helper: forces the next ensureHistoricalPrices() call to re-read the environment. */
export function resetHistoricalPriceLoader(): void {
  loadedFor = undefined;
  clearHistoricalPrices();
}
