import fs from "node:fs";
import { NextRequest } from "next/server";
import { screenshotPath } from "@/lib/applications";
import { getApplication } from "@/lib/db";

/** GET -> the latest screenshot of the application form (JPEG). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const app = getApplication(id);
  const file = app ? screenshotPath(app) : null;
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
  });
}
