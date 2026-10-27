import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { serveFixtures, testEnvironment } from "./helpers";

testEnvironment();

let site: { origin: string; close: () => Promise<void> };
let session: typeof import("@/lib/browser/session");

before(async () => {
  session = await import("@/lib/browser/session");
  site = await serveFixtures();
});

after(async () => {
  await session.closeBrowser();
  await site.close();
});

/** Runs one model step that calls `toolName` with `input`, with the app's real tools and approval rules. */
async function callTool(toolName: string, input: Record<string, unknown>) {
  const { streamText, isStepCount } = await import("ai");
  const { MockLanguageModelV4 } = await import("ai/test");
  const { simulateReadableStream } = await import("ai");
  const { buildTools, toolApprovals } = await import("@/lib/tools");
  const keys = { llmApiKey: "x", llmProvider: "anthropic" as const, llmModel: "mock", cleanlistApiKey: "", composioApiKey: "", composioUserId: "" };
  const { tools } = buildTools(keys);
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, logprobs: undefined, usage },
        ],
      }),
    }),
  });
  const result = streamText({ model, prompt: "go", tools, toolApproval: toolApprovals(tools), stopWhen: isStepCount(1) });
  const types: string[] = [];
  for await (const part of result.stream) types.push(part.type);
  return types;
}

test("submitting an application always waits for the user", async () => {
  const types = await callTool("browser_apply_submit", { application_id: "anything" });
  assert.ok(types.includes("tool-approval-request"), types.join(","));
  assert.ok(!types.includes("tool-result"), "must not run before approval");
});

test("browser clicks wait for the user only when they would submit, send, buy or delete", async () => {
  const { browseOpen } = await import("@/lib/browser/browse");
  const snap = await session.withBrowser(() => browseOpen(`${site.origin}/browse.html`));
  const order = snap.elements.find((element) => element.label === "Place order")!;
  const details = snap.elements.find((element) => element.label === "Show details")!;

  const risky = await callTool("browser_act", { id: order.id, action: "click" });
  assert.ok(risky.includes("tool-approval-request"), risky.join(","));
  assert.ok(!risky.includes("tool-result"));

  const safe = await callTool("browser_act", { id: details.id, action: "click" });
  assert.ok(!safe.includes("tool-approval-request"), safe.join(","));
  assert.ok(safe.includes("tool-result"), safe.join(","));
});
