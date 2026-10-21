import { NextRequest } from "next/server";
import { getTrackerStatus, requestTrackerSync } from "@/lib/tracker";

// The first sync creates the spreadsheet and copies everything saved so far.
export const maxDuration = 120;

function credentials(req: NextRequest) {
  return {
    apiKey: req.headers.get("x-composio-key") ?? "",
    userId: req.headers.get("x-composio-user")?.trim() || "default",
  };
}

/** GET -> is Google Sheets connected, the sheet link, rows waiting, saved jobs. */
export async function GET(req: NextRequest) {
  const { apiKey, userId } = credentials(req);
  return Response.json(await getTrackerStatus(apiKey, userId));
}

/** POST -> sync now (creates the tracker sheet on first use). */
export async function POST(req: NextRequest) {
  const { apiKey, userId } = credentials(req);
  if (!apiKey) {
    return Response.json({ error: "Missing Composio API key" }, { status: 400 });
  }
  const outcome = await requestTrackerSync(apiKey, userId);
  const status = await getTrackerStatus(apiKey, userId);
  return Response.json({ outcome, status });
}
