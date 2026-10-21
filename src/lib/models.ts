import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { OLLAMA_CLOUD_BASE_URL, type UserKeys } from "@/lib/types";

/** The chat model for the user's provider + key. */
export function resolveModel(keys: UserKeys) {
  switch (keys.llmProvider) {
    case "openai":
      return createOpenAI({ apiKey: keys.llmApiKey })(keys.llmModel);
    case "google":
      return createGoogleGenerativeAI({ apiKey: keys.llmApiKey })(keys.llmModel);
    case "ollama":
      // Ollama Cloud only implements /v1/chat/completions — its OpenAI-compat
      // layer rejects the Responses API (unknown "item_reference" items).
      return createOpenAI({
        baseURL: OLLAMA_CLOUD_BASE_URL,
        apiKey: keys.llmApiKey,
      }).chat(keys.llmModel);
    default:
      return createAnthropic({ apiKey: keys.llmApiKey })(keys.llmModel);
  }
}
