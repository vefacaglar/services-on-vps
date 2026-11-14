// Shapes returned by the console's read-only /api/meili/* routes and the pure
// helpers the Meilisearch pages share.

export type IndexRow = {
  uid: string;
  primaryKey: string | null;
  createdAt: string;
  updatedAt: string;
  numberOfDocuments?: number;
  indexSize?: number;
  isIndexing?: boolean;
  numberOfEmbeddedDocuments?: number;
};
export type Overview = {
  version: string;
  health: string;
  databaseSize: number;
  usedDatabaseSize: number;
  lastUpdate: string | null;
  indexes: IndexRow[];
  totalIndexes: number;
  features: Record<string, unknown> | null;
};
export type Task = {
  uid: number;
  indexUid: string | null;
  status: TaskStatus;
  type: string;
  details?: Record<string, unknown> | null;
  error?: { message: string; code: string } | null;
  duration: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
export type TaskPage = {
  results: Task[];
  total: number;
  limit: number;
  from: number | null;
  next: number | null;
};
export type ApiKey = {
  name: string | null;
  description: string | null;
  uid: string;
  keyPrefix: string;
  actions: string[];
  indexes: string[];
  expiresAt: string | null;
  createdAt: string;
};
export type IndexStats = {
  numberOfDocuments: number;
  rawDocumentDbSize?: number;
  avgDocumentSize?: number;
  isIndexing: boolean;
  numberOfEmbeddings?: number;
  numberOfEmbeddedDocuments?: number;
  fieldDistribution: Record<string, number>;
};
export type IndexDetail = {
  index: IndexRow;
  stats: IndexStats;
  settings: Record<string, unknown>;
};
export type DocumentPage = {
  results: Record<string, unknown>[];
  offset: number;
  limit: number;
  total: number;
};
export type SearchResult = {
  hits: Record<string, unknown>[];
  estimatedTotalHits?: number;
  totalHits?: number;
  processingTimeMs: number;
  facetDistribution?: Record<string, Record<string, number>>;
};

export const taskStatuses = [
  "enqueued",
  "processing",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];

// Common task types; Meilisearch adds more over time, so the filter is advisory.
export const taskTypes = [
  "documentAdditionOrUpdate",
  "documentEdition",
  "documentDeletion",
  "settingsUpdate",
  "indexCreation",
  "indexUpdate",
  "indexDeletion",
  "indexSwap",
  "taskCancelation",
  "taskDeletion",
  "dumpCreation",
  "snapshotCreation",
] as const;

export const UID = /^[a-zA-Z0-9_-]{1,400}$/;

export function taskQuery(filters: {
  statuses?: string[];
  types?: string[];
  indexUids?: string[];
  limit?: number;
  from?: number | null;
}): string {
  const params = new URLSearchParams();
  for (const name of ["statuses", "types", "indexUids"] as const) {
    const values = (filters[name] || []).filter(Boolean);
    if (values.length) params.set(name, values.join(","));
  }
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.from != null) params.set("from", String(filters.from));
  const text = params.toString();
  return "/api/meili/tasks" + (text ? `?${text}` : "");
}

/** Parses ISO 8601 durations such as "PT0.012345S" or "PT1M2.5S" into ms. */
export function durationMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(
    value,
  );
  if (!match) return null;
  const [, d, h, m, s] = match;
  return (
    ((+(d || 0) * 24 + +(h || 0)) * 60 + +(m || 0)) * 60000 +
    Math.round(+(s || 0) * 1000)
  );
}

export function formatDuration(ms: number | null, locale: string): string {
  if (ms == null) return "—";
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(
      value,
    );
  if (ms < 1000) return `${number(ms)} ms`;
  if (ms < 60000) return `${number(ms / 1000, 1)} s`;
  return `${number(Math.floor(ms / 60000))} min ${number(Math.round((ms % 60000) / 1000))} s`;
}

/** Index swaps recorded in indexSwap task details, newest first. */
export function swapsOf(tasks: Task[]) {
  return tasks.flatMap((task) => {
    const swaps = task.details?.swaps;
    if (!Array.isArray(swaps)) return [];
    return swaps.flatMap((swap: unknown) => {
      const entry = swap as { indexes?: unknown; rename?: unknown };
      if (!Array.isArray(entry.indexes) || entry.indexes.length !== 2)
        return [];
      return [
        {
          task: task.uid,
          status: task.status,
          at: task.finishedAt || task.enqueuedAt,
          from: String(entry.indexes[0]),
          to: String(entry.indexes[1]),
          rename: entry.rename === true,
        },
      ];
    });
  });
}

/** One-line summary of task details for tables. */
export function taskSummary(task: Task): string {
  const details = task.details || {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value == null || key === "swaps") continue;
    if (typeof value === "number" || typeof value === "string")
      parts.push(`${key}: ${value}`);
    else if (Array.isArray(value)) parts.push(`${key}: ${value.length}`);
    else parts.push(key);
  }
  return parts.join(" · ");
}

/** Field distribution sorted by count, then name. */
export function fieldRows(distribution: Record<string, number> | undefined) {
  return Object.entries(distribution || {})
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));
}

export type SettingRow = {
  key: string;
  kind: "list" | "map" | "value" | "object";
  empty: boolean;
  value: unknown;
};

/** Normalises settings for a readable list; empty lists and maps are flagged. */
export function settingRows(settings: Record<string, unknown>): SettingRow[] {
  return Object.entries(settings).map(([key, value]) => {
    if (Array.isArray(value))
      return { key, kind: "list", empty: value.length === 0, value };
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      const flat = entries.every(
        ([, v]) => v == null || typeof v !== "object" || Array.isArray(v),
      );
      return {
        key,
        kind: flat ? "map" : "object",
        empty: entries.length === 0,
        value,
      };
    }
    return { key, kind: "value", empty: value == null, value };
  });
}

export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
