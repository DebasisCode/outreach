import { NextRequest } from "next/server";
import { getApplicantProfile, getResumeInfo, saveApplicantProfile } from "@/lib/applicant";

/** GET -> { profile, resume } — what application forms are filled from. */
export async function GET() {
  return Response.json({ profile: getApplicantProfile(), resume: getResumeInfo() });
}

/** PUT { profile } -> saves the given fields. */
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { profile?: Record<string, unknown> } | null;
  if (!body?.profile || typeof body.profile !== "object") {
    return Response.json({ error: "Missing profile" }, { status: 400 });
  }
  return Response.json({ profile: saveApplicantProfile(body.profile), resume: getResumeInfo() });
}
