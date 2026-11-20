import { afterEach, describe, expect, it, vi } from "vitest";
import { aiGroceryPlannerService, type GroceryPlannerInput } from "../src/lib/services/ai-grocery";
const input: GroceryPlannerInput = { userContext:{age:30,gender:"female",height:160,currentWeight:60,activityLevel:"moderate"},healthGoal:"weight loss",durationDays:3,budgetMode:"max",budgetLimitBdt:200,foodInspirations:["rice"],preferences:{allergies:["egg"],intolerances:[],dietaryRestrictions:["vegan"],dislikedFoods:[]} };
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe("Gemini grocery planning",()=>{
 it("passes real inputs and filtered catalog; enforces the total budget",async()=>{
 vi.stubEnv("GEMINI_API_KEY","test-key");vi.stubEnv("GEMINI_MODEL","test-model");
 const request=vi.fn(async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({items:[{foodId:"rice_miniket",quantity:1,reasonEn:"Energy for your three-day plan"}]})}]}}]}),{status:200}));
 vi.stubGlobal("fetch",request);
 const plan=await aiGroceryPlannerService.generatePlan(input);
 const args=request.mock.calls as unknown as [string,RequestInit][];
 const prompt=JSON.parse(JSON.parse(String(args[0][1].body)).contents[0].parts[0].text);
 expect(prompt.profile).toEqual(input.userContext);
 expect(prompt.totalBudgetBdt).toBe(200);expect(prompt.days).toBe(3);
 expect(prompt.catalog.some((f:{id:string})=>f.id.startsWith("eggs_"))).toBe(false);
 expect(plan.budgetAnalysis.totalActualCostBdt).toBeLessThanOrEqual(200);
 expect(plan.budgetAnalysis.totalActualCostBdt).toBeCloseTo(plan.items.reduce((s,i)=>s+i.itemTotal,0),2);
 });
 it("does not silently substitute a fixed basket when Gemini fails",async()=>{
 vi.stubEnv("GEMINI_API_KEY","test-key");vi.stubGlobal("fetch",vi.fn(async()=>new Response("",{status:429})));
 await expect(aiGroceryPlannerService.generatePlan(input)).rejects.toThrow("temporarily unavailable");
 });
 it("rejects foods outside the allowed catalog",async()=>{
 vi.stubEnv("GEMINI_API_KEY","test-key");vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({items:[{foodId:"invented-food",quantity:1}]})}]}}]}))));
 await expect(aiGroceryPlannerService.generatePlan(input)).rejects.toThrow("invalid food");
 });
});
