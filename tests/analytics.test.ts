import { describe, it, expect } from "vitest";
import { dayTotals, summarizePeriod, weightProgress, weightWindow, buildInsights, consistencyGrid } from "@/lib/analytics";
import { dayKey } from "@/lib/dashboard-metrics";

const now = new Date(2026, 10, 20, 12); // 20 Nov 2026, local time
const item = (loggedOn: string, calories: number, protein = 0, carbs = 0, fat = 0) =>
  ({ id: loggedOn + calories, loggedOn, calories, protein, carbs, fat } as any);

describe("dayTotals", () => {
  it("sums each day and marks empty days as not logged", () => {
    const days = dayTotals([item(dayKey(now), 500, 30), item(dayKey(now), 300, 10)], 3, now);
    expect(days[2].kcal).toBe(800);
    expect(days[2].protein).toBe(40);
    expect(days[2].logged).toBe(true);
    expect(days[0].logged).toBe(false);
  });
});

describe("summarizePeriod", () => {
  it("averages only logged days, not empty ones", () => {
    const diary = [item(dayKey(now), 2000), item(dayKey(new Date(2026, 10, 19)), 1800)];
    const s = summarizePeriod(dayTotals(diary, 7, now), 2000, 150);
    expect(s.loggedDays).toBe(2);
    expect(s.avgKcal).toBe(1900);
    expect(s.onTargetDays).toBe(2); // 1800 is exactly 10% under 2000
  });

  it("returns nulls when nothing is logged", () => {
    const s = summarizePeriod(dayTotals([], 7, now), 2000, 150);
    expect(s.avgKcal).toBeNull();
    expect(s.macroSplitPct).toBeNull();
  });
});

describe("weightProgress", () => {
  it("reports direction toward the goal", () => {
    const pts = [{ date: "2026-11-01", kg: 80 }, { date: "2026-11-20", kg: 78 }];
    const p = weightProgress(pts, 75)!;
    expect(p.delta).toBe(-2);
    expect(p.onTrack).toBe(true);
    expect(p.toGoal).toBe(3);
  });

  it("filters the window and sorts by date", () => {
    const pts = [{ date: "2026-11-20", kg: 78 }, { date: "2026-08-01", kg: 90 }, { date: "2026-11-10", kg: 79 }];
    expect(weightWindow(pts, 30, now).map((p) => p.kg)).toEqual([79, 78]);
  });
});

describe("buildInsights", () => {
  it("asks for logging when nothing is recorded", () => {
    const s = summarizePeriod(dayTotals([], 7, now), 2000, 150);
    const out = buildInsights({ summary: s, target: 2000, proteinTarget: 150, goal: "lose", streak: 0, weight: null });
    expect(out[0].kind).toBe("logging");
  });

  it("uses the user's own numbers in the text", () => {
    const diary = [item(dayKey(now), 1500, 40)];
    const s = summarizePeriod(dayTotals(diary, 7, now), 2000, 150);
    const out = buildInsights({ summary: s, target: 2000, proteinTarget: 150, goal: "lose", streak: 1, weight: null });
    expect(out.find((i) => i.kind === "calorie")!.text).toContain("25%");
    expect(out.find((i) => i.kind === "protein")!.text).toContain("150 g target");
  });
});

describe("consistencyGrid", () => {
  it("marks on-target days at the top level and picks a best weekday", () => {
    const g = consistencyGrid([item(dayKey(now), 2000)], 2000, now);
    expect(g.cells[g.cells.length - 1].level).toBe(4);
    expect(g.bestDow).toBe(now.getDay());
  });
});
