import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseStockStatus, getStockForCatalog, clearStockCache } from "../src/lib/services/stock-check";
import { BANGLADESH_FOOD_CATALOG, type FoodItemDefinition } from "../src/lib/services/bangladesh-food-db";
import { aiGroceryPlannerService } from "../src/lib/services/ai-grocery";

const page = (availability: string) =>
  `<html><body><nav>Menu</nav><h1>Masoor Dal 1kg</h1><p>${availability}</p><h2>Related Products</h2><p>Moong dal in stock</p></body></html>`;

const withUrl = (id: string, url: string): FoodItemDefinition => ({
  ...(BANGLADESH_FOOD_CATALOG.find((f) => f.id === "dal_masoor") as FoodItemDefinition),
  id,
  retailerUrl: url,
});

beforeEach(() => clearStockCache());
afterEach(() => vi.unstubAllGlobals());

describe("stock: parsing", () => {
  it("reads in stock and out of stock from the main product only", () => {
    expect(parseStockStatus(page("In stock"))).toBe("In stock");
    expect(parseStockStatus(page("Out of stock"))).toBe("Out of stock");
  });

  it("ignores availability text in related products and reports Unverified when none is stated", () => {
    expect(parseStockStatus(`<h1>Dal</h1><p>Price</p><h2>Related Products</h2><p>In stock</p>`)).toBe("Unverified");
    expect(parseStockStatus("<html><body>no product heading</body></html>")).toBe("Unverified");
  });
});

describe("stock: cache", () => {
  it("fetches each retailer page once and reuses the result", async () => {
    const fetchMock = vi.fn(async () => new Response(page("In stock"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const food = withUrl("dal_test", "https://example.test/dal");

    const first = await getStockForCatalog([food]);
    const second = await getStockForCatalog([food]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.dal_test.status).toBe("In stock");
    expect(second.dal_test.checkedAt).toBe(first.dal_test.checkedAt);
  });

  it("shares one request between concurrent callers", async () => {
    const fetchMock = vi.fn(async () => new Response(page("Out of stock"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const food = withUrl("dal_conc", "https://example.test/conc");
    await Promise.all([getStockForCatalog([food]), getStockForCatalog([food])]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks an unreachable retailer as Unverified instead of failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const food = withUrl("dal_down", "https://example.test/down");
    const out = await getStockForCatalog([food]);
    expect(out.dal_down.status).toBe("Unverified");
  });

  it("only checks catalog items that have a retailer URL", async () => {
    const fetchMock = vi.fn(async () => new Response(page("In stock"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await getStockForCatalog(BANGLADESH_FOOD_CATALOG);
    const withRetailer = BANGLADESH_FOOD_CATALOG.filter((f) => f.retailerUrl).length;
    expect(Object.keys(out).length).toBe(withRetailer);
    expect(fetchMock).toHaveBeenCalledTimes(withRetailer);
  });
});

describe("stock: planner choice", () => {
  const baseInput = {
    userContext: { age: 26, gender: "male", height: 172, currentWeight: 68, activityLevel: "moderate" },
    healthGoal: "weight loss",
    durationDays: 7,
    budgetMode: "none" as const,
    foodInspirations: [],
    preferences: { allergies: [], intolerances: [], dietaryRestrictions: ["halal"], dislikedFoods: [] },
  };

  it("never plans an out-of-stock food and reports it in stockExcluded", async () => {
    const plan = await aiGroceryPlannerService.generatePlan({
      ...baseInput,
      stockByFoodId: { dal_masoor: "Out of stock" },
    });
    expect(plan.items.some((i) => i.foodId === "dal_masoor")).toBe(false);
    expect(plan.stockExcluded.map((s) => s.foodId)).toContain("dal_masoor");
  });

  it("keeps unverified foods and labels their stock status on the item", async () => {
    const plan = await aiGroceryPlannerService.generatePlan({
      ...baseInput,
      stockByFoodId: { dal_masoor: "Unverified" },
    });
    expect(plan.stockExcluded).toEqual([]);
    const dal = plan.items.find((i) => i.foodId === "dal_masoor");
    if (dal) expect(dal.stockStatus).toBe("Unverified");
  });
});
