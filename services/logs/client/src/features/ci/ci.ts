// Shapes returned by the console's /api/ci/* routes (a gateway in front of
// Woodpecker CI), the typed calls and the pure helpers the CI pages share.
import { api } from "../../lib/api";
import type { Key } from "../../lib/i18n";

export const ciStatuses = [
  "skipped",
  "pending",
  "running",
  "success",
  "failure",
  "killed",
  "canceled",
  "error",
  "blocked",
  "declined",
  "created",
] as const;
export type CiStatus = (typeof ciStatuses)[number];

export type CiStep = {
  id: number;
  name: string;
  state: CiStatus;
  type: string;
  started: number;
  finished: number;
  exitCode: number;
  error: string;
};
export type CiWorkflow = {
  id: number;
  name: string;
  state: CiStatus;
  started: number;
  finished: number;
  error: string;
  steps: CiStep[];
};
export type CiPipeline = {
  number: number;
  status: CiStatus;
  event: string;
  branch: string;
  commit: string;
  message: string;
  author: string;
  created: number;
  started: number;
  finished: number;
  environment: string;
  variables: Record<string, string>;
  errors: { message: string; isWarning: boolean }[];
  forgeUrl: string;
  workflows?: CiWorkflow[];
};
export type CiRepo = {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  forgeUrl: string;
  lastPipeline: CiPipeline | null;
};
export type CiOverview = {
  user: string;
  version: string;
  url: string;
  repos: CiRepo[];
};
export type CiAvailableRepo = {
  forgeRemoteId: string;
  fullName: string;
  private: boolean;
  active: boolean;
  id: number;
};
export type CiRepoDetail = {
  repo: CiRepo;
  branches: string[];
  pipelines: CiPipeline[];
};
export type CiPipelineDetail = { repo: CiRepo; pipeline: CiPipeline };
export type CiLogLine = {
  line: number;
  time: number;
  type: number;
  text: string;
};
export type CiLog = { lines: CiLogLine[]; truncated: boolean };
export type BuildRequest = {
  branch: string;
  environment: string;
  variables: Record<string, string>;
};

const repoPath = (id: number) => `/api/ci/repos/${id}`;
const pipelinePath = (id: number, number: number) =>
  `${repoPath(id)}/pipelines/${number}`;

export const ciApi = {
  overview: (signal?: AbortSignal) =>
    api<CiOverview>("/api/ci/overview", undefined, signal),
  available: (signal?: AbortSignal) =>
    api<{ repos: CiAvailableRepo[] }>("/api/ci/available", undefined, signal),
  addRepo: (forgeRemoteId: string) =>
    api<CiRepo>("/api/ci/repos", { forgeRemoteId }),
  repo: (id: number, signal?: AbortSignal) =>
    api<CiRepoDetail>(repoPath(id), undefined, signal),
  trigger: (id: number, body: BuildRequest) =>
    api<CiPipeline>(`${repoPath(id)}/pipelines`, body),
  pipeline: (id: number, number: number, signal?: AbortSignal) =>
    api<CiPipelineDetail>(pipelinePath(id, number), undefined, signal),
  log: (id: number, number: number, stepId: number, signal?: AbortSignal) =>
    api<CiLog>(
      `${pipelinePath(id, number)}/steps/${stepId}/logs`,
      undefined,
      signal,
    ),
  cancel: (id: number, number: number) =>
    api<{ ok: true }>(`${pipelinePath(id, number)}/cancel`, {}),
};

/** Route parameters are positive integers; anything else is not a page. */
export function parseId(value: string | undefined): number | null {
  return value && /^[1-9]\d{0,14}$/.test(value) ? +value : null;
}

const active: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "created",
  "blocked",
]);
/** Still moving: worth polling, and can be canceled. */
export function isActive(status: string | undefined): boolean {
  return !!status && active.has(status);
}

export type Tone = "ok" | "bad" | "run" | "wait" | "off";
const tones: Record<CiStatus, Tone> = {
  success: "ok",
  failure: "bad",
  error: "bad",
  killed: "bad",
  running: "run",
  pending: "wait",
  created: "wait",
  blocked: "wait",
  skipped: "off",
  canceled: "off",
  declined: "off",
};
/** Statuses Woodpecker adds later read as neutral instead of breaking. */
export function statusTone(status: string): Tone {
  return Object.hasOwn(tones, status) ? tones[status as CiStatus] : "off";
}

const labels: Record<CiStatus, Key> = {
  skipped: "ciStatusSkipped",
  pending: "ciStatusPending",
  running: "ciStatusRunning",
  success: "ciStatusSuccess",
  failure: "ciStatusFailure",
  killed: "ciStatusKilled",
  canceled: "ciStatusCanceled",
  error: "ciStatusError",
  blocked: "ciStatusBlocked",
  declined: "ciStatusDeclined",
  created: "ciStatusCreated",
};
/** Dictionary key of a status, or null to show the raw value. */
export function statusKey(status: string): Key | null {
  return Object.hasOwn(labels, status) ? labels[status as CiStatus] : null;
}

/**
 * Elapsed seconds of a pipeline, workflow or step. Timestamps are unix
 * seconds and 0 means not set; an unfinished item counts up to `now` only
 * while it is still active.
 */
export function elapsedSeconds(
  item: { started: number; finished: number; state: string },
  now: number,
): number | null {
  if (!item.started) return null;
  const end = item.finished || (isActive(item.state) ? now : 0);
  if (!end) return null;
  return Math.max(0, Math.floor(end - item.started));
}

export function formatSeconds(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** Unix seconds to an ISO string for the shared date formatter. */
export function isoOf(seconds: number): string | null {
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

export const shortCommit = (commit: string) => commit.slice(0, 7);

export function firstLine(message: string): string {
  return message.trim().split(/\r?\n/, 1)[0].trim();
}

export const defaultEnvironments = ["production", "staging"] as const;
/** The fixed suggestions, then every environment already used, in order. */
export function environmentSuggestions(
  pipelines: Pick<CiPipeline, "environment">[],
): string[] {
  return [
    ...new Set([
      ...defaultEnvironments,
      ...pipelines.map((p) => p.environment.trim()).filter(Boolean),
    ]),
  ];
}

/** The repository's default branch first, then the rest as listed. */
export function branchOptions(
  branches: string[],
  defaultBranch: string,
): string[] {
  return [...new Set([defaultBranch, ...branches].filter(Boolean))];
}

const failed: ReadonlySet<string> = new Set(["failure", "error", "killed"]);
/** The step to show first: the running one, else the first failed, else the first. */
export function pickStep(workflows: CiWorkflow[] | undefined): CiStep | null {
  const steps = (workflows || []).flatMap((workflow) => workflow.steps || []);
  return (
    steps.find((step) => step.state === "running") ||
    steps.find((step) => failed.has(step.state)) ||
    steps[0] ||
    null
  );
}

export type LogKind = "stdout" | "stderr" | "exit" | "meta" | "progress";
const logKinds: LogKind[] = ["stdout", "stderr", "exit", "meta", "progress"];
export function logKind(type: number): LogKind {
  return logKinds[type] || "stdout";
}

export type VariableRow = { name: string; value: string };
export type BuildProblem = { key: Key; values?: Record<string, string> };
export type BuildCheck =
  { ok: true; body: BuildRequest } | { ok: false; problem: BuildProblem };

export const MAX_VARIABLES = 20;
export const MAX_VALUE_LENGTH = 4096;
const ENVIRONMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Why a variable name is refused, or null when the server would take it. */
export function variableNameProblem(name: string): Key | null {
  if (!VARIABLE.test(name)) return "ciInvalidVariableName";
  if (
    name.startsWith("CI_") ||
    name.startsWith("WOODPECKER_") ||
    name === "DEPLOY_ENV"
  )
    return "ciReservedVariable";
  return null;
}

/**
 * Applies the server's rules before a build is sent. Branch and environment
 * are trimmed; rows left entirely empty are dropped.
 */
export function validateBuild(input: {
  branch: string;
  environment: string;
  variables: VariableRow[];
}): BuildCheck {
  const fail = (key: Key, values?: Record<string, string>): BuildCheck => ({
    ok: false,
    problem: { key, values },
  });
  const branch = input.branch.trim();
  if (!branch) return fail("ciBranchRequired");
  if (branch.length > 255) return fail("ciBranchTooLong");
  const environment = input.environment.trim();
  if (environment && !ENVIRONMENT.test(environment))
    return fail("ciInvalidEnvironment");
  const rows = input.variables
    .map((row) => ({ name: row.name.trim(), value: row.value }))
    .filter((row) => row.name || row.value);
  if (rows.length > MAX_VARIABLES) return fail("ciTooManyVariables");
  const variables: Record<string, string> = {};
  for (const { name, value } of rows) {
    if (!name) return fail("ciVariableNameRequired");
    const problem = variableNameProblem(name);
    if (problem) return fail(problem, { name });
    if (Object.hasOwn(variables, name))
      return fail("ciDuplicateVariable", { name });
    if (value.length > MAX_VALUE_LENGTH || value.includes("\0"))
      return fail("ciInvalidVariableValue", { name });
    variables[name] = value;
  }
  return { ok: true, body: { branch, environment, variables } };
}
