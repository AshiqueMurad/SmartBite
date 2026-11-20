/**
 * Analytics calculations from the user's own food diary, weight log and targets.
 * Pure functions with no randomness: the same data always gives the same numbers.
 * Days with nothing logged are not counted in averages, so they never pull a number down.
 */

import { dayKey } from "@/lib/dashboard-metrics";
import type { FoodItem } from "@/lib/sample-data";

export type RangeKey = "week" | "month" | "quarter";
export const RANGE_DAYS: Record<RangeKey, number> = { week: 7, month: 30, quarter: 90 };

export interface WeightPoint {
  date: string; // YYYY-MM-DD
  kg: number;
}

export interface DayTotal {
  date: string;
  dow: number; // 0 = Sunday
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  logged: boolean;
}

/** A day counts as on target when its calories are within this share of the target. */
const ON_TARGET_BAND = 0.1;

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** One entry per day for the last `days` days, oldest first. */
export function dayTotals(foodDiary: FoodItem[], days: number, now: Date = new Date()): DayTotal[] {
  const today = dayKey(now);
  const byDay = new Map<string, { kcal: number; protein: number; carbs: number; fat: number; count: number }>();
  for (const f of foodDiary) {
    const key = f.loggedOn ?? today;
    const cur = byDay.get(key) ?? { kcal: 0, protein: 0, carbs: 0, fat: 0, count: 0 };
    cur.kcal += f.calories;
    cur.protein += f.protein;
    cur.carbs += f.carbs;
    cur.fat += f.fat;
    cur.count += 1;
    byDay.set(key, cur);
  }
  const out: DayTotal[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(now, -i);
    const key = dayKey(d);
    const v = byDay.get(key);
    out.push({
      date: key,
      dow: d.getDay(),
      kcal: Math.round(v?.kcal ?? 0),
      protein: Math.round(v?.protein ?? 0),
      carbs: Math.round(v?.carbs ?? 0),
      fat: Math.round(v?.fat ?? 0),
      logged: (v?.count ?? 0) > 0,
    });
  }
  return out;
}

export interface PeriodSummary {
  totalDays: number;
  loggedDays: number;
  avgKcal: number | null;
  avgProtein: number | null;
  onTargetDays: number;
  adherencePct: number | null;
  vsTargetPct: number | null; // negative = under target
  proteinVsTargetPct: number | null;
  macroSplitPct: { protein: number; carbs: number; fat: number } | null;
}

export function summarizePeriod(
  days: DayTotal[],
  target: number | null,
  proteinTarget: number | null
): PeriodSummary {
  const logged = days.filter((d) => d.logged);
  const n = logged.length;
  const hasTarget = target !== null && target > 0;
  if (n === 0) {
    return {
      totalDays: days.length,
      loggedDays: 0,
      avgKcal: null,
      avgProtein: null,
      onTargetDays: 0,
      adherencePct: null,
      vsTargetPct: null,
      proteinVsTargetPct: null,
      macroSplitPct: null,
    };
  }
  const sum = (k: "kcal" | "protein" | "carbs" | "fat") => logged.reduce((a, d) => a + d[k], 0);
  const avgKcal = Math.round(sum("kcal") / n);
  const avgProtein = Math.round(sum("protein") / n);
  const onTargetDays = hasTarget
    ? logged.filter((d) => Math.abs(d.kcal - target!) / target! <= ON_TARGET_BAND).length
    : 0;

  const pCal = sum("protein") * 4;
  const cCal = sum("carbs") * 4;
  const fCal = sum("fat") * 9;
  const totalCal = pCal + cCal + fCal;
  let macroSplitPct: PeriodSummary["macroSplitPct"] = null;
  if (totalCal > 0) {
    const protein = Math.round((pCal / totalCal) * 100);
    const carbs = Math.round((cCal / totalCal) * 100);
    macroSplitPct = { protein, carbs, fat: 100 - protein - carbs };
  }

  return {
    totalDays: days.length,
    loggedDays: n,
    avgKcal,
    avgProtein,
    onTargetDays,
    adherencePct: hasTarget ? Math.round((onTargetDays / n) * 100) : null,
    vsTargetPct: hasTarget ? Math.round(((avgKcal - target!) / target!) * 100) : null,
    proteinVsTargetPct:
      proteinTarget && proteinTarget > 0 ? Math.round((avgProtein / proteinTarget) * 100) : null,
    macroSplitPct,
  };
}

/** Consistency heatmap: 84 days, oldest first. Level 0 = not logged; 4 = within 10% of target. */
export interface HeatCell {
  date: string;
  dow: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export function consistencyGrid(foodDiary: FoodItem[], target: number | null, now: Date = new Date()) {
  const days = dayTotals(foodDiary, 84, now);
  const hasTarget = target !== null && target > 0;
  const cells: HeatCell[] = days.map((d) => {
    if (!d.logged) return { date: d.date, dow: d.dow, level: 0 };
    if (!hasTarget) return { date: d.date, dow: d.dow, level: 1 };
    const diff = Math.abs(d.kcal - target!) / target!;
    const level: 1 | 2 | 3 | 4 = diff <= 0.1 ? 4 : diff <= 0.2 ? 3 : diff <= 0.35 ? 2 : 1;
    return { date: d.date, dow: d.dow, level };
  });

  // Weekday with the most on-target days. Null when there are none.
  const onTargetByDow = [0, 0, 0, 0, 0, 0, 0];
  for (const c of cells) if (c.level >= 4) onTargetByDow[c.dow] += 1;
  const best = Math.max(...onTargetByDow);
  const bestDow = best > 0 ? onTargetByDow.indexOf(best) : null;

  return { cells, bestDow, loggedDays: cells.filter((c) => c.level > 0).length };
}

export interface WeightProgress {
  start: number;
  current: number;
  delta: number;
  goal: number | null;
  toGoal: number | null;
  onTrack: boolean | null;
}

/** Weight entries from the last `days` days, oldest first. */
export function weightWindow(log: WeightPoint[], days: number, now: Date = new Date()): WeightPoint[] {
  const start = dayKey(addDays(now, -(days - 1)));
  const end = dayKey(now);
  return log.filter((w) => w.date >= start && w.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function weightProgress(points: WeightPoint[], goal: number | null): WeightProgress | null {
  if (points.length === 0) return null;
  const start = points[0].kg;
  const current = points[points.length - 1].kg;
  const delta = round1(current - start);
  const toGoal = goal !== null ? round1(current - goal) : null;
  let onTrack: boolean | null = null;
  if (goal !== null && delta !== 0 && goal !== start) {
    onTrack = Math.sign(delta) === Math.sign(goal - start);
  }
  return { start, current, delta, goal, toGoal, onTrack };
}

export type InsightKind = "calorie" | "protein" | "streak" | "logging" | "weight";
export interface Insight {
  kind: InsightKind;
  text: string;
}

export function buildInsights(input: {
  summary: PeriodSummary;
  target: number | null;
  proteinTarget: number | null;
  goal: string | null;
  streak: number;
  weight: WeightProgress | null;
}): Insight[] {
  const { summary, target, proteinTarget, goal, streak, weight } = input;
  const out: Insight[] = [];

  if (summary.loggedDays === 0) {
    return [
      {
        kind: "logging",
        text: "Nothing is logged in this period yet. Scan a meal or add food to your diary to see insights based on your own data.",
      },
    ];
  }

  if (summary.vsTargetPct !== null && target !== null) {
    if (summary.vsTargetPct <= -10) {
      out.push({
        kind: "calorie",
        text: `You are averaging ${Math.abs(summary.vsTargetPct)}% under your ${target} kcal target${
          goal === "lose" ? ". That fits a weight-loss goal, as long as protein stays high" : ""
        }.`,
      });
    } else if (summary.vsTargetPct >= 10) {
      out.push({
        kind: "calorie",
        text: `You are averaging ${summary.vsTargetPct}% over your ${target} kcal target. Smaller portions at dinner would bring this closer.`,
      });
    } else {
      out.push({ kind: "calorie", text: `Your average is within 10% of your ${target} kcal target.` });
    }
  }

  if (summary.proteinVsTargetPct !== null && proteinTarget !== null && summary.avgProtein !== null) {
    if (summary.proteinVsTargetPct < 80) {
      out.push({
        kind: "protein",
        text: `Protein averages ${summary.avgProtein} g a day, ${summary.proteinVsTargetPct}% of your ${proteinTarget} g target. Add dal, eggs, fish or chicken to at least one meal.`,
      });
    } else {
      out.push({
        kind: "protein",
        text: `Protein averages ${summary.avgProtein} g a day, ${summary.proteinVsTargetPct}% of your ${proteinTarget} g target.`,
      });
    }
  }

  if (summary.totalDays > 0 && summary.loggedDays / summary.totalDays < 0.5) {
    out.push({
      kind: "logging",
      text: `You logged on ${summary.loggedDays} of ${summary.totalDays} days. Averages are more reliable with more logged days.`,
    });
  }

  if (streak >= 3) {
    out.push({ kind: "streak", text: `${streak}-day logging streak.` });
  }

  if (weight) {
    if (weight.toGoal !== null) {
      const remaining = Math.abs(weight.toGoal);
      if (weight.onTrack === true) {
        out.push({
          kind: "weight",
          text: `Weight is moving toward your goal (${weight.delta > 0 ? "+" : ""}${weight.delta} kg this period). ${remaining} kg to go.`,
        });
      } else if (weight.onTrack === false) {
        out.push({
          kind: "weight",
          text: `Weight is moving away from your goal (${weight.delta > 0 ? "+" : ""}${weight.delta} kg this period). Check the calorie trend above.`,
        });
      } else {
        out.push({ kind: "weight", text: `Current weight ${weight.current} kg, ${remaining} kg from your goal.` });
      }
    }
  } else {
    out.push({ kind: "weight", text: "Log your weight below to track progress toward your goal." });
  }

  return out;
}
