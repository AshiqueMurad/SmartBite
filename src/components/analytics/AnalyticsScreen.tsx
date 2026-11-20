"use client";

import React, { useMemo, useState } from "react";
import { BarChart3, Beef, Target, Award, Sparkles, Download, TrendingDown, TrendingUp, Flame } from "lucide-react";
import { AppShell } from "@/components/dashboard/AppShell";
import { Card } from "@/components/dashboard/Card";
import { useAppStore } from "@/store/useAppStore";
import { streakDays, weeklyActivityFor, dayKey } from "@/lib/dashboard-metrics";
import {
  RANGE_DAYS,
  type RangeKey,
  dayTotals,
  summarizePeriod,
  consistencyGrid,
  weightWindow,
  weightProgress,
  buildInsights,
} from "@/lib/analytics";
import { useI18n } from "@/components/providers/AppProvider";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/nutrition";
import { cn } from "@/lib/utils";

const HEAT_COLORS = ["#EEF1EE", "#B6D4C2", "#6FAE8B", "#2C7E5F", "#1E4D3B"];
const DOW_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const INSIGHT_ICONS = {
  calorie: TrendingDown,
  protein: Beef,
  streak: Award,
  logging: Sparkles,
  weight: Target,
} as const;

export function AnalyticsScreen() {
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const user = useAppStore((s) => s.user);
  const targets = useAppStore((s) => s.targets);
  const profile = useAppStore((s) => s.onboardingProfile);
  const foodDiary = useAppStore((s) => s.foodDiary);
  const weightLog = useAppStore((s) => s.weightLog) ?? [];
  const logWeight = useAppStore((s) => s.logWeight);
  const [range, setRange] = useState<RangeKey>("month");
  const [weightInput, setWeightInput] = useState("");
  const [weightError, setWeightError] = useState<string | null>(null);

  const days = RANGE_DAYS[range];
  const dailyCal = targets?.dailyCalories ?? null;
  const proteinGoal = targets?.protein ?? null;
  const goalWeight = profile?.goalWeight ?? null;

  const series = useMemo(() => dayTotals(foodDiary, days), [foodDiary, days]);
  const summary = useMemo(() => summarizePeriod(series, dailyCal, proteinGoal), [series, dailyCal, proteinGoal]);
  const weekly = useMemo(() => weeklyActivityFor(foodDiary, dailyCal ?? 2000), [foodDiary, dailyCal]);
  const grid = useMemo(() => consistencyGrid(foodDiary, dailyCal), [foodDiary, dailyCal]);
  const streak = streakDays(foodDiary);
  const weights = useMemo(() => weightWindow(weightLog, days), [weightLog, days]);
  const progress = useMemo(() => weightProgress(weights, goalWeight), [weights, goalWeight]);
  const insights = useMemo(
    () =>
      buildInsights({
        summary,
        target: dailyCal,
        proteinTarget: proteinGoal,
        goal: profile?.goal ?? null,
        streak,
        weight: progress,
      }),
    [summary, dailyCal, proteinGoal, profile, streak, progress]
  );

  // Calorie chart: plot logged days only, so empty days do not drop to zero.
  const W = 100;
  const H = 38;
  const loggedCals = series.filter((d) => d.logged).map((d) => d.kcal);
  const chartLo = Math.min(...loggedCals, dailyCal ?? Infinity) - 100;
  const chartHi = Math.max(...loggedCals, dailyCal ?? 0) + 100;
  const calPts = series
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.logged)
    .map(({ d, i }) => {
      const x = days > 1 ? (i / (days - 1)) * W : W / 2;
      const y = H - ((d.kcal - chartLo) / Math.max(1, chartHi - chartLo)) * H;
      return { x, y };
    });
  const calLine = calPts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const calArea =
    calPts.length > 1
      ? `${calPts[0].x.toFixed(2)},${H} ${calLine} ${calPts[calPts.length - 1].x.toFixed(2)},${H}`
      : "";
  const goalY = dailyCal ? H - ((dailyCal - chartLo) / Math.max(1, chartHi - chartLo)) * H : null;

  // Weight chart
  const wVals = weights.map((w) => w.kg);
  const wLo = wVals.length ? Math.min(...wVals) - 0.3 : 0;
  const wHi = wVals.length ? Math.max(...wVals) + 0.3 : 1;
  const wPts = weights.map((w, i) => {
    const x = weights.length > 1 ? (i / (weights.length - 1)) * W : W / 2;
    const y = H - ((w.kg - wLo) / Math.max(0.1, wHi - wLo)) * H;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  // Macro donut
  const macro = summary.macroSplitPct;
  const macroDist = [
    { label: lang === "bn" ? "প্রোটিন" : "Protein", pct: macro?.protein ?? 0, color: "#1E4D3B" },
    { label: lang === "bn" ? "শর্করা" : "Carbs", pct: macro?.carbs ?? 0, color: "#D4A843" },
    { label: lang === "bn" ? "চর্বি" : "Fat", pct: macro?.fat ?? 0, color: "#E06D53" },
  ];

  const kpis = [
    {
      label: "Avg Daily Calories",
      value: summary.avgKcal !== null ? formatNumber(summary.avgKcal) : "—",
      unit: t("common.kcal"),
      icon: Flame,
      color: "#1E4D3B",
      sub:
        summary.vsTargetPct === null
          ? "Set a target to compare"
          : summary.vsTargetPct < 0
          ? `${Math.abs(summary.vsTargetPct)}% under target`
          : `${summary.vsTargetPct}% over target`,
    },
    {
      label: "Avg Protein",
      value: summary.avgProtein !== null ? formatNumber(summary.avgProtein) : "—",
      unit: t("common.grams"),
      icon: Beef,
      color: "#D4A843",
      sub: summary.proteinVsTargetPct !== null ? `${summary.proteinVsTargetPct}% of target` : "—",
    },
    {
      label: "Goal Adherence",
      value: summary.adherencePct !== null ? `${summary.adherencePct}` : "—",
      unit: summary.adherencePct !== null ? t("common.percent") : "",
      icon: Target,
      color: "#E06D53",
      sub: `${summary.onTargetDays}/${summary.loggedDays} logged days within 10% of target`,
    },
    {
      label: t("dash.streak.title"),
      value: String(streak),
      unit: t("dash.streak.days"),
      icon: Award,
      color: "#E8940A",
      sub: "ACTIVE STREAK",
    },
  ];

  const rangeTabs: { id: RangeKey; en: string; bn: string }[] = [
    { id: "week", en: "Week", bn: "সপ্তাহ" },
    { id: "month", en: "Month", bn: "মাস" },
    { id: "quarter", en: "3 Months", bn: "৩ মাস" },
  ];

  const submitWeight = () => {
    const kg = Number(weightInput);
    if (!Number.isFinite(kg) || kg < 30 || kg > 250) {
      setWeightError("Enter a weight between 30 and 250 kg.");
      return;
    }
    setWeightError(null);
    logWeight(kg);
    setWeightInput("");
    toast({ title: "Weight logged", description: `${kg} kg saved for today.` });
  };

  const exportReport = () => {
    const rows = ["date,calories,protein_g,carbs_g,fat_g,logged", ...series.map((d) => [d.date, d.kcal, d.protein, d.carbs, d.fat, d.logged ? 1 : 0].join(","))];
    rows.push("", "date,weight_kg", ...weights.map((w) => `${w.date},${w.kg}`));
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smartbite-${range}-${dayKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Report exported", description: `${days} days exported as CSV.` });
  };

  return (
    <AppShell activeView="analytics" urlPath="smartbite.ai/analytics">
      <div className="p-4 sm:p-6 lg:p-7 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[#2C7E8F] to-[#1E4D3B] flex items-center justify-center shadow-sm">
              <BarChart3 className="h-5 w-5 text-white" strokeWidth={2} />
            </div>
            <div>
              <h1 className="font-jakarta text-2xl sm:text-3xl font-extrabold text-[#162623] tracking-tight">{t("sidebar.analytics")}</h1>
              <p className="text-sm text-[#4A5A55] mt-0.5">{user?.fullName?.split(" ")[0] ?? "there"}&apos;s nutrition progress, from your own logs.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 p-1 rounded-full bg-white border border-[#DCE4E1] shadow-sm">
              {rangeTabs.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRange(r.id)}
                  className={cn(
                    "px-3 h-8 rounded-full text-xs font-semibold transition-colors",
                    range === r.id ? "bg-[#1E4D3B] text-white" : "text-[#4A5A55] hover:text-[#162623]"
                  )}
                >
                  {lang === "bn" ? r.bn : r.en}
                </button>
              ))}
            </div>
            <button
              onClick={exportReport}
              className="flex items-center gap-2 px-4 h-11 rounded-full bg-[#1E4D3B] text-white text-sm font-semibold shadow-sm hover:bg-[#163A2C]"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>

        {!targets && (
          <Card className="bg-[#FFF7E6] p-4 mb-4 border-[#E8940A]/20">
            <p className="text-sm text-[#4A5A55]">Complete onboarding to compare your intake with your personal calorie and protein targets.</p>
          </Card>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {kpis.map((k) => {
            const Icon = k.icon;
            return (
              <Card key={k.label} className="bg-white p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${k.color}1A` }}>
                    <Icon className="h-4 w-4" strokeWidth={2} style={{ color: k.color }} />
                  </span>
                </div>
                <div className="text-[11px] text-[#4A5A55] uppercase tracking-wide">{k.label}</div>
                <div className="font-jakarta text-2xl font-extrabold text-[#162623] tabular-nums leading-tight mt-0.5">
                  {k.value} <span className="text-xs font-medium text-[#4A5A55]">{k.unit}</span>
                </div>
                <div className="text-[10px] text-[#1E4D3B] font-semibold mt-1">{k.sub}</div>
              </Card>
            );
          })}
        </div>

        {/* Calorie trend */}
        <Card className="bg-white p-5 mb-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-jakarta text-base font-extrabold text-[#162623]">Calorie Trend</h3>
              <p className="text-[11px] text-[#4A5A55]">
                {summary.loggedDays} of {days} days logged
                {summary.avgKcal !== null ? ` · avg ${formatNumber(summary.avgKcal)} kcal` : ""}
                {dailyCal ? ` · target ${formatNumber(dailyCal)}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1.5 text-[#4A5A55]"><span className="w-2.5 h-2.5 rounded-full bg-[#1E4D3B]" /> Consumed</span>
              <span className="flex items-center gap-1.5 text-[#4A5A55]"><span className="w-2.5 h-0.5 bg-[#E06D53]" /> Target</span>
            </div>
          </div>
          {calPts.length < 2 ? (
            <div className="h-[180px] flex items-center justify-center text-sm text-[#4A5A55] text-center px-6">
              Log meals on at least two days in this range to see your trend.
            </div>
          ) : (
            <div className="relative w-full" style={{ height: 180 }}>
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full">
                <defs>
                  <linearGradient id="calArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#1E4D3B" stopOpacity="0.32" />
                    <stop offset="100%" stopColor="#1E4D3B" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                {[0.25, 0.5, 0.75].map((g) => (
                  <line key={g} x1="0" y1={H * g} x2={W} y2={H * g} stroke="#EEF1EE" strokeWidth="0.3" />
                ))}
                {goalY !== null && <line x1="0" y1={goalY} x2={W} y2={goalY} stroke="#E06D53" strokeWidth="0.5" strokeDasharray="2 1.5" />}
                <polygon points={calArea} fill="url(#calArea)" />
                <polyline points={calLine} fill="none" stroke="#1E4D3B" strokeWidth="0.7" strokeLinejoin="round" />
              </svg>
            </div>
          )}
          <div className="flex justify-between text-[10px] text-[#4A5A55] mt-1">
            <span>{series[0]?.date}</span>
            <span>{series[series.length - 1]?.date}</span>
          </div>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          {/* Macro distribution donut */}
          <Card className="bg-white p-5">
            <h3 className="font-jakarta text-base font-extrabold text-[#162623] mb-1">Macro Distribution</h3>
            <p className="text-[11px] text-[#4A5A55] mb-2">Share of calories, logged days in this period</p>
            <div className="relative w-40 h-40 mx-auto my-2">
              <svg viewBox="0 0 80 80" className="w-full h-full -rotate-90">
                <circle cx="40" cy="40" r="32" fill="none" stroke="#EEF1EE" strokeWidth="9" />
                {(() => {
                  const C = 2 * Math.PI * 32;
                  let acc = 0;
                  return macroDist.map((m) => {
                    const dash = (m.pct / 100) * C;
                    const offset = -acc * C;
                    acc += m.pct / 100;
                    return (
                      <circle key={m.label} cx="40" cy="40" r="32" fill="none" stroke={m.color} strokeWidth="9"
                        strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={offset} />
                    );
                  });
                })()}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[10px] text-[#4A5A55] uppercase tracking-wide">Avg</span>
                <span className="font-jakarta text-lg font-extrabold text-[#162623] tabular-nums">
                  {summary.avgKcal !== null ? formatNumber(summary.avgKcal) : "—"}
                </span>
                <span className="text-[9px] text-[#4A5A55]">{t("common.kcal")}</span>
              </div>
            </div>
            <div className="space-y-1.5 mt-2">
              {macroDist.map((m) => (
                <div key={m.label} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: m.color }} />
                  <span className="text-[11px] text-[#4A5A55] flex-1">{m.label}</span>
                  <span className="text-[11px] font-bold text-[#162623] tabular-nums">{m.pct}{t("common.percent")}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Weekly activity bars: % of calorie target logged per day, last 7 days */}
          <Card className="bg-white p-5">
            <h3 className="font-jakarta text-base font-extrabold text-[#162623] mb-1">{t("dash.streak.weekly")}</h3>
            <p className="text-[11px] text-[#4A5A55] mb-3">Calories logged each day, as % of your target</p>
            <div className="flex items-end justify-between gap-2 h-40">
              {weekly.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                  <span className="text-[9px] font-bold text-[#162623] tabular-nums">{d.value}</span>
                  <div className="w-full flex flex-col justify-end rounded-t-full overflow-hidden" style={{ height: "78%" }}>
                    <div className="w-full rounded-t-full bg-[#1E4D3B]" style={{ height: `${d.value}%` }} />
                  </div>
                  <span className="text-[10px] font-semibold text-[#4A5A55]">{lang === "bn" ? d.dayBn : d.day}</span>
                </div>
              ))}
            </div>
          </Card>

          {/* Weight progress, from the user's own log */}
          <Card className="bg-white p-5">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-jakarta text-base font-extrabold text-[#162623]">Weight Progress</h3>
              {progress && progress.delta !== 0 && (
                <span className={cn("flex items-center gap-1 text-[11px] font-bold", progress.onTrack === false ? "text-[#E06D53]" : "text-[#1E4D3B]")}>
                  {progress.delta < 0 ? <TrendingDown className="h-3.5 w-3.5" /> : <TrendingUp className="h-3.5 w-3.5" />}
                  {progress.delta > 0 ? "+" : ""}{progress.delta} kg
                </span>
              )}
            </div>
            {progress ? (
              <>
                <p className="text-[11px] text-[#4A5A55] mb-2">
                  {progress.start} kg → {progress.current} kg{goalWeight ? ` · goal ${goalWeight} kg` : ""}
                </p>
                <div className="relative w-full" style={{ height: 130 }}>
                  {wPts.length > 1 ? (
                    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-full">
                      <polyline points={wPts.join(" ")} fill="none" stroke="#2C7E8F" strokeWidth="0.8" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-[#4A5A55] text-center">
                      Log another weight to see a line.
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 pt-3 border-t border-[#DCE4E1]">
                  <div><div className="text-[10px] text-[#4A5A55] uppercase">Start</div><div className="text-sm font-bold text-[#162623] tabular-nums">{progress.start}kg</div></div>
                  <div><div className="text-[10px] text-[#4A5A55] uppercase">Current</div><div className="text-sm font-bold text-[#1E4D3B] tabular-nums">{progress.current}kg</div></div>
                  <div><div className="text-[10px] text-[#4A5A55] uppercase">Goal</div><div className="text-sm font-bold text-[#162623] tabular-nums">{goalWeight ?? "—"}{goalWeight ? "kg" : ""}</div></div>
                </div>
              </>
            ) : (
              <p className="text-sm text-[#4A5A55] py-6">No weight logged in this period.</p>
            )}
            <form
              className="flex gap-2 mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                submitWeight();
              }}
            >
              <input
                type="number"
                step="0.1"
                inputMode="decimal"
                placeholder="Today's weight (kg)"
                value={weightInput}
                onChange={(e) => setWeightInput(e.target.value)}
                className="flex-1 min-w-0 rounded-xl border border-[#DCE4E1] px-3 py-2 text-sm text-[#162623] focus:outline-none focus:ring-2 focus:ring-[#2C7E8F]/40"
              />
              <button type="submit" className="px-4 rounded-xl bg-[#1E4D3B] text-white text-sm font-semibold hover:bg-[#163A2C]">
                Log
              </button>
            </form>
            {weightError && <p className="text-xs text-red-600 mt-1">{weightError}</p>}
          </Card>
        </div>

        {/* Consistency heatmap + insights */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="bg-white p-5 lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-jakarta text-base font-extrabold text-[#162623]">Consistency</h3>
                <p className="text-[11px] text-[#4A5A55]">Last 12 weeks · darker means closer to your calorie target</p>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-[#4A5A55]">
                <span>Logged, off target</span>
                {HEAT_COLORS.slice(1).map((c) => (
                  <span key={c} className="w-3 h-3 rounded-sm" style={{ backgroundColor: c }} />
                ))}
                <span>On target</span>
              </div>
            </div>
            <div className="flex gap-1 overflow-x-auto scroll-soft pb-1">
              {Array.from({ length: 12 }).map((_, w) => (
                <div key={w} className="flex flex-col gap-1">
                  {Array.from({ length: 7 }).map((_, d) => {
                    const cell = grid.cells[w * 7 + d];
                    if (!cell) return <span key={d} className="w-3.5 h-3.5" />;
                    return (
                      <span
                        key={d}
                        className="w-3.5 h-3.5 rounded-sm"
                        style={{ backgroundColor: HEAT_COLORS[cell.level] }}
                        title={`${cell.date}${cell.level === 0 ? " · not logged" : ""}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-[#DCE4E1]">
              <div>
                <div className="text-[10px] text-[#4A5A55] uppercase tracking-wide">Best Day</div>
                <div className="text-sm font-bold text-[#162623]">{grid.bestDow !== null ? DOW_EN[grid.bestDow] : "—"}</div>
              </div>
              <div>
                <div className="text-[10px] text-[#4A5A55] uppercase tracking-wide">Logged Days</div>
                <div className="text-sm font-bold text-[#162623]">{grid.loggedDays} / 84</div>
              </div>
              <div>
                <div className="text-[10px] text-[#4A5A55] uppercase tracking-wide">Current Streak</div>
                <div className="text-sm font-bold text-[#1E4D3B]">{streak} days</div>
              </div>
            </div>
          </Card>

          <Card className="bg-gradient-to-br from-[#FFF7E6] to-[#FBEED1] p-5 border-[#E8940A]/20">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-[#E8940A] flex items-center justify-center">
                <Sparkles className="h-4 w-4 text-white" strokeWidth={2} />
              </div>
              <h3 className="font-jakarta text-base font-extrabold text-[#162623]">{t("dash.insights.title")}</h3>
            </div>
            <div className="space-y-3">
              {insights.map((ins, i) => {
                const Icon = INSIGHT_ICONS[ins.kind];
                return (
                  <div key={i} className="flex gap-2">
                    <Icon className="h-4 w-4 text-[#1E4D3B] flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-[#4A5A55] leading-relaxed">{ins.text}</p>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="h-6" />
      </div>
    </AppShell>
  );
}
