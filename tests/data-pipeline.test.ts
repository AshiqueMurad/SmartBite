import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCsv,
  parseUom,
  summarizeCommodityPrices,
  parseRetailerOffer,
  mapNutriticsFoods,
  median,
} from "../src/lib/services/data-parsers";
import { matchCommodities, getHistoricalPrice } from "../src/lib/services/historical-prices";
import { ensureHistoricalPrices, resetHistoricalPriceLoader } from "../src/lib/services/price-history";
import { liveUnitPrice, getCachedLivePrice, clearStockCache } from "../src/lib/services/stock-check";
import { quoteBestPrice } from "../src/lib/services/pricing-engine";
import { BANGLADESH_FOOD_CATALOG, type FoodItemDefinition } from "../src/lib/services/bangladesh-food-db";
import { RAG_KNOWLEDGE_BASE } from "../src/lib/services/rag-nutrition";

const food = (id: string): FoodItemDefinition => BANGLADESH_FOOD_CATALOG.find((f) => f.id === id)!;

const SAMPLE_CSV = `date,adm0_name,commodity,price,uom,currency
2026-10-01,Bangladesh,"Rice, medium",70,KG,BDT
2026-10-08,Bangladesh,"Rice, medium",72,KG,BDT
2026-10-15,Bangladesh,"Rice, medium",74,KG,BDT
2026-10-15,Bangladesh,"Lentil ""red""",250,500 G,BDT
2026-10-22,Bangladesh,"Lentil ""red""",260,500 G,BDT
2026-10-29,Bangladesh,"Lentil ""red""",240,500 G,BDT
2026-10-29,India,Rice,50,KG,INR
2026-10-29,Bangladesh,Milk,100,L,USD
2026-10-29,Bangladesh,Bad,abc,KG,BDT
`;

afterEach(() => {
  delete process.env.PRICE_HISTORY_CSV;
  resetHistoricalPriceLoader();
  clearStockCache();
});

describe("csv parsing", () => {
  it("handles quoted commas, escaped quotes and CRLF", () => {
    expect(parseCsv('a,"b ""q""",c\r\n1,2,3\n')).toEqual([
      ["a", 'b "q"', "c"],
      ["1", "2", "3"],
    ]);
  });
});

describe("units of measure", () => {
  it("converts grams and millilitres to kg and litres", () => {
    expect(parseUom("500 G")).toEqual({ base: "kg", quantityInBase: 0.5 });
    expect(parseUom("KG")).toEqual({ base: "kg", quantityInBase: 1 });
    expect(parseUom("500 ML")).toEqual({ base: "litre", quantityInBase: 0.5 });
  });

  it("rejects units that cannot be converted", () => {
    expect(parseUom("PCS")).toBeNull();
    expect(parseUom("bunch")).toBeNull();
  });
});

describe("price summaries", () => {
  it("computes a per-kg median and keeps only Bangladesh BDT rows", () => {
    const out = summarizeCommodityPrices(SAMPLE_CSV, { country: "Bangladesh" });
    const rice = out.find((c) => c.commodity === "Rice, medium");
    const lentil = out.find((c) => c.commodity === 'Lentil "red"');
    expect(rice?.unitPriceBdt).toBe(72);
    expect(rice?.sampleSize).toBe(3);
    // 250, 260 and 240 BDT per 500 g are 500, 520 and 480 per kg; the median is 500.
    expect(lentil?.unitPriceBdt).toBe(500);
    expect(out.some((c) => c.commodity === "Milk")).toBe(false); // USD skipped without a rate
    expect(out.some((c) => c.commodity === "Bad")).toBe(false);
  });

  it("converts USD rows when an exchange rate is given", () => {
    const csv = `date,adm0_name,commodity,price,uom,currency
2026-10-01,Bangladesh,Milk,1,L,USD
2026-10-08,Bangladesh,Milk,1,L,USD
2026-10-15,Bangladesh,Milk,1,L,USD
`;
    const out = summarizeCommodityPrices(csv, { country: "Bangladesh", usdToBdt: 120 });
    expect(out[0].unitPriceBdt).toBe(120);
  });

  it("drops commodities with too few samples and throws on a missing column", () => {
    expect(summarizeCommodityPrices(SAMPLE_CSV, { country: "Bangladesh", minSamples: 4 })).toEqual([]);
    expect(() => summarizeCommodityPrices("foo,bar\n1,2\n", { country: "Bangladesh" })).toThrow(/missing a date column/);
  });

  it("computes medians", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("historical mapping", () => {
  it("maps commodity names to catalog foods with the same unit", () => {
    const summaries = summarizeCommodityPrices(SAMPLE_CSV, { country: "Bangladesh" });
    const map = matchCommodities(
      summaries,
      [{ foodId: "rice_miniket", patterns: ["^rice\\b"] }, { foodId: "dal_masoor", patterns: ["lentil"] }],
      (id) => (id === "rice_miniket" ? "kg" : id === "dal_masoor" ? "litre" : undefined)
    );
    expect(map.get("rice_miniket")?.unitPriceBdt).toBe(72);
    expect(map.has("dal_masoor")).toBe(false); // lentil is kg, dal_masoor was declared litre
  });

  it("reads PRICE_HISTORY_CSV and feeds quoteBestPrice with the historical source", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prices-"));
    const file = path.join(dir, "prices.csv");
    fs.writeFileSync(file, SAMPLE_CSV);
    process.env.PRICE_HISTORY_CSV = file;
    resetHistoricalPriceLoader();
    ensureHistoricalPrices();

    const rice = food("rice_miniket");
    expect(getHistoricalPrice(rice.id)?.unitPriceBdt).toBe(72);
    const quote = quoteBestPrice(rice, 2);
    expect(quote.priceSource).toBe("historical_median");
    expect(quote.itemTotal).toBe(144);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the static benchmark when no file is configured", () => {
    const quote = quoteBestPrice(food("rice_miniket"), 2);
    expect(quote.priceSource).toBe("static_benchmark");
  });
});

describe("live retailer prices", () => {
  it("reads schema.org JSON-LD and converts the pack price to a unit price", () => {
    const html = `<html><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Miniket 5kg",
       "offers":{"@type":"Offer","price":"350.00","priceCurrency":"BDT","availability":"https://schema.org/InStock"}}
    </script></html>`;
    const offer = parseRetailerOffer(html);
    expect(offer).toEqual({ price: 350, currency: "BDT", inStock: true });
    expect(liveUnitPrice(food("rice_miniket"), offer)).toBe(70);
  });

  it("ignores non-BDT, out-of-stock and unsized items", () => {
    const inr = { price: 350, currency: "INR", inStock: true };
    const out = { price: 350, currency: "BDT", inStock: false };
    expect(liveUnitPrice(food("rice_miniket"), inr)).toBeNull();
    expect(liveUnitPrice(food("rice_miniket"), out)).toBeNull();
    const unsized = { ...food("rice_miniket"), retailerPackSize: undefined };
    expect(liveUnitPrice(unsized, { price: 350, currency: "BDT", inStock: true })).toBeNull();
  });

  it("returns null from malformed JSON-LD", () => {
    expect(parseRetailerOffer('<script type="application/ld+json">{nope</script>')).toBeNull();
  });

  it("prefers a live retailer price over historical and static prices", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prices-"));
    const file = path.join(dir, "prices.csv");
    fs.writeFileSync(file, SAMPLE_CSV);
    process.env.PRICE_HISTORY_CSV = file;
    resetHistoricalPriceLoader();
    ensureHistoricalPrices();

    const html = `<script type="application/ld+json">{"@type":"Product","offers":{"price":"350","priceCurrency":"BDT","availability":"InStock"}}</script>`;
    const url = "https://example.test/miniket";
    vi.stubGlobal("fetch", async () => new Response(`<h1>Miniket</h1><p>In stock</p>${html}`, { status: 200 }));
    const { getStockInfo } = await import("../src/lib/services/stock-check");
    await getStockInfo({ ...food("rice_miniket"), id: "rice_live_test", retailerUrl: url });
    const live = getCachedLivePrice("rice_live_test");
    expect(live?.unitPriceBdt).toBe(70);
    expect(quoteBestPrice({ ...food("rice_miniket"), id: "rice_live_test", retailerUrl: url }, 2).priceSource).toBe("live_retailer");
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });
});

describe("Nutritics mapping", () => {
  it("maps foods with numeric per-100g values and skips incomplete entries", () => {
    const foods = mapNutriticsFoods({
      foods: [
        { name: "Red lentil", per100g: { kcal: "340", protein: 24, carbs: 60, fat: 1, sodiumMg: 12 } },
        { name: "Incomplete", per100g: { kcal: 100 } },
        { per100g: { kcal: 1, protein: 1, carbs: 1, fat: 1 } },
      ],
    });
    expect(foods).toHaveLength(1);
    expect(foods[0].per100g.kcal).toBe(340);
    expect(foods[0].per100g.sodiumMg).toBe(12);
  });
});

describe("RAG knowledge base", () => {
  it("requires a real https source for every cited entry", () => {
    for (const doc of RAG_KNOWLEDGE_BASE) {
      if (doc.evidence === "cited") {
        expect(doc.sourceUrl, doc.id).toMatch(/^https:\/\//);
      } else {
        expect(doc.sourceUrl, doc.id).toBeNull();
      }
    }
  });

  it("has unique ids", () => {
    const ids = RAG_KNOWLEDGE_BASE.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
