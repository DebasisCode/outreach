import { NextRequest } from "next/server";
import { connectWithApiKey, createConnectLink } from "@/lib/composio";

export const maxDuration = 60;

/**
 * POST { composioApiKey, composioUserId, toolkitSlug, apiKey? }
 *  - OAuth toolkits (Gmail, Outlook): returns { redirectUrl } to Composio's
 *    hosted sign-in page.
 *  - API-key toolkits (SerpAPI): pass `apiKey`; returns { status }.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    composioApiKey?: string;
    composioUserId?: string;
    toolkitSlug?: string;
    apiKey?: string;
  };
  const { composioApiKey, toolkitSlug } = body;
  const userId = body.composioUserId?.trim() || "default";
  if (!composioApiKey || !toolkitSlug) {
    return Response.json(
      { error: "Missing Composio API key or toolkit slug" },
      { status: 400 },
    );
  }

  try {
    if (body.apiKey?.trim()) {
      const result = await connectWithApiKey(
        composioApiKey,
        userId,
        toolkitSlug,
        body.apiKey.trim(),
      );
      return Response.json(result);
    }
    const origin = req.headers.get("origin") ?? req.nextUrl.origin;
    const link = await createConnectLink(
      composioApiKey,
      userId,
      toolkitSlug,
      `${origin}/?connected=${encodeURIComponent(toolkitSlug)}`,
    );
    return Response.json(link);
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Failed to connect",
      },
      { status: 500 },
    );
  }
}
