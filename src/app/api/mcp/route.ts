import { NextRequest, NextResponse } from "next/server";
import { SMARTBITE_MCP_TOOLS, handleMCPToolCall } from "@/lib/mcp/server";
import { requireUser } from "@/lib/auth/require-user";
import { aiRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;

  return NextResponse.json({
    mcpVersion: "1.0.0",
    serverName: "smartbite-nutrition-mcp",
    transport: "HTTP/JSON-RPC",
    tools: SMARTBITE_MCP_TOOLS,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;
  const limited = aiRateLimit(req, auth.userId, "mcp", { perUser: 60, perIp: 120 });
  if (limited) return limited;

  try {
    const body = await req.json();
    const { tool, arguments: args } = body;

    if (!tool || typeof tool !== "string") {
      return NextResponse.json({ error: "Invalid MCP request. Missing 'tool' name." }, { status: 400 });
    }

    const result = await handleMCPToolCall(tool, args || {});
    return NextResponse.json({
      success: true,
      tool,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "MCP Execution Error" },
      { status: 500 }
    );
  }
}
