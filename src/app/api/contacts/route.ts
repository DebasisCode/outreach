import { listRecentContacts } from "@/lib/db";

export const maxDuration = 30;

export async function GET() {
  return Response.json({ contacts: listRecentContacts(100) });
}