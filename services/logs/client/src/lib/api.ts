import { clearHistory } from "./sessionHistory";
import type { Key } from "./i18n";
export type LogRow = Record<string, unknown>;
export class ApiError extends Error {
  key: Key;
  status: number;
  code: string;
  position?: number;
  constructor(key: Key, status = 0, details = "", code = "") {
    super(details);
    this.key = key;
    this.status = status;
    this.code = code;
  }
}
const meiliKeys: Record<string, Key> = {
  not_configured: "meiliNotConfigured",
  unreachable: "meiliUnreachable",
  invalid_key: "meiliInvalidKey",
};
const pgKeys: Record<string, Key> = {
  not_configured: "pgNotConfigured",
  invalid_config: "pgInvalidConfig",
  unreachable: "pgUnreachable",
  auth_failed: "pgAuthFailed",
  too_many_connections: "pgTooManyConnections",
  write_disabled: "pgWriteDisabled",
  confirmation_required: "pgConfirmRequired",
  database_confirmation_required: "pgDbConfirmRequired",
  rows_changed: "pgRowsChanged",
  row_count: "pgRowCount",
  no_primary_key: "pgNoPrimaryKey",
  not_a_table: "pgNotATable",
  transaction_control: "pgTransactionControl",
  blocked_statement: "pgBlocked",
  invalid_row: "pgInvalidRow",
};
const ciKeys: Record<string, Key> = {
  not_configured: "ciNotConfigured",
};
// Mapped codes whose server message names the offending function or column.
const keepDetails = new Set(["blocked_statement", "invalid_row"]);
// Meilisearch, PostgreSQL and CI routes return {error, code}; keep the engine's
// own message (e.g. an invalid filter or SQL error) as details. Other routes
// keep generic messages.
export async function serviceError(
  response: Response,
  keys: Record<string, Key>,
  rejected: Key,
): Promise<ApiError> {
  let body: { error?: string; code?: string; position?: number } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Non-JSON error bodies fall back to the status mapping.
  }
  const code = body.code || "";
  const key: Key =
    keys[code] ||
    (code === "timeout"
      ? "pgTimeout"
      : code === "read_only"
        ? "pgReadOnly"
        : response.status === 404
          ? "meiliNotFound"
          : response.status === 400
            ? rejected
            : "requestFailed");
  const details =
    (keys[code] && !keepDetails.has(code)) || !body.error
      ? ""
      : body.error.slice(0, 2000);
  const error = new ApiError(key, response.status, details, code);
  error.position = body.position;
  return error;
}
export const meiliError = (response: Response) =>
  serviceError(response, meiliKeys, "meiliRequestRejected");
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "logs-ui",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("connectionFailed");
  }
  if (!response.ok) {
    if (response.status === 401) clearHistory();
    else if (path.startsWith("/api/meili/")) throw await meiliError(response);
    else if (path.startsWith("/api/pg/"))
      throw await serviceError(response, pgKeys, "queryError");
    else if (path.startsWith("/api/ci/"))
      throw await serviceError(response, ciKeys, "ciRequestRejected");
    const key: Key =
      response.status === 401
        ? path === "/api/login"
          ? "invalidCredentials"
          : "sessionExpired"
        : response.status === 429
          ? "rateLimit"
          : response.status === 400
            ? "invalidQuery"
            : "requestFailed";
    throw new ApiError(key, response.status);
  }
  return response.json() as Promise<T>;
}
export async function engine<T>(
  endpoint: string,
  params: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await engineResponse(endpoint, params, signal);
  return response.json() as Promise<T>;
}
export async function engineResponse(
  endpoint: string,
  params: Record<string, string | number>,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(`/select/logsql/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      ),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("connectionFailed");
  }
  if (response.status === 401) {
    clearHistory();
    throw new ApiError("sessionExpired", 401);
  }
  if (!response.ok)
    throw new ApiError(
      "queryError",
      response.status,
      (await response.text()).slice(0, 8000),
    );
  return response;
}
export function parseJSONLines(text: string): LogRow[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row))
        throw new ApiError("invalidJSON");
      return row as LogRow;
    });
}
export async function* streamJSONLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<LogRow> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const abort = () => {
    void reader.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 2_000_000) throw new ApiError("invalidJSON");
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines)
        for (const row of parseJSONLines(line)) {
          if (signal.aborted) return;
          yield row;
        }
      if (done) {
        for (const row of parseJSONLines(pending)) yield row;
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value);
}
export function fieldsOf(rows: LogRow[]): string[] {
  const keys = new Set(rows.flatMap((row) => Object.keys(row)));
  return [...keys].sort((a, b) => {
    const rank = (key: string) =>
      ["_time", "level", "compose_service", "_msg"].indexOf(key);
    const ar = rank(a),
      br = rank(b);
    return ar < 0 && br < 0
      ? a.localeCompare(b)
      : ar < 0
        ? 1
        : br < 0
          ? -1
          : ar - br;
  });
}
export function quoted(value: string) {
  return JSON.stringify(value);
}
export function download(
  rows: LogRow[],
  format: "jsonl" | "csv" | "json",
  columns?: string[],
  name = "logs",
) {
  const fields = columns || fieldsOf(rows);
  const csv = (value: unknown) => `"${display(value).replaceAll('"', '""')}"`;
  const text =
    format === "jsonl"
      ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
      : format === "json"
        ? JSON.stringify(rows, null, 2) + "\n"
        : [
          fields.map(csv).join(","),
          ...rows.map((row) => fields.map((key) => csv(row[key])).join(",")),
        ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([text], {
      type:
        format === "jsonl"
          ? "application/x-ndjson"
          : format === "json"
            ? "application/json"
            : "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
