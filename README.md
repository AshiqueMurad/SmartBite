# SmartBite

SmartBite is a nutrition coach for users in Bangladesh. It reads a photo of a meal, a restaurant menu, or a list of ingredients, estimates the nutrition, and shows a locally priced grocery basket that meets the user's calorie and protein targets within their allergy, diet, dislike, and budget rules. All user-facing text is available in English and Bangla.

## What it does

- **Meal scanning.** A photo is sent to a vision model. The server tries the user's own API key first, then the configured providers (Gemini, Groq, OpenRouter, and a free captioning endpoint). If none is available, a local CLIP model identifies up to 45 food labels and a nutrition table produces the estimate. Results include a confidence value (see *Limits*), NOVA processing group, and glycemic impact.
- **Dietary pivot.** For a scanned dish, the app retrieves the most relevant guideline entries (BM25 with stopword removal over a small curated knowledge base) and builds a market basket from the dish's ingredients. Foods that conflict with the user's allergies, intolerances, diet, or dislikes are excluded and listed. Savings are only shown when the user gives a real restaurant price. When a Gemini key is configured, the answer is personalized from the retrieved evidence. Each guideline entry shows its source link, or is labelled "general guidance" when no verified source exists.
- **Grocery planner.** The planner builds a basket for the user's health goal, duration, and budget. It searches over quantity changes, swaps, additions, and removals until daily kcal and protein are within ±10% of target, with the budget as a hard limit. Allergies, diets, and dislikes are enforced before the search. When the targets cannot be met, the result includes a `targetsUnmet` reason, which the UI shows.
- **Scanned items that do not match.** Each scanned or typed item is either matched to a catalog food by whole word, or reported with a reason: a prepared dish, not in the catalog, excluded by the user's settings, or out of stock.
- **Stock checks.** Catalog items with a retailer product URL are checked for stock. Results are cached for 15 minutes (2 minutes if unverified). Out-of-stock items are not planned. Prices come from the first source available for each item: a live retailer price (schema.org JSON-LD on the product page, converted using the pack size), then a historical median from a local Kaggle Global Food Prices export (see *Data sources*), then the static Dhaka benchmark table. Each price is labelled with its source.
- **Accounts and history.** Email and password sign-up. A signed, HTTP-only session cookie lasts 30 days. Users can save food preferences and grocery lists.
- **MCP tools.** `/api/mcp` exposes three tools for agents: `get_dietary_pivot`, `generate_localized_grocery_plan`, and `query_rag_nutrition_guidelines`. Calls require a signed-in session.

## Data sources

| Source | Used for | How it is enabled |
| --- | --- | --- |
| Nutritics | Localized nutrition lookup (tried first) | `NUTRITICS_SEARCH_URL` and `NUTRITICS_API_KEY`. The URL template comes from the account's Nutritics documentation. The response mapping in `data-parsers.ts` (`mapNutriticsFoods`) assumes a shape that must be checked against that documentation. |
| USDA FoodData Central | Raw and generic foods | `USDA_API_KEY` (defaults to `DEMO_KEY`) |
| Open Food Facts | Packaged products | Always on |
| Edamam | Recipe-level nutrition | `EDAMAM_APP_ID` and `EDAMAM_APP_KEY` |
| Retailer product pages | Live unit prices and stock | Always on for catalog items with `retailerUrl` and `retailerPackSize` |
| Kaggle Global Food Prices (CSV) | Historical median prices, Bangladesh | `PRICE_HISTORY_CSV`. Tune name matching with `npm run prices:inspect -- <file.csv>` and `src/lib/data/commodity-map.json`. |

Guideline entries in the RAG knowledge base are cited only when a verified https source is attached. A test enforces this.

## Tech stack

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Zustand, Prisma with PostgreSQL, ONNX Runtime (CLIP), Vitest.

## Getting started

Requirements: Node.js 20.9 or newer, and a PostgreSQL database (Neon, Supabase, or local).

```bash
npm install --legacy-peer-deps
cp .env.example .env         # then edit DATABASE_URL and AUTH_SECRET
npx prisma db push           # creates the tables in your database
npm run dev                  # http://localhost:3005
```

`npm run build` downloads the CLIP model files into `.vision/` (once), generates the Prisma client, and builds the app.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. Use `sslmode=require` on Neon and Supabase. |
| `AUTH_SECRET` | yes in production | At least 32 characters, used to sign session cookies. Generate with `openssl rand -base64 32`. |
| `GEMINI_API_KEY` | no | Enables Gemini for vision, dietary personalization, and the planner's tip text. |
| `GEMINI_MODEL` | no | Defaults to `gemini-flash-lite-latest`. |
| `GROQ_API_KEY`, `GROQ_VISION_MODEL` | no | Groq vision fallback. |
| `OPENROUTER_API_KEY`, `OPENROUTER_VISION_MODEL` | no | OpenRouter vision fallback. |

Users can also enter their own provider key in the scanner. It is sent only with that request and is kept in the browser's local storage.

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3005 (webpack). |
| `npm run build` | Downloads the CLIP model, generates the Prisma client, builds the app. |
| `npm start` | Starts the production server. |
| `npm test` | Runs the Vitest suite. |
| `npm run lint` | Runs ESLint. |
| `npm run db:push` | Applies the Prisma schema to the database (refuses changes that would drop data). |
| `npm run db:migrate` | Creates a Prisma migration in development. |

## API routes

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | none for sign-up and login (login is rate-limited) | Session cookie. |
| `POST /api/scan-meal` | session, 20/hour per user, 60/hour per IP | Photo to nutrition estimate. |
| `POST /api/dietary-pivot` | session, 30/hour per user, 90/hour per IP | Scanned dish to guideline-backed pivot and basket. |
| `POST /api/grocery/inspect-food` | session, 40/hour per user, 120/hour per IP | Photo or text to scanned food items. |
| `POST /api/grocery/generate` | session, 30/hour per user, 90/hour per IP | Grocery plan. |
| `GET`, `PUT /api/grocery/preferences` | session | Allergies, intolerances, diet, dislikes. |
| `GET`, `POST`, `DELETE /api/grocery/saved` | session | Saved grocery lists. Each user sees only their own. |
| `GET`, `POST /api/mcp` | session, 60/hour per user | Tool endpoint. |

The user is always taken from the session cookie. A `userId` in the request body or query string is ignored.

## Project layout

```
src/app/api/           Route handlers (see table above)
src/components/        Screens: scanner, shopping, dashboard, onboarding, and others
src/lib/services/      Planner (ai-grocery), basket optimizer, pivot and RAG (rag-nutrition),
                       CLIP nutrition fallback (clip-nutrition), catalog and matching
                       (bangladesh-food-db, ingredient-matcher), stock checks (stock-check)
src/lib/auth/          Session tokens, requireUser, rate limits, password hashing
prisma/schema.prisma   Database schema (PostgreSQL)
scripts/               prepare-vision.mjs downloads the CLIP model at build time
tests/                 Vitest suites: planner, catalog and matching, pivot, stock, CLIP fallback, security
```

## Tests

`npm test` runs about 70 tests:

- **Planner:** calorie and protein targets within ±10%, allergy and diet exclusions, budget limits, and the `targetsUnmet` reasons.
- **Pivot:** allergy, diet, and dislike filtering, savings only from a real price, NOVA classification, and whole-word matching.
- **Catalog and matching:** all 45 scanner labels are covered, plurals normalize, and "eggplant" never matches egg.
- **Stock:** HTML parsing, caching, and de-duplicated requests.
- **CLIP fallback:** plural matching, confidence, and user-context warnings.
- **Security:** every guarded route returns 401 without a valid session, identity comes only from the session, and rate limits apply.

## Limits

- **Stock is live for only three catalog items.** Only items with a `retailerUrl` are checked, and that is three of 52 items. The three HomeFreshBD URLs were not verified against the live site. If a URL is wrong, the item shows as unverified.
- **Prices are estimates.** Every price comes from the static Dhaka benchmark table. Nutrition values for the catalog and the CLIP fallback are per-serving approximations, not measured data.
- **Scan confidence is a heuristic.** It combines CLIP match strength with the share of detected items that have nutrition data. It is not a calibrated probability.
- **Guideline coverage is narrow.** The knowledge base has seven entries. The ICMR-NIN 2024 and NOVA (Monteiro 2019) links were checked against search results. The WHO salt link has not been checked. The main guideline is Indian (ICMR), not Bangladeshi. Bangladesh-specific guidance (BIRDEM) appears only as general guidance.
- **Rate limits are per process.** They are held in memory, so with several server instances each one keeps its own counts.
- **Schema changes use `db push`.** There is no migration history yet. Create one with `npm run db:migrate` before relying on it in production.
- **The demo account is in source.** Its credentials are in `src/lib/sample-data.ts` and shown on the sign-in page. Remove them before public launch.
- **Lint has five errors.** All are the React `set-state-in-effect` rule, in `ScannerScreen` and `ShoppingScreen`.

## Medical disclaimer

SmartBite is for nutrition planning and education. It is not medical advice and does not diagnose or treat any condition. People with diabetes, kidney disease, hypertension, or food allergies should consult a licensed doctor or registered dietitian before changing their diet.

## Deployment

`render.yaml` deploys the app to Render. Set `DATABASE_URL` in the Render dashboard. `AUTH_SECRET` is generated automatically. The start command runs `prisma db push` and then starts the server.
