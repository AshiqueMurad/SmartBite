import { recognizeFoodsScored } from "@/lib/services/free-vision";
import { buildNutritionFromCaption, captionToLabels } from "@/lib/services/clip-nutrition";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { aiRateLimit } from "@/lib/auth/rate-limit";
import sharp from "sharp";
import { loadUserContext, describeUserContext } from "@/lib/services/user-context";
import { enrichIngredients } from "@/lib/services/nutrition-sources";
import { personalizeMeal } from "@/lib/services/personalization";
import type { ProfilePayload } from "@/lib/profile-payload";

export const runtime = "nodejs";
export const maxDuration = 60;

export interface Ingredient {
  name: string;
  quantity: string;
  calories: number;
}

export interface MealAnalysisResult {
  mealName: string;
  confidence: number; // 0-1
  totalCalories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  ingredients: Ingredient[];
  insights: string[];
  portionSize: string;
  provider?: string;
  isMenu?: boolean;
  glycemicImpact?: "low" | "medium" | "high";
  novaGroup?: number;
  dietaryPivot?: {
    orderSwap?: string;
    marketStaples?: string[];
  };
}

const SYSTEM_PROMPT = `You are SmartBite Nutrition Intelligence AI, an expert clinical nutrition analyst and culinary scientist. You analyze food photos, raw ingredients, or restaurant menus and return a precise, structured nutritional and metabolic report.

Your job:
1. Determine if the image contains food, drinks, edible ingredients, OR a restaurant menu. If a restaurant menu is detected, extract the featured dishes, identify the best metabolic options, and flag ultra-processed traps.
2. Identify the dish(es) and individual ingredients visible in the photo. If it is an arrangement of groceries, ingredients, or raw foods, accurately name the spread (e.g., "South Asian Whole Foods Spread", "Fresh Produce & Lean Protein Platter").
3. Estimate portion sizes realistically.
4. Calculate total calories and macronutrients (protein, carbs, fat, fiber, sugar) in grams.
5. Provide metabolic insights: estimated glycemic impact (low/medium/high), NOVA food processing category (1 = unprocessed, 4 = ultra-processed), and 2-4 contextual health insights referencing the actual detected items.
6. Suggest a "dietary pivot": a smart restaurant order swap or healthier local market staples to prepare at home.

Return ONLY a valid JSON object with this exact schema (no markdown, no commentary):
{
  "mealName": "string — concise dish name, ingredient platter name, or 'Menu: [Key Item]' (or 'Unknown' only if completely non-food)",
  "portionSize": "string — e.g. '1 plate (350g)' or '1 platter (600g)'",
  "confidence": number (0-1),
  "totalCalories": number,
  "protein": number (grams),
  "carbs": number (grams),
  "fat": number (grams),
  "fiber": number (grams),
  "sugar": number (grams),
  "isMenu": boolean,
  "glycemicImpact": "low" | "medium" | "high",
  "novaGroup": number (1 to 4),
  "ingredients": [
    { "name": "string", "quantity": "string", "calories": number }
  ],
  "insights": ["string", "string"],
  "dietaryPivot": {
    "orderSwap": "string — healthier ordering swap or preparation modification",
    "marketStaples": ["string", "string"]
  }
}

Guidelines:
- If the image contains zero food or menu content (e.g. pure code text, blank document, abstract logo with no food), return: {"mealName":"Unknown","portionSize":"","confidence":0,"totalCalories":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"sugar":0,"isMenu":false,"glycemicImpact":"low","novaGroup":1,"ingredients":[],"insights":["We could not identify food in this image. Please upload a clear photo of a meal, grocery ingredients, or a restaurant menu."]}
- Insights should reference actual detected content (e.g. "High in bioavailable protein from freshwater fish", "Refined grains cause rapid postprandial glucose spike").
- Never give medical advice. Frame insights as nutritional and metabolic observations.`;

function hasServerLLMKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY);
}

function buildSystemPrompt(userContext: string): string {
  if (!userContext) return SYSTEM_PROMPT;
  return (
    SYSTEM_PROMPT +
    "\n\nPERSONALIZATION (mandatory):\n" + userContext + "\n" +
    "Rules: compare this meal with the user's daily calorie and protein targets and say how it fits in at least one insight. " +
    "If any detected item matches an allergy, intolerance, or disliked food, add an insight starting with 'Allergy alert:' or 'Avoid:'. " +
    "Make dietaryPivot match the user's goal. Base every insight on items actually visible in the photo."
  );
}

async function normalizeImageToJpeg(dataUrl: string): Promise<{
  jpegBuffer: Buffer;
  jpegBase64: string;
  jpegDataUrl: string;
}> {
  const match = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/);
  const base64Raw = match ? match[1] : dataUrl;
  const inputBuffer = Buffer.from(base64Raw, "base64");

  const jpegBuffer = await sharp(inputBuffer)
    .rotate()
    .resize(800, 800, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  const jpegBase64 = jpegBuffer.toString("base64");
  const jpegDataUrl = `data:image/jpeg;base64,${jpegBase64}`;
  return { jpegBuffer, jpegBase64, jpegDataUrl };
}

async function callGeminiVision(jpegBase64: string, apiKey: string, systemPrompt: string): Promise<string> {
  const models = [
    process.env.GEMINI_MODEL,
    "gemini-flash-lite-latest",
    "gemini-3-flash-preview",
    "gemini-flash-latest",
  ].filter(Boolean) as string[];
  let lastErr: Error | null = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: "Analyze this photo of food or ingredients carefully. If it is a cooked meal, name the dish. If it is an arrangement of raw ingredients, groceries, or whole foods (e.g. avocado, eggs, meat, fish, berries, veggies), identify it accurately as a Whole Foods & Ingredient Spread and list all the ingredients you see with realistic quantities and nutrition. Return ONLY the valid JSON report.",
                },
                { inlineData: { mimeType: "image/jpeg", data: jpegBase64 } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastErr = new Error(`Gemini model ${model} error (${res.status}): ${errText.slice(0, 150)}`);
        continue;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastErr || new Error("Gemini Vision failed across candidate models");
}

async function callGroqVision(jpegDataUrl: string, apiKey: string, systemPrompt: string): Promise<string> {
  const model =
    process.env.GROQ_VISION_MODEL ||
    "meta-llama/llama-4-scout-17b-16e-instruct";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this meal photo and return the nutrition report as JSON.",
            },
            { type: "image_url", image_url: { url: jpegDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callOpenRouterVision(jpegDataUrl: string, apiKey: string, systemPrompt: string): Promise<string> {
  const model =
    process.env.OPENROUTER_VISION_MODEL || "google/gemini-2.0-flash-exp:free";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this meal photo and return the nutrition report as JSON.",
            },
            { type: "image_url", image_url: { url: jpegDataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter API error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * Step 1 of Free Keyless Vision Pipeline:
 * Uses Microsoft Florence-2 Vision model hosted on HuggingFace Spaces to generate
 * a rich, accurate visual description of the uploaded image.
 */
async function captionImageWithFlorence2(jpegBuffer: Buffer): Promise<string> {
  const spaces = [
    {
      host: "https://prithivmlmods-florence-2-image-caption.hf.space",
      endpoint: "/describe_image",
      buildPayload: (fileData: unknown) => [fileData, "Florence-2-base"],
    },
    {
      host: "https://prithivmlmods-florence2-vision-models.hf.space",
      endpoint: "/run_florence2_inference",
      buildPayload: (fileData: unknown) => [
        "Florence-2-base",
        fileData,
        "<MORE_DETAILED_CAPTION>",
        1024,
        3,
      ],
    },
  ];

  let lastError: Error | null = null;

  for (const space of spaces) {
    try {
      const form = new FormData();
      form.append(
        "files",
        new Blob([new Uint8Array(jpegBuffer)], { type: "image/jpeg" }),
        "meal.jpg"
      );

      const upRes = await fetch(`${space.host}/gradio_api/upload`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(4000),
      });
      if (!upRes.ok) {
        throw new Error(`Upload to ${space.host} failed (${upRes.status})`);
      }

      const upFiles = await upRes.json();
      const uploadedPath = upFiles?.[0];
      if (!uploadedPath) {
        throw new Error(`No file path returned from ${space.host}`);
      }

      const fileData = {
        path: uploadedPath,
        url: `${space.host}/gradio_api/file=${uploadedPath}`,
        orig_name: "meal.jpg",
        size: jpegBuffer.length,
        mime_type: "image/jpeg",
        meta: { _type: "gradio.FileData" },
      };

      const callRes = await fetch(
        `${space.host}/gradio_api/call${space.endpoint}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: space.buildPayload(fileData) }),
          signal: AbortSignal.timeout(4000),
        }
      );
      if (!callRes.ok) {
        throw new Error(`Call to ${space.endpoint} failed (${callRes.status})`);
      }

      const callJson = await callRes.json();
      if (!callJson?.event_id) {
        throw new Error(`Missing event_id from ${space.host}`);
      }

      const sseRes = await fetch(
        `${space.host}/gradio_api/call${space.endpoint}/${callJson.event_id}`,
        { signal: AbortSignal.timeout(4000) }
      );
      const sseText = await sseRes.text();

      for (const line of sseText.split("\n")) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6).trim();
          if (!payload || payload === "null") continue;
          const arr = JSON.parse(payload);
          if (Array.isArray(arr) && typeof arr[0] === "string" && arr[0].trim()) {
            return arr[0].trim();
          }
        }
      }
      throw new Error(`Empty caption from ${space.host}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.warn(`[scan-meal] Vision space ${space.host} failed:`, lastError.message);
    }
  }

  throw lastError || new Error("All free vision captioning endpoints failed");
}

const FOOD_KEYWORDS = [
  "food", "meal", "dish", "plate", "bowl", "salad", "soup", "chicken", "beef",
  "meat", "fish", "seafood", "shrimp", "prawn", "salmon", "tuna", "egg", "tofu",
  "paneer", "cheese", "milk", "yogurt", "curd", "rice", "biryani", "pulao",
  "khichuri", "bread", "toast", "roti", "chapati", "paratha", "naan", "pasta",
  "noodle", "spaghetti", "pizza", "burger", "sandwich", "wrap", "taco", "burrito",
  "fries", "potato", "sweet potato", "vegetable", "veggie", "greens", "lettuce",
  "spinach", "kale", "cabbage", "broccoli", "cauliflower", "carrot", "tomato",
  "cucumber", "onion", "garlic", "corn", "pea", "beans", "lentil", "dal", "daal",
  "chickpea", "chana", "curry", "bhuna", "masala", "stew", "gravy", "sauce",
  "fruit", "banana", "apple", "orange", "mango", "berry", "strawberry", "grape",
  "watermelon", "avocado", "lemon", "lime", "nut", "almond", "cashew", "walnut",
  "peanut", "seed", "pumpkin", "cake", "pastry", "cookie", "dessert", "ice cream",
  "chocolate", "pancake", "waffle", "oat", "porridge", "cereal", "coffee", "tea",
  "juice", "smoothie", "wine", "drink", "beverage", "steak", "pork", "lamb",
  "turkey", "duck", "sausage", "bacon", "sushi", "dumpling", "momo", "samosa",
];

const NON_FOOD_INDICATORS = [
  "screenshot", "webpage", "website", "homepage", "browser", "toolbar",
  "search bar", "menu bar", "text box", "dialog box", "button", "icon",
  "computer screen", "laptop", "smartphone", "source code", "diagram",
  "flowchart", "document", "invoice", "receipt",
];

function matchesWholeWord(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function isCaptionFoodRelated(caption: string): boolean {
  const hasNonFoodIndicator = NON_FOOD_INDICATORS.some((kw) =>
    matchesWholeWord(caption, kw)
  );
  if (hasNonFoodIndicator) return false;
  return FOOD_KEYWORDS.some((kw) => matchesWholeWord(caption, kw));
}

/**
 * Step 2A of Free Keyless Vision Pipeline:
 * Converts the Florence-2 visual description into the structured nutrition JSON
 * using Pollinations free OpenAI reasoning model (gpt-oss-20b).
 */
async function analyzeCaptionWithFreeLLM(visualDescription: string, systemPrompt: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    const res = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Visual description of the photo:\n${visualDescription}\n\nReturn ONLY the valid JSON nutrition report object.`,
          },
        ],
      }),
    });

    if (res.status === 429 || res.status === 402) {
      continue;
    }
    if (!res.ok) {
      throw new Error(`Pollinations LLM returned status ${res.status}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content && typeof content === "string") {
      return content;
    }
  }
  throw new Error("Free text LLM rate-limited");
}


function parseMealJson(rawContent: string): Partial<MealAnalysisResult> | null {
  let jsonStr = rawContent.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }
  const firstBrace = jsonStr.indexOf("{");
  const lastBrace = jsonStr.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;
  const limited = aiRateLimit(req, auth.userId, "scan-meal", { perUser: 20, perIp: 60 });
  if (limited) return limited;

  try {
    const body = await req.json();
    // Identity comes from the session. Any userId in the body is ignored.
    const { image, profile } = body as {
      profile?: ProfilePayload | null;
      image?: string;
      apiKey?: string;
      provider?: "gemini" | "groq" | "openrouter";
    };

    if (!image || typeof image !== "string") {
      return NextResponse.json(
        { error: "Image data is required (base64 data URL)." },
        { status: 400 }
      );
    }

    if (!image.startsWith("data:image/")) {
      return NextResponse.json(
        { error: "Image must be a base64 data URL." },
        { status: 400 }
      );
    }

    // Normalize any image format (AVIF, WebP, PNG, JPEG, etc.) to standard JPEG
    const { jpegBuffer, jpegBase64, jpegDataUrl } = await normalizeImageToJpeg(image);
    const userCtx = await loadUserContext(auth.userId, profile ?? null);
    const systemPrompt = buildSystemPrompt(describeUserContext(userCtx));

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return NextResponse.json({ success: false, error: "Food scanning is temporarily unavailable. Please try again later." }, { status: 503 });
    }
    let rawContent: string;
    const usedProvider = "gemini";
    try {
      rawContent = await callGeminiVision(jpegBase64, geminiKey, systemPrompt);
    } catch {
      return NextResponse.json({ success: false, error: "Gemini could not complete this scan. Please try again shortly." }, { status: 503 });
    }

    const parsed = parseMealJson(rawContent);
    if (!parsed) {
      return NextResponse.json(
        { success: false, error: "Could not parse meal nutrition response. Please try again." },
        { status: 500 }
      );
    }

    const sanitize = (v: unknown, fb: number) =>
      typeof v === "number" && !isNaN(v) ? Math.round(v) : fb;
    const sanitizeConfidence = (v: unknown, fb: number) =>
      typeof v === "number" && !isNaN(v) ? Math.min(1, Math.max(0, v)) : fb;

    const mealName = String(parsed.mealName || "Unknown").trim();
    const confidence = sanitizeConfidence(parsed.confidence, 0.85);
    const totalCalories = sanitize(parsed.totalCalories, 0);

    // Check if the image is not food
    if (
      mealName.toLowerCase() === "unknown" ||
      mealName.toLowerCase() === "not food" ||
      (confidence === 0 && totalCalories === 0)
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            parsed.insights?.[0] ||
            `We could not detect any food in this image. Please upload a clear photo of a meal.`,
        },
        { status: 422 }
      );
    }

    const isMenu = Boolean(parsed.isMenu || mealName.toLowerCase().startsWith("menu:"));
    const glycemicImpact =
      parsed.glycemicImpact === "high" || parsed.glycemicImpact === "medium" || parsed.glycemicImpact === "low"
        ? parsed.glycemicImpact
        : (sanitize(parsed.carbs, 0) > 45 && sanitize(parsed.fiber, 0) < 3)
        ? "high"
        : sanitize(parsed.carbs, 0) > 25
        ? "medium"
        : "low";

    const novaGroup =
      typeof parsed.novaGroup === "number" && parsed.novaGroup >= 1 && parsed.novaGroup <= 4
        ? parsed.novaGroup
        : isMenu
        ? 4
        : 1;

    const dietaryPivot = parsed.dietaryPivot && typeof parsed.dietaryPivot === "object"
      ? {
          orderSwap: String(parsed.dietaryPivot.orderSwap || "Choose grilled protein and leafy greens with minimal refined oil."),
          marketStaples: Array.isArray(parsed.dietaryPivot.marketStaples)
            ? parsed.dietaryPivot.marketStaples.map(String)
            : ["Sonali Chicken", "Lal Chaal", "Palong Shak", "Musur Dal"],
        }
      : undefined;

    const result: MealAnalysisResult = {
      mealName,
      portionSize: String(parsed.portionSize || "1 serving"),
      confidence,
      totalCalories,
      protein: sanitize(parsed.protein, 0),
      carbs: sanitize(parsed.carbs, 0),
      fat: sanitize(parsed.fat, 0),
      fiber: sanitize(parsed.fiber, 0),
      sugar: sanitize(parsed.sugar, 0),
      isMenu,
      glycemicImpact,
      novaGroup,
      dietaryPivot,
      ingredients: Array.isArray(parsed.ingredients)
        ? parsed.ingredients.map((ing) => ({
            name: String(ing.name || "Ingredient"),
            quantity: String(ing.quantity || "1 serving"),
            calories: sanitize(ing.calories, 0),
          }))
        : [],
      insights: Array.isArray(parsed.insights)
        ? parsed.insights.map((i) => String(i))
        : ["Analysis complete based on visual recognition."],
      provider: usedProvider,
    };

    // Live nutrition lookups and a personalized fit check against the user's own targets and rules.
    const ingredientNames = result.ingredients.map((i) => i.name);
    const sourcedNutrition = await enrichIngredients(ingredientNames);
    const personalization = personalizeMeal(
      {
        totalCalories: result.totalCalories,
        protein: result.protein,
        sugar: result.sugar,
        ingredientNames,
        sourced: sourcedNutrition,
      },
      userCtx
    );

    return NextResponse.json({
      success: true,
      result: {
        ...result,
        insights: [...personalization.notes, ...result.insights],
        personalization,
        sourcedNutrition,
      },
    });
  } catch (err) {
    console.error("[scan-meal] error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        success: false,
        error: `We couldn't analyze your image. ${message}`,
      },
      { status: 500 }
    );
  }
}
