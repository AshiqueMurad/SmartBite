import type { CleanGroceryItem } from "./pricing-engine";
import type { StockInfo, StockStatus } from "./stock-check";

export interface BasketOffer {
  name: string;
  url: string;
  stock: StockStatus;
  checkedAt: string;
}

/**
 * Builds the basket tip and the retailer stock lines for items in the basket. Stock comes from
 * the cached stock checker, so this function makes no retailer requests of its own.
 */
export async function buildBasketContext(
  items: CleanGroceryItem[],
  goal: string,
  stockByFoodId: Record<string, StockInfo>
): Promise<{ tip: string; offers: BasketOffer[] }> {
  const offers: BasketOffer[] = items
    .filter((item) => stockByFoodId[item.foodId])
    .map((item) => {
      const info = stockByFoodId[item.foodId];
      return { name: item.genericName, url: info.url, stock: info.status, checkedAt: info.checkedAt };
    });

  // Retrieve general dietary guidance by goal before asking for a basket-specific example.
  const guidance = /sugar|diabet|glycemic/i.test(goal) ? "Limit added sugar and sweetened drinks."
    : /pressure|sodium|heart/i.test(goal) ? "Limit salt and salty condiments."
    : "Include foods from several food groups at each meal.";
  let tip = guidance;
  const key = process.env.GEMINI_API_KEY;
  if (key && items.length) {
    try {
      const model = encodeURIComponent(process.env.GEMINI_MODEL || "gemini-flash-lite-latest");
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(6500),
        body: JSON.stringify({ contents: [{ parts: [{ text: "Write one short general meal suggestion in English using only the listed foods and this Bangladesh dietary guideline. Avoid medical claims. Guideline: " + guidance + " Foods: " + items.map(i => i.genericName).join(", ") }] }] }),
      });
      if (response.ok) tip = (await response.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() || guidance;
    } catch { /* The retrieved guideline remains available without generation. */ }
  }
  return { tip, offers };
}
