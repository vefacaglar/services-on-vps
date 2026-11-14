import { useQueryClient } from "@tanstack/react-query";
import type { EditorView } from "@codemirror/view";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { usePreferences } from "../../app/Preferences";
import { Dialog } from "../../components/Dialog";
import { TableView } from "../../components/LogViews";
import { QueryEditor, type RunTarget } from "../../components/QueryEditor";
import { api, ApiError, download } from "../../lib/api";
import {
  clearSQLHistory,
  getSQLHistory,
  rememberSQL,
} from "../../lib/sessionHistory";
import type { DbSchema } from "../../lib/sqlCompletion";
import { Explorer } from "./Explorer";
import {
  apiPath,
  confirmMatches,
  dbPath,
  errorLocation,
  errorRange,
  loadWorkspace,
  newTab,
  planLines,
  saveWorkspace,
  selectTop,
  type QueryResult,
  type Workspace,
  type WorkspaceTab,
  type WriteResult,
} from "./pg";
import { ResultGrid } from "./ResultGrid";
import { PgError, PgHeading, useFormat, useNames, useOverview, usePg } from "./shared";
import { useWriteMode, WriteToggle } from "./Write";
import meili from "../meilisearch/Meilisearch.module.css";
import pg from "./Postgres.module.css";
import styles from "./Workspace.module.css";

type Pane = "results" | "messages" | "plan";
type Run = {
  result?: QueryResult;
  committed?: boolean;
  plan?: string[] | null;
  messages: string[];
  error?: unknown;
  errorAt?: { line: number; column: number } | null;
  errorRange?: { from: number; to: number } | null;
  pane: Pane;
};
type Preview = {
  tabId: string;
  db: string;
  sql: string;
  result: WriteResult;
};

function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
const SPLIT_KEY = "pg-workspace-split";
function savedSplit() {
  try {
    const value = Number(storage()?.getItem(SPLIT_KEY));
    return value >= 120 && value <= 900 ? value : 260;
  } catch {
    return 260;
  }
}

export default function QueryPage() {
  const { t } = usePreferences();
  const f = useFormat();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const {
    ok,
    values: [urlDb],
  } = useNames("db");
  const [workspace, setWorkspace] = useState<Workspace>(() =>
    loadWorkspace(urlDb || "postgres", storage(), t("pgQueryTab")),
  );
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState<RunTarget>(undefined);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [typed, setTyped] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<unknown>(null);
  const [split, setSplit] = useState(savedSplit);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const view = useRef<EditorView | null>(null);
  const dragging = useRef<{ y: number; height: number } | null>(null);
  const writeMode = useWriteMode();
  const overview = useOverview();

  const active =
    workspace.tabs.find((tab) => tab.id === workspace.active) ||
    workspace.tabs[0];
  const db = active.db;
  const run = runs[active.id];
  const schema = usePg<DbSchema>(dbPath(db, "/schema"), ok);

  useEffect(() => saveWorkspace(workspace, storage()), [workspace]);

  // Keep the URL's database and the active tab in step. A table page's
  // "Query this table" arrives as navigation state and opens a new tab.
  const incoming = (location.state as { sql?: string } | null)?.sql;
  useEffect(() => {
    if (!ok) return;
    if (incoming) {
      setWorkspace((w) => {
        const tab = newTab(urlDb, incoming, w.tabs, t("pgQueryTab"));
        return { tabs: [...w.tabs, tab].slice(-20), active: tab.id };
      });
      navigate(dbPath(urlDb, "/query"), { replace: true, state: null });
      return;
    }
    setWorkspace((w) => {
      const current = w.tabs.find((tab) => tab.id === w.active);
      if (current?.db === urlDb) return w;
      const match = w.tabs.find((tab) => tab.db === urlDb);
      if (match) return { ...w, active: match.id };
      const tab = newTab(urlDb, "", w.tabs, t("pgQueryTab"));
      return { tabs: [...w.tabs, tab].slice(-20), active: tab.id };
    });
  }, [ok, urlDb, incoming, navigate]);

  const updateTab = useCallback((id: string, patch: Partial<WorkspaceTab>) => {
    setWorkspace((w) => ({
      ...w,
      tabs: w.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    }));
  }, []);
  function activate(tab: WorkspaceTab) {
    setWorkspace((w) => ({ ...w, active: tab.id }));
    setSelection(undefined);
    if (tab.db !== urlDb) navigate(dbPath(tab.db, "/query"), { replace: true });
  }
  function addTab(sql = "", tabDb = db, title?: string) {
    const tab = {
      ...newTab(tabDb, sql, workspace.tabs, t("pgQueryTab")),
      ...(title ? { title } : {}),
    };
    setWorkspace((w) => ({ tabs: [...w.tabs, tab].slice(-20), active: tab.id }));
    setSelection(undefined);
    if (tabDb !== urlDb) navigate(dbPath(tabDb, "/query"), { replace: true });
    return tab;
  }
  function closeTab(id: string) {
    const index = workspace.tabs.findIndex((tab) => tab.id === id);
    const rest = workspace.tabs.filter((tab) => tab.id !== id);
    if (!rest.length) {
      const tab = newTab(db, "", [], t("pgQueryTab"));
      setWorkspace({ tabs: [tab], active: tab.id });
    } else {
      const next = id === workspace.active ? rest[Math.max(0, index - 1)] : active;
      setWorkspace({ tabs: rest, active: next.id });
      if (next.db !== urlDb) navigate(dbPath(next.db, "/query"), { replace: true });
    }
    setRuns(({ [id]: _, ...others }) => others);
  }
  function setRun(id: string, value: Run) {
    setRuns((all) => ({ ...all, [id]: value }));
  }
  function failure(tab: WorkspaceTab, target: { from: number; text: string }, error: unknown): Run {
    const position = error instanceof ApiError ? error.position : undefined;
    const range = errorRange(tab.sql, target, position);
    return {
      messages: [],
      error,
      errorRange: range,
      errorAt: range ? errorLocation(tab.sql, [...tab.sql.slice(0, range.from)].length + 1) : null,
      pane: "messages",
    };
  }

  async function execute(
    explain = false,
    target: RunTarget = selection,
    tab: WorkspaceTab = active,
    forceRead = false,
  ) {
    const statement = target || { text: tab.sql, from: 0 };
    if (!statement.text.trim() || busy) return;
    rememberSQL(statement.text);
    setHistoryVersion((v) => v + 1);
    setBusy(tab.id);
    try {
      if (writeMode && !explain && !forceRead) {
        const result = await api<WriteResult>(
          apiPath(dbPath(tab.db, "/write/preview")),
          { sql: statement.text },
        );
        setTyped("");
        setCommitError(null);
        setPreview({ tabId: tab.id, db: tab.db, sql: statement.text, result });
        setRun(tab.id, {
          result: undefined,
          messages: [
            t("pgPreviewMessage", { count: f.number(result.rowsAffected) }),
            ...(result.notices || []),
          ],
          pane: "messages",
        });
        return;
      }
      const result = await api<QueryResult>(apiPath(dbPath(tab.db, "/query")), {
        sql: statement.text,
        explain,
      });
      const plan = planLines(result);
      setRun(tab.id, {
        result,
        plan,
        messages: [
          ...(result.notices || []),
          [
            t("pgResultInfo", {
              count: f.number(result.rows.length),
              duration: f.ms(result.durationMs),
            }),
            result.command,
          ]
            .filter(Boolean)
            .join(" · "),
          ...(result.truncated
            ? [t("pgTruncated", { count: f.number(result.rows.length) })]
            : []),
        ],
        pane: plan ? "plan" : "results",
      });
    } catch (error) {
      setRun(tab.id, failure(tab, statement, error));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!preview || committing) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await api<WriteResult>(
        apiPath(dbPath(preview.db, "/write/commit")),
        {
          sql: preview.sql,
          confirm: true,
          expectedRows: preview.result.rowsAffected,
          ...(preview.result.dangerous ? { confirmDatabase: typed.trim() } : {}),
        },
      );
      setRun(preview.tabId, {
        result: result.columns.length ? result : undefined,
        committed: true,
        messages: [
          ...(result.notices || []),
          [t("pgCommitted", { count: f.number(result.rowsAffected) }), result.command]
            .filter(Boolean)
            .join(" · "),
        ],
        pane: result.columns.length ? "results" : "messages",
      });
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ["pg"] });
    } catch (error) {
      setCommitError(error);
    } finally {
      setCommitting(false);
    }
  }

  async function format() {
    const target = selection || { text: active.sql, from: 0 };
    try {
      const { format } = await import("sql-formatter");
      const text = format(target.text, {
        language: "postgresql",
        keywordCase: "upper",
        tabWidth: 2,
      });
      updateTab(
        active.id,
        selection
          ? {
              sql:
                active.sql.slice(0, selection.from) +
                text +
                active.sql.slice(selection.from + selection.text.length),
            }
          : { sql: text },
      );
    } catch (error) {
      setRun(active.id, {
        messages: [
          `${t("pgFormatFailed")}: ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
        ],
        pane: "messages",
      });
    }
  }

  function insert(text: string) {
    const editor = view.current;
    if (!editor) {
      updateTab(active.id, { sql: active.sql + text });
      return;
    }
    editor.dispatch(editor.state.replaceSelection(text));
    editor.focus();
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    dragging.current = { y: event.clientY, height: split };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function drag(event: PointerEvent<HTMLDivElement>) {
    const d = dragging.current;
    if (!d) return;
    setSplit(Math.max(120, Math.min(900, d.height + event.clientY - d.y)));
  }
  function endDrag() {
    dragging.current = null;
    try {
      storage()?.setItem(SPLIT_KEY, String(split));
    } catch {
      // Not remembered.
    }
  }

  if (!ok) return <Navigate replace to="/postgres" />;
  const databases = overview.data?.databases.map((d) => d.name) || [];
  const result = run?.result;
  const columns = result?.columns.map((c) => c.name) || [];
  const pending = busy === active.id;
  return (
    <>
      <PgHeading db={db} title={t("pgSqlEditor")} eyebrow={`${t("pgDatabase")} · ${db}`} />
      <div className={`${styles.workspace} ${explorerOpen ? "" : styles.noExplorer}`}>
        {explorerOpen && (
          <Explorer
            db={db}
            schema={schema.data}
            loading={schema.isPending}
            onInsert={insert}
            onSelectTop={(s, table) => {
              const tab = addTab(selectTop(s, table), db, table);
              void execute(false, undefined, tab, true);
            }}
          />
        )}
        <div className={styles.main}>
          <div className={styles.tabBar} role="tablist" aria-label={t("pgQueryTabs")}>
            <button
              className={`text-button ${styles.explorerToggle}`}
              aria-pressed={explorerOpen}
              onClick={() => setExplorerOpen((v) => !v)}
              title={t("pgExplorer")}
            >
              ☰
            </button>
            {workspace.tabs.map((tab) => (
              <div
                key={tab.id}
                className={`${styles.tab} ${tab.id === active.id ? styles.tabActive : ""}`}
              >
                {renaming === tab.id ? (
                  <input
                    autoFocus
                    className={styles.tabRename}
                    defaultValue={tab.title}
                    aria-label={t("pgRenameTab")}
                    maxLength={60}
                    onBlur={(e) => {
                      updateTab(tab.id, { title: e.target.value.trim() || tab.title });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    role="tab"
                    aria-selected={tab.id === active.id}
                    title={`${tab.title} · ${tab.db} — ${t("pgRenameHint")}`}
                    onClick={() => activate(tab)}
                    onDoubleClick={() => setRenaming(tab.id)}
                  >
                    {tab.title}
                    <span className={styles.tabDb}>{tab.db}</span>
                  </button>
                )}
                <button
                  className={styles.tabClose}
                  aria-label={`${t("close")}: ${tab.title}`}
                  onClick={() => closeTab(tab.id)}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className={`text-button ${styles.addTab}`}
              aria-label={t("pgNewTab")}
              title={t("pgNewTab")}
              disabled={workspace.tabs.length >= 20}
              onClick={() => addTab()}
            >
              +
            </button>
          </div>

          <div className={`${styles.toolbar} ${writeMode ? styles.toolbarWrite : ""}`}>
            <select
              aria-label={t("pgDatabase")}
              value={db}
              onChange={(e) => {
                updateTab(active.id, { db: e.target.value });
                navigate(dbPath(e.target.value, "/query"), { replace: true });
              }}
            >
              {databases.includes(db) ? null : <option value={db}>{db}</option>}
              {databases.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <span className={styles.toggleSlot}>
              <WriteToggle />
            </span>
            <span className={styles.spacer} />
            <button className="text-button" onClick={() => setHistory(true)}>
              {t("history")}
            </button>
            <button className="ghost" onClick={() => void format()} title={t("pgFormatHint")}>
              {t("pgFormat")}
            </button>
            <button className="ghost" disabled={!!busy} onClick={() => void execute(true)}>
              {t("pgExplain")}
            </button>
            <button
              className={writeMode ? pg.danger : "primary"}
              disabled={!!busy}
              onClick={() => void execute()}
              title={t("pgRunHint")}
            >
              {t(writeMode ? "pgPreview" : "pgRun")}
              {selection ? ` (${t("pgSelection")})` : ""} ↵
            </button>
          </div>

          <div className={writeMode ? styles.editorWrite : styles.editor}>
            <QueryEditor
              mode="sql"
              value={active.sql}
              onChange={(sql) => updateTab(active.id, { sql })}
              onRun={(target) => void execute(false, target)}
              fields={[]}
              wrap={false}
              schema={schema.data}
              error={run?.errorRange}
              onSelection={setSelection}
              height={`${split}px`}
              onView={(v) => (view.current = v)}
              key={active.id}
            />
          </div>
          <div
            className={styles.splitter}
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("pgResizeEditor")}
            tabIndex={0}
            onPointerDown={startDrag}
            onPointerMove={drag}
            onPointerUp={endDrag}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") setSplit((h) => Math.max(120, h - 20));
              if (e.key === "ArrowDown") setSplit((h) => Math.min(900, h + 20));
            }}
          />

          <section className={styles.results}>
            <div className={styles.resultsHead}>
              <div role="tablist" aria-label={t("rows")} className={meili.tabs}>
                {(["results", "messages", "plan"] as const).map((pane) => (
                  <button
                    key={pane}
                    role="tab"
                    aria-selected={(run?.pane || "results") === pane}
                    onClick={() => run && setRun(active.id, { ...run, pane })}
                  >
                    {t(pane === "results" ? "pgResults" : pane === "messages" ? "pgMessages" : "pgPlan")}
                    {pane === "results" && result ? ` ${f.number(result.rows.length)}` : ""}
                    {pane === "messages" && run?.error ? " !" : ""}
                  </button>
                ))}
              </div>
              <div className={styles.exports}>
                <button
                  className="text-button"
                  disabled={!result?.rows.length}
                  onClick={() => result && download(result.rows, "csv", columns, "query")}
                >
                  CSV ↓
                </button>
                <button
                  className="text-button"
                  disabled={!result?.rows.length}
                  onClick={() => result && download(result.rows, "json", columns, "query")}
                >
                  JSON ↓
                </button>
              </div>
            </div>
            <div className={styles.paneBody}>
              {pending && <p className={meili.meta}>{t("loading")}</p>}
              {!pending && !run && <p className={meili.meta}>{t("noResultsYet")}</p>}
              {!pending && run && (run.pane || "results") === "results" &&
                (result ? (
                  result.columns.length === 0 ? (
                    <p className={meili.meta}>{result.command || t("pgNoRows")}</p>
                  ) : result.rows.length === 0 ? (
                    <div className="empty">
                      <p>{t("pgNoRows")}</p>
                    </div>
                  ) : (
                    <ResultGrid result={result} key={`${active.id}:${result.durationMs}`} />
                  )
                ) : (
                  <p className={meili.meta}>{run.error ? t("pgSeeMessages") : t("noResultsYet")}</p>
                ))}
              {!pending && run?.pane === "messages" && (
                <div className={styles.messages}>
                  {run.messages.map((message, index) => (
                    <pre key={index} className={message.startsWith("WARNING") ? styles.warnLine : undefined}>
                      {message}
                    </pre>
                  ))}
                  {run.error ? (
                    <div>
                      <PgError error={run.error} />
                      {run.errorAt && (
                        <p className={meili.meta}>
                          {t("pgErrorAt", { line: run.errorAt.line, column: run.errorAt.column })}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
              {!pending && run?.pane === "plan" &&
                (run.plan ? (
                  <pre className={styles.plan}>
                    {run.plan.map((line, index) => (
                      <span key={index} className={/^\s*->/.test(line) || index === 0 ? styles.planNode : undefined}>
                        {line}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className={meili.meta}>{t("pgNoPlan")}</p>
                ))}
            </div>
          </section>

          <footer className={styles.status} aria-label={t("pgStatus")}>
            <span>{db}</span>
            <span>{overview.data?.server.user || "—"}</span>
            <span>
              {result
                ? t("pgRowsCount", { count: f.number(result.rows.length) })
                : "—"}
            </span>
            <span>{result ? `${f.ms(result.durationMs)} ms` : "—"}</span>
            <span className={writeMode ? styles.statusWrite : styles.statusRead}>
              {t(writeMode ? "writeMode" : "readOnly")}
            </span>
          </footer>
        </div>
      </div>

      {preview && (
        <Dialog
          title={t("pgConfirmWrite")}
          onClose={() => {
            if (!committing) setPreview(null);
          }}
        >
          <div className={pg.affected}>
            <strong>
              {t("pgWillAffect", { count: f.number(preview.result.rowsAffected) })}
            </strong>
            <code>
              {preview.db}
              {preview.result.command ? ` · ${preview.result.command}` : ""}
            </code>
          </div>
          <pre className={`${meili.code} ${pg.confirmSQL}`}>{preview.sql}</pre>
          <p>{t("pgPreviewRolledBack")}</p>
          {preview.result.dangerous && (
            <div className={pg.dangerBox} role="alert">
              <ul>
                {preview.result.reasons.map((reason) => (
                  <li key={reason}>
                    {t(reason === "ddl" ? "pgDangerDDL" : "pgDangerNoWhere")}
                  </li>
                ))}
              </ul>
              <label className={pg.typeName}>
                <span>{t("pgTypeDbName", { db: preview.db })}</span>
                <input
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </label>
            </div>
          )}
          {preview.result.rows.length > 0 && (
            <div>
              <h3 className={pg.subhead}>{t("pgReturning")}</h3>
              <TableView
                rows={preview.result.rows.slice(0, 20)}
                columns={preview.result.columns.map((c) => c.name)}
              />
            </div>
          )}
          <PgError error={commitError} />
          <div className={pg.dialogActions}>
            <button className="ghost" disabled={committing} onClick={() => setPreview(null)}>
              {t("pgCancel")}
            </button>
            <button
              className={pg.danger}
              disabled={
                committing ||
                (preview.result.dangerous && !confirmMatches(typed, preview.db))
              }
              onClick={() => void commit()}
            >
              {t("pgCommit")}
            </button>
          </div>
        </Dialog>
      )}
      {history && (
        <Dialog title={t("history")} onClose={() => setHistory(false)}>
          <p>{t("savedSession")}</p>
          {getSQLHistory().length ? (
            getSQLHistory().map((item, index) => (
              <button
                className={pg.historyItem}
                key={`${historyVersion}:${index}`}
                onClick={() => {
                  updateTab(active.id, { sql: item });
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
