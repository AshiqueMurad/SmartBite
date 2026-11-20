"use client";

import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ShoppingBasket,
  Sparkles,
  Trash2,
  Check,
  AlertCircle,
  Info,
  Calendar,
  Wallet,
  ArrowRight,
  RefreshCw,
  Save,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  X,
  SlidersHorizontal,
  Flame,
  Beef,
  Wheat,
  Droplet,
  History,
  Copy,
  Printer,
  ShieldAlert,
} from "lucide-react";
import { AppShell } from "@/components/dashboard/AppShell";
import { useAppStore } from "@/store/useAppStore";
import { useI18n } from "@/components/providers/AppProvider";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { CleanGroceryItem } from "@/lib/services/pricing-engine";
import { evaluateTargetsUnmet, type GroceryPlanResult } from "@/lib/services/ai-grocery";
import { calculateBasketNutrition } from "@/lib/services/nutrition-calc";

type ActiveTab = "planner" | "review" | "history";

interface SavedListSummary {
  id: string;
  title: string;
  durationDays: number;
  budgetMode: string;
  actualCost: number;
  healthGoal?: string;
  compromisesMade?: string;
  dailyCalories: number;
  dailyProtein: number;
  dailyCarbs: number;
  dailyFat: number;
  createdAt: string;
  items: CleanGroceryItem[];
}

export function ShoppingScreen() {
  const { t, lang } = useI18n();
  const setView = useAppStore((s) => s.setView);
  const user = useAppStore((s) => s.user);
  const profile = useAppStore((s) => s.onboardingProfile);
  const targets = useAppStore((s) => s.targets);
  const stagedVisionItems = useAppStore((s) => s.stagedVisionItems);
  // Items handed over from a camera scan. Copied here so the store can be cleared while they still feed the plan.
  const [visionItems, setVisionItems] = useState<string[]>([]);
  const stagedDietaryPivot = useAppStore((s) => s.stagedDietaryPivot);
  const clearStagedVision = useAppStore((s) => s.clearStagedVision);
  const { toast } = useToast();

  const [tab, setTab] = useState<ActiveTab>("planner");

  // Form Inputs
  const [healthGoal, setHealthGoal] = useState(
    "High-protein muscle recovery and balanced energy on a budget, avoiding refined sugar."
  );
  const [durationDays, setDurationDays] = useState(7);
  const [customDays, setCustomDays] = useState("");
  const [budgetMode, setBudgetMode] = useState<"max" | "cheapest" | "none">("max");
  const [budgetLimitBdt, setBudgetLimitBdt] = useState<number | string>(2200);

  // Preferences & Health Settings
  const [showPreferencesModal, setShowPreferencesModal] = useState(false);
  const [allergies, setAllergies] = useState<string[]>([]);
  const [intolerances, setIntolerances] = useState<string[]>([]);
  const [dietaryRestrictions, setDietaryRestrictions] = useState<string[]>(["halal"]);
  const [dislikedFoods, setDislikedFoods] = useState<string[]>([]);
  const [newDislikeText, setNewDislikeText] = useState("");

  // Plan generation state
  const [generating, setGenerating] = useState(false);
  const [planResult, setPlanResult] = useState<GroceryPlanResult | null>(null);
  const [expandedExplanationId, setExpandedExplanationId] = useState<string | null>(null);

  // Saved lists
  const [savedLists, setSavedLists] = useState<SavedListSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [savingList, setSavingList] = useState(false);

  // Quick Goal Presets
  const QUICK_GOALS = [
    { id: "g1", label: t("aishop.goal.quick1"), text: "Weight loss and prolonged satiety with high dietary fiber, lean protein, and reduced simple sugars." },
    { id: "g2", label: t("aishop.goal.quick2"), text: "High-protein lean muscle gain on a smart budget, prioritizing eggs, chicken, and dal." },
    { id: "g3", label: t("aishop.goal.quick3"), text: "Diabetic-friendly, low-glycemic blood sugar management with red rice, lentils, and bitter gourd/lau." },
    { id: "g4", label: t("aishop.goal.quick4"), text: "Cost-effective nutritious college student groceries with eggs, tilapia, and seasonal greens." },
    { id: "g5", label: t("aishop.goal.quick5"), text: "Heart-healthy and low-sodium basket with omega-3 freshwater fish, garlic, and fresh vegetables." },
  ];

  // Fetch preferences on mount
  useEffect(() => {
    async function loadPreferences() {
      try {
        const res = await fetch(`/api/grocery/preferences`);
        if (res.ok) {
          const data = await res.json();
          if (data.preferences) {
            setAllergies(data.preferences.allergies || []);
            setIntolerances(data.preferences.intolerances || []);
            setDietaryRestrictions(data.preferences.dietaryRestrictions || ["halal"]);
            setDislikedFoods(data.preferences.dislikedFoods || []);
          }
        }
      } catch {
        // silent failover
      }
    }
    loadPreferences();
  }, [user?.id]);

  // Synchronize Vision-to-Market staged items
  useEffect(() => {
    if (stagedVisionItems && stagedVisionItems.length > 0) {
      setVisionItems(stagedVisionItems);
      if (stagedDietaryPivot?.localizedMarketPivot?.description) {
        setHealthGoal(`Dietary Pivot: ${stagedDietaryPivot.localizedMarketPivot.description}`);
      }
      clearStagedVision();
      toast({
        title: "Vision-to-Market Transferred!",
        description: "Your dietary pivot was added to the health goal. Ready to generate a localized Dhaka basket.",
      });
    }
  }, [stagedVisionItems, stagedDietaryPivot, toast, clearStagedVision]);

  // Fetch saved lists when switching to history tab
  useEffect(() => {
    if (tab === "history") {
      fetchSavedLists();
    }
  }, [tab]);

  const fetchSavedLists = async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/grocery/saved`);
      if (res.ok) {
        const data = await res.json();
        setSavedLists(data.lists || []);
      }
    } catch {
      toast({ title: "Failed to load saved lists", variant: "destructive" });
    } finally {
      setLoadingHistory(false);
    }
  };

  // Generate Grocery Plan
  const handleGenerate = async () => {
    setGenerating(true);
    const finalDays = customDays && Number(customDays) > 0 ? Number(customDays) : durationDays;
    const limit = budgetMode === "max" ? Number(budgetLimitBdt) || undefined : undefined;

    try {
      const res = await fetch("/api/grocery/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userContext: {
            age: profile?.age,
            gender: profile?.gender,
            height: profile?.height,
            currentWeight: profile?.currentWeight,
            activityLevel: profile?.activityLevel,
          },
          healthGoal,
          durationDays: finalDays,
          budgetMode,
          budgetLimitBdt: limit,
          foodInspirations: visionItems,
          preferences: {
            allergies,
            intolerances,
            dietaryRestrictions,
            dislikedFoods,
          },
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to generate plan");
      }

      setPlanResult(data.data);
      setTab("review");
      toast({
        title: lang === "bn" ? "বাজার তালিকা প্রস্তুত!" : "Grocery Plan Generated!",
        description: `${data.data.items.length} items optimized for BDT ৳${data.data.budgetAnalysis.totalActualCostBdt}.`,
      });
    } catch (err) {
      toast({
        title: "Generation error",
        description: err instanceof Error ? err.message : "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  };

  // Live item modifications inside review table
  const updateItemQuantity = (itemId: string, newQty: number) => {
    if (!planResult) return;
    const clampedQty = Math.max(0.1, Math.round(newQty * 10) / 10);
    const updatedItems = planResult.items.map((it) => {
      if (it.id === itemId) {
        const itemTotal = Math.round(clampedQty * it.unitPrice);
        return { ...it, quantity: clampedQty, itemTotal };
      }
      return it;
    });

    const newNutrition = calculateBasketNutrition(
      updatedItems.map((i) => ({ foodId: i.foodId, quantity: i.quantity })),
      planResult.nutrition.durationDays
    );

    const newTotalCost = updatedItems.reduce((acc, it) => acc + it.itemTotal, 0);

    setPlanResult({
      ...planResult,
      items: updatedItems,
      nutrition: newNutrition,
      budgetAnalysis: {
        ...planResult.budgetAnalysis,
        totalActualCostBdt: newTotalCost,
        remainingBudgetBdt:
          planResult.budgetAnalysis.budgetLimitBdt
            ? Math.max(0, planResult.budgetAnalysis.budgetLimitBdt - newTotalCost)
            : undefined,
        isBudgetExceeded:
          Boolean(planResult.budgetAnalysis.budgetLimitBdt) &&
          newTotalCost > (planResult.budgetAnalysis.budgetLimitBdt || 0),
      },
      targetsUnmet: evaluateTargetsUnmet({
        dailyCalories: newNutrition.dailyCalories,
        dailyProtein: newNutrition.dailyProtein,
        totalCostBdt: newTotalCost,
        targetCalories: planResult.targetComparison.targetDailyCalories,
        targetProtein: planResult.targetComparison.targetDailyProtein,
        budgetLimitBdt:
          planResult.budgetAnalysis.budgetMode === "max" ? planResult.budgetAnalysis.budgetLimitBdt : undefined,
      }),
    });
  };

  const updateItemPrice = (itemId: string, newPrice: number) => {
    if (!planResult) return;
    const validPrice = Math.max(0, Math.round(newPrice));
    const updatedItems = planResult.items.map((it) => {
      if (it.id === itemId) {
        const itemTotal = Math.round(it.quantity * validPrice);
        return { ...it, unitPrice: validPrice, itemTotal, isPriceEditable: false };
      }
      return it;
    });

    const newTotalCost = updatedItems.reduce((acc, it) => acc + it.itemTotal, 0);

    setPlanResult({
      ...planResult,
      items: updatedItems,
      budgetAnalysis: {
        ...planResult.budgetAnalysis,
        totalActualCostBdt: newTotalCost,
        remainingBudgetBdt:
          planResult.budgetAnalysis.budgetLimitBdt
            ? Math.max(0, planResult.budgetAnalysis.budgetLimitBdt - newTotalCost)
            : undefined,
      },
      targetsUnmet: evaluateTargetsUnmet({
        dailyCalories: planResult.nutrition.dailyCalories,
        dailyProtein: planResult.nutrition.dailyProtein,
        totalCostBdt: newTotalCost,
        targetCalories: planResult.targetComparison.targetDailyCalories,
        targetProtein: planResult.targetComparison.targetDailyProtein,
        budgetLimitBdt:
          planResult.budgetAnalysis.budgetMode === "max" ? planResult.budgetAnalysis.budgetLimitBdt : undefined,
      }),
    });
  };

  const togglePurchased = (itemId: string) => {
    if (!planResult) return;
    setPlanResult({
      ...planResult,
      items: planResult.items.map((it) =>
        it.id === itemId ? { ...it, purchased: !it.purchased } : it
      ),
    });
  };

  const removeItem = (itemId: string) => {
    if (!planResult) return;
    const updatedItems = planResult.items.filter((it) => it.id !== itemId);
    const newNutrition = calculateBasketNutrition(
      updatedItems.map((i) => ({ foodId: i.foodId, quantity: i.quantity })),
      planResult.nutrition.durationDays
    );
    const newTotalCost = updatedItems.reduce((acc, it) => acc + it.itemTotal, 0);

    setPlanResult({
      ...planResult,
      items: updatedItems,
      nutrition: newNutrition,
      budgetAnalysis: {
        ...planResult.budgetAnalysis,
        totalActualCostBdt: newTotalCost,
      },
    });
  };

  // Manual Persistence: Save List to History
  const handleSaveList = async () => {
    if (!planResult) return;
    setSavingList(true);
    try {
      const res = await fetch("/api/grocery/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          durationDays: planResult.nutrition.durationDays,
          budgetMode: planResult.budgetAnalysis.budgetMode,
          budgetLimit: planResult.budgetAnalysis.budgetLimitBdt,
          actualCost: planResult.budgetAnalysis.totalActualCostBdt,
          healthGoal,
          compromisesMade: planResult.budgetAnalysis.compromisesMade,
          suggestedBudget: planResult.budgetAnalysis.suggestedRealisticBudgetBdt,
          dailyCalories: planResult.nutrition.dailyCalories,
          dailyProtein: planResult.nutrition.dailyProtein,
          dailyCarbs: planResult.nutrition.dailyCarbs,
          dailyFat: planResult.nutrition.dailyFat,
          items: planResult.items,
        }),
      });

      if (!res.ok) throw new Error("Could not save list");

      toast({
        title: lang === "bn" ? "সংরক্ষণ সম্পন্ন!" : "Saved Successfully!",
        description: t("aishop.savedSuccess"),
      });
    } catch {
      toast({ title: "Failed to save list", variant: "destructive" });
    } finally {
      setSavingList(false);
    }
  };

  // Delete saved list from history
  const handleDeleteSavedList = async (id: string) => {
    try {
      const res = await fetch(`/api/grocery/saved?id=${id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSavedLists((prev) => prev.filter((l) => l.id !== id));
        toast({ title: "Saved list removed" });
      }
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  };

  // Re-load a saved list into live editor
  const handleLoadSavedList = (saved: SavedListSummary) => {
    const nutrition = calculateBasketNutrition(
      saved.items.map((i) => ({ foodId: i.foodId, quantity: i.quantity })),
      saved.durationDays
    );
    setPlanResult({
      items: saved.items,
      nutrition,
      targetComparison: {
        targetDailyCalories: targets?.dailyCalories || 2000,
        targetDailyProtein: targets?.protein || 120,
        targetDailyCarbs: targets?.carbs || 250,
        targetDailyFat: targets?.fat || 60,
      },
      budgetAnalysis: {
        budgetMode: (saved.budgetMode as any) || "max",
        budgetLimitBdt: saved.budgetMode === "max" ? saved.actualCost : undefined,
        totalActualCostBdt: saved.actualCost,
        isBudgetExceeded: false,
        compromisesMade: saved.compromisesMade,
      },
      targetsUnmet: null,
      stockExcluded: [],
      unmatchedInspirations: [],
      disclaimer: t("aishop.disclaimer"),
      disclaimerBn: t("aishop.disclaimer"),
      generatedAt: saved.createdAt,
    });
    setDurationDays(saved.durationDays);
    if (saved.healthGoal) setHealthGoal(saved.healthGoal);
    setTab("review");
  };

  return (
    <AppShell activeView="shopping">
      <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
            {/* Top Navigation & Title */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="w-10 h-10 rounded-2xl bg-[#1E4D3B]/10 flex items-center justify-center text-[#1E4D3B]">
                    <ShoppingBasket className="h-5 w-5" />
                  </div>
                  <div>
                    <h1 className="font-heading text-2xl sm:text-3xl font-bold text-[#1E4D3B] tracking-tight">
                      {t("aishop.title")}
                    </h1>
                    <p className="text-xs sm:text-sm text-[#5A6E69]">
                      {t("aishop.subtitle")}
                    </p>
                  </div>
                </div>
              </div>

              {/* Navigation Tabs */}
              <div className="flex items-center bg-[#E5ECE9] p-1 rounded-2xl gap-1 self-start sm:self-auto">
                <button
                  onClick={() => setTab("planner")}
                  className={cn(
                    "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all",
                    tab === "planner"
                      ? "bg-white text-[#1E4D3B] shadow-sm"
                      : "text-[#5A6E69] hover:text-[#1E4D3B]"
                  )}
                >
                  <Sparkles className="h-3.5 w-3.5 inline mr-1.5 text-[#5CB85C]" />
                  {t("aishop.tab.planner")}
                </button>
                <button
                  onClick={() => setTab("review")}
                  disabled={!planResult}
                  className={cn(
                    "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all",
                    tab === "review"
                      ? "bg-white text-[#1E4D3B] shadow-sm"
                      : "text-[#5A6E69] hover:text-[#1E4D3B]",
                    !planResult && "opacity-40 cursor-not-allowed"
                  )}
                >
                  <ShoppingBasket className="h-3.5 w-3.5 inline mr-1.5" />
                  {t("aishop.tab.review")}
                </button>
                <button
                  onClick={() => setTab("history")}
                  className={cn(
                    "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all",
                    tab === "history"
                      ? "bg-white text-[#1E4D3B] shadow-sm"
                      : "text-[#5A6E69] hover:text-[#1E4D3B]"
                  )}
                >
                  <History className="h-3.5 w-3.5 inline mr-1.5" />
                  {t("aishop.tab.history")}
                </button>
              </div>
            </div>

            {/* Prominent Medical & Nutritional Disclaimer */}
            <div className="rounded-2xl border border-[#DCE4E1] bg-white/80 p-3.5 sm:p-4 shadow-sm flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 text-[#E06D53] shrink-0 mt-0.5" />
              <p className="text-xs text-[#5A6E69] leading-relaxed">
                {t("aishop.disclaimer")}
              </p>
            </div>

            {/* Vision-to-Market Active Loop Notification */}
            {visionItems.length > 0 && (
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="rounded-3xl border-2 border-[#98DF26] bg-gradient-to-r from-[#1E4D3B] to-[#2B6A52] text-white p-5 shadow-lg relative overflow-hidden"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full bg-[#98DF26] text-[#1E4D3B] text-[11px] font-extrabold uppercase tracking-wider">
                        Vision-to-Market Loop Active
                      </span>
                      <span className="text-xs text-white/70">
                        {visionItems.length} items staged from visual scan
                      </span>
                    </div>
                    <h3 className="text-base sm:text-lg font-bold text-white">
                      Camera scan converted to Localized Dhaka Market Planner
                    </h3>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {visionItems.map((item, idx) => (
                        <span
                          key={idx}
                          className="px-2.5 py-1 rounded-xl bg-white/15 border border-white/20 text-xs font-semibold text-white"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                    {stagedDietaryPivot?.localizedMarketPivot && (
                      <p className="text-xs text-[#98DF26] pt-1">
                        💡 Dietary Pivot: {stagedDietaryPivot.localizedMarketPivot.title}
                        {typeof stagedDietaryPivot.localizedMarketPivot.totalEstCostBdt === "number" &&
                          ` · Basket ~৳${stagedDietaryPivot.localizedMarketPivot.totalEstCostBdt}`}
                        {typeof stagedDietaryPivot.localizedMarketPivot.estCostSavingsBdt === "number"
                          ? ` · Saves ~৳${stagedDietaryPivot.localizedMarketPivot.estCostSavingsBdt} vs restaurant`
                          : " · No restaurant price to compare"}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      onClick={handleGenerate}
                      disabled={generating}
                      className="rounded-2xl bg-[#98DF26] hover:bg-[#88CF1E] text-[#1E4D3B] font-extrabold text-xs sm:text-sm px-5 py-2.5 shadow-md"
                    >
                      {generating ? (
                        <RefreshCw className="h-4 w-4 animate-spin mr-1.5" />
                      ) : (
                        <Sparkles className="h-4 w-4 mr-1.5 text-[#1E4D3B]" />
                      )}
                      Generate Dhaka Basket
                    </Button>
                    <button
                      onClick={clearStagedVision}
                      className="p-2 rounded-xl text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                      title="Clear Vision Staging"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* TAB 1: PLANNER & GENERATOR */}
            {tab === "planner" && (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                {/* 2. Health Goal Textarea & Quick Chips */}
                <div className="bg-white rounded-3xl border border-[#DCE4E1] p-5 sm:p-6 shadow-sm space-y-3">
                  <label className="block text-sm font-bold text-[#1E4D3B]">
                    {t("aishop.goal.label")}
                  </label>
                  <textarea
                    rows={3}
                    value={healthGoal}
                    onChange={(e) => setHealthGoal(e.target.value)}
                    placeholder={t("aishop.goal.placeholder")}
                    className="w-full rounded-2xl border border-[#DCE4E1] bg-[#F4F7F6] p-3.5 text-sm text-[#1E4D3B] placeholder:text-[#5A6E69]/50 focus:outline-none focus:border-[#5CB85C]"
                  />
                  <div className="flex flex-wrap gap-2 pt-1">
                    {QUICK_GOALS.map((q) => (
                      <button
                        key={q.id}
                        type="button"
                        onClick={() => setHealthGoal(q.text)}
                        className="px-3 py-1.5 rounded-xl border border-[#DCE4E1] bg-[#F4F7F6] text-xs font-medium text-[#1E4D3B] hover:border-[#5CB85C] hover:bg-[#5CB85C]/10 transition-all"
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 4. Duration & Budget Modes */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {/* Duration Presets */}
                  <div className="bg-white rounded-3xl border border-[#DCE4E1] p-5 shadow-sm space-y-3">
                    <label className="block text-sm font-bold text-[#1E4D3B]">
                      {t("aishop.duration.label")}
                    </label>
                    <div className="grid grid-cols-4 gap-2">
                      {[1, 7, 15, 30].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => {
                            setDurationDays(d);
                            setCustomDays("");
                          }}
                          className={cn(
                            "py-2.5 rounded-2xl border text-xs font-bold transition-all",
                            durationDays === d && !customDays
                              ? "bg-[#1E4D3B] text-white border-[#1E4D3B]"
                              : "bg-[#F4F7F6] text-[#5A6E69] border-[#DCE4E1] hover:border-[#1E4D3B]/40"
                          )}
                        >
                          {d} {lang === "bn" ? "দিন" : "Days"}
                        </button>
                      ))}
                    </div>
                    <div className="pt-1">
                      <input
                        type="number"
                        min="1"
                        max="60"
                        value={customDays}
                        onChange={(e) => {
                          setCustomDays(e.target.value);
                          if (e.target.value) setDurationDays(Number(e.target.value));
                        }}
                        placeholder={`${t("aishop.duration.custom")} (e.g. 10)`}
                        className="w-full rounded-xl border border-[#DCE4E1] bg-[#F4F7F6] px-3.5 py-2 text-xs text-[#1E4D3B] focus:outline-none focus:border-[#5CB85C]"
                      />
                    </div>
                  </div>

                  {/* Budget Modes */}
                  <div className="bg-white rounded-3xl border border-[#DCE4E1] p-5 shadow-sm space-y-3">
                    <label className="block text-sm font-bold text-[#1E4D3B]">
                      {t("aishop.budget.label")}
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => setBudgetMode("max")}
                        className={cn(
                          "py-2 rounded-xl border text-[11px] font-bold transition-all text-center",
                          budgetMode === "max"
                            ? "bg-[#1E4D3B] text-white border-[#1E4D3B]"
                            : "bg-[#F4F7F6] text-[#5A6E69] border-[#DCE4E1]"
                        )}
                      >
                        {t("aishop.budget.max")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setBudgetMode("cheapest")}
                        className={cn(
                          "py-2 rounded-xl border text-[11px] font-bold transition-all text-center",
                          budgetMode === "cheapest"
                            ? "bg-[#1E4D3B] text-white border-[#1E4D3B]"
                            : "bg-[#F4F7F6] text-[#5A6E69] border-[#DCE4E1]"
                        )}
                      >
                        {t("aishop.budget.cheapest")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setBudgetMode("none")}
                        className={cn(
                          "py-2 rounded-xl border text-[11px] font-bold transition-all text-center",
                          budgetMode === "none"
                            ? "bg-[#1E4D3B] text-white border-[#1E4D3B]"
                            : "bg-[#F4F7F6] text-[#5A6E69] border-[#DCE4E1]"
                        )}
                      >
                        {t("aishop.budget.none")}
                      </button>
                    </div>

                    {budgetMode === "max" && (
                      <div className="space-y-2 pt-1">
                        <div className="relative">
                          <span className="absolute left-3.5 top-2 text-xs font-bold text-[#1E4D3B]">
                            ৳
                          </span>
                          <input
                            type="number"
                            value={budgetLimitBdt}
                            onChange={(e) => setBudgetLimitBdt(e.target.value)}
                            placeholder={t("aishop.budget.limitPlaceholder")}
                            className="w-full pl-8 pr-3.5 py-2 rounded-xl border border-[#DCE4E1] bg-[#F4F7F6] text-xs text-[#1E4D3B] font-bold focus:outline-none focus:border-[#5CB85C]"
                          />
                        </div>
                        <p className="text-[11px] text-[#5A6E69] italic">
                          {t("aishop.budget.strictNote")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>



                {/* 5. Food Preferences & Health Settings Toggle */}
                <div className="bg-white rounded-3xl border border-[#DCE4E1] p-5 shadow-sm flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-[#E5ECE9] flex items-center justify-center text-[#1E4D3B]">
                      <SlidersHorizontal className="h-4 w-4" />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-[#1E4D3B]">
                        {t("aishop.pref.title")}
                      </h4>
                      <p className="text-xs text-[#5A6E69]">
                        Allergies: {allergies.length ? allergies.join(", ") : "None"} · Diet: {dietaryRestrictions.join(", ")}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowPreferencesModal(true)}
                    className="rounded-full border-[#DCE4E1] text-xs font-semibold hover:border-[#1E4D3B]"
                  >
                    {t("common.edit")}
                  </Button>
                </div>

                {/* Generate Button */}
                <Button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="w-full h-14 rounded-2xl bg-[#1E4D3B] hover:bg-[#1E4D3B]/90 text-white font-bold text-base shadow-lg transition-transform active:scale-[0.99]"
                >
                  {generating ? (
                    <>
                      <RefreshCw className="mr-2 h-5 w-5 animate-spin text-[#5CB85C]" />
                      {t("aishop.generating")}
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-5 w-5 text-[#5CB85C]" />
                      {t("aishop.generateBtn")}
                    </>
                  )}
                </Button>
              </motion.div>
            )}

            {/* TAB 2: REVIEWABLE INTERACTIVE SHOPPING LIST */}
            {tab === "review" && planResult && (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                {/* Cost & Budget Summary Bar */}
                <div className="bg-white rounded-3xl border border-[#DCE4E1] p-5 sm:p-6 shadow-sm space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <span className="text-xs font-bold uppercase tracking-wider text-[#5A6E69]">
                        {t("aishop.basket.title")}
                      </span>
                      <div className="flex items-baseline gap-2 mt-1">
                        <span className="text-3xl font-extrabold text-[#1E4D3B]">
                          ৳{planResult.budgetAnalysis.totalActualCostBdt}
                        </span>
                        {planResult.budgetAnalysis.budgetLimitBdt && (
                          <span className="text-xs text-[#5A6E69]">
                            / ৳{planResult.budgetAnalysis.budgetLimitBdt} ({planResult.nutrition.durationDays} {lang === "bn" ? "দিনের" : "days"})
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleSaveList}
                        disabled={savingList}
                        className="rounded-full border-[#DCE4E1] text-[#1E4D3B] font-bold hover:bg-[#5CB85C]/15"
                      >
                        <Save className="h-3.5 w-3.5 mr-1 text-[#5CB85C]" />
                        {t("aishop.saveBtn")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => window.print()}
                        className="rounded-full text-[#5A6E69] hover:text-[#1E4D3B]"
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Targets not met: explains why kcal/protein fall outside ±10% or the budget blocks them */}
                  {planResult.targetsUnmet && (
                    <div
                      role="alert"
                      className="rounded-2xl border border-[#E06D53] bg-[#FFF4F1] p-3 text-xs text-[#8A3B2A] flex items-start gap-2"
                    >
                      <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold">{lang === "bn" ? "লক্ষ্যমাত্রা পূরণ হয়নি: " : "Targets not met: "}</span>
                        {lang === "bn" ? planResult.targetsUnmet.reasonBn : planResult.targetsUnmet.reason}
                      </div>
                    </div>
                  )}

                  {/* Compromises / Substitution Alert */}
                  {planResult.budgetAnalysis.compromisesMade && (
                    <div className="rounded-2xl border border-[#F2D15B] bg-[#FFFBEA] p-3 text-xs text-[#856404] flex items-start gap-2">
                      <Info className="h-4 w-4 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold">Budget Compromise & Substitution: </span>
                        {planResult.budgetAnalysis.compromisesMade}
                      </div>
                    </div>
                  )}

                  <p className="text-sm">{lang === "bn" ? "দাম বেঞ্চমার্ক অনুমান (স্থির ঢাকা তালিকা), সরাসরি খুচরা বিক্রেতার লাইভ দাম নয়।" : "Prices come from a live retailer price where one was read, otherwise from historical Dhaka data or the static benchmark table."}</p>
                  {planResult.stockExcluded?.length > 0 && (
                    <p className="text-sm text-[#8A3B2A]">
                      {lang === "bn" ? "স্টকে না থাকায় বাদ দেওয়া হয়েছে: " : "Left out because retailer reports out of stock: "}
                      {planResult.stockExcluded.map((s) => s.genericName).join(", ")}
                    </p>
                  )}
                  {planResult.nutrition.dailyCalories < planResult.targetComparison.targetDailyCalories && <p className="text-sm">{lang === "bn" ? "এই তালিকা দৈনিক শক্তির চাহিদার একটি অংশ পূরণ করে।" : "This basket covers part of your daily energy target."}</p>}
                  {planResult.context && <section className="space-y-2 text-sm"><p>{planResult.context.tip}</p>{planResult.context.offers.map(offer => <p key={offer.url}><a className="underline" href={offer.url} target="_blank" rel="noreferrer">{offer.name} · {lang === "bn" ? "খুচরা পণ্যের পাতা" : "retailer page"}</a> · {offer.stock === "Unverified" ? (lang === "bn" ? "স্টক যাচাই হয়নি" : "stock not verified") : offer.stock === "In stock" ? (lang === "bn" ? "স্টকে আছে" : "in stock") : (lang === "bn" ? "স্টকে নেই" : "out of stock")} · {new Date(offer.checkedAt).toLocaleString()}</p>)}</section>}
                  <a className="text-sm underline" target="_blank" rel="noreferrer" href="https://www.fao.org/nutrition/education/dietary-guidelines/regions/bangladesh/en/">{lang === "bn" ? "বাংলাদেশের খাদ্য নির্দেশিকা" : "Bangladesh food-based dietary guidelines"}</a>
                  {/* Nutritional Summary: Basket Total & Estimated Daily Average (Raw edible portion basis) */}
                  <div className="pt-2 border-t border-[#E5ECE9]">
                    <div className="text-xs font-bold text-[#1E4D3B] mb-2 flex items-center justify-between">
                      <span>{t("aishop.nutrition.dailyAvg")}</span>
                      {planResult.nutrition.hasEstimatedData && (
                        <span className="text-[10px] text-[#E06D53] italic">
                          *Includes food database estimates
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="p-3 rounded-2xl bg-[#F4F7F6] border border-[#E5ECE9]">
                        <div className="flex items-center justify-between text-xs text-[#5A6E69]">
                          <span>Calories</span>
                          <Flame className="h-3.5 w-3.5 text-[#E06D53]" />
                        </div>
                        <div className="mt-1 text-lg font-bold text-[#1E4D3B]">
                          {planResult.nutrition.dailyCalories}
                          <span className="text-xs text-[#5A6E69] ml-1">kcal/day</span>
                        </div>
                        <div className="text-[10px] text-[#5A6E69]">
                          Target: ~{planResult.targetComparison.targetDailyCalories}
                        </div>
                      </div>

                      <div className="p-3 rounded-2xl bg-[#F4F7F6] border border-[#E5ECE9]">
                        <div className="flex items-center justify-between text-xs text-[#5A6E69]">
                          <span>Protein</span>
                          <Beef className="h-3.5 w-3.5 text-[#E06D53]" />
                        </div>
                        <div className="mt-1 text-lg font-bold text-[#1E4D3B]">
                          {planResult.nutrition.dailyProtein}
                          <span className="text-xs text-[#5A6E69] ml-1">g/day</span>
                        </div>
                        <div className="text-[10px] text-[#5A6E69]">
                          Target: ~{planResult.targetComparison.targetDailyProtein}g
                        </div>
                      </div>

                      <div className="p-3 rounded-2xl bg-[#F4F7F6] border border-[#E5ECE9]">
                        <div className="flex items-center justify-between text-xs text-[#5A6E69]">
                          <span>Carbs</span>
                          <Wheat className="h-3.5 w-3.5 text-[#D4A843]" />
                        </div>
                        <div className="mt-1 text-lg font-bold text-[#1E4D3B]">
                          {planResult.nutrition.dailyCarbs}
                          <span className="text-xs text-[#5A6E69] ml-1">g/day</span>
                        </div>
                        <div className="text-[10px] text-[#5A6E69]">
                          Target: ~{planResult.targetComparison.targetDailyCarbs}g
                        </div>
                      </div>

                      <div className="p-3 rounded-2xl bg-[#F4F7F6] border border-[#E5ECE9]">
                        <div className="flex items-center justify-between text-xs text-[#5A6E69]">
                          <span>Fat</span>
                          <Droplet className="h-3.5 w-3.5 text-[#5BB8E8]" />
                        </div>
                        <div className="mt-1 text-lg font-bold text-[#1E4D3B]">
                          {planResult.nutrition.dailyFat}
                          <span className="text-xs text-[#5A6E69] ml-1">g/day</span>
                        </div>
                        <div className="text-[10px] text-[#5A6E69]">
                          Target: ~{planResult.targetComparison.targetDailyFat}g
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Interactive Grocery Items Table / List */}
                <div className="bg-white rounded-3xl border border-[#DCE4E1] overflow-hidden shadow-sm">
                  <div className="p-4 sm:p-5 border-b border-[#E5ECE9] flex items-center justify-between bg-[#F9FBFA]">
                    <h3 className="font-heading text-base font-bold text-[#1E4D3B]">
                      {lang === "bn" ? "বাজারের পণ্য তালিকা ও সমন্বয়" : "Grocery Checklist & Live Editor"}
                    </h3>
                    <span className="text-xs text-[#5A6E69]">
                      {planResult.items.filter((i) => i.purchased).length} / {planResult.items.length} {lang === "bn" ? "কেনা হয়েছে" : "purchased"}
                    </span>
                  </div>

                  <div className="divide-y divide-[#E5ECE9]">
                    {planResult.items.map((item) => {
                      const isExpanded = expandedExplanationId === item.id;
                      return (
                        <div
                          key={item.id}
                          className={cn(
                            "p-4 transition-colors",
                            item.purchased ? "bg-[#F4F7F6]/60 opacity-60" : "hover:bg-[#F9FBFA]"
                          )}
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            {/* Left: Checkbox + Name */}
                            <div className="flex items-start gap-3 min-w-0">
                              <button
                                type="button"
                                onClick={() => togglePurchased(item.id)}
                                className={cn(
                                  "mt-0.5 w-5 h-5 rounded-lg border flex items-center justify-center transition-colors",
                                  item.purchased
                                    ? "bg-[#1E4D3B] border-[#1E4D3B] text-white"
                                    : "border-[#DCE4E1] bg-white hover:border-[#1E4D3B]"
                                )}
                              >
                                {item.purchased && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                              </button>

                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn(
                                      "font-bold text-sm text-[#1E4D3B]",
                                      item.purchased && "line-through text-[#5A6E69]"
                                    )}
                                  >
                                    {lang === "bn" ? item.genericNameBn : item.genericName}
                                  </span>
                                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#E5ECE9] text-[#1E4D3B]">
                                    {lang === "bn" ? item.selectionReasonBn : item.selectionReason}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedExplanationId(isExpanded ? null : item.id)
                                  }
                                  className="text-[11px] font-medium text-[#5A6E69] hover:text-[#1E4D3B] flex items-center gap-1 mt-0.5"
                                >
                                  {isExpanded ? (
                                    <>
                                      Hide reasoning <ChevronUp className="h-3 w-3" />
                                    </>
                                  ) : (
                                    <>
                                      Why this food? <ChevronDown className="h-3 w-3" />
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            {/* Right: Quantity Stepper + Editable Unit Price + Total */}
                            <div className="flex items-center gap-3 self-end sm:self-center">
                              {/* Quantity Stepper */}
                              <div className="flex items-center border border-[#DCE4E1] rounded-xl bg-white px-1 py-0.5">
                                <button
                                  type="button"
                                  onClick={() => updateItemQuantity(item.id, item.quantity - 0.5)}
                                  className="w-6 h-6 rounded flex items-center justify-center text-[#5A6E69] hover:text-[#1E4D3B]"
                                >
                                  -
                                </button>
                                <span className="px-2 text-xs font-bold text-[#1E4D3B] tabular-nums">
                                  {item.quantity} {item.unit}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => updateItemQuantity(item.id, item.quantity + 0.5)}
                                  className="w-6 h-6 rounded flex items-center justify-center text-[#5A6E69] hover:text-[#1E4D3B]"
                                >
                                  +
                                </button>
                              </div>

                              {/* Unit Price (Editable) */}
                              <div className="flex items-center gap-1">
                                <span className="text-xs text-[#5A6E69]">@ ৳</span>
                                <input
                                  type="number"
                                  value={item.unitPrice || ""}
                                  onChange={(e) => updateItemPrice(item.id, Number(e.target.value))}
                                  placeholder="0"
                                  className="w-16 px-1.5 py-1 rounded-lg border border-[#DCE4E1] bg-white text-xs text-[#1E4D3B] font-bold text-right focus:outline-none focus:border-[#5CB85C]"
                                />
                              </div>

                              {/* Item Total */}
                              <div className="text-right min-w-[70px]">
                                <span className="text-sm font-extrabold text-[#1E4D3B]">
                                  ৳{item.itemTotal}
                                </span>
                              </div>

                              {/* Delete Item */}
                              <button
                                type="button"
                                onClick={() => removeItem(item.id)}
                                className="text-[#5A6E69] hover:text-[#E06D53] p-1"
                                title="Remove"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Expandable Explanation */}
                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0 }}
                                className="mt-2.5 p-3 rounded-2xl bg-[#E5ECE9]/60 text-xs text-[#1E4D3B] border border-[#DCE4E1]"
                              >
                                {lang === "bn" ? item.expandedExplanationBn : item.expandedExplanation}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>
            )}

            {/* TAB 3: SAVED LISTS & HISTORY */}
            {tab === "history" && (
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4"
              >
                {loadingHistory ? (
                  <div className="p-12 text-center text-xs text-[#5A6E69]">
                    <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-[#5CB85C]" />
                    Loading your saved lists...
                  </div>
                ) : savedLists.length === 0 ? (
                  <div className="bg-white rounded-3xl border border-[#DCE4E1] p-12 text-center space-y-3">
                    <div className="w-14 h-14 rounded-2xl bg-[#E5ECE9] flex items-center justify-center mx-auto text-[#1E4D3B]">
                      <ShoppingBasket className="h-7 w-7" />
                    </div>
                    <h3 className="font-heading text-lg font-bold text-[#1E4D3B]">
                      {t("aishop.history.empty")}
                    </h3>
                    <Button
                      onClick={() => setTab("planner")}
                      className="rounded-full bg-[#1E4D3B] text-white hover:bg-[#1E4D3B]/90 text-xs font-semibold"
                    >
                      {t("aishop.tab.planner")}
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {savedLists.map((list) => (
                      <div
                        key={list.id}
                        className="bg-white rounded-3xl border border-[#DCE4E1] p-5 shadow-sm space-y-3 flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-center justify-between text-xs text-[#5A6E69] mb-1">
                            <span>
                              {new Date(list.createdAt).toLocaleDateString(
                                lang === "bn" ? "bn-BD" : "en-US",
                                { month: "short", day: "numeric", year: "numeric" }
                              )}
                            </span>
                            <span className="font-bold text-[#1E4D3B] px-2 py-0.5 rounded-full bg-[#E5ECE9]">
                              {list.durationDays} {lang === "bn" ? "দিন" : "Days"}
                            </span>
                          </div>
                          <h4 className="font-heading text-base font-bold text-[#1E4D3B]">
                            {list.title}
                          </h4>
                          <div className="mt-1 text-2xl font-extrabold text-[#1E4D3B]">
                            ৳{list.actualCost}
                          </div>
                          <p className="mt-1 text-xs text-[#5A6E69] line-clamp-2">
                            {list.healthGoal || "Personalized local nutrition basket"}
                          </p>

                          <div className="mt-3 flex items-center gap-2 text-[11px] text-[#5A6E69]">
                            <span>Avg: ~{list.dailyCalories} kcal/day</span>
                            <span>•</span>
                            <span>{list.dailyProtein}g protein</span>
                            <span>•</span>
                            <span>{list.items.length} items</span>
                          </div>
                        </div>

                        <div className="pt-2 border-t border-[#E5ECE9] flex items-center justify-between">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleLoadSavedList(list)}
                            className="rounded-full border-[#DCE4E1] text-[#1E4D3B] text-xs font-semibold hover:border-[#1E4D3B]"
                          >
                            {t("aishop.history.reload")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDeleteSavedList(list.id)}
                            className="text-[#E06D53] hover:bg-[#E06D53]/10 text-xs"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </div>

      {/* Preferences & Health Settings Modal */}
      {showPreferencesModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-3xl border border-[#DCE4E1] p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto space-y-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-heading text-lg font-bold text-[#1E4D3B]">
                {t("aishop.pref.title")}
              </h3>
              <button
                onClick={() => setShowPreferencesModal(false)}
                className="text-[#5A6E69] hover:text-[#1E4D3B]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Allergies (Strict Hard Exclusions) */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-[#1E4D3B] uppercase tracking-wider">
                {t("aishop.pref.allergies")}
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "shellfish", label: "Shellfish / Chingri (চিংড়ি)" },
                  { id: "fish", label: "Fish (মাছ)" },
                  { id: "egg", label: "Egg / Dim (ডিম)" },
                  { id: "dairy", label: "Dairy / Milk (দুধ)" },
                  { id: "gluten", label: "Gluten / Atta (আটা)" },
                ].map((item) => {
                  const selected = allergies.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        setAllergies((prev) =>
                          selected ? prev.filter((i) => i !== item.id) : [...prev, item.id]
                        )
                      }
                      className={cn(
                        "px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all",
                        selected
                          ? "bg-[#E06D53] border-[#E06D53] text-white"
                          : "border-[#DCE4E1] text-[#5A6E69] hover:border-[#1E4D3B]"
                      )}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Intolerances */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-[#1E4D3B] uppercase tracking-wider">
                {t("aishop.pref.intolerances")}
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "lactose", label: "Lactose Intolerance" },
                  { id: "fodmap", label: "FODMAP Sensitivity" },
                ].map((item) => {
                  const selected = intolerances.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        setIntolerances((prev) =>
                          selected ? prev.filter((i) => i !== item.id) : [...prev, item.id]
                        )
                      }
                      className={cn(
                        "px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all",
                        selected
                          ? "bg-[#1E4D3B] border-[#1E4D3B] text-white"
                          : "border-[#DCE4E1] text-[#5A6E69] hover:border-[#1E4D3B]"
                      )}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Dietary Restrictions */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-[#1E4D3B] uppercase tracking-wider">
                {t("aishop.pref.diet")}
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "halal", label: "Halal (হাঁলাল)" },
                  { id: "vegetarian", label: "Vegetarian (নিরামিষ)" },
                  { id: "vegan", label: "Vegan" },
                ].map((item) => {
                  const selected = dietaryRestrictions.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        setDietaryRestrictions((prev) =>
                          selected ? prev.filter((i) => i !== item.id) : [...prev, item.id]
                        )
                      }
                      className={cn(
                        "px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all",
                        selected
                          ? "bg-[#1E4D3B] border-[#1E4D3B] text-white"
                          : "border-[#DCE4E1] text-[#5A6E69] hover:border-[#1E4D3B]"
                      )}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Disliked Foods */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-[#1E4D3B] uppercase tracking-wider">
                {t("aishop.pref.dislikes")}
              </label>
              <div className="flex flex-wrap gap-2 mb-2">
                {dislikedFoods.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#F4F7F6] text-xs font-medium text-[#1E4D3B] border border-[#DCE4E1]"
                  >
                    {f}
                    <button
                      type="button"
                      onClick={() => setDislikedFoods((prev) => prev.filter((x) => x !== f))}
                      className="hover:text-[#E06D53]"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newDislikeText}
                  onChange={(e) => setNewDislikeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newDislikeText.trim()) {
                      setDislikedFoods((prev) => [...prev, newDislikeText.trim()]);
                      setNewDislikeText("");
                    }
                  }}
                  placeholder="e.g. Begun (eggplant), Korola (bitter gourd)..."
                  className="flex-1 rounded-xl border border-[#DCE4E1] bg-[#F4F7F6] px-3 py-2 text-xs text-[#1E4D3B] focus:outline-none focus:border-[#5CB85C]"
                />
                <Button
                  size="sm"
                  type="button"
                  onClick={() => {
                    if (newDislikeText.trim()) {
                      setDislikedFoods((prev) => [...prev, newDislikeText.trim()]);
                      setNewDislikeText("");
                    }
                  }}
                  className="rounded-xl bg-[#1E4D3B] text-white text-xs"
                >
                  Add
                </Button>
              </div>
            </div>

            <Button
              onClick={async () => {
                setShowPreferencesModal(false);
                try {
                  await fetch("/api/grocery/preferences", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      allergies,
                      intolerances,
                      dietaryRestrictions,
                      dislikedFoods,
                    }),
                  });
                } catch {
                  // silent
                }
              }}
              className="w-full rounded-2xl bg-[#1E4D3B] text-white font-bold h-11"
            >
              {t("common.save")}
            </Button>
          </motion.div>
        </div>
      )}
    </AppShell>
  );
}
