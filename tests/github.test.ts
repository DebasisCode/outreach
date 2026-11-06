import assert from "node:assert/strict";
import { test } from "node:test";
import { testEnvironment } from "./helpers";

testEnvironment();

test("GitHub auth configs are reused only for the exact scope set", async () => {
  const { githubScopesMatch } = await import("@/lib/composio");
  assert.equal(githubScopesMatch(["repo", "read:user"], ["read:user", "repo"]), true);
  assert.equal(githubScopesMatch("repo, read:user", ["read:user", "repo"]), true);
  assert.equal(githubScopesMatch(["repo", "read:user", "admin:org"], ["read:user", "repo"]), false);
  assert.equal(githubScopesMatch(undefined, ["repo"]), false);
});

test("GitHub connection creates a repo-only config without calling scope recommendation", async () => {
  const { ensureGithubAuthConfig, GITHUB_OAUTH_SCOPES } = await import("@/lib/composio");
  let createdScopes: unknown;
  const client = {
    authConfigs: {
      list: async () => ({ items: [] }),
      create: async (_toolkit: string, input: { credentials?: { scopes?: unknown } }) => {
        createdScopes = input.credentials?.scopes;
        return { id: "github-scoped" };
      },
    },
  } as never;

  assert.deepEqual([...GITHUB_OAUTH_SCOPES], ["repo"]);
  assert.equal(await ensureGithubAuthConfig(client), "github-scoped");
  assert.deepEqual(createdScopes, ["repo"]);
});

test("repository paths are normalized and traversal is rejected", async () => {
  const { githubPath } = await import("@/lib/github");
  assert.equal(githubPath("/src\\components/file.ts"), "src/components/file.ts");
  assert.equal(githubPath("", true), "");
  assert.throws(() => githubPath("../secret"));
  assert.throws(() => githubPath("src/../secret"));
});

test("GitHub file content is decoded and bounded", async () => {
  const { decodeGithubFileContent } = await import("@/lib/github");
  assert.deepEqual(decodeGithubFileContent("aGVsbG8sIHdvcmxkCg==", "base64"), {
    content: "hello, world\n",
    truncated: false,
  });
  assert.deepEqual(decodeGithubFileContent("abcdef", "utf-8", 3), {
    content: "abc",
    truncated: true,
  });
});

test("GitHub exposes focused reads and approval-gated writes only", async () => {
  const { buildTools, toolApprovals } = await import("@/lib/tools");
  const { tools, enabled } = buildTools({
    llmApiKey: "x",
    llmProvider: "anthropic",
    llmModel: "mock",
    cleanlistApiKey: "",
    composioApiKey: "test-key",
    composioUserId: "default",
  });
  const reads = [
    "github_list_repositories",
    "github_get_repository",
    "github_list_files",
    "github_read_file",
    "github_list_pull_requests",
    "github_get_pull_request",
  ];
  const writes = ["github_create_branch", "github_commit_changes", "github_create_pull_request"];
  const approvals = toolApprovals(tools);

  for (const name of [...reads, ...writes]) {
    assert.ok(tools[name], `${name} should be registered`);
    assert.ok(enabled.includes(name), `${name} should be enabled`);
  }
  for (const name of reads) assert.equal(approvals[name], undefined);
  for (const name of writes) assert.equal(approvals[name], "user-approval");
  assert.equal(tools.github_delete_repository, undefined);
  assert.equal(tools.github_merge_pull_request, undefined);
});
