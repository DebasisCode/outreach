"use client";

import { Kbd } from "@/components/kbd";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  parseToolOutput,
  type GithubDirectoryOutput,
  type GithubFileOutput,
  type GithubMutationOutput,
  type GithubPullRequest,
  type GithubPullRequestOutput,
  type GithubPullRequestsOutput,
  type GithubRepositoriesOutput,
  type GithubRepository,
} from "@/lib/tool-outputs";
import {
  BanIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileCodeIcon,
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";

function Shell({
  icon,
  title,
  meta,
  children,
  footer,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="not-prose bg-card mb-4 w-full overflow-hidden rounded-lg border">
      <div className="bg-muted/40 flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          {icon ?? <GitBranchIcon className="size-3.5 shrink-0" />}
          <span className="truncate">{title}</span>
        </div>
        {meta ? <div className="text-muted-foreground shrink-0 text-[11px]">{meta}</div> : null}
      </div>
      {children}
      {footer ? <div className="border-t px-3 py-2">{footer}</div> : null}
    </div>
  );
}

function Line({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "bad" }) {
  return (
    <p className={`flex items-start gap-1.5 text-xs ${tone === "ok" ? "text-green-700 dark:text-green-500" : tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}>
      {children}
    </p>
  );
}

function External({ href, children }: { href?: string; children: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a className="inline-flex min-w-0 items-center gap-1 hover:underline" href={href} rel="noopener noreferrer" target="_blank">
      <span className="truncate">{children}</span>
      <ExternalLinkIcon className="size-3 shrink-0 opacity-50" />
    </a>
  );
}

const repositoryName = (input: Record<string, unknown>) =>
  `${typeof input.owner === "string" ? input.owner : ""}/${typeof input.repo === "string" ? input.repo : ""}`;

const text = (value: unknown) => (typeof value === "string" ? value : "");

interface GithubFileChange {
  path?: string;
  content?: string;
}

function CommitReview({ input }: { input: Record<string, unknown> }) {
  const files = Array.isArray(input.files)
    ? input.files.filter((file): file is GithubFileChange => Boolean(file) && typeof file === "object")
    : [];
  const deleted = Array.isArray(input.delete_paths)
    ? input.delete_paths.filter((path): path is string => typeof path === "string")
    : [];
  return (
    <div>
      <div className="space-y-1 px-3 py-2.5 text-xs">
        <p className="font-mono">{repositoryName(input)}</p>
        <p><span className="text-muted-foreground">Branch:</span> {text(input.branch)}</p>
        {text(input.base_branch) ? <p><span className="text-muted-foreground">Create from:</span> {text(input.base_branch)}</p> : null}
        <p><span className="text-muted-foreground">Commit:</span> {text(input.message)}</p>
      </div>
      <div className="divide-y border-t">
        {files.map((file) => (
          <details className="group" key={file.path} open={files.length === 1}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium">
              <FileCodeIcon className="size-3.5 text-muted-foreground" />
              {file.path}
              <span className="text-muted-foreground ml-auto font-normal">new complete content</span>
            </summary>
            <pre className="bg-muted/30 max-h-72 overflow-auto whitespace-pre-wrap break-words border-t px-3 py-2 font-mono text-[11px]">{file.content ?? ""}</pre>
          </details>
        ))}
        {deleted.map((path) => (
          <p className="text-destructive flex items-center gap-2 px-3 py-2 text-xs" key={path}>
            <BanIcon className="size-3.5" /> Delete {path}
          </p>
        ))}
      </div>
    </div>
  );
}

const APPROVAL_INFO: Record<string, { title: string; action: string; running: string }> = {
  github_create_branch: { title: "Create this GitHub branch?", action: "Create branch", running: "Creating branch…" },
  github_commit_changes: { title: "Commit these GitHub changes?", action: "Commit changes", running: "Committing changes…" },
  github_create_pull_request: { title: "Open this GitHub pull request?", action: "Open pull request", running: "Opening pull request…" },
};

export function GitHubApprovalCard({
  toolName,
  input,
  state,
  approved,
  output,
  errorText,
  onRespond,
  mac = false,
}: {
  toolName: string;
  input: Record<string, unknown>;
  state: string;
  approved?: boolean;
  output?: unknown;
  errorText?: string;
  onRespond?: (approved: boolean) => void;
  mac?: boolean;
}) {
  const info = APPROVAL_INFO[toolName] ?? { title: "Approve this GitHub change?", action: "Approve", running: "Working…" };
  const mutation = parseToolOutput<GithubMutationOutput>(output);
  const pullRequest = parseToolOutput<GithubPullRequestOutput>(output);
  const succeeded = toolName === "github_create_pull_request" ? pullRequest?.created === true : toolName === "github_commit_changes" ? mutation?.committed === true : mutation?.created === true;
  const result = toolName === "github_create_pull_request" ? pullRequest : mutation;
  const waiting = state === "approval-requested" && onRespond;

  let review: ReactNode;
  if (toolName === "github_commit_changes") {
    review = <CommitReview input={input} />;
  } else if (toolName === "github_create_pull_request") {
    review = (
      <div className="space-y-2 px-3 py-2.5 text-xs">
        <p className="font-mono">{repositoryName(input)}</p>
        <p><span className="text-muted-foreground">Merge</span> {text(input.head)} <span className="text-muted-foreground">into</span> {text(input.base)}</p>
        <p className="text-sm font-medium">{text(input.title)}</p>
        {text(input.body) ? <p className="whitespace-pre-wrap text-muted-foreground">{text(input.body)}</p> : null}
        {input.draft ? <Badge variant="outline">Draft</Badge> : null}
      </div>
    );
  } else {
    review = (
      <div className="space-y-1 px-3 py-2.5 text-xs">
        <p className="font-mono">{repositoryName(input)}</p>
        <p><span className="text-muted-foreground">New branch:</span> {text(input.branch)}</p>
        <p><span className="text-muted-foreground">From:</span> {text(input.source) || "repository default branch"}</p>
      </div>
    );
  }

  let footer: ReactNode;
  if (waiting) {
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button onClick={() => onRespond(false)} size="sm" variant="ghost">
          <BanIcon /> Don&apos;t
          <Kbd className="ml-1 hidden h-4.5 sm:inline-flex" keys={["esc"]} mac={mac} />
        </Button>
        <Button onClick={() => onRespond(true)} size="sm">
          {toolName === "github_create_pull_request" ? <GitPullRequestIcon /> : <GitBranchIcon />}
          {info.action}
          <Kbd className="bg-primary-foreground/15 text-primary-foreground ml-1 hidden h-4.5 border-transparent sm:inline-flex" keys={["mod", "enter"]} mac={mac} />
        </Button>
      </div>
    );
  } else if (state === "approval-requested") {
    footer = <Line><BanIcon className="size-3.5" /> Not done — the chat moved on without a decision.</Line>;
  } else if (state === "output-denied" || state === "approval-responded" && approved === false) {
    footer = <Line><BanIcon className="size-3.5" /> Not done.</Line>;
  } else if (state === "output-error" || state === "output-available" && !succeeded) {
    footer = <Line tone="bad"><XCircleIcon className="mt-px size-3.5 shrink-0" /> {errorText ?? result?.error ?? "GitHub did not complete the change."}</Line>;
  } else if (state === "output-available" && succeeded) {
    footer = (
      <Line tone="ok">
        <CheckCircle2Icon className="mt-px size-3.5 shrink-0" />
        <span>
          {toolName === "github_create_pull_request" ? `Pull request #${pullRequest?.number ?? ""} opened` : toolName === "github_commit_changes" ? "Changes committed" : "Branch created"}
          {result?.url ? <> · <External href={result.url}>View on GitHub</External></> : null}
        </span>
      </Line>
    );
  } else {
    footer = <Line><LoaderCircleIcon className="size-3.5 animate-spin" /> {info.running}</Line>;
  }

  return (
    <Shell
      footer={footer}
      icon={toolName === "github_create_pull_request" ? <GitPullRequestIcon className="size-3.5" /> : <GitBranchIcon className="size-3.5" />}
      title={waiting ? info.title : toolName === "github_create_pull_request" ? "GitHub pull request" : "GitHub change"}
    >
      {review}
    </Shell>
  );
}

function Repository({ repository }: { repository: GithubRepository }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
        <External href={repository.url}>{repository.full_name ?? repository.name ?? "Repository"}</External>
        {repository.private ? <Badge variant="outline">Private</Badge> : null}
      </div>
      {repository.description ? <p className="text-muted-foreground mt-0.5 text-xs">{repository.description}</p> : null}
      <p className="text-muted-foreground mt-1 text-[11px]">
        {[repository.language, repository.default_branch ? `default: ${repository.default_branch}` : undefined].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

function PullRequests({ pullRequests }: { pullRequests: GithubPullRequest[] }) {
  if (pullRequests.length === 0) return <div className="px-3 py-2.5 text-xs text-muted-foreground">No pull requests found.</div>;
  return (
    <div className="divide-y">
      {pullRequests.map((pr) => (
        <div className="px-3 py-2.5" key={pr.number ?? pr.url ?? pr.title}>
          <div className="flex items-center gap-2 text-sm font-medium">
            <External href={pr.url}>#{pr.number} {pr.title}</External>
            {pr.state ? <Badge variant="outline">{pr.state}</Badge> : null}
            {pr.draft ? <Badge variant="secondary">Draft</Badge> : null}
          </div>
          <p className="text-muted-foreground mt-1 font-mono text-[11px]">{pr.head ?? "?"} → {pr.base ?? "?"}</p>
        </div>
      ))}
    </div>
  );
}

/** Read-only GitHub tool results. */
export function GitHubResultCard({ toolName, output }: { toolName: string; output: unknown }) {
  if (toolName === "github_list_repositories") {
    const result = parseToolOutput<GithubRepositoriesOutput>(output);
    const repositories = result?.repositories ?? [];
    return (
      <Shell meta={`${repositories.length} shown`} title="GitHub repositories">
        {repositories.length ? <div className="divide-y">{repositories.map((repo) => <Repository key={repo.full_name ?? repo.name} repository={repo} />)}</div> : <div className="px-3 py-2.5 text-xs text-muted-foreground">No accessible repositories found.</div>}
      </Shell>
    );
  }
  if (toolName === "github_get_repository") {
    const repository = parseToolOutput<GithubRepository>(output) ?? {};
    return <Shell title={repository.full_name ?? "GitHub repository"}><Repository repository={repository} /></Shell>;
  }
  if (toolName === "github_list_files") {
    const result = parseToolOutput<GithubDirectoryOutput>(output);
    const entries = result?.entries ?? [];
    return (
      <Shell meta={result?.ref} title={`${result?.repo ?? "Repository"}${result?.path ? `/${result.path}` : ""}`}>
        <div className="divide-y">
          {entries.map((entry) => (
            <div className="flex items-center gap-2 px-3 py-2 text-xs" key={`${entry.type}-${entry.path}`}>
              {entry.type === "directory" || entry.type === "dir" ? <FolderIcon className="size-3.5 text-muted-foreground" /> : <FileIcon className="size-3.5 text-muted-foreground" />}
              {entry.url ? <External href={entry.url}>{entry.path ?? entry.name}</External> : <span>{entry.path ?? entry.name}</span>}
              {entry.size !== undefined ? <span className="text-muted-foreground ml-auto text-[11px]">{entry.size} B</span> : null}
            </div>
          ))}
          {entries.length === 0 ? <p className="px-3 py-2.5 text-xs text-muted-foreground">Empty directory.</p> : null}
        </div>
        {result?.truncated ? <p className="border-t px-3 py-2 text-[11px] text-amber-700 dark:text-amber-500">Tree truncated; narrow the path to see more.</p> : null}
      </Shell>
    );
  }
  if (toolName === "github_read_file") {
    const result = parseToolOutput<GithubFileOutput>(output);
    return (
      <Shell icon={<FileCodeIcon className="size-3.5" />} meta={result?.ref} title={result?.path ?? "Repository file"}>
        <pre className="bg-muted/20 max-h-96 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px]">{result?.content ?? ""}</pre>
        {result?.truncated ? <p className="border-t px-3 py-2 text-[11px] text-amber-700 dark:text-amber-500">Content truncated after 60,000 characters.</p> : null}
      </Shell>
    );
  }
  if (toolName === "github_list_pull_requests") {
    const result = parseToolOutput<GithubPullRequestsOutput>(output);
    return <Shell icon={<GitPullRequestIcon className="size-3.5" />} title="GitHub pull requests"><PullRequests pullRequests={result?.pull_requests ?? []} /></Shell>;
  }
  const result = parseToolOutput<GithubPullRequestOutput>(output);
  return <Shell icon={<GitPullRequestIcon className="size-3.5" />} title="GitHub pull request"><PullRequests pullRequests={result ? [result] : []} /></Shell>;
}
