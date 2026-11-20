import type { FoodItemDefinition } from "./bangladesh-food-db";
import { parseRetailerOffer, type RetailerOffer } from "./data-parsers";

/**
 * Retailer stock status read from a product page. "Unverified" means the page could not be
 * fetched or did not state availability, so the item is kept and labelled as unverified.
 */
export type StockStatus = "In stock" | "Out of stock" | "Unverified";

export interface StockInfo {
  foodId: string;
  name: string;
  url: string;
  status: StockStatus;
  checkedAt: string;
}

const TTL_VERIFIED_MS = 15 * 60 * 1000;
const TTL_UNVERIFIED_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4500;

interface CacheEntry {
  info: StockInfo;
  expiresAt: number;
}

/** Live unit price read from a retailer page, per the catalog item's standardUnit. */
export interface LiveRetailerPrice {
  foodId: string;
  unitPriceBdt: number;
  url: string;
  checkedAt: string;
  expiresAt: number;
}

const liveCache = new Map<string, LiveRetailerPrice>();

/**
 * Converts a retailer pack price to a unit price. Returns null unless the page quotes BDT, the
 * item is in stock (or availability is unstated), and the catalog gives the pack size.
 */
export function liveUnitPrice(food: FoodItemDefinition, offer: RetailerOffer | null): number | null {
  if (!offer || !food.retailerPackSize || food.retailerPackSize <= 0) return null;
  if (offer.currency !== "BDT" && offer.currency !== "TK") return null;
  if (offer.inStock === false) return null;
  return Math.round((offer.price / food.retailerPackSize) * 100) / 100;
}

/** The live unit price for a catalog item if it was read recently, otherwise null. */
export function getCachedLivePrice(foodId: string): LiveRetailerPrice | null {
  const hit = liveCache.get(foodId);
  if (!hit || hit.expiresAt <= Date.now()) return null;
  return hit;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StockInfo>>();

/**
 * Reads availability from a retailer product page. Only the main product section is
 * inspected, because related products carry their own stock labels.
 */
export function parseStockStatus(html: string): StockStatus {
  const section = html.split(/<h1\b[^>]*>/i)[1]?.split(/Related Products|You May Also Like/i)[0];
  if (!section) return "Unverified";
  const text = section
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const match = text.match(/\b(out of stock|in stock)\b/i);
  if (!match) return "Unverified";
  return match[1].toLowerCase() === "in stock" ? "In stock" : "Out of stock";
}

async function fetchStock(
  food: FoodItemDefinition & { retailerUrl: string }
): Promise<{ info: StockInfo; offer: RetailerOffer | null }> {
  let status: StockStatus = "Unverified";
  let offer: RetailerOffer | null = null;
  try {
    const res = await fetch(food.retailerUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const html = await res.text();
      status = parseStockStatus(html);
      offer = parseRetailerOffer(html);
    }
  } catch {
    // Retailer unreachable: keep the item, marked as unverified.
  }
  const info: StockInfo = {
    foodId: food.id,
    name: food.genericName,
    url: food.retailerUrl,
    status,
    checkedAt: new Date().toISOString(),
  };
  return { info, offer };
}

/**
 * Stock for one catalog item, cached in memory. Concurrent requests for the same item share
 * one fetch. Returns null when the item has no retailer URL.
 */
export async function getStockInfo(food: FoodItemDefinition): Promise<StockInfo | null> {
  if (!food.retailerUrl) return null;
  const hit = cache.get(food.id);
  if (hit && hit.expiresAt > Date.now()) return hit.info;

  const pending = inflight.get(food.id);
  if (pending) return pending;

  const request = fetchStock(food as FoodItemDefinition & { retailerUrl: string })
    .then(({ info, offer }) => {
      const ttl = info.status === "Unverified" ? TTL_UNVERIFIED_MS : TTL_VERIFIED_MS;
      cache.set(food.id, { info, expiresAt: Date.now() + ttl });
      const unit = liveUnitPrice(food, offer);
      if (unit !== null) {
        liveCache.set(food.id, {
          foodId: food.id,
          unitPriceBdt: unit,
          url: info.url,
          checkedAt: info.checkedAt,
          expiresAt: Date.now() + ttl,
        });
      } else {
        liveCache.delete(food.id);
      }
      return info;
    })
    .finally(() => {
      inflight.delete(food.id);
    });
  inflight.set(food.id, request);
  return request;
}

/** Stock for every catalog item that has a retailer URL, keyed by food id. */
export async function getStockForCatalog(
  foods: FoodItemDefinition[]
): Promise<Record<string, StockInfo>> {
  const withUrl = foods.filter((f) => Boolean(f.retailerUrl));
  const infos = await Promise.all(withUrl.map((f) => getStockInfo(f)));
  const out: Record<string, StockInfo> = {};
  for (const info of infos) if (info) out[info.foodId] = info;
  return out;
}

/** Clears the cache. Used by tests. */
export function clearStockCache(): void {
  cache.clear();
  liveCache.clear();
  inflight.clear();
}
