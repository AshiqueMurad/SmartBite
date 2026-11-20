import { describe, it, expect } from "vitest";
import { buildNutritionFromCaption, captionToLabels, entriesFor, clipConfidence } from "../src/lib/services/clip-nutrition";
import type { UserContext } from "../src/lib/services/user-context";
import type { ProfilePayload } from "../src/lib/profile-payload";

const ctx = (over: Partial<UserContext> = {}): UserContext => ({
  profile: null, allergies: [], intolerances: [], dietaryRestrictions: [], dislikedFoods: [], ...over,
});
const profile = (over: Partial<ProfilePayload> = {}): ProfilePayload => ({
  gender: "male", age: 26, height: 172, currentWeight: 68, goalWeight: 65, activityLevel: "moderate",
  goal: "overall", dailyCalories: 2000, protein: 120, carbs: 200, fat: 60, ...over,
} as ProfilePayload);
const det = (labels: string[], score = 0.3) => labels.map((label) => ({ label, score }));

describe("CLIP fallback: plurals and exact words", () => {
  it("matches plural labels to their singular nutrition entries", () => {
    expect(entriesFor("eggs")[0]?.name).toBe("Hard-Boiled / Cooked Eggs");
    expect(entriesFor("potatoes")[0]?.name).toBe("Roasted Potatoes");
    expect(entriesFor("tomatoes")[0]?.name).toBe("Fresh Tomatoes");
    expect(entriesFor("mushrooms")[0]?.name).toBe("Mushrooms");
  });

  it("does not read eggplant as egg", () => {
    expect(entriesFor("eggplant").some((e) => e.name === "Hard-Boiled / Cooked Eggs")).toBe(false);
  });

  it("matches the flatbread label", () => {
    expect(entriesFor("flatbread")[0]?.name).toBe("Artisan Bread / Flatbread");
  });

  it("splits a text caption into phrases", () => {
    expect(captionToLabels("rice and dal, egg; salad").map((d) => d.label)).toEqual(["rice", "dal", "egg", "salad"]);
  });
});

describe("CLIP fallback: confidence", () => {
  it("is no longer a fixed 0.88", () => {
    const strong = buildNutritionFromCaption(det(["rice", "dal", "fish"], 0.34), ctx()).confidence;
    const weak = buildNutritionFromCaption(det(["rice", "dal", "fish"], 0.21), ctx()).confidence;
    expect(strong).not.toBe(0.88);
    expect(strong).toBeGreaterThan(weak);
  });

  it("falls to a low value when no label has nutrition data", () => {
    const r = buildNutritionFromCaption(det(["dragonfruit"], 0.3), ctx());
    expect(r.confidence).toBeLessThanOrEqual(0.2);
    expect(r.insights.join(" ")).toMatch(/generic estimate/);
  });

  it("is bounded between 0.1 and 0.9", () => {
    expect(clipConfidence(det(["rice"], 1), 1)).toBeLessThanOrEqual(0.9);
    expect(clipConfidence(det(["rice"], 0.2), 1)).toBeGreaterThanOrEqual(0.1);
  });

  it("names labels the table cannot value instead of silently dropping them", () => {
    const r = buildNutritionFromCaption(det(["rice", "dragonfruit"], 0.3), ctx());
    expect(r.insights.join(" ")).toMatch(/dragonfruit/);
  });
});

describe("CLIP fallback: user context", () => {
  it("warns when a detected food matches an allergy", () => {
    const r = buildNutritionFromCaption(det(["egg", "rice"]), ctx({ allergies: ["egg"] }));
    expect(r.insights.some((i) => /Warning: Hard-Boiled.*egg/.test(i))).toBe(true);
  });

  it("warns when a detected food breaks the user's diet", () => {
    const r = buildNutritionFromCaption(det(["chicken"]), ctx({ dietaryRestrictions: ["vegan"] }));
    expect(r.insights.some((i) => /does not fit your diet/.test(i))).toBe(true);
  });

  it("does not warn for foods that fit the user's rules", () => {
    const r = buildNutritionFromCaption(det(["lentil", "rice"]), ctx({ dietaryRestrictions: ["vegan"], allergies: ["egg"] }));
    expect(r.insights.some((i) => /Warning/.test(i))).toBe(false);
  });

  it("flags a meal above a third of the daily target for weight loss", () => {
    const r = buildNutritionFromCaption(det(["fish", "rice", "egg"]), ctx({ profile: profile({ goal: "lose", dailyCalories: 1200 }) }));
    expect(r.insights.some((i) => /above a third of your 1200 kcal/.test(i))).toBe(true);
  });

  it("flags low protein for a muscle-gain goal", () => {
    const r = buildNutritionFromCaption(det(["rice"]), ctx({ profile: profile({ goal: "muscle" }) }));
    expect(r.insights.some((i) => /low for your goal/.test(i))).toBe(true);
  });

  it("gives different output for different users", () => {
    const labels = det(["egg", "rice"]);
    const plain = buildNutritionFromCaption(labels, ctx());
    const allergic = buildNutritionFromCaption(labels, ctx({ allergies: ["egg"] }));
    expect(allergic.insights.join("|")).not.toBe(plain.insights.join("|"));
  });
});
