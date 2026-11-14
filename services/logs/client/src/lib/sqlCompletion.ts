// Schema-aware SQL completion data for the PostgreSQL editor. Pure helpers;
// QueryEditor turns them into CodeMirror completion sources.

export type SchemaColumn = {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
};
export type DbSchema = {
  schemas: Record<string, Record<string, SchemaColumn[]>>;
  /** "table", "view", "materialized view" or "foreign table". */
  kinds?: Record<string, Record<string, string>>;
  truncated: boolean;
};
export type CompletionItem = {
  label: string;
  type: string;
  detail?: string;
  boost?: number;
};
export type Namespace = Record<string, Record<string, CompletionItem[]>>;

/** {schema: {table: [{name, type}]}} → lang-sql's namespace, with column
 * types as completion details. */
export function completionNamespace(schema: DbSchema | undefined): Namespace {
  const out: Namespace = {};
  for (const [name, tables] of Object.entries(schema?.schemas || {})) {
    out[name] = {};
    for (const [table, columns] of Object.entries(tables))
      out[name][table] = columns.map((c) => ({
        label: c.name,
        type: "property",
        detail: c.type,
      }));
  }
  return out;
}

const ident = `(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*)`;
const reference = new RegExp(
  `\\b(?:from|join|update|into)\\s+(?:only\\s+)?(${ident}(?:\\s*\\.\\s*${ident})?)`,
  "gi",
);

function unquote(part: string) {
  const name = part.trim();
  return name.startsWith('"')
    ? name.slice(1, -1).replaceAll('""', '"')
    : name.toLowerCase();
}

/** Blanks out comments and string literals so FROM inside them is ignored. */
function code(sql: string) {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'?/g, (m) =>
    " ".repeat(m.length),
  );
}

/** Tables named after FROM, JOIN, UPDATE or INTO, resolved against the
 * schema (unqualified names: public first, then any schema). */
export function referencedTables(sql: string, schema: DbSchema | undefined) {
  const found: { schema: string; table: string }[] = [];
  if (!schema) return found;
  for (const match of code(sql).matchAll(reference)) {
    const parts = match[1]
      .split(new RegExp(`\\s*\\.\\s*(?=${ident}$)`))
      .map(unquote);
    let resolved: { schema: string; table: string } | undefined;
    if (parts.length === 2) {
      if (schema.schemas[parts[0]]?.[parts[1]])
        resolved = { schema: parts[0], table: parts[1] };
    } else {
      const owner = schema.schemas.public?.[parts[0]]
        ? "public"
        : Object.keys(schema.schemas).find((s) => schema.schemas[s][parts[0]]);
      if (owner) resolved = { schema: owner, table: parts[0] };
    }
    if (
      resolved &&
      !found.some(
        (f) => f.schema === resolved.schema && f.table === resolved.table,
      )
    )
      found.push(resolved);
  }
  return found;
}

/** Columns of the tables the statement already references, for completion
 * without a table prefix (SELECT list, WHERE, ORDER BY…). */
export function columnCompletions(
  sql: string,
  schema: DbSchema | undefined,
): CompletionItem[] {
  const seen = new Set<string>();
  const out: CompletionItem[] = [];
  for (const ref of referencedTables(sql, schema))
    for (const column of schema!.schemas[ref.schema][ref.table]) {
      if (seen.has(column.name)) continue;
      seen.add(column.name);
      out.push({
        label: column.name,
        type: "property",
        detail: `${ref.table} · ${column.type}`,
        boost: 2,
      });
    }
  return out;
}

/** Common PostgreSQL functions; keywords come from the lang-sql dialect. */
export const sqlFunctions = [
  "abs", "age", "array_agg", "array_length", "avg", "ceil", "coalesce",
  "concat", "count", "current_date", "current_setting", "current_timestamp",
  "date_part", "date_trunc", "dense_rank", "extract", "floor",
  "format", "gen_random_uuid", "generate_series", "greatest", "json_agg",
  "jsonb_agg", "jsonb_array_elements", "jsonb_build_object",
  "jsonb_each", "jsonb_extract_path_text", "jsonb_object_keys", "lag", "lead",
  "least", "left", "length", "lower", "max", "min", "now", "nullif",
  "pg_database_size", "pg_size_pretty", "pg_total_relation_size", "random",
  "rank", "regexp_matches", "regexp_replace", "replace", "right", "round",
  "row_number", "split_part", "string_agg", "substring", "sum", "to_char",
  "to_date", "to_jsonb", "to_timestamp", "trim", "unnest", "upper",
].map((label): CompletionItem => ({ label, type: "function" }));
