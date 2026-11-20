import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE } from "../src/lib/auth/session";
import { aiRateLimit } from "../src/lib/auth/rate-limit";

// In-memory stand-in for the database. Only the calls the guarded routes make are provided.
const users = new Set(["user-a", "user-b"]);
const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  userFoodPreference: { findUnique: vi.fn(), upsert: vi.fn() },
  savedGroceryList: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db }));

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    users.has(where.id) ? { id: where.id } : null
  );
  db.userFoodPreference.findUnique.mockResolvedValue(null);
  db.userFoodPreference.upsert.mockImplementation(async ({ create }: { create: unknown }) => ({
    ...(create as object), defaultBudgetMode: "max",
  }));
  db.savedGroceryList.findMany.mockResolvedValue([]);
  db.savedGroceryList.create.mockImplementation(async ({ data }: { data: unknown }) => ({ id: "L1", ...(data as object) }));
  db.savedGroceryList.findFirst.mockResolvedValue(null);
});

const cookieFor = (uid: string) => `${SESSION_COOKIE}=${createSessionToken(uid)}`;
const req = (url: string, init: { method?: string; cookie?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const savedRoute = () => import("../src/app/api/grocery/saved/route");
const prefsRoute = () => import("../src/app/api/grocery/preferences/route");
const scanRoute = () => import("../src/app/api/scan-meal/route");
const pivotRoute = () => import("../src/app/api/dietary-pivot/route");
const mcpRoute = () => import("../src/app/api/mcp/route");
const generateRoute = () => import("../src/app/api/grocery/generate/route");
const inspectRoute = () => import("../src/app/api/grocery/inspect-food/route");

describe("auth: every guarded route refuses requests without a valid session", () => {
  it("returns 401 with no cookie", async () => {
    const saved = await savedRoute();
    expect((await saved.GET(req("/api/grocery/saved", { method: "GET" }))).status).toBe(401);
    expect((await saved.POST(req("/api/grocery/saved", { body: {} }))).status).toBe(401);
    const prefs = await prefsRoute();
    expect((await prefs.GET(req("/api/grocery/preferences", { method: "GET" }))).status).toBe(401);
    expect((await (await scanRoute()).POST(req("/api/scan-meal", { body: {} }))).status).toBe(401);
    expect((await (await pivotRoute()).POST(req("/api/dietary-pivot", { body: {} }))).status).toBe(401);
    expect((await (await mcpRoute()).POST(req("/api/mcp", { body: {} }))).status).toBe(401);
    expect((await (await mcpRoute()).GET(req("/api/mcp", { method: "GET" }))).status).toBe(401);
    expect((await (await generateRoute()).POST(req("/api/grocery/generate", { body: {} }))).status).toBe(401);
    expect((await (await inspectRoute()).POST(req("/api/grocery/inspect-food", { body: {} }))).status).toBe(401);
  });

  it("rejects a forged or tampered session cookie", async () => {
    const saved = await savedRoute();
    const forged = `${SESSION_COOKIE}=eyJ1aWQiOiJ1c2VyLWEifQ.not-a-real-signature`;
    expect((await saved.GET(req("/api/grocery/saved", { method: "GET", cookie: forged }))).status).toBe(401);
  });

  it("rejects a valid token whose account no longer exists", async () => {
    const saved = await savedRoute();
    const res = await saved.GET(req("/api/grocery/saved", { method: "GET", cookie: cookieFor("deleted-user") }));
    expect(res.status).toBe(401);
  });
});

describe("auth: identity comes from the session, never from the request", () => {
  it("saves a list under the session user even when the body names another user", async () => {
    const saved = await savedRoute();
    const res = await saved.POST(req("/api/grocery/saved", {
      cookie: cookieFor("user-a"),
      body: { userId: "user-b", title: "Mine", items: [] },
    }));
    expect(res.status).toBe(200);
    expect(db.savedGroceryList.create.mock.calls[0][0].data.userId).toBe("user-a");
  });

  it("lists only the session user's lists, ignoring a userId in the query", async () => {
    const saved = await savedRoute();
    await saved.GET(req("/api/grocery/saved?userId=user-b", { method: "GET", cookie: cookieFor("user-a") }));
    expect(db.savedGroceryList.findMany.mock.calls[0][0].where.userId).toBe("user-a");
  });

  it("deletes only when the list belongs to the session user", async () => {
    const saved = await savedRoute();
    await saved.DELETE(req("/api/grocery/saved?id=L9&userId=user-b", { method: "DELETE", cookie: cookieFor("user-a") }));
    expect(db.savedGroceryList.findFirst.mock.calls[0][0].where).toEqual({ id: "L9", userId: "user-a" });
  });

  it("writes preferences for the session user, ignoring a userId in the body", async () => {
    const prefs = await prefsRoute();
    const res = await prefs.PUT(req("/api/grocery/preferences", {
      method: "PUT",
      cookie: cookieFor("user-a"),
      body: { userId: "user-b", allergies: ["egg"] },
    }));
    expect(res.status).toBe(200);
    expect(db.userFoodPreference.upsert.mock.calls[0][0].where.userId).toBe("user-a");
  });

  it("loads the user's allergy context from the session user, not a body userId", async () => {
    const pivot = await pivotRoute();
    await pivot.POST(req("/api/dietary-pivot", {
      cookie: cookieFor("user-a"),
      body: { userId: "user-b", mealName: "Dal", ingredients: ["dal"] },
    }));
    const lookedUp = db.userFoodPreference.findUnique.mock.calls.map((c) => c[0].where.userId);
    expect(lookedUp).toContain("user-a");
    expect(lookedUp).not.toContain("user-b");
  });

  it("no longer contains the demo_user fallback", async () => {
    const files = await Promise.all([
      import("node:fs").then((fs) => fs.readFileSync("src/app/api/grocery/saved/route.ts", "utf8")),
      import("node:fs").then((fs) => fs.readFileSync("src/app/api/grocery/preferences/route.ts", "utf8")),
      import("node:fs").then((fs) => fs.readFileSync("src/components/shopping/ShoppingScreen.tsx", "utf8")),
    ]);
    for (const src of files) expect(src).not.toContain("demo_user");
  });
});

describe("rate limits on AI routes", () => {
  const ip = (addr: string) => new Headers({ "x-forwarded-for": addr });

  it("blocks a user after the per-user limit", () => {
    const r = (n: number) => new NextRequest("http://localhost/x", { headers: ip(`10.0.0.${n}`) });
    const results = Array.from({ length: 21 }, (_, i) => aiRateLimit(r(100 + i), "rl-user-1", "t-user", { perUser: 20, perIp: 1000 }));
    expect(results.slice(0, 20).every((x) => x === null)).toBe(true);
    expect(results[20]?.status).toBe(429);
  });

  it("blocks an IP after the per-IP limit, even across different users", () => {
    const same = new NextRequest("http://localhost/x", { headers: ip("203.0.113.9") });
    const results = Array.from({ length: 4 }, (_, i) => aiRateLimit(same, `rl-ip-user-${i}`, "t-ip", { perUser: 100, perIp: 3 }));
    expect(results[2]).toBeNull();
    expect(results[3]?.status).toBe(429);
  });

  it("uses the rightmost X-Forwarded-For address so a client cannot spoof its way out", () => {
    const spoof = (fake: string) => new NextRequest("http://localhost/x", { headers: ip(`${fake}, 198.51.100.7`) });
    const a = aiRateLimit(spoof("1.1.1.1"), "rl-spoof-user-a", "t-spoof", { perUser: 100, perIp: 1 });
    const b = aiRateLimit(spoof("2.2.2.2"), "rl-spoof-user-b", "t-spoof", { perUser: 100, perIp: 1 });
    expect(a).toBeNull();
    expect(b?.status).toBe(429);
  });

  it("the scan route returns 429 once the user is over the limit", async () => {
    const scan = await scanRoute();
    const cookie = cookieFor("user-b");
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await scan.POST(req("/api/scan-meal", { cookie, body: {} }));
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
