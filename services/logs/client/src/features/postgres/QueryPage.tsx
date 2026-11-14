import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { Dialog } from "../../components/Dialog";
import { JSONView, TableView } from "../../components/LogViews";
import { QueryEditor } from "../../components/QueryEditor";
import { api, ApiError, download } from "../../lib/api";
import {
  clearSQLHistory,
  getSQLHistory,
  rememberSQL,
} from "../../lib/sessionHistory";
import {
  apiPath,
  dbPath,
  errorLocation,
  type Database,
  type QueryResult,
} from "./pg";
import { PgError, PgHeading, useFormat, useNames, usePg } from "./shared";
import meili from "../meilisearch/Meilisearch.module.css";
import styles from "./Postgres.module.css";

type Run = { sql: string; explain: boolean };

export default function QueryPage() {
  const { t } = usePreferences();
  const f = useFormat();
  const location = useLocation();
  const {
    ok,
    values: [db],
  } = useNames("db");
  const initial = (location.state as { sql?: string } | null)?.sql;
  const [draft, setDraft] = useState(
    initial || getSQLHistory()[0] || "SELECT now(), current_database();",
  );
  const [view, setView] = useState<"table" | "json">("table");
  const [wrap, setWrap] = useState(false);
  const [history, setHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [last, setLast] = useState<Run | null>(null);
  // Table names feed the editor's completions.
  const tables = usePg<Database>(dbPath(db), ok);
  const names = useMemo(
    () =>
      (tables.data?.tables || []).flatMap((x) =>
        x.schema === "public"
          ? [x.name, `${x.schema}.${x.name}`]
          : [`${x.schema}.${x.name}`],
      ),
    [tables.data],
  );
  const query = useMutation({
    mutationFn: (run: Run) =>
      api<QueryResult>(apiPath(dbPath(db, "/query")), run),
  });
  if (!ok) return <Navigate replace to="/postgres" />;
  function run(sql = draft, explain = false) {
    if (!sql.trim() || query.isPending) return;
    if (sql !== draft) setDraft(sql);
    rememberSQL(sql);
    setHistoryVersion((v) => v + 1);
    setLast({ sql, explain });
    query.mutate({ sql, explain });
  }
  const data = query.data;
  const columns = data?.columns.map((c) => c.name) || [];
  const error = query.error;
  const where =
    error instanceof ApiError && last
      ? errorLocation(last.sql, error.position)
      : null;
  return (
    <>
      <PgHeading
        db={db}
        title={t("pgSqlEditor")}
        eyebrow={`${t("pgDatabase")} · ${db}`}
      />
      <div className={meili.page}>
        <section className={styles.editor}>
          <p className={meili.help}>{t("pgQueryHelp")}</p>
          <QueryEditor
            mode="sql"
            value={draft}
            onChange={setDraft}
            onRun={() => run()}
            fields={names}
            wrap={wrap}
          />
          <div className={styles.editorTools}>
            <button className="text-button" onClick={() => setHistory(true)}>
              {t("history")}
            </button>
            <button
              className="ghost"
              disabled={query.isPending}
              onClick={() => run(draft, true)}
            >
              {t("pgExplain")}
            </button>
            <button
              className="primary"
              disabled={query.isPending}
              onClick={() => run()}
            >
              {t("pgRun")} ↵
            </button>
          </div>
        </section>
        {error && (
          <div>
            <PgError error={error} />
            {where && (
              <p className={meili.meta}>
                {t("pgErrorAt", { line: where.line, column: where.column })}
              </p>
            )}
          </div>
        )}
        <section className={meili.results}>
          <div className={meili.resultHeader}>
            <div role="tablist" aria-label={t("rows")} className={meili.tabs}>
              {(["table", "json"] as const).map((item) => (
                <button
                  key={item}
                  role="tab"
                  aria-selected={view === item}
                  onClick={() => setView(item)}
                >
                  {t(item)}
                </button>
              ))}
            </div>
            <div className={styles.resultActions}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={wrap}
                  onChange={(e) => setWrap(e.target.checked)}
                />
                {t("wrapLines")}
              </label>
              <button
                className="text-button"
                disabled={!data?.rows.length}
                onClick={() =>
                  data && download(data.rows, "csv", columns, "query")
                }
              >
                {t("downloadCSV")} ↓
              </button>
              <button
                className="text-button"
                disabled={!data?.rows.length}
                onClick={() =>
                  data && download(data.rows, "jsonl", columns, "query")
                }
              >
                {t("downloadJSONL")} ↓
              </button>
            </div>
          </div>
          <p className={meili.meta} role="status">
            {query.isPending
              ? t("loading")
              : data
                ? [
                    t("pgResultInfo", {
                      count: f.number(data.rows.length),
                      duration: f.ms(data.durationMs),
                    }),
                    data.command,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : t("noResultsYet")}
          </p>
          {data?.truncated && (
            <p className={meili.note} role="note">
              {t("pgTruncated", { count: f.number(data.rows.length) })}
            </p>
          )}
          {data && data.rows.length === 0 && data.columns.length > 0 && (
            <div className="empty">
              <p>{t("pgNoRows")}</p>
            </div>
          )}
          {data &&
            data.rows.length > 0 &&
            (view === "table" ? (
              <TableView rows={data.rows} columns={columns} wrap={wrap} />
            ) : (
              <JSONView rows={data.rows} wrap={wrap} />
            ))}
        </section>
      </div>
      {history && (
        <Dialog title={t("history")} onClose={() => setHistory(false)}>
          <p>{t("savedSession")}</p>
          {getSQLHistory().length ? (
            getSQLHistory().map((item, index) => (
              <button
                className={styles.historyItem}
                key={`${historyVersion}:${index}`}
                onClick={() => {
                  setDraft(item);
                  setHistory(false);
                }}
              >
                <code>{item}</code>
              </button>
            ))
          ) : (
            <p>{t("noHistory")}</p>
          )}
          <button
            className="text-button"
            onClick={() => {
              clearSQLHistory();
              setHistoryVersion((v) => v + 1);
            }}
          >
            {t("clearHistory")}
          </button>
        </Dialog>
      )}
    </>
  );
}
