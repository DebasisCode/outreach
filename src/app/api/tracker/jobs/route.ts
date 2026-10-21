import { after, NextRequest } from "next/server";
import { saveJob } from "@/lib/db";
import type { JobResult } from "@/lib/tool-outputs";
import { jobInputFromResult, requestTrackerSync, trackerReport } from "@/lib/tracker";

export const maxDuration = 120;

/**
 * POST { job, source } -> save a job from a job card (Save / Find recruiter)
 * and log it to the tracker sheet.
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-composio-key") ?? "";
  const userId = req.headers.get("x-composio-user")?.trim() || "default";
  const body = (await req.json().catch(() => ({}))) as { job?: JobResult; source?: string };
  const input = body.job ? jobInputFromResult(body.job, body.source) : null;
  if (!input) {
    return Response.json({ error: "A job needs at least a title." }, { status: 400 });
  }

  const { job, created } = saveJob(input);
  let tracker = {};
  if (apiKey) {
    const sync = requestTrackerSync(apiKey, userId);
    // The first sync also creates the sheet; let it finish after we reply.
    after(() => sync);
    tracker = await trackerReport(sync, 4000);
  }
  return Response.json({
    job: { url: job.url, title: job.title, company: job.company, status: job.status },
    created,
    ...tracker,
  });
}
