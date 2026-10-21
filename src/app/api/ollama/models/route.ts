import { NextRequest } from "next/server";

export const maxDuration = 60;

/**
 * List the user's available Ollama Cloud models. Proxies
 * https://ollama.com/api/tags with the user's Bearer key so the key never
 * hits the browser network tab as a query param and CORS stays our friend.
 */
export async function GET(req: NextRequest) {
  const apiKey = req.headers.get("x-ollama-key") ?? "";
  if (!apiKey) {
    return Response.json(
      { error: "Missing Ollama API key — add it in Settings." },
      { status: 400 },
    );
  }

  try {
    const res = await fetch("https://ollama.com/api/tags", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return Response.json(
        {
          error:
            res.status === 401 || res.status === 403
              ? "Ollama rejected the API key — check it at ollama.com/settings/keys."
              : `Ollama API error (${res.status})`,
        },
        { status: res.status },
      );
    }
    const payload = (await res.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const models = (payload.models ?? [])
      .map((m) => m.name ?? m.model ?? "")
      .filter(Boolean);
    return Response.json({ models });
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? `Failed to reach Ollama Cloud: ${err.message}`
            : "Failed to reach Ollama Cloud",
      },
      { status: 502 },
    );
  }
}