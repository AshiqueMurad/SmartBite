import type { ActivityLevel, GoalType, Gender } from "@/lib/nutrition";

/** Profile data the client sends to the server so AI answers can be personalized. */
export interface ProfilePayload {
  gender: Gender;
  age: number;
  height: number;
  currentWeight: number;
  goalWeight: number;
  activityLevel: ActivityLevel;
  goal: GoalType;
  dailyCalories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export const GOAL_LABELS: Record<GoalType, string> = {
  lose: "weight loss",
  maintain: "weight maintenance",
  gain: "healthy weight gain",
  muscle: "muscle gain",
  overall: "overall metabolic health",
};

interface ProfileLike {
  gender: Gender;
  age: number;
  height: number;
  currentWeight: number;
  goalWeight: number;
  activityLevel: ActivityLevel;
  goal: GoalType;
}

interface TargetsLike {
  dailyCalories: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Builds the payload from the store's onboarding profile and computed targets. */
export function profilePayload(
  profile: ProfileLike | null | undefined,
  targets: TargetsLike | null | undefined
): ProfilePayload | null {
  if (!profile) return null;
  return {
    gender: profile.gender,
    age: profile.age,
    height: profile.height,
    currentWeight: profile.currentWeight,
    goalWeight: profile.goalWeight,
    activityLevel: profile.activityLevel,
    goal: profile.goal,
    dailyCalories: targets?.dailyCalories ?? null,
    protein: targets?.protein ?? null,
    carbs: targets?.carbs ?? null,
    fat: targets?.fat ?? null,
  };
}
