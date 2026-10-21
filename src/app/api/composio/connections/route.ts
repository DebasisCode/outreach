import { NextRequest } from "next/server";
import {
  describeConnection,
  disconnectConnection,
  listConnections,
} from "@/lib/composio";

export const maxDuration = 60;

function credentials(req: NextRequest) {
  return {
    apiKey: req.headers.get("x-composio-key") ?? "",
    userId: req.headers.get("x-composio-user")?.trim() || "default",
  };
}

const failure = (err: unknown, fallback: string) =>
  Response.json({ error: err instanceof Error ? err.message : fallback }, { status: 500 });

/** GET -> this user's connections, with the mailbox address for active ones. */
export async function GET(req: NextRequest) {
  const { apiKey, userId } = credentials(req);
  if (!apiKey) {
    return Response.json({ error: "Missing Composio API key" }, { status: 400 });
  }
  try {
    const connections = await listConnections(apiKey, userId);
    const withLabels = await Promise.all(
      connections.map(async (connection) => ({
        ...connection,
        account: await describeConnection(apiKey, userId, connection),
      })),
    );
    return Response.json({ connections: withLabels });
  } catch (err) {
    return failure(err, "Failed to list Composio connections");
  }
}

/** DELETE ?id=ca_... -> disconnect one of this user's accounts. */
export async function DELETE(req: NextRequest) {
  const { apiKey, userId } = credentials(req);
  const id = req.nextUrl.searchParams.get("id");
  if (!apiKey || !id) {
    return Response.json({ error: "Missing Composio API key or connection id" }, { status: 400 });
  }
  try {
    await disconnectConnection(apiKey, userId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return failure(err, "Failed to disconnect");
  }
}
