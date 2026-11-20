import type { FoodItem } from "@/lib/sample-data";

const EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BN_DAYS = ["রবি", "সোম", "মঙ্গল", "বুধ", "বৃহ", "শুক্র", "শনি"];

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Consecutive days with at least one logged item, counting back from today. */
export function streakDays(foodDiary: FoodItem[], now: Date = new Date()): number {
  const today = dayKey(now);
  const loggedDays = new Set(foodDiary.map((f) => f.loggedOn ?? today));
  // If nothing is logged yet today, start counting from yesterday so the streak is not reset mid-day.
  let cursor = loggedDays.has(today) ? now : addDays(now, -1);
  let count = 0;
  while (loggedDays.has(dayKey(cursor))) {
    count++;
    cursor = addDays(cursor, -1);
  }
  return count;
}

export interface WeekBar {
  day: string;
  dayBn: string;
  value: number; // percent of daily calorie target, 0-100
}

/** Last seven days, oldest first. Empty days are 0. */
export function weeklyActivityFor(
  foodDiary: FoodItem[],
  dailyCal: number,
  now: Date = new Date()
): WeekBar[] {
  const target = Math.max(1, dailyCal);
  const bars: WeekBar[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(now, -i);
    const key = dayKey(d);
    const kcal = foodDiary
      .filter((f) => (f.loggedOn ?? dayKey(now)) === key)
      .reduce((sum, f) => sum + f.calories, 0);
    bars.push({
      day: EN_DAYS[d.getDay()],
      dayBn: BN_DAYS[d.getDay()],
      value: Math.min(100, Math.round((kcal / target) * 100)),
    });
  }
  return bars;
}

/** Macro split as percentages; all zero when nothing is logged. */
export function macroShares(protein: number, carbs: number, fat: number) {
  const total = protein + carbs + fat;
  if (total <= 0) return { protein: 0, carbs: 0, fat: 0 };
  const p = Math.round((protein / total) * 100);
  const c = Math.round((carbs / total) * 100);
  return { protein: p, carbs: c, fat: Math.max(0, 100 - p - c) };
}
