import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;

  try {
    const lists = await db.savedGroceryList.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({
      success: true,
      lists: lists.map((l) => ({ ...l, items: JSON.parse(l.rawItemsJson || "[]") })),
    });
  } catch (err) {
    console.error("[api/grocery/saved GET] error:", err);
    return NextResponse.json({ success: false, error: "Failed to fetch saved lists" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;

  try {
    const body = await req.json();
    const {
      title,
      durationDays = 7,
      budgetMode = "max",
      budgetLimit,
      actualCost = 0,
      healthGoal = "",
      compromisesMade = "",
      suggestedBudget,
      dailyCalories = 0,
      dailyProtein = 0,
      dailyCarbs = 0,
      dailyFat = 0,
      items = [],
    } = body;

    const listTitle = title || `Grocery Plan (${durationDays} Days - ৳${actualCost})`;

    const saved = await db.savedGroceryList.create({
      data: {
        userId: auth.userId,
        title: listTitle,
        durationDays: Number(durationDays),
        budgetMode,
        budgetLimit: budgetLimit ? Number(budgetLimit) : null,
        actualCost: Number(actualCost),
        healthGoal,
        compromisesMade: compromisesMade || null,
        suggestedBudget: suggestedBudget ? Number(suggestedBudget) : null,
        dailyCalories: Number(dailyCalories),
        dailyProtein: Number(dailyProtein),
        dailyCarbs: Number(dailyCarbs),
        dailyFat: Number(dailyFat),
        rawItemsJson: JSON.stringify(items),
      },
    });

    return NextResponse.json({ success: true, list: { ...saved, items } });
  } catch (err) {
    console.error("[api/grocery/saved POST] error:", err);
    return NextResponse.json({ success: false, error: "Failed to save grocery list" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;

  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "List ID is required." }, { status: 400 });
    }

    // Ownership is checked against the session user, so one user cannot delete another's list.
    const existing = await db.savedGroceryList.findFirst({ where: { id, userId: auth.userId } });
    if (!existing) {
      return NextResponse.json({ success: false, error: "List not found or unauthorized." }, { status: 404 });
    }

    await db.savedGroceryList.delete({ where: { id } });
    return NextResponse.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    console.error("[api/grocery/saved DELETE] error:", err);
    return NextResponse.json({ success: false, error: "Failed to delete list" }, { status: 500 });
  }
}
