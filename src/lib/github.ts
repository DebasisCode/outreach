import {
  ComposioActionError,
  dig,
  findActiveConnection,
  runAction,
  type ConnectionInfo,
} from "@/lib/composio";
import type {
  GithubDirectoryOutput,
  GithubFileEntry,
  GithubFileOutput,
  GithubMutationOutput,
  GithubPullRequest,
  GithubPullRequestOutput,
  GithubPullRequestsOutput,
  GithubRepositoriesOutput,
  GithubRepository,
} from "@/lib/tool-outputs";
import { jsonSchema, type ToolSet } from "ai";

export const GITHUB_CREATE_BRANCH_TOOL = "github_create_branch";
export const GITHUB_COMMIT_CHANGES_TOOL = "github_commit_changes";
export const GITHUB_CREATE_PULL_REQUEST_TOOL = "github_create_pull_request";
export const GITHUB_APPROVAL_TOOLS = [
  GITHUB_CREATE_BRANCH_TOOL,
  GITHUB_COMMIT_CHANGES_TOOL,
  GITHUB_CREATE_PULL_REQUEST_TOOL,
] as const;

const MAX_FILE_CHARS = 60_000;
const MAX_TREE_ENTRIES = 300;
const MAX_WRITE_FILES = 20;

type Json = Record<string, unknown>;
type RepoInput = { owner: string; repo: string };

const record = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const records = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item): item is Json => Boolean(record(item))) : [];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Composio versions have used data and response_data wrappers over time. */
function payload(data: Json): Json {
  let current = data;
  for (let depth = 0; depth < 3; depth += 1) {
    const next = record(current.response_data) ?? record(current.data);
    if (!next) break;
    current = next;
  }
  return current;
}

function value(data: Json, key: string): unknown {
  const direct = dig(data, key);
  return direct !== undefined ? direct : payload(data)[key];
}

function arrayValue(data: Json, ...keys: string[]): unknown[] {
  let current = data;
  for (let depth = 0; depth < 4; depth += 1) {
    for (const key of keys) {
      if (Array.isArray(current[key])) return current[key] as unknown[];
    }
    for (const wrapper of ["response_data", "data"]) {
      if (Array.isArray(current[wrapper])) return current[wrapper] as unknown[];
    }
    const next = record(current.response_data) ?? record(current.data);
    if (!next) break;
    current = next;
  }
  return [];
}

function resourcePayload(data: Json, key: string): Json {
  const body = payload(data);
  return record(body[key]) ?? body;
}

function required(value: string | undefined, label: string): string {
  const cleaned = value?.trim();
  if (!cleaned) throw new ComposioActionError(`${label} is required.`);
  return cleaned;
}

export function githubPath(path: string, allowEmpty = false): string {
  const cleaned = path.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!cleaned && allowEmpty) return "";
  if (!cleaned || cleaned.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ComposioActionError("Use a valid repository-relative file path.");
  }
  return cleaned;
}

function repoInput(input: RepoInput): RepoInput {
  return { owner: required(input.owner, "GitHub owner"), repo: required(input.repo, "GitHub repository") };
}

function branchName(value: string, label = "Branch"): string {
  return required(required(value, label).replace(/^refs\/heads\//, ""), label);
}

async function requireGithub(apiKey: string, userId: string): Promise<ConnectionInfo> {
  const connection = await findActiveConnection(apiKey, userId, ["github"]);
  if (!connection) {
    throw new ComposioActionError(
      "No GitHub account is connected. Open Connections (plug icon) and connect GitHub first.",
    );
  }
  return connection;
}

async function callForUser(
  apiKey: string,
  userId: string,
  connection: ConnectionInfo,
  slug: string,
  args: Json,
): Promise<Json> {
  return runAction(apiKey, slug, "github", {
    userId,
    connectedAccountId: connection.id,
    args,
  });
}

function mapRepository(row: Json): GithubRepository {
  const owner = record(row.owner);
  const name = text(row.name);
  const fullName = text(row.full_name) ?? ([text(owner?.login), name].filter(Boolean).join("/") || undefined);
  return {
    name,
    full_name: fullName,
    url: text(row.html_url) ?? (fullName ? `https://github.com/${fullName}` : undefined),
    description: text(row.description),
    private: typeof row.private === "boolean" ? row.private : undefined,
    default_branch: text(row.default_branch),
    language: text(row.language),
    updated_at: text(row.updated_at),
  };
}

function mapEntry(row: Json): GithubFileEntry {
  const type = text(row.type);
  return {
    name: text(row.name) ?? text(row.path)?.split("/").at(-1),
    path: text(row.path),
    type: type === "blob" ? "file" : type === "tree" ? "directory" : type,
    size: number(row.size),
    sha: text(row.sha),
    url: text(row.html_url) ?? text(row.url),
  };
}

function mapPullRequest(row: Json): GithubPullRequest {
  const head = record(row.head);
  const base = record(row.base);
  return {
    number: number(row.number),
    title: text(row.title),
    state: text(row.state),
    url: text(row.html_url) ?? text(row.url),
    head: text(head?.ref) ?? text(row.head_ref),
    base: text(base?.ref) ?? text(row.base_ref),
    draft: typeof row.draft === "boolean" ? row.draft : undefined,
    merged: typeof row.merged === "boolean" ? row.merged : Boolean(text(row.merged_at)),
    updated_at: text(row.updated_at),
  };
}

async function repositoryWithConnection(
  apiKey: string,
  userId: string,
  connection: ConnectionInfo,
  input: RepoInput,
): Promise<GithubRepository> {
  const repo = repoInput(input);
  const data = await callForUser(apiKey, userId, connection, "GITHUB_GET_A_REPOSITORY", repo);
  return mapRepository(resourcePayload(data, "repository"));
}

export async function listGithubRepositories(
  apiKey: string,
  userId: string,
  limit = 20,
): Promise<GithubRepositoriesOutput> {
  const connection = await requireGithub(apiKey, userId);
  const perPage = Math.min(Math.max(Math.round(limit), 1), 50);
  const data = await callForUser(apiKey, userId, connection, "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", {
    type: "all",
    sort: "updated",
    direction: "desc",
    per_page: perPage,
  });
  return {
    repositories: records(arrayValue(data, "repositories", "items")).slice(0, perPage).map(mapRepository),
  };
}

export async function getGithubRepository(
  apiKey: string,
  userId: string,
  input: RepoInput,
): Promise<GithubRepository> {
  const connection = await requireGithub(apiKey, userId);
  return repositoryWithConnection(apiKey, userId, connection, input);
}

export async function listGithubFiles(
  apiKey: string,
  userId: string,
  input: RepoInput & { path?: string; ref?: string; recursive?: boolean },
): Promise<GithubDirectoryOutput> {
  const connection = await requireGithub(apiKey, userId);
  const repo = repoInput(input);
  const path = githubPath(input.path ?? "", true);
  if (input.recursive) {
    const ref = input.ref?.trim() ||
      (await repositoryWithConnection(apiKey, userId, connection, repo)).default_branch || "HEAD";
    const data = await callForUser(apiKey, userId, connection, "GITHUB_GET_A_TREE", {
      ...repo,
      tree_sha: ref,
      recursive: "true",
    });
    const rows = records(arrayValue(data, "tree", "entries"));
    return {
      ...repo,
      ref,
      entries: rows.slice(0, MAX_TREE_ENTRIES).map(mapEntry),
      truncated: rows.length > MAX_TREE_ENTRIES || value(data, "truncated") === true,
    };
  }

  const data = await callForUser(apiKey, userId, connection, "GITHUB_GET_REPOSITORY_CONTENT", {
    ...repo,
    path,
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
  });
  const rows = arrayValue(data, "entries", "items");
  const file = resourcePayload(data, "file");
  const entries = rows.length > 0 ? records(rows) : text(file.path) || text(file.name) ? [file] : [];
  return {
    ...repo,
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
    path,
    entries: entries.slice(0, MAX_TREE_ENTRIES).map(mapEntry),
    truncated: entries.length > MAX_TREE_ENTRIES,
  };
}

export function decodeGithubFileContent(
  encoded: string,
  encoding?: string,
  maxChars = MAX_FILE_CHARS,
): { content: string; truncated: boolean } {
  const decoded = encoding?.toLowerCase() === "base64"
    ? Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8")
    : encoded;
  return {
    content: decoded.slice(0, maxChars),
    truncated: decoded.length > maxChars,
  };
}

export async function readGithubFile(
  apiKey: string,
  userId: string,
  input: RepoInput & { path: string; ref?: string },
): Promise<GithubFileOutput> {
  const connection = await requireGithub(apiKey, userId);
  const repo = repoInput(input);
  const path = githubPath(input.path);
  const data = await callForUser(apiKey, userId, connection, "GITHUB_GET_REPOSITORY_CONTENT", {
    ...repo,
    path,
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
  });
  const file = resourcePayload(data, "file");
  if (Array.isArray(file.content) || Array.isArray(data.data) || Array.isArray(data.response_data)) {
    throw new ComposioActionError(`${path} is a directory. Use github_list_files instead.`);
  }
  const encoded = typeof file.content === "string" ? file.content : "";
  if (!encoded && number(file.size) !== 0) {
    throw new ComposioActionError(
      `GitHub returned no content for ${path}. It may be binary or too large for the contents API.`,
    );
  }
  const decoded = decodeGithubFileContent(encoded, text(file.encoding));
  return {
    ...repo,
    ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
    path,
    sha: text(file.sha),
    size: number(file.size),
    content: decoded.content,
    truncated: decoded.truncated,
    url: text(file.html_url),
  };
}

export async function createGithubBranch(
  apiKey: string,
  userId: string,
  input: RepoInput & { branch: string; source?: string },
): Promise<GithubMutationOutput> {
  const connection = await requireGithub(apiKey, userId);
  const repo = repoInput(input);
  const branch = branchName(input.branch, "New branch name");
  const repository = await repositoryWithConnection(apiKey, userId, connection, repo);
  const source = input.source?.trim() || repository.default_branch;
  if (!source) throw new ComposioActionError("Pass source because this repository has no default branch.");
  const sourceData = await callForUser(apiKey, userId, connection, "GITHUB_GET_A_BRANCH", {
    ...repo,
    branch: source,
  });
  const sourceBranch = resourcePayload(sourceData, "branch");
  const commit = record(sourceBranch.commit);
  const sha = text(commit?.sha) ?? text(sourceBranch.sha);
  if (!sha) throw new ComposioActionError(`Couldn't resolve the commit for source branch ${source}.`);
  await callForUser(apiKey, userId, connection, "GITHUB_CREATE_BRANCH", {
    ...repo,
    branch_name: branch,
    sha,
  });
  const fullName = repository.full_name ?? `${repo.owner}/${repo.repo}`;
  return {
    created: true,
    ...repo,
    branch,
    commit_sha: sha,
    url: repository.url ? `${repository.url}/tree/${encodeURIComponent(branch)}` : `https://github.com/${fullName}/tree/${encodeURIComponent(branch)}`,
  };
}

export async function commitGithubChanges(
  apiKey: string,
  userId: string,
  input: RepoInput & {
    branch: string;
    message: string;
    files?: Array<{ path: string; content: string }>;
    delete_paths?: string[];
    base_branch?: string;
  },
): Promise<GithubMutationOutput> {
  const connection = await requireGithub(apiKey, userId);
  const repo = repoInput(input);
  const branch = branchName(input.branch);
  const message = required(input.message, "Commit message");
  const files = (input.files ?? []).slice(0, MAX_WRITE_FILES).map((file) => ({
    path: githubPath(file.path),
    content: file.content,
    encoding: "utf-8",
  }));
  const deleted = [...new Set((input.delete_paths ?? []).map((path) => githubPath(path)))];
  if ((input.files?.length ?? 0) > MAX_WRITE_FILES) {
    throw new ComposioActionError(`Commit at most ${MAX_WRITE_FILES} files at a time.`);
  }
  if (files.length + deleted.length === 0) {
    throw new ComposioActionError("Pass at least one file to create/update or one path to delete.");
  }
  const paths = [...files.map((file) => file.path), ...deleted];
  if (new Set(paths).size !== paths.length) {
    throw new ComposioActionError("A file can appear only once in a commit.");
  }
  const data = await callForUser(apiKey, userId, connection, "GITHUB_COMMIT_MULTIPLE_FILES", {
    ...repo,
    branch,
    message,
    upserts: files,
    ...(deleted.length ? { deletes: deleted } : {}),
    ...(input.base_branch?.trim() ? { base_branch: input.base_branch.trim() } : {}),
    max_retries: 3,
  });
  const result = payload(data);
  const commit = record(result.commit);
  const commitSha = text(result.commit_sha) ?? text(result.new_commit_sha) ?? text(result.sha) ?? text(commit?.sha) ?? text(commit?.oid);
  const fullName = `${repo.owner}/${repo.repo}`;
  return {
    committed: true,
    ...repo,
    branch,
    commit_sha: commitSha,
    files: files.map((file) => file.path),
    deleted,
    url: text(result.html_url) ?? text(commit?.html_url) ?? (commitSha ? `https://github.com/${fullName}/commit/${commitSha}` : undefined),
  };
}

export async function createGithubPullRequest(
  apiKey: string,
  userId: string,
  input: RepoInput & { base: string; head: string; title: string; body?: string; draft?: boolean },
): Promise<GithubPullRequestOutput> {
  const connection = await requireGithub(apiKey, userId);
  const repo = repoInput(input);
  const data = await callForUser(apiKey, userId, connection, "GITHUB_CREATE_A_PULL_REQUEST", {
    ...repo,
    base: required(input.base, "Base branch"),
    head: required(input.head, "Head branch"),
    title: required(input.title, "Pull request title"),
    ...(input.body?.trim() ? { body: input.body } : {}),
    draft: Boolean(input.draft),
    maintainer_can_modify: true,
  });
  return { created: true, ...mapPullRequest(resourcePayload(data, "pull_request")) };
}

export async function listGithubPullRequests(
  apiKey: string,
  userId: string,
  input: RepoInput & { state?: "open" | "closed" | "all"; limit?: number },
): Promise<GithubPullRequestsOutput> {
  const connection = await requireGithub(apiKey, userId);
  const repo = repoInput(input);
  const limit = Math.min(Math.max(Math.round(input.limit ?? 20), 1), 50);
  const data = await callForUser(apiKey, userId, connection, "GITHUB_LIST_PULL_REQUESTS", {
    ...repo,
    state: input.state ?? "open",
    sort: "updated",
    direction: "desc",
    per_page: limit,
  });
  return {
    pull_requests: records(arrayValue(data, "pull_requests", "items")).slice(0, limit).map(mapPullRequest),
  };
}

export async function getGithubPullRequest(
  apiKey: string,
  userId: string,
  input: RepoInput & { number: number },
): Promise<GithubPullRequestOutput> {
  const connection = await requireGithub(apiKey, userId);
  const data = await callForUser(apiKey, userId, connection, "GITHUB_GET_A_PULL_REQUEST", {
    ...repoInput(input),
    pull_number: Math.round(input.number),
  });
  return mapPullRequest(resourcePayload(data, "pull_request"));
}

const RepoProperties = {
  owner: { type: "string", description: "Repository owner or organization" },
  repo: { type: "string", description: "Repository name, without owner or .git" },
} as const;

const RepoSchema = jsonSchema<RepoInput>({
  type: "object",
  properties: RepoProperties,
  required: ["owner", "repo"],
  additionalProperties: false,
});

const ListReposSchema = jsonSchema<{ limit?: number }>({
  type: "object",
  properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
  additionalProperties: false,
});

const ListFilesSchema = jsonSchema<RepoInput & { path?: string; ref?: string; recursive?: boolean }>({
  type: "object",
  properties: {
    ...RepoProperties,
    path: { type: "string", description: "Directory path; empty for the repository root" },
    ref: { type: "string", description: "Branch, tag, or commit SHA" },
    recursive: { type: "boolean", description: "Read the complete repository tree (up to 300 entries)" },
  },
  required: ["owner", "repo"],
  additionalProperties: false,
});

const ReadFileSchema = jsonSchema<RepoInput & { path: string; ref?: string }>({
  type: "object",
  properties: {
    ...RepoProperties,
    path: { type: "string", description: "Repository-relative file path" },
    ref: { type: "string", description: "Branch, tag, or commit SHA" },
  },
  required: ["owner", "repo", "path"],
  additionalProperties: false,
});

const CreateBranchSchema = jsonSchema<RepoInput & { branch: string; source?: string }>({
  type: "object",
  properties: {
    ...RepoProperties,
    branch: { type: "string", description: "New branch name" },
    source: { type: "string", description: "Existing source branch; defaults to the repository default branch" },
  },
  required: ["owner", "repo", "branch"],
  additionalProperties: false,
});

const CommitSchema = jsonSchema<RepoInput & {
  branch: string;
  message: string;
  files?: Array<{ path: string; content: string }>;
  delete_paths?: string[];
  base_branch?: string;
}>({
  type: "object",
  properties: {
    ...RepoProperties,
    branch: { type: "string", description: "Existing target branch, or a new branch when base_branch is supplied" },
    base_branch: { type: "string", description: "Existing branch to create branch from when it does not exist yet" },
    message: { type: "string", description: "Commit message" },
    files: {
      type: "array",
      maxItems: MAX_WRITE_FILES,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Complete new UTF-8 file content, not a diff" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      description: "Files to create or replace atomically",
    },
    delete_paths: { type: "array", items: { type: "string" }, description: "Files to delete in the same commit" },
  },
  required: ["owner", "repo", "branch", "message"],
  additionalProperties: false,
});

const CreatePrSchema = jsonSchema<RepoInput & {
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}>({
  type: "object",
  properties: {
    ...RepoProperties,
    base: { type: "string", description: "Branch to merge into" },
    head: { type: "string", description: "Branch containing the changes (owner:branch for a fork)" },
    title: { type: "string" },
    body: { type: "string", description: "Markdown pull request description" },
    draft: { type: "boolean", default: false },
  },
  required: ["owner", "repo", "base", "head", "title"],
  additionalProperties: false,
});

const ListPrsSchema = jsonSchema<RepoInput & { state?: "open" | "closed" | "all"; limit?: number }>({
  type: "object",
  properties: {
    ...RepoProperties,
    state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
  },
  required: ["owner", "repo"],
  additionalProperties: false,
});

const GetPrSchema = jsonSchema<RepoInput & { number: number }>({
  type: "object",
  properties: {
    ...RepoProperties,
    number: { type: "integer", minimum: 1 },
  },
  required: ["owner", "repo", "number"],
  additionalProperties: false,
});

const failure = (err: unknown) => JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
const run = async (operation: () => Promise<unknown>) => {
  try {
    return JSON.stringify(await operation());
  } catch (err) {
    return failure(err);
  }
};

/** Focused GitHub tools; writes are marked for approval by tools.ts. */
export function buildGithubTools(apiKey: string, userId: string): { tools: ToolSet; enabled: string[] } {
  const tools: ToolSet = {
    github_list_repositories: {
      description: "List repositories accessible to the connected GitHub account, most recently updated first.",
      inputSchema: ListReposSchema,
      execute: async (input) => run(() => listGithubRepositories(apiKey, userId, input.limit)),
    },
    github_get_repository: {
      description: "Get repository metadata, including its default branch, visibility, language, and GitHub URL.",
      inputSchema: RepoSchema,
      execute: async (input) => run(() => getGithubRepository(apiKey, userId, input)),
    },
    github_list_files: {
      description: "List a repository directory, or its recursive file tree. Use before editing to discover exact paths and refs.",
      inputSchema: ListFilesSchema,
      execute: async (input) => run(() => listGithubFiles(apiKey, userId, input)),
    },
    github_read_file: {
      description: "Read a UTF-8 repository file at a branch/tag/commit. Returns its SHA and flags content truncated after 60,000 characters.",
      inputSchema: ReadFileSchema,
      execute: async (input) => run(() => readGithubFile(apiKey, userId, input)),
    },
    [GITHUB_CREATE_BRANCH_TOOL]: {
      description: "Create a GitHub branch from source (the default branch when omitted). The user reviews and approves before anything is created.",
      inputSchema: CreateBranchSchema,
      execute: async (input) => run(() => createGithubBranch(apiKey, userId, input)),
    },
    [GITHUB_COMMIT_CHANGES_TOOL]: {
      description: "Atomically create, replace, or delete up to 20 files in one GitHub commit. Read files before replacing them and pass complete new contents, not patches; never replace a file from a truncated read. Set base_branch to create a new target branch. The user approves the exact changes first; force pushes are not supported.",
      inputSchema: CommitSchema,
      execute: async (input) => run(() => commitGithubChanges(apiKey, userId, input)),
    },
    [GITHUB_CREATE_PULL_REQUEST_TOOL]: {
      description: "Open a GitHub pull request from head into base after the user reviews and approves the title, body, and branches.",
      inputSchema: CreatePrSchema,
      execute: async (input) => run(() => createGithubPullRequest(apiKey, userId, input)),
    },
    github_list_pull_requests: {
      description: "List pull requests in a repository, including their source/target branches and URLs.",
      inputSchema: ListPrsSchema,
      execute: async (input) => run(() => listGithubPullRequests(apiKey, userId, input)),
    },
    github_get_pull_request: {
      description: "Get the current state and branches of one pull request by number.",
      inputSchema: GetPrSchema,
      execute: async (input) => run(() => getGithubPullRequest(apiKey, userId, input)),
    },
  };
  return { tools, enabled: Object.keys(tools) };
}
