/**
 * Lists the commodity names in a price CSV for one country, with sample counts, so the regex
 * patterns in src/lib/data/commodity-map.json can be tuned to the file.
 *
 * Usage: node --experimental-strip-types scripts/inspect-price-csv.ts <file.csv> [country]
 */
import fs from "node:fs";
import { parseCsv } from "../src/lib/services/data-parsers.ts";

const [file, country = "Bangladesh"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: inspect-price-csv <file.csv> [country]");
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(file, "utf8"));
const header = rows[0].map((h) => h.trim().toLowerCase());
const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
const iCountry = col("adm0_name", "country", "admin0");
const iCommodity = col("commodity", "cm_name", "item", "product");
const iUom = col("uom", "unit", "cm_unit");

if (iCountry === -1 || iCommodity === -1) {
  console.error("Could not find country or commodity columns. Header:", header.join(", "));
  process.exit(1);
}

const counts = new Map<string, { n: number; uoms: Set<string> }>();
for (const r of rows.slice(1)) {
  if ((r[iCountry] ?? "").trim().toLowerCase() !== country.toLowerCase()) continue;
  const name = (r[iCommodity] ?? "").trim();
  const entry = counts.get(name) ?? { n: 0, uoms: new Set<string>() };
  entry.n++;
  if (iUom !== -1) entry.uoms.add((r[iUom] ?? "").trim());
  counts.set(name, entry);
}

const sorted = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`${sorted.length} commodities for ${country}:`);
for (const [name, { n, uoms }] of sorted) {
  console.log(`${String(n).padStart(6)}  ${name}  [${[...uoms].join(", ")}]`);
}
