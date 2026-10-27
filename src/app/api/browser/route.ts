import { NextRequest } from "next/server";
import { browserStatus, closeBrowser, showPage } from "@/lib/browser/session";

/** GET -> is the automation browser open? */
export async function GET() {
  return Response.json(browserStatus());
}

/** POST { action: "show", id? } brings a tab to the front · { action: "close" } closes the window. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
  if (body.action === "close") {
    await closeBrowser();
    return Response.json({ ok: true });
  }
  if (body.action === "show") {
    const shown = await showPage(body.id ?? null).catch(() => false);
    return Response.json(
      shown ? { ok: true } : { ok: false, error: "That tab isn't open — the assistant reopens it on the next step." },
      { status: shown ? 200 : 404 },
    );
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
