import { recognizeFoods } from "@/lib/services/free-vision";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { requireUser } from "@/lib/auth/require-user";
import { aiRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if ("error" in auth) return auth.error;
  const limited = aiRateLimit(req, auth.userId, "inspect-food", { perUser: 40, perIp: 120 });
  if (limited) return limited;

  try {
    const body = await req.json();
    const { image, text } = body as { image?: string; text?: string };

    const detectedItems: string[] = [];

    // If text inspiration provided, parse simple food phrases
    if (text && typeof text === "string" && text.trim()) {
      const parts = text
        .split(/[,;\n+&]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 1);
      detectedItems.push(...parts);
    }

    // If image provided, analyze image or call vision
    if (image && typeof image === "string" && image.startsWith("data:image/")) {
      const match = image.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/);
      const base64Raw = match ? match[1] : image;
      const rawBuffer = Buffer.from(base64Raw, "base64");
      
      // Optimize image before sending to vision API
      let buffer: Buffer;
      try {
        buffer = await sharp(rawBuffer)
          .rotate()
          .resize(800, 800, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch {
        buffer = rawBuffer;
      }

      const items = await recognizeFoods(buffer);
      if (!items.length) return NextResponse.json({ success: false, error: "No supported food was recognized. Try a closer photo or type the ingredients." }, { status: 422 });
      detectedItems.push(...items);
    }
    // Deduplicate
    const unique = Array.from(new Set(detectedItems)).slice(0, 8);

    if (!unique.length) return NextResponse.json({success:false,error:"Provide a photo or ingredient."},{status:400});
    return NextResponse.json({
      success: true,
      items: unique,
    });
  } catch (err) {
    console.error("[inspect-food] error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to inspect food inspiration" },
      { status: 500 }
    );
  }
}
