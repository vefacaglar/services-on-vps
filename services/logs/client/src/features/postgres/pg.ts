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
  /** Server notices (RAISE NOTICE, warnings) raised while running. */
  notices?: string[];
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

// Write mode (POST /api/pg/db/{db}/write/{preview,commit} and
// /api/pg/db/{db}/table/{schema}/{table}/write).
export type PgStatus = {
  configured: boolean;
  invalid: boolean;
  superuser: boolean | null;
  writeEnabled: boolean;
};
export type WriteReason = "ddl" | "no_where";
export type WriteResult = QueryResult & {
  rowsAffected: number;
  ddl: boolean;
  dangerous: boolean;
  reasons: WriteReason[];
  committed: boolean;
};
export type RowWriteResult = {
  command: string;
  rowsAffected: number;
  row: Row | null;
};
export type RowChange =
  | { op: "insert"; values: Record<string, string | null> }
  | {
      op: "update";
      key: Record<string, unknown>;
      values: Record<string, string | null>;
    }
  | { op: "delete"; key: Record<string, unknown> };

/** The typed confirmation must name the database exactly. */
export function confirmMatches(typed: string, db: string) {
  return typed.trim() === db;
}

/** True for a value the server shortened (2000-byte cap plus "…"). */
export function isTruncated(value: unknown) {
  return (
    typeof value === "string" &&
    value.endsWith("…") &&
    new TextEncoder().encode(value).length >= 2000
  );
}

/** Primary-key values of a row; null when a value is missing, null,
 * structured or shortened, so the row cannot be identified safely. */
export function rowKey(row: Row, pk: string[]) {
  if (!pk.length) return null;
  const key: Record<string, unknown> = {};
  for (const name of pk) {
    const value = row[name];
    if (
      value == null ||
      typeof value === "object" ||
      isTruncated(value) ||
      !(name in row)
    )
      return null;
    key[name] = value;
  }
  return key;
}

/** Quotes values into a PostgreSQL array literal ({"a","b",NULL}). */
export function pgArrayLiteral(values: unknown[]): string {
  return `{${values
    .map((v) =>
      v == null
        ? "NULL"
        : Array.isArray(v)
          ? pgArrayLiteral(v)
          : `"${(typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/[\\"]/g, (c) => `\\${c}`)}"`,
    )
    .join(",")}}`;
}

/** A cell value as PostgreSQL input text for the editor. */
export function editText(value: unknown, type: string) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && type.endsWith("[]"))
    return pgArrayLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** "id = 7, code = a" for confirmation dialogs. */
export function describeKey(key: Record<string, unknown>) {
  return Object.entries(key)
    .map(([k, v]) => `${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/** Insert form fields → values: empty fields are left to the column
 * default, NULL is explicit. */
export function insertValues(
  fields: Record<string, { text: string; isNull: boolean }>,
) {
  const values: Record<string, string | null> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (field.isNull) values[name] = null;
    else if (field.text !== "") values[name] = field.text;
  }
  return values;
}

// SQL workspace: query tabs persisted in localStorage (text and database
// only; results and write mode stay in memory).
export type WorkspaceTab = { id: string; title: string; db: string; sql: string };
export type Workspace = { tabs: WorkspaceTab[]; active: string };
export const WORKSPACE_KEY = "pg-workspace-v1";

export function newTab(
  db: string,
  sql = "",
  tabs: WorkspaceTab[] = [],
  label = "Query",
) {
  let n = tabs.length + 1;
  while (tabs.some((t) => t.title === `${label} ${n}`)) n++;
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: `${label} ${n}`,
    db,
    sql,
  } satisfies WorkspaceTab;
}

/** Reads the saved workspace; anything malformed falls back to one tab. */
export function loadWorkspace(
  db: string,
  storage: Pick<Storage, "getItem"> | undefined,
  label = "Query",
): Workspace {
  try {
    const parsed = JSON.parse(storage?.getItem(WORKSPACE_KEY) || "null") as Workspace | null;
    const tabs = (Array.isArray(parsed?.tabs) ? parsed.tabs : []).filter(
      (t): t is WorkspaceTab =>
        !!t &&
        typeof t.id === "string" &&
        typeof t.title === "string" &&
        typeof t.db === "string" &&
        typeof t.sql === "string" &&
        t.db.length > 0 &&
        t.db.length <= 128,
    ).slice(0, 20);
    if (tabs.length)
      return {
        tabs,
        active: tabs.some((t) => t.id === parsed!.active) ? parsed!.active : tabs[0].id,
      };
  } catch {
    // Unavailable or corrupt storage: start fresh.
  }
  const tab = newTab(db, "SELECT now(), current_database();", [], label);
  return { tabs: [tab], active: tab.id };
}

export function saveWorkspace(
  workspace: Workspace,
  storage: Pick<Storage, "setItem"> | undefined,
) {
  try {
    storage?.setItem(
      WORKSPACE_KEY,
      JSON.stringify({
        active: workspace.active,
        tabs: workspace.tabs.map((t) => ({ ...t, sql: t.sql.slice(0, 20000) })),
      }),
    );
  } catch {
    // Quota or privacy mode: the workspace just is not remembered.
  }
}

/** Maps a PostgreSQL error position (1-based, in code points of the text
 * that ran) to a document range covering the word at that point. */
export function errorRange(
  doc: string,
  run: { from: number; text: string },
  position?: number,
) {
  if (!position || position < 1) return null;
  const before = [...run.text].slice(0, position - 1).join("");
  const from = run.from + before.length;
  if (from > doc.length) return null;
  let to = from;
  while (to < doc.length && /[\w$."]/.test(doc[to])) to++;
  return { from, to: Math.max(to, Math.min(from + 1, doc.length)) };
}

/** EXPLAIN output as lines with their indentation intact. */
export function planLines(result: QueryResult | undefined) {
  if (
    !result ||
    result.columns.length !== 1 ||
    result.columns[0].name !== "QUERY PLAN"
  )
    return null;
  return result.rows.map((row) => String(row["QUERY PLAN"] ?? ""));
}

/** Client-side sort of a result: numbers numerically, NULLs last. */
export function sortRows(rows: Row[], column: string, descending: boolean) {
  const numeric = (v: unknown) =>
    typeof v === "number"
      ? v
      : typeof v === "string" && /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v)
        ? Number(v)
        : null;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = a.row[column],
        y = b.row[column];
      if (x == null || y == null)
        return x == null && y == null ? a.index - b.index : x == null ? 1 : -1;
      const nx = numeric(x),
        ny = numeric(y);
      const order =
        nx !== null && ny !== null
          ? nx - ny
          : (typeof x === "string" ? x : JSON.stringify(x)).localeCompare(
              typeof y === "string" ? y : JSON.stringify(y),
            );
      return (descending ? -order : order) || a.index - b.index;
    })
    .map((x) => x.row);
}

/** Cell text for copying: NULL stays distinguishable from empty text. */
export function cellCopy(value: unknown) {
  return value === null || value === undefined
    ? "NULL"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}
export function rowCopy(row: Row, columns: string[]) {
  return columns.map((c) => cellCopy(row[c])).join("\t");
}

const reserved = new Set(
  "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric system_user table then to trailing true union unique user using variadic when where window with".split(
    " ",
  ),
);
/** An identifier as it must be typed: bare when safe, else double-quoted. */
export function sqlIdent(name: string) {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !reserved.has(name)
    ? name
    : quoteIdent(name);
}
/** schema.table for the editor; the public schema is left implicit. */
export function sqlName(schema: string, table: string) {
  return schema === "public"
    ? sqlIdent(table)
    : `${sqlIdent(schema)}.${sqlIdent(table)}`;
}
export function selectTop(schema: string, table: string) {
  return `SELECT *\nFROM ${sqlName(schema, table)}\nLIMIT 100;`;
}
