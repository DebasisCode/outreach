import { NextRequest } from "next/server";
import { storeKnowledge } from "@/lib/knowledge";
import { extractFileText } from "@/lib/extract";
import type { UserKeys } from "@/lib/types";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const keysRaw = form.get("keys");
  const file = form.get("file");
  if (typeof keysRaw !== "string" || !(file instanceof File)) {
    return Response.json({ error: "Missing file or keys" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return Response.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  let keys: UserKeys;
  try {
    keys = JSON.parse(keysRaw) as UserKeys;
  } catch {
    return Response.json({ error: "Invalid keys payload" }, { status: 400 });
  }

  try {
    const text = await extractFileText(file);
    if (!text.trim()) {
      return Response.json(
        { error: "Could not extract any text — scanned PDFs without a text layer aren't supported." },
        { status: 422 },
      );
    }
    const result = await storeKnowledge(keys, file.name, text);
    return Response.json(result);
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to process the file",
      },
      { status: 500 },
    );
  }
}