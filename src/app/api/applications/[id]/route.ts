import { NextRequest } from "next/server";
import { getApplication } from "@/lib/db";

/** GET -> one application, with its latest view of the form (for the review card). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const app = getApplication(id);
  if (!app) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    application: {
      id: app.id,
      status: app.status,
      title: app.title,
      company: app.company,
      ats: app.ats,
      jobUrl: app.jobUrl,
      url: app.url,
      summary: app.summary,
      submittedAt: app.submittedAt,
      updatedAt: app.updatedAt,
      screenshot: app.screenshot ? `/api/applications/${app.id}/screenshot?v=${app.updatedAt}` : null,
    },
  });
}
