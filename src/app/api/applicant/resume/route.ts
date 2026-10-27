import fs from "node:fs";
import { NextRequest } from "next/server";
import { deleteResume, getResumeInfo, resumePath, saveResume } from "@/lib/applicant";
import { extractFileText } from "@/lib/extract";
import { storeKnowledge } from "@/lib/knowledge";
import type { UserKeys } from "@/lib/types";

export const maxDuration = 120;

/**
 * POST (multipart: file, keys?, addToKnowledge?) -> the resume applications
 * upload. With addToKnowledge=1 its text also goes into the knowledge base,
 * so the assistant can answer questions from it.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file" }, { status: 400 });
  let resume;
  try {
    resume = await saveResume(file);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Couldn't save the file" }, { status: 400 });
  }
  let knowledge: string | null = null;
  if (form.get("addToKnowledge") === "1") {
    try {
      const keysRaw = form.get("keys");
      const keys = (typeof keysRaw === "string" ? JSON.parse(keysRaw) : {}) as UserKeys;
      const text = await extractFileText(file);
      if (text.trim()) {
        await storeKnowledge(keys, `Resume — ${resume.fileName}`, text);
        knowledge = "added";
      } else {
        knowledge = "no text found in the file";
      }
    } catch (err) {
      knowledge = err instanceof Error ? err.message : "couldn't add it to the knowledge base";
    }
  }
  return Response.json({ resume, knowledge });
}

/** GET -> the resume file itself. */
export async function GET() {
  const file = resumePath();
  const info = getResumeInfo();
  if (!file || !info) return Response.json({ error: "No resume uploaded" }, { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${encodeURIComponent(info.fileName)}"`,
    },
  });
}

export async function DELETE() {
  deleteResume();
  return Response.json({ ok: true });
}
