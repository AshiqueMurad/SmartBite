"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Lang } from "@/lib/i18n";
import type {
  Gender,
  ActivityLevel,
  GoalType,
  NutritionTargets,
} from "@/lib/nutrition";
import { calculateTargets } from "@/lib/nutrition";
import { dayKey } from "@/lib/dashboard-metrics";
import type {
  FoodItem,
  DailyTask,
  Reminder,
} from "@/lib/sample-data";
import {
  SAMPLE_FOOD_DIARY,
  SAMPLE_TASKS,
  SAMPLE_REMINDERS,
  DEMO_PROFILE,
  uid,
} from "@/lib/sample-data";

export type View =
  | "landing"
  | "signin"
  | "signup"
  | "onboarding"
  | "dashboard"
  | "foodDiary"
  | "scanner"
  | "shopping"
  | "analytics"
  | "settings";

export interface User {
  id: string;
  fullName: string;
  email: string;
  createdAt: string;
}

export interface OnboardingProfile {
  gender: Gender;
  age: number;
  height: number; // cm
  currentWeight: number; // kg
  goalWeight: number; // kg
  activityLevel: ActivityLevel;
  goal: GoalType;
}

export interface AppState {
  // Navigation
  view: View;
  setView: (v: View) => void;

  // Language
  lang: Lang;
  setLang: (l: Lang) => void;

  // Auth
  user: User | null;
  isAuthed: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signInDemo: () => Promise<void>;
  signOut: () => void;
  restoreSession: () => Promise<void>;
  lastUserId: string | null; // id of the account whose local data is on this device

  // Onboarding
  onboardingStep: number; // 0-7 (8 steps), 8 = final summary
  onboardingProfile: OnboardingProfile | null;
  targets: NutritionTargets | null;
  setOnboardingStep: (n: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  updateOnboardingProfile: (p: Partial<OnboardingProfile>) => void;
  calculateAndSetTargets: () => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;

  // Dashboard data
  foodDiary: FoodItem[];
  weightLog: { date: string; kg: number }[];
  logWeight: (kg: number) => void;
  tasks: DailyTask[];
  reminders: Reminder[];
  streak: number;

  // Food diary actions
  addFood: (food: FoodItem) => void;
  removeFood: (id: string) => void;
  toggleTask: (id: string) => void;
  toggleReminder: (id: string) => void;

  // Computed getters
  getConsumedCalories: () => number;
  getConsumedProtein: () => number;
  getConsumedCarbs: () => number;
  getConsumedFat: () => number;

  // Vision-to-Market Staging
  stagedVisionItems: string[] | null;
  stagedDietaryPivot: any | null;
  setStagedVisionItems: (items: string[]) => void;
  setStagedDietaryPivot: (pivot: any) => void;
  clearStagedVision: () => void;

  // Theme
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
}

type StoreSet = (partial: Partial<AppState>) => void;
type StoreGet = () => AppState;

async function postAuth(url: string, body: unknown): Promise<{ user: User }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data as { user: User };
}

/** Marks the account as signed in. If a different account used this browser, its local data is cleared. */
function applyUser(set: StoreSet, get: StoreGet, u: User) {
  const previous = get().lastUserId;
  const switching = previous !== null && previous !== u.id;
  set({
    user: u,
    isAuthed: true,
    lastUserId: u.id,
    ...(switching
      ? { foodDiary: [], weightLog: [], onboardingProfile: null, targets: null, stagedVisionItems: null, stagedDietaryPivot: null }
      : {}),
  });
}

const initialTargets = calculateTargets({
  gender: DEMO_PROFILE.gender,
  age: DEMO_PROFILE.age,
  height: DEMO_PROFILE.height,
  currentWeight: DEMO_PROFILE.currentWeight,
  goalWeight: DEMO_PROFILE.goalWeight,
  activityLevel: DEMO_PROFILE.activityLevel,
  goal: DEMO_PROFILE.goal,
});

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Navigation
      view: "landing",
      setView: (v) => set({ view: v }),

      // Language
      lang: "en",
      setLang: (l) => set({ lang: l }),

      // Auth
      user: null,
      isAuthed: false,
      lastUserId: null,
      signIn: async (email, password) => {
        const data = await postAuth("/api/auth/login", { email, password });
        applyUser(set, get, data.user);
      },
      signUp: async (name, email, password) => {
        const data = await postAuth("/api/auth/signup", { name, email, password });
        applyUser(set, get, data.user);
      },
      signInDemo: async () => {
        // Starts a real server session for the shared demo account (created on first use).
        const data = await postAuth("/api/auth/demo", {});
        const sameAccount = get().lastUserId === data.user.id && get().onboardingProfile !== null;
        applyUser(set, get, data.user);
        if (sameAccount) {
          // Returning to the demo on this device: keep whatever the user changed.
          set({ view: "dashboard" });
          return;
        }
        const demoProfile: OnboardingProfile = {
          gender: DEMO_PROFILE.gender,
          age: DEMO_PROFILE.age,
          height: DEMO_PROFILE.height,
          currentWeight: DEMO_PROFILE.currentWeight,
          goalWeight: DEMO_PROFILE.goalWeight,
          activityLevel: DEMO_PROFILE.activityLevel,
          goal: DEMO_PROFILE.goal,
        };
        const demoTargets = { ...calculateTargets(demoProfile), protein: 254 };
        set({
          onboardingProfile: demoProfile,
          targets: demoTargets,
          foodDiary: SAMPLE_FOOD_DIARY,
          weightLog: [],
          tasks: SAMPLE_TASKS,
          reminders: SAMPLE_REMINDERS,
          streak: 7,
          view: "dashboard",
        });
      },
      signOut: () => {
        fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        set({ user: null, isAuthed: false, view: "landing", onboardingStep: 0 });
      },
      restoreSession: async () => {
        try {
          const res = await fetch("/api/auth/me", { cache: "no-store" });
          if (res.ok) {
            const data = (await res.json()) as { user: User };
            applyUser(set, get, data.user);
          } else if (get().isAuthed) {
            set({ user: null, isAuthed: false });
          }
        } catch {
          // Offline: keep the locally remembered session until the server can be reached.
        }
      },

      // Onboarding
      onboardingStep: 0,
      onboardingProfile: null,
      targets: initialTargets,
      weightLog: [],
      setOnboardingStep: (n) => set({ onboardingStep: n }),
      nextStep: () => set((s) => ({ onboardingStep: s.onboardingStep + 1 })),
      prevStep: () =>
        set((s) => ({ onboardingStep: Math.max(0, s.onboardingStep - 1) })),
      updateOnboardingProfile: (p) =>
        set((s) => {
          const next = {
            ...(s.onboardingProfile ?? {
              gender: "male",
              age: 25,
              height: 170,
              currentWeight: 70,
              goalWeight: 70,
              activityLevel: "moderate",
              goal: "overall",
            }),
            ...p,
          } as OnboardingProfile;
          // Keep the stored targets in step with the profile so no screen shows an old number.
          return { onboardingProfile: next, targets: calculateTargets(next) };
        }),
      calculateAndSetTargets: () => {
        const profile = get().onboardingProfile;
        if (!profile) return;
        const t = calculateTargets(profile);
        set({ targets: t });
      },
      completeOnboarding: () => {
        get().calculateAndSetTargets();
        set({
          view: "dashboard",
        });
      },
      resetOnboarding: () =>
        set({ onboardingStep: 0, onboardingProfile: null }),

      // Dashboard data
      foodDiary: [],
      tasks: [],
      reminders: [],
      streak: 0,

      // Actions
      addFood: (food) =>
        set((s) => ({
          foodDiary: [...s.foodDiary, { ...food, loggedOn: food.loggedOn ?? dayKey() }],
        })),
      removeFood: (id) =>
        set((s) => ({ foodDiary: s.foodDiary.filter((f) => f.id !== id) })),
      toggleTask: (id) =>
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id ? { ...t, completed: !t.completed } : t
          ),
        })),
      toggleReminder: (id) =>
        set((s) => ({
          reminders: s.reminders.map((r) =>
            r.id === id ? { ...r, completed: !r.completed } : r
          ),
        })),

      // Computed
      getConsumedCalories: () =>
        get().foodDiary.reduce((sum, f) => sum + f.calories, 0),
      getConsumedProtein: () =>
        get().foodDiary.reduce((sum, f) => sum + f.protein, 0),
      getConsumedCarbs: () =>
        get().foodDiary.reduce((sum, f) => sum + f.carbs, 0),
      getConsumedFat: () => get().foodDiary.reduce((sum, f) => sum + f.fat, 0),
      // One weight entry per day: logging again the same day replaces the earlier value.
      logWeight: (kg) => {
        const today = dayKey();
        set((s) => ({
          weightLog: [...(s.weightLog ?? []).filter((w) => w.date !== today), { date: today, kg }].sort((a, b) =>
            a.date.localeCompare(b.date)
          ),
        }));
      },

      // Vision-to-Market Staging
      stagedVisionItems: null,
      stagedDietaryPivot: null,
      setStagedVisionItems: (items) => set({ stagedVisionItems: items }),
      setStagedDietaryPivot: (pivot) => set({ stagedDietaryPivot: pivot }),
      clearStagedVision: () => set({ stagedVisionItems: null, stagedDietaryPivot: null }),

      // Theme
      theme: "light",
      setTheme: (t) => set({ theme: t }),
    }),
    {
      name: "smartbite-store",
      version: 2,
      // Remove the demo meals that older builds injected into every account.
      migrate: (persisted: unknown) => {
        const p = (persisted ?? {}) as any;
        const sampleIds = new Set(SAMPLE_FOOD_DIARY.map((f) => f.id));
        return {
          ...p,
          foodDiary: (p.foodDiary ?? []).filter((f: { id: string }) => !sampleIds.has(f.id)),
          tasks: [],
          reminders: [],
          streak: 0,
        } as any;
      },
      partialize: (state) => ({
        lang: state.lang,
        user: state.user,
        isAuthed: state.isAuthed,
        lastUserId: state.lastUserId,
        onboardingProfile: state.onboardingProfile,
        targets: state.targets,
        foodDiary: state.foodDiary,
        weightLog: state.weightLog,
        tasks: state.tasks,
        reminders: state.reminders,
        streak: state.streak,
        theme: state.theme,
      }),
    }
  )
);
