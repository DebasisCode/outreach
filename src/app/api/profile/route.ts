import { NextRequest } from "next/server";
import { getUser, upsertUser } from "@/lib/db";
import type { UserKeys } from "@/lib/types";

export const maxDuration = 30;

/** GET /api/profile?username=x -> stored keys JSON (or 404). */
export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  if (!username?.trim()) {
    return Response.json({ error: "Missing username" }, { status: 400 });
  }
  const user = getUser(username);
  if (!user) {
    return Response.json({ error: "Unknown username" }, { status: 404 });
  }
  return Response.json({ username: user.username, keys: JSON.parse(user.keys) });
}

/** POST { username, keys } -> upsert the user's keys. */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    username?: string;
    keys?: Partial<UserKeys>;
  };
  if (!body.username?.trim()) {
    return Response.json({ error: "Missing username" }, { status: 400 });
  }
  if (!body.keys || typeof body.keys !== "object") {
    return Response.json({ error: "Missing keys" }, { status: 400 });
  }
  upsertUser(body.username, JSON.stringify(body.keys));
  return Response.json({ ok: true, username: body.username.trim().toLowerCase() });
}