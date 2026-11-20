/**
 * Pure parsing helpers for external data: CSV price tables, schema.org product offers on retailer
 * pages, and Nutritics food responses. No imports and no I/O, so every function can be unit tested.
 */

export interface Per100g {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodiumMg: number | null;
}

export type BaseUnit = "kg" | "litre";

// ---------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, escaped quotes, CRLF or LF line endings)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((x) => x.trim() !== "")) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Units of measure, e.g. "KG", "500 G", "L", "500 ML". Returns how much of the base unit one
// listed quantity contains, so a price can be converted to a per-kg or per-litre price.
// ---------------------------------------------------------------------------

export function parseUom(uom: string): { base: BaseUnit; quantityInBase: number } | null {
  const m = uom
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)?\s*(kg|kgs|kilo|kilogram|kilograms|g|gm|gram|grams|l|ltr|litre|litres|liter|liters|ml)$/);
  if (!m) return null;
  const amount = m[1] ? Number(m[1]) : 1;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = m[2];
  if (["kg", "kgs", "kilo", "kilogram", "kilograms"].includes(unit)) return { base: "kg", quantityInBase: amount };
  if (["g", "gm", "gram", "grams"].includes(unit)) return { base: "kg", quantityInBase: amount / 1000 };
  if (["ml"].includes(unit)) return { base: "litre", quantityInBase: amount / 1000 };
  return { base: "litre", quantityInBase: amount };
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface CommodityPrice {
  commodity: string;
  base: BaseUnit;
  unitPriceBdt: number;
  sampleSize: number;
  windowStart: string;
  windowEnd: string;
}

export interface PriceSummaryOptions {
  /** Only rows whose country column equals this value are used, case-insensitively. */
  country: string;
  /** Used to convert USD rows to BDT. Rows in other currencies are skipped. */
  usdToBdt?: number;
  /** Days of history, counted back from the newest row for each commodity. */
  windowDays?: number;
  /** Commodities with fewer samples in the window are dropped. */
  minSamples?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function findColumn(header: string[], names: string[], label: string): number {
  const idx = header.findIndex((h) => names.includes(h));
  if (idx === -1) {
    throw new Error(`Price CSV is missing a ${label} column (looked for ${names.join(", ")}). Header: ${header.join(", ")}`);
  }
  return idx;
}

/**
 * Turns a long-format price table (one row per market observation) into a median unit price
 * per commodity. The window ends at each commodity's newest observation, so an old dataset still
 * yields a recent-looking benchmark, and the window is reported so the UI can show it.
 */
export function summarizeCommodityPrices(csvText: string, opts: PriceSummaryOptions): CommodityPrice[] {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());

  const iDate = findColumn(header, ["date", "mp_date"], "date");
  const iCountry = findColumn(header, ["adm0_name", "country", "admin0"], "country");
  const iCommodity = findColumn(header, ["commodity", "cm_name", "item", "product"], "commodity");
  const iPrice = findColumn(header, ["price", "mp_price", "value"], "price");
  const iUom = findColumn(header, ["uom", "unit", "cm_unit"], "unit of measure");
  const iCurrency = header.findIndex((h) => ["currency", "cur_name"].includes(h));

  const wanted = opts.country.trim().toLowerCase();
  type Point = { t: number; unitPrice: number };
  const groups = new Map<string, { commodity: string; base: BaseUnit; points: Point[] }>();

  for (const r of rows.slice(1)) {
    if ((r[iCountry] ?? "").trim().toLowerCase() !== wanted) continue;

    const price = Number((r[iPrice] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;

    const currency = iCurrency === -1 ? "BDT" : (r[iCurrency] ?? "").trim().toUpperCase();
    let priceBdt: number;
    if (currency === "BDT" || currency === "TK") priceBdt = price;
    else if (currency === "USD" && opts.usdToBdt && opts.usdToBdt > 0) priceBdt = price * opts.usdToBdt;
    else continue;

    const uom = parseUom(r[iUom] ?? "");
    if (!uom) continue;

    const t = Date.parse((r[iDate] ?? "").trim());
    if (!Number.isFinite(t)) continue;

    const commodity = (r[iCommodity] ?? "").trim();
    if (!commodity) continue;

    const key = `${commodity.toLowerCase()}|${uom.base}`;
    const g = groups.get(key) ?? { commodity, base: uom.base, points: [] };
    g.points.push({ t, unitPrice: priceBdt / uom.quantityInBase });
    groups.set(key, g);
  }

  const windowDays = opts.windowDays ?? 90;
  const minSamples = opts.minSamples ?? 3;
  const out: CommodityPrice[] = [];

  for (const g of groups.values()) {
    const newest = Math.max(...g.points.map((p) => p.t));
    const start = newest - windowDays * DAY_MS;
    const inWindow = g.points.filter((p) => p.t >= start && p.t <= newest);
    if (inWindow.length < minSamples) continue;

    const oldest = Math.min(...inWindow.map((p) => p.t));
    out.push({
      commodity: g.commodity,
      base: g.base,
      unitPriceBdt: Math.round(median(inWindow.map((p) => p.unitPrice)) * 100) / 100,
      sampleSize: inWindow.length,
      windowStart: new Date(oldest).toISOString().slice(0, 10),
      windowEnd: new Date(newest).toISOString().slice(0, 10),
    });
  }
  return out.sort((a, b) => b.sampleSize - a.sampleSize);
}

// ---------------------------------------------------------------------------
// Retailer product pages: schema.org Product / Offer in JSON-LD
// ---------------------------------------------------------------------------

export interface RetailerOffer {
  price: number;
  currency: string;
  /** null when the page does not state availability. */
  inStock: boolean | null;
}

function flattenJsonLd(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(flattenJsonLd);
  if (!node || typeof node !== "object") return [];
  const graph = Array.isArray(node["@graph"]) ? flattenJsonLd(node["@graph"]) : [];
  return [node, ...graph];
}

function hasType(node: any, type: string): boolean {
  const t = node?.["@type"];
  return Array.isArray(t) ? t.includes(type) : t === type;
}

/** Reads the first Product offer with a positive price from a page's JSON-LD, if any. */
export function parseRetailerOffer(html: string): RetailerOffer | null {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    for (const node of flattenJsonLd(data)) {
      if (!hasType(node, "Product")) continue;
      const offers: any[] = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
      for (const o of offers) {
        const price = Number(String(o.price ?? o.lowPrice ?? "").replace(/,/g, ""));
        if (!Number.isFinite(price) || price <= 0) continue;
        const availability = String(o.availability ?? "");
        const inStock = /InStock/i.test(availability) ? true : /OutOfStock|SoldOut|PreOrder/i.test(availability) ? false : null;
        return { price, currency: String(o.priceCurrency ?? "").trim().toUpperCase(), inStock };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nutritics. The response shape below is an assumption about the account's JSON, to be checked
// against the Nutritics documentation before relying on it. Fields that are missing are skipped.
// Expected shape: { foods: [ { name, allergens?: string[], per100g: { kcal, protein, carbs, fat,
//   fiber?, sugar?, sodiumMg? } } ] }
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface NutriticsFood {
  name: string;
  per100g: Per100g;
  allergens: string[];
}

export function mapNutriticsFoods(json: any): NutriticsFood[] {
  const foods: any[] = Array.isArray(json?.foods) ? json.foods : [];
  const out: NutriticsFood[] = [];
  for (const f of foods) {
    const name = String(f?.name ?? "").trim();
    const p = f?.per100g ?? {};
    const kcal = num(p.kcal);
    const protein = num(p.protein);
    const carbs = num(p.carbs);
    const fat = num(p.fat);
    if (!name || kcal === null || protein === null || carbs === null || fat === null) continue;
    out.push({
      name,
      per100g: {
        kcal,
        protein,
        carbs,
        fat,
        fiber: num(p.fiber) ?? 0,
        sugar: num(p.sugar) ?? 0,
        sodiumMg: num(p.sodiumMg),
      },
      allergens: Array.isArray(f.allergens) ? f.allergens.map(String) : [],
    });
  }
  return out;
}
