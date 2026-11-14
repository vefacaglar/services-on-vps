// Shapes returned by the console's read-only /api/pg/* routes and the pure
// helpers the PostgreSQL pages share.

export type Row = Record<string, unknown>;
export type Overview = {
  server: {
    version: string;
    fullVersion: string;
    startedAt: string;
    uptimeSeconds: number;
    maxConnections: number;
    user: string;
    database: string;
    waitingLocks: number;
  };
  connections: { state: string; count: number }[];
  totals: {
    commits: number | string | null;
    rollbacks: number | string | null;
    deadlocks: number | string | null;
    cacheHitRatio: number | null;
  };
  databases: {
    name: string;
    size: number;
    connections: number;
    commits: number | string | null;
    rollbacks: number | string | null;
    deadlocks: number | string | null;
    cacheHitRatio: number | null;
  }[];
  longRunning: {
    pid: number;
    database: string | null;
    user: string | null;
    application: string | null;
    client: string | null;
    state: string | null;
    waitEventType: string | null;
    waitEvent: string | null;
    seconds: number;
    query: string;
  }[];
};
export type TableRow = {
  schema: string;
  name: string;
  kind: string;
  estimatedRows: number;
  totalSize: number;
  tableSize: number;
  indexSize: number;
  seqScans: number | null;
  idxScans: number | null;
  liveRows: number | null;
  deadRows: number | null;
  lastVacuum: string | null;
  lastAnalyze: string | null;
  readable: boolean;
};
export type Database = {
  database: string;
  size: number;
  schemas: { name: string; owner: string; tables: number }[];
  tables: TableRow[];
  views: { schema: string; name: string }[];
  extensions: { name: string; version: string; schema: string }[];
  statements:
    | {
        query: string;
        calls: number;
        totalMs: number;
        meanMs: number;
        rows: number;
      }[]
    | null;
  statementsError?: string;
};
export type TableDetail = {
  database: string;
  schema: string;
  name: string;
  kind: string;
  info: {
    estimatedRows: number;
    totalSize: number;
    tableSize: number;
    indexSize: number;
    comment: string | null;
    readable: boolean;
    owner: string;
  };
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    comment: string | null;
  }[];
  constraints: { name: string; type: string; definition: string }[];
  indexes: {
    name: string;
    definition: string;
    size: number;
    scans: number;
    unique: boolean;
    primary: boolean;
    unused: boolean;
  }[];
  triggers: { name: string; definition: string; enabled: boolean }[];
};
export type QueryResult = {
  columns: { name: string; type: string }[];
  rows: Row[];
  truncated: boolean;
  durationMs: number;
  command?: string;
  orderBy?: string[];
};

export type SortKey = "name" | "estimatedRows" | "totalSize" | "deadRows";

/** Sorts tables; numbers descending first, names ascending first. */
export function sortTables(
  tables: TableRow[],
  key: SortKey,
  descending: boolean,
  filter = "",
): TableRow[] {
  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? tables.filter((t) =>
        `${t.schema}.${t.name}`.toLowerCase().includes(needle),
      )
    : [...tables];
  const value = (t: TableRow): number | string =>
    key === "name" ? `${t.schema}.${t.name}` : Number(t[key] ?? -1);
  rows.sort((a, b) => {
    const x = value(a),
      y = value(b);
    const order =
      typeof x === "string"
        ? x.localeCompare(y as string)
        : (x as number) - (y as number);
    return descending ? -order : order;
  });
  return rows;
}

/** URL for a table, with each identifier segment escaped. */
export function tablePath(db: string, schema: string, table: string) {
  return `/postgres/db/${encodeURIComponent(db)}/table/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`;
}
export function dbPath(db: string, suffix = "") {
  return `/postgres/db/${encodeURIComponent(db)}${suffix}`;
}
export function apiPath(path: string) {
  return "/api/pg" + path.slice("/postgres".length);
}

/** Double-quotes an identifier the way PostgreSQL expects. */
export function quoteIdent(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

export function starterQuery(schema: string, table: string) {
  return `SELECT *\nFROM ${quoteIdent(schema)}.${quoteIdent(table)}\nLIMIT 100`;
}

export function formatUptime(seconds: number, language: "tr" | "en") {
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60);
  const units = language === "tr" ? ["g", "sa", "dk"] : ["d", "h", "min"];
  if (d) return `${d} ${units[0]} ${h} ${units[1]}`;
  if (h) return `${h} ${units[1]} ${m} ${units[2]}`;
  return `${m} ${units[2]}`;
}

/** Splits a 0-based error position into line and column (1-based). */
export function errorLocation(sql: string, position?: number) {
  if (!position || position < 1) return null;
  const before = [...sql].slice(0, position - 1).join("");
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
